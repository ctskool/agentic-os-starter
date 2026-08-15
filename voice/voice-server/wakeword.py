"""
Wake-word listener — openWakeWord "hey jarvis" on the default mic.

Chosen over Porcupine (the original P4 plan) because Porcupine requires a
Picovoice account + access key; openWakeWord ships a pretrained hey-jarvis
ONNX model and rides the onnxruntime(-gpu) already in this venv. Fully
local, zero keys.

Runs as a daemon thread inside server.py:
  mic (16k mono int16, 80ms frames) -> openwakeword predict
  score >= threshold -> emit {"type":"wake"} -> capture the utterance with
  energy endpointing -> whisper STT (shared model, lock in server.py) ->
  emit {"type":"transcript","text":...}.

The HUD listens on ws://:3108/events: "wake" = barge-in (stop TTS, show
listening), "transcript" = dispatch through POST /api/voice/text.
"""

import threading
import time

import numpy as np

SR = 16000
FRAME = 1280  # 80ms @ 16k — the frame size openwakeword expects per predict()
WAKE_MODEL = "hey_jarvis_v0.1"

MAX_UTTERANCE_S = 8.0    # hard cap on post-wake capture
NO_SPEECH_S = 2.5        # wake fired but nobody spoke -> timeout
TRAIL_SILENCE_FRAMES = 9  # ~720ms of quiet after speech = end of utterance
COOLDOWN_S = 1.5         # ignore re-triggers right after a capture


# one mic capture at a time — hotkey mashing must not stack recorders
_capture_lock = threading.Lock()


def capture_once(transcribe_pcm, emit, source="hotkey",
                 trail_silence_s=1.6, max_utterance_s=20.0, no_speech_s=5.0):
    """One-shot push-to-talk capture WITHOUT a wake word — triggered by the
    global hotkey (or POST /listen). Same event protocol as the wake path
    so every connected client (the Obsidian orb, even minimized) handles it
    identically. Endpointing is deliberately LOOSER than wake mode: a
    deliberate ask includes thinking pauses, so the trailing-silence window
    defaults to 1.6s (vs wake's ~0.7s) and the utterance cap to 20s."""
    if not _capture_lock.acquire(blocking=False):
        return  # a capture is already running
    trail_frames = max(3, int(trail_silence_s / 0.08))  # 80ms frames
    try:
        import sounddevice as sd

        with sd.InputStream(
            samplerate=SR, channels=1, dtype="int16", blocksize=FRAME
        ) as stream:
            # short noise-floor estimate so the speech gate fits the room
            noise = 80.0
            for _ in range(3):  # ~240ms
                frame, _o = stream.read(FRAME)
                pcm = frame[:, 0]
                rms = float(np.sqrt(np.mean(pcm.astype(np.float32) ** 2)))
                noise = 0.7 * noise + 0.3 * min(rms, 600.0)
            emit({"type": "wake", "score": 1.0, "source": source})

            speech_gate = max(noise * 3.0, 250.0)
            frames = []
            started = False
            silent = 0
            t0 = time.time()
            while time.time() - t0 < max_utterance_s:
                frame, _ = stream.read(FRAME)
                pcm = frame[:, 0]
                frames.append(pcm.copy())
                rms = float(np.sqrt(np.mean(pcm.astype(np.float32) ** 2)))
                if rms >= speech_gate:
                    started = True
                    silent = 0
                else:
                    silent += 1
                    if started and silent >= trail_frames:
                        break
                    if not started and time.time() - t0 > no_speech_s:
                        emit({"type": "wake_timeout"})
                        return

            if not started:
                emit({"type": "wake_timeout"})
                return
            audio = np.concatenate(frames).astype(np.float32) / 32768.0
            t1 = time.time()
            try:
                text = transcribe_pcm(audio)
            except Exception as e:  # noqa: BLE001
                emit({"type": "wake_error", "error": str(e)})
                return
            if text:
                emit({"type": "transcript", "text": text, "ms": int((time.time() - t1) * 1000)})
            else:
                emit({"type": "wake_timeout"})
    except Exception as e:  # noqa: BLE001
        emit({"type": "wake_error", "error": f"{type(e).__name__}: {e}"})
    finally:
        _capture_lock.release()


class HotkeyListener:
    """Global OS hotkey → capture_once. Works with every window minimized —
    the answer plays through the orb's (still-running) audio pipeline."""

    def __init__(self, transcribe_pcm, emit, combo="ctrl+alt+j", capture_kwargs=None):
        self.combo = combo
        self.ok = False
        self.error = None
        self._transcribe = transcribe_pcm
        self._emit = emit
        self._capture_kwargs = capture_kwargs or {}

    def start(self):
        try:
            import keyboard  # global hooks, no admin needed in user session
        except Exception as e:  # noqa: BLE001
            self.error = f"keyboard lib missing: {e}"
            print(f"voice hotkey disabled: {self.error}")
            return
        try:
            keyboard.add_hotkey(self.combo, self._fire, suppress=False)
            self.ok = True
            print(f"voice hotkey armed — {self.combo}")
        except Exception as e:  # noqa: BLE001
            self.error = f"{type(e).__name__}: {e}"
            print(f"voice hotkey failed: {self.error}")

    def _fire(self):
        threading.Thread(
            target=capture_once,
            args=(self._transcribe, self._emit),
            kwargs={"source": "hotkey", **self._capture_kwargs},
            daemon=True,
            name="hotkey-capture",
        ).start()


class WakeListener:
    def __init__(self, transcribe_pcm, emit, threshold=0.5):
        """transcribe_pcm(float32 mono 16k) -> str; emit(dict) is thread-safe."""
        self.transcribe_pcm = transcribe_pcm
        self.emit = emit
        self.threshold = threshold
        self.ok = False
        self.error = None
        self._thread = threading.Thread(target=self._run, daemon=True, name="wake-listener")

    def start(self):
        self._thread.start()

    def _run(self):
        try:
            import sounddevice as sd
            from openwakeword.model import Model

            model = Model(wakeword_models=[WAKE_MODEL], inference_framework="onnx")
        except Exception as e:  # missing mic/deps/models — report via /health, never crash the server
            self.error = f"{type(e).__name__}: {e}"
            print(f"wake word disabled: {self.error}")
            return

        try:
            with sd.InputStream(
                samplerate=SR, channels=1, dtype="int16", blocksize=FRAME
            ) as stream:
                self.ok = True
                print(f"wake word armed — '{WAKE_MODEL}' threshold={self.threshold}")
                noise = 80.0  # rolling RMS noise floor, follows the room
                last_fire = 0.0
                while True:
                    frame, _overflowed = stream.read(FRAME)
                    pcm = frame[:, 0]
                    rms = float(np.sqrt(np.mean(pcm.astype(np.float32) ** 2)))
                    # clamp so speech doesn't drag the floor up
                    noise = 0.98 * noise + 0.02 * min(rms, 600.0)
                    score = float(model.predict(pcm)[WAKE_MODEL])
                    if score >= self.threshold and time.time() - last_fire > COOLDOWN_S:
                        self.emit({"type": "wake", "score": round(score, 3)})
                        self._capture(stream, noise)
                        model.reset()
                        last_fire = time.time()
        except Exception as e:
            self.ok = False
            self.error = f"{type(e).__name__}: {e}"
            print(f"wake listener died: {self.error}")

    def _capture(self, stream, noise):
        """Record until the speaker goes quiet, then STT and emit."""
        speech_gate = max(noise * 3.0, 250.0)
        frames = []
        started = False
        silent = 0
        t0 = time.time()
        while time.time() - t0 < MAX_UTTERANCE_S:
            frame, _ = stream.read(FRAME)
            pcm = frame[:, 0]
            frames.append(pcm.copy())
            rms = float(np.sqrt(np.mean(pcm.astype(np.float32) ** 2)))
            if rms >= speech_gate:
                started = True
                silent = 0
            else:
                silent += 1
                if started and silent >= TRAIL_SILENCE_FRAMES:
                    break
                if not started and time.time() - t0 > NO_SPEECH_S:
                    self.emit({"type": "wake_timeout"})
                    return

        if not started:
            self.emit({"type": "wake_timeout"})
            return

        audio = np.concatenate(frames).astype(np.float32) / 32768.0
        t1 = time.time()
        try:
            text = self.transcribe_pcm(audio)
        except Exception as e:
            self.emit({"type": "wake_error", "error": str(e)})
            return
        if text:
            self.emit(
                {"type": "transcript", "text": text, "ms": int((time.time() - t1) * 1000)}
            )
        else:
            self.emit({"type": "wake_timeout"})
