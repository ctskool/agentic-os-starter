"""
Jarvis local voice — Kokoro-82M TTS + faster-whisper STT behind FastAPI
on :3108.

The standalone voice process the handoff reserved (Next API routes stay
stateless; this holds the warm models). lib/tts.ts and lib/stt.ts
auto-detect it via /health and fall back to ElevenLabs when it's not
running.

GET  /health         -> {"ok": true, "voice": "...", "stt": {...}}
GET  /speak?text=... -> audio/wav, streamed sentence-by-sentence so the
                        browser starts playback after the FIRST sentence
                        is generated, not the whole reply.
POST /stt            -> raw audio body (webm/opus/wav) -> {"text": "..."}
                        faster-whisper on CUDA (RTX 5090, ~100ms warm),
                        CPU int8 if CUDA init fails.

Run: .venv\\Scripts\\python.exe server.py   (or start-voice-server.vbs)
"""

import asyncio
import glob
import io
import json
import os
import re
import struct
import sys
import threading
import time

# ctranslate2 (faster-whisper) needs cuDNN/cuBLAS DLLs from the pip
# nvidia-* wheels on the DLL search path BEFORE import
for _d in glob.glob(os.path.join(sys.prefix, "Lib", "site-packages", "nvidia", "*", "bin")):
    os.add_dll_directory(_d)
    os.environ["PATH"] = _d + os.pathsep + os.environ["PATH"]

import numpy as np
import uvicorn
from fastapi import FastAPI, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse
from faster_whisper import WhisperModel
from kokoro_onnx import Kokoro

from wakeword import HotkeyListener, WakeListener, WAKE_MODEL, capture_once

# Load ~/.claude/.env (same file the runner + metrics scripts read) so
# KOKORO_VOICE / WHISPER_MODEL / WAKE_WORD can be configured in one place.
# Real environment variables still win.
_env_file = os.path.join(os.path.expanduser("~"), ".claude", ".env")
if os.path.exists(_env_file):
    with open(_env_file, encoding="utf-8") as _f:
        for _raw in _f:
            _line = _raw.strip()
            if not _line or _line.startswith("#") or "=" not in _line:
                continue
            _k, _v = _line.split("=", 1)
            os.environ.setdefault(_k.strip(), _v.strip().strip("\"'"))

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = 3108
VOICE = os.environ.get("KOKORO_VOICE", "bm_george")  # calm British male
SPEED = float(os.environ.get("KOKORO_SPEED", "1.0"))
SAMPLE_RATE = 24000  # kokoro output rate
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "small.en")
# domain vocab bias — keeps acronyms like MRR from coming out "M.R.A."
WHISPER_PROMPT = os.environ.get(
    "WHISPER_PROMPT",
    "Jarvis dashboard voice commands: MRR, revenue, YouTube subscribers, "
    "TikTok, Instagram, metrics pull, morning report, inbox brief, GitHub "
    "trending, trend scan, daily briefing, runner, queue, top three priorities.",
)

app = FastAPI()

def load_kokoro():
    """CUDA via onnxruntime-gpu (~250ms/sentence vs ~1050ms CPU). kokoro-onnx
    picks the provider from ONNX_PROVIDER at init; if CUDA can't actually
    create (missing DLLs etc) onnxruntime silently falls back to CPU inside
    the session, so trust the session's own report, not the env var."""
    model = os.path.join(HERE, "kokoro-v1.0.onnx")
    voices = os.path.join(HERE, "voices-v1.0.bin")
    if os.environ.get("KOKORO_DEVICE", "auto") != "cpu":
        try:
            os.environ["ONNX_PROVIDER"] = "CUDAExecutionProvider"
            k = Kokoro(model, voices)
            if "CUDAExecutionProvider" in k.sess.get_providers():
                return k, "cuda"
        except Exception as e:
            print(f"kokoro cuda failed ({e}); falling back to cpu")
        os.environ.pop("ONNX_PROVIDER", None)
    return Kokoro(model, voices), "cpu"

kokoro, KOKORO_DEVICE = load_kokoro()

def load_whisper():
    """CUDA float16 (5090 = ~100ms warm) with CPU int8 fallback so a
    broken CUDA stack degrades to slow-but-working, never to dead."""
    if os.environ.get("WHISPER_DEVICE", "auto") != "cpu":
        try:
            m = WhisperModel(WHISPER_MODEL, device="cuda", compute_type="float16")
            return m, "cuda"
        except Exception as e:
            print(f"whisper cuda failed ({e}); falling back to cpu int8")
    return WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8"), "cpu"

whisper, WHISPER_DEVICE = load_whisper()

# one whisper model, two callers (/stt route + wake-word thread) — serialize
whisper_lock = threading.Lock()


def transcribe_pcm(audio_f32):
    """float32 mono 16k -> text. Shared by the wake-word capture path."""
    with whisper_lock:
        segments, _info = whisper.transcribe(
            audio_f32, beam_size=1, language="en", vad_filter=False,
            initial_prompt=WHISPER_PROMPT,
        )
        # segments is a lazy generator — consume INSIDE the lock or the
        # actual decode runs unguarded
        return " ".join(s.text.strip() for s in segments).strip()


# --- P4: wake word + HUD event stream -------------------------------------
# The HUD connects to ws://:3108/events. The wake thread emits through
# emit_event() which hops onto the uvicorn event loop thread-safely.

WAKE_ENABLED = os.environ.get("WAKE_WORD", "on").lower() not in ("off", "0", "false")
WAKE_THRESHOLD = float(os.environ.get("WAKE_THRESHOLD", "0.5"))

ws_clients: set = set()
main_loop = None


def emit_event(payload: dict):
    if main_loop is None:
        return
    msg = json.dumps(payload)

    async def _send():
        for ws in list(ws_clients):
            try:
                await ws.send_text(msg)
            except Exception:
                ws_clients.discard(ws)

    asyncio.run_coroutine_threadsafe(_send(), main_loop)


wake = WakeListener(transcribe_pcm, emit_event, threshold=WAKE_THRESHOLD) if WAKE_ENABLED else None

# global hotkey — push-to-talk from ANY app, Obsidian minimized included.
# Off only with VOICE_HOTKEY=off; independent of the wake word.
# HOTKEY_SILENCE: trailing quiet (seconds) that ends the utterance — loose
# by default so thinking pauses don't cut you off mid-ask.
HOTKEY = os.environ.get("VOICE_HOTKEY", "ctrl+alt+j")
HOTKEY_SILENCE = float(os.environ.get("VOICE_HOTKEY_SILENCE", "1.6"))
HOTKEY_MAX_S = float(os.environ.get("VOICE_HOTKEY_MAX", "20"))
CAPTURE_KW = {"trail_silence_s": HOTKEY_SILENCE, "max_utterance_s": HOTKEY_MAX_S}
hotkey = (
    HotkeyListener(transcribe_pcm, emit_event, combo=HOTKEY, capture_kwargs=CAPTURE_KW)
    if HOTKEY.lower() not in ("off", "0", "false")
    else None
)


@app.websocket("/events")
async def events(ws: WebSocket):
    await ws.accept()
    # hello tells the HUD whether hands-free is actually armed — the client
    # can't read /health cross-origin, and "wake word armed" must not lie
    await ws.send_text(json.dumps({"type": "hello", "wake": bool(wake and wake.ok)}))
    ws_clients.add(ws)
    try:
        while True:
            await ws.receive_text()  # client pings — content ignored
    except WebSocketDisconnect:
        pass
    finally:
        ws_clients.discard(ws)


@app.on_event("startup")
async def _startup():
    global main_loop
    main_loop = asyncio.get_running_loop()
    if wake is not None:
        wake.start()
    if hotkey is not None:
        hotkey.start()


@app.post("/listen")
def listen():
    """Programmatic push-to-talk — same one-shot capture the hotkey fires."""
    threading.Thread(
        target=capture_once, args=(transcribe_pcm, emit_event),
        kwargs={"source": "api", **CAPTURE_KW}, daemon=True, name="api-capture",
    ).start()
    return {"ok": True}


def wav_header(sample_rate: int) -> bytes:
    """Streaming WAV header with unknown length (0x7FFFFFFF) — browsers
    play it progressively and stop at end-of-stream."""
    data_size = 0x7FFFFFFF - 36
    return struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF", 36 + data_size, b"WAVE",
        b"fmt ", 16, 1, 1, sample_rate, sample_rate * 2, 2, 16,
        b"data", data_size,
    )


SENTENCE_SPLIT = re.compile(r"(?<=[.!?…])\s+")


def chunks_of(text: str):
    """First sentence ships alone so playback starts ASAP; the rest glue
    into >=60-char chunks so tiny fragments don't chop the prosody."""
    parts = [p.strip() for p in SENTENCE_SPLIT.split(text) if p.strip()]
    if not parts:
        return [text]
    out, cur = [parts[0]], ""
    for p in parts[1:]:
        cur = f"{cur} {p}".strip()
        if len(cur) >= 60:
            out.append(cur)
            cur = ""
    if cur:
        out.append(cur)
    return out


@app.get("/health")
def health():
    return {
        "ok": True,
        "engine": "kokoro",
        "voice": VOICE,
        "device": KOKORO_DEVICE,
        "stt": {"ok": True, "model": WHISPER_MODEL, "device": WHISPER_DEVICE},
        "wake": {
            "enabled": WAKE_ENABLED,
            "ok": bool(wake and wake.ok),
            "model": WAKE_MODEL,
            "threshold": WAKE_THRESHOLD,
            "error": wake.error if wake else None,
        },
        "hotkey": {
            "combo": HOTKEY,
            "ok": bool(hotkey and hotkey.ok),
            "error": hotkey.error if hotkey else None,
        },
    }


@app.post("/stt")
async def stt(req: Request):
    audio = await req.body()
    if len(audio) < 1000:
        return Response(status_code=400, content="clip too short")
    t0 = time.time()
    # faster-whisper decodes webm/opus/wav via PyAV from a file-like object
    with whisper_lock:
        segments, _info = whisper.transcribe(
            io.BytesIO(audio), beam_size=1, language="en", vad_filter=False,
            initial_prompt=WHISPER_PROMPT,
        )
        text = " ".join(s.text.strip() for s in segments).strip()
    return {"text": text, "ms": int((time.time() - t0) * 1000)}


@app.get("/speak")
def speak(text: str = ""):
    text = text.strip()[:900]
    if not text:
        return Response(status_code=400, content="empty text")

    def gen():
        yield wav_header(SAMPLE_RATE)
        for chunk in chunks_of(text):
            samples, sr = kokoro.create(chunk, voice=VOICE, speed=SPEED, lang="en-gb")
            pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype(np.int16)
            yield pcm.tobytes()
            # short breath between sentences
            yield b"\x00" * int(SAMPLE_RATE * 0.12) * 2

    return StreamingResponse(gen(), media_type="audio/wav",
                             headers={"Cache-Control": "no-store"})


if __name__ == "__main__":
    # warm both models so the first real request doesn't pay init cost —
    # whisper's first CUDA run JITs kernels (~9s); feed it kokoro's warmup
    # audio so the whole pipeline is hot
    samples, _ = kokoro.create("Systems online.", voice=VOICE, speed=SPEED, lang="en-gb")
    warm = io.BytesIO()
    import soundfile as sf
    sf.write(warm, samples, SAMPLE_RATE, format="WAV")
    warm.seek(0)
    list(whisper.transcribe(warm, beam_size=1, language="en")[0])
    print(f"kokoro({KOKORO_DEVICE}) + whisper({WHISPER_MODEL}/{WHISPER_DEVICE}) warm — serving :{PORT} voice={VOICE}")
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
