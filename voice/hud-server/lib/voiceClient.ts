// ---------------------------------------------------------------------------
// Client-side voice singleton.
// P1: speak(text) queues utterances; each plays through an <audio> element
// wired into a Web Audio AnalyserNode so getLevel() exposes the real RMS
// envelope GraphCore mouths. Autoplay policy: nothing plays until the first
// user gesture — utterances queue and drain on unlock.
// P2: PTT — startCapture()/finishCapture() record mic audio (MediaRecorder),
// POST the clip to /api/voice (Scribe STT → router → maybe queue write),
// then speak the reply. Holding Space IS a gesture, so PTT also unlocks.
// ---------------------------------------------------------------------------

type SpeakingListener = (speaking: boolean) => void;
type LogListener = (cls: string, text: string) => void;
type PanelsListener = (panels: string[]) => void;
type DeliverableListener = (path: string, label: string) => void;
type ListeningListener = (listening: boolean) => void;

export interface Reveal {
  kind: "doc" | "link";
  target: string;
  label: string;
  at: number; // char offset into the reply where its sentence starts
}
type RevealListener = (r: Reveal) => void;

interface Utterance {
  text: string;
  reveals?: Reveal[];
}

const WAKE_EVENTS_URL = "ws://127.0.0.1:3108/events";
// Kokoro bm_george at 1.0 speaks ~13 chars/sec — close enough to time the
// callout pops to the sentence being spoken
const CHARS_PER_SEC = 13;
// post-wake utterances that just mean "never mind" — already barged in, drop
const DISMISS_RE = /^(stop|cancel|never ?mind|nothing|no|nope|shut up|quiet)[\s.!,]*$/i;

class VoiceClient {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private input: AudioNode | null = null; // head of the sheen chain
  private timeData: Uint8Array<ArrayBuffer> | null = null;
  private queue: Utterance[] = [];
  private playing = false;
  private unlocked = false;
  private disabled = false; // 503 — no key on the server
  private inited = false;
  private announcedLocked = false;
  private speakingListeners = new Set<SpeakingListener>();
  private log: LogListener = () => {};
  private onPanelsCb: PanelsListener = () => {};
  private onDeliverableCb: DeliverableListener = () => {};
  private recorder: MediaRecorder | null = null;
  private micStream: MediaStream | null = null;
  private currentStop: (() => void) | null = null;
  private chunks: BlobPart[] = [];
  private captureStart = 0;
  private wakeWs: WebSocket | null = null;
  private wakeWasUp = false;
  private listeningCb: ListeningListener = () => {};
  private onOpenDocCb: DeliverableListener = () => {};
  private onRevealCb: RevealListener = () => {};
  private revealTimers: { id: ReturnType<typeof setTimeout>; r: Reveal; fired: boolean }[] = [];

  init() {
    if (this.inited || typeof window === "undefined") return;
    this.inited = true;

    const unlock = () => {
      if (this.unlocked) return;
      this.unlocked = true;
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
      this.ensureGraph();
      this.ctx?.resume().catch(() => {});
      void this.drain();
    };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);

    // config probe — surface a missing key once, up front
    fetch("/api/speak", { cache: "no-store" })
      .then(async (res) => {
        if (res.status === 503) {
          this.disabled = true;
          this.queue = [];
          this.log("err", "voice offline — voice-server on :3108 is down");
        } else if (res.ok) {
          const j = (await res.json().catch(() => ({}))) as { engine?: string };
          this.log("ok", `voice link armed — ${j.engine ?? "kokoro"} · local`);
        }
      })
      .catch(() => {});

    this.connectWake();
  }

  // --- P4: wake word — voice-server pushes wake/transcript events over WS;
  // hands-free path mirrors PTT exactly, minus the browser-side recording
  private connectWake() {
    if (typeof window === "undefined") return;
    const open = () => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(WAKE_EVENTS_URL);
      } catch {
        setTimeout(open, 10_000);
        return;
      }
      this.wakeWs = ws;
      ws.onopen = () => {
        this.wakeWasUp = true;
        // armed/disarmed log waits for the server's hello — see handleWakeEvent
      };
      ws.onmessage = (ev) => this.handleWakeEvent(String(ev.data));
      ws.onclose = () => {
        this.wakeWs = null;
        if (this.wakeWasUp) {
          this.wakeWasUp = false;
          this.listeningCb(false);
          this.log("sys", "wake word link lost — retrying");
        }
        setTimeout(open, 5000); // quiet retry: voice-server may just be down
      };
      ws.onerror = () => ws.close();
    };
    open();
  }

  private handleWakeEvent(raw: string) {
    let e: { type?: string; text?: string; wake?: boolean };
    try {
      e = JSON.parse(raw) as { type?: string; text?: string; wake?: boolean };
    } catch {
      return;
    }
    if (e.type === "hello") {
      this.log(
        "ok",
        e.wake ? 'wake word armed — say "hey Jarvis"' : "voice link up — push-to-talk only (wake word off)"
      );
    } else if (e.type === "wake") {
      // full barge-in: hearing the wake word mid-speech cuts Jarvis off
      if (this.stop()) this.log("sys", "wake — interrupted");
      this.listeningCb(true);
      this.log("sys", "wake — listening …");
    } else if (e.type === "wake_timeout" || e.type === "wake_error") {
      this.listeningCb(false);
      if (e.type === "wake_error") this.log("err", "wake capture failed");
    } else if (e.type === "transcript") {
      this.listeningCb(false);
      const text = (e.text ?? "").trim();
      if (!text) return;
      if (DISMISS_RE.test(text)) {
        this.log("sys", `you · ${text} — dismissed`);
        return;
      }
      void this.dispatchText(text);
    }
  }

  private async dispatchText(transcript: string): Promise<void> {
    try {
      const res = await fetch("/api/voice/text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript }),
      });
      await this.handleVoiceResponse(res);
    } catch (e) {
      this.log("err", `voice command failed: ${String(e).slice(0, 120)}`);
    }
  }

  onSpeaking(cb: SpeakingListener): () => void {
    this.speakingListeners.add(cb);
    return () => this.speakingListeners.delete(cb);
  }

  onLog(cb: LogListener) {
    this.log = cb;
  }

  /** P3 choreography — fires with the panel ids a voice reply references */
  onPanels(cb: PanelsListener) {
    this.onPanelsCb = cb;
  }

  /** fires when a reply references a vault document (reveal chip) */
  onDeliverable(cb: DeliverableListener) {
    this.onDeliverableCb = cb;
  }

  /** fires when a reply asks for a document to open ON SCREEN right now */
  onOpenDoc(cb: DeliverableListener) {
    this.onOpenDocCb = cb;
  }

  /** fires per sequenced callout as the voice reaches its sentence */
  onReveal(cb: RevealListener) {
    this.onRevealCb = cb;
  }

  /** fires when the wake word opens/closes a hands-free listening window */
  onListening(cb: ListeningListener) {
    this.listeningCb = cb;
  }

  speak(text: string, reveals?: Reveal[]) {
    const clean = sanitize(text);
    if (!clean || this.disabled) return;
    this.queue.push({ text: clean, reveals });
    if (!this.unlocked) {
      if (!this.announcedLocked) {
        this.announcedLocked = true;
        this.log("sys", "voice queued — click or key to enable audio");
      }
      return;
    }
    void this.drain();
  }

  /** kill the current utterance AND everything queued behind it */
  stop(): boolean {
    const wasTalking = this.playing || this.queue.length > 0;
    this.queue = [];
    this.clearReveals(false); // barge-in: pending callouts die with the speech
    this.currentStop?.();
    return wasTalking;
  }

  private scheduleReveals(reveals: Reveal[]) {
    for (const r of reveals) {
      const entry = {
        r,
        fired: false,
        id: setTimeout(() => {
          entry.fired = true;
          this.onRevealCb(r);
        }, (r.at / CHARS_PER_SEC) * 1000),
      };
      this.revealTimers.push(entry);
    }
  }

  /** flush=true (natural end): unfired reveals pop immediately rather than
   *  never — speech ran faster than the estimate */
  private clearReveals(flush: boolean) {
    for (const e of this.revealTimers) {
      clearTimeout(e.id);
      if (flush && !e.fired) this.onRevealCb(e.r);
    }
    this.revealTimers = [];
  }

  /** real speech envelope, 0..1 — null when no audio is playing */
  getLevel = (): number | null => {
    if (!this.playing || !this.analyser || !this.timeData) return null;
    this.analyser.getByteTimeDomainData(this.timeData);
    let sum = 0;
    for (let i = 0; i < this.timeData.length; i++) {
      const d = (this.timeData[i] - 128) / 128;
      sum += d * d;
    }
    const rms = Math.sqrt(sum / this.timeData.length);
    return Math.min(rms * 3.2, 1); // speech RMS ~0..0.3 → usable 0..1
  };

  /** begin PTT recording; resolves false if mic unavailable or voice offline */
  async startCapture(): Promise<boolean> {
    if (this.disabled) {
      this.log("err", "voice offline — can't listen without the TTS key");
      return false;
    }
    if (this.recorder) return true; // already capturing
    this.stop(); // barge-in: opening the mic shuts Jarvis up
    try {
      // keep the stream alive between captures — re-acquiring adds ~200ms
      if (!this.micStream) {
        this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
    } catch {
      this.log("err", "microphone access denied");
      return false;
    }
    this.chunks = [];
    this.recorder = new MediaRecorder(this.micStream);
    this.recorder.addEventListener("dataavailable", (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    });
    this.recorder.start();
    this.captureStart = performance.now();
    return true;
  }

  /** stop recording, ship the clip through STT → router, speak the reply */
  async finishCapture(): Promise<void> {
    const rec = this.recorder;
    if (!rec) return;
    this.recorder = null;
    const heldMs = performance.now() - this.captureStart;
    await new Promise<void>((res) => {
      rec.addEventListener("stop", () => res(), { once: true });
      rec.stop();
    });
    const blob = new Blob(this.chunks, { type: rec.mimeType || "audio/webm" });
    this.chunks = [];
    if (heldMs < 350 || blob.size < 1000) return; // accidental tap

    this.log("sys", "transcribing …");
    try {
      const res = await fetch("/api/voice", {
        method: "POST",
        headers: { "Content-Type": blob.type },
        body: blob,
      });
      await this.handleVoiceResponse(res);
    } catch (e) {
      this.log("err", `voice command failed: ${String(e).slice(0, 120)}`);
    }
  }

  /** shared tail of both voice paths (PTT clip + wake transcript) */
  private async handleVoiceResponse(res: Response): Promise<void> {
    if (res.status === 503) {
      this.disabled = true;
      this.log("err", "voice offline — TTS key missing");
      return;
    }
    if (!res.ok) {
      const j = await res.json().catch(() => ({ error: String(res.status) }));
      this.log("err", `voice command failed: ${String(j.error ?? res.status).slice(0, 120)}`);
      return;
    }
    const j = (await res.json()) as {
      transcript: string;
      tier: number;
      skill: string | null;
      queued: string | null;
      reply: string;
      panels?: string[];
      deliverable?: string | null;
      reveal?: string | null;
      reveals?: Reveal[];
    };
    if (j.transcript) this.log("sys", `you · ${j.transcript}`);
    if (j.queued && j.skill) this.log("sys", `intent queued → ${j.skill}`);
    if (Array.isArray(j.panels) && j.panels.length > 0) this.onPanelsCb(j.panels);
    const sequenced = Array.isArray(j.reveals) && j.reveals.length > 0;
    if (j.deliverable && j.reveal === "open") {
      // "bring up the html" — open the overlay now, no chip detour
      this.onOpenDocCb(j.deliverable, "document");
    } else if (j.deliverable && !sequenced) {
      // sequenced reveals already include the doc — don't double-pop it
      this.onDeliverableCb(j.deliverable, "morning report");
    }
    if (j.reply) {
      this.log("ok", `jarvis · ${j.reply}`);
      this.speak(j.reply, sequenced ? j.reveals : undefined);
    }
  }

  private ensureGraph() {
    if (this.ctx) return;
    this.ctx = new AudioContext();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.4;
    this.timeData = new Uint8Array(this.analyser.fftSize);
    this.analyser.connect(this.ctx.destination);

    // "sheen" chain — the Jarvis-in-the-suit timbre. Subtle: highpass strips
    // sub-rumble, presence peak lifts intelligibility, short convolution
    // reverb at low wet adds the helmet-metal air. Analyser sits after the
    // mix so the orb mouths what's actually heard.
    const hp = this.ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 90;
    const presence = this.ctx.createBiquadFilter();
    presence.type = "peaking";
    presence.frequency.value = 3200;
    presence.gain.value = 2.5;
    presence.Q.value = 0.8;
    const dry = this.ctx.createGain();
    dry.gain.value = 1.0;
    const conv = this.ctx.createConvolver();
    conv.buffer = makeImpulse(this.ctx, 0.18, 2.8);
    const wet = this.ctx.createGain();
    wet.gain.value = 0.12;

    hp.connect(presence);
    presence.connect(dry);
    dry.connect(this.analyser);
    presence.connect(conv);
    conv.connect(wet);
    wet.connect(this.analyser);
    this.input = hp;
  }

  private setSpeaking(on: boolean) {
    this.playing = on;
    this.speakingListeners.forEach((cb) => cb(on));
  }

  private async drain() {
    if (this.playing || this.queue.length === 0 || this.disabled) return;
    const utt = this.queue.shift()!;
    this.ensureGraph();
    this.setSpeaking(true);
    try {
      await this.playOne(utt);
    } catch (e) {
      // a dead utterance shouldn't kill the queue; 503 means key vanished
      const dead = await this.checkDisabled();
      if (dead) {
        this.queue = [];
        this.log("err", "voice offline — TTS unavailable");
      } else {
        this.log("err", `voice playback failed: ${String(e).slice(0, 120)}`);
      }
    }
    this.setSpeaking(false);
    void this.drain();
  }

  private playOne(utt: Utterance): Promise<void> {
    return new Promise((resolve, reject) => {
      const audio = new Audio(`/api/speak?text=${encodeURIComponent(utt.text)}`);
      audio.preload = "auto";
      const src = this.ctx!.createMediaElementSource(audio);
      src.connect(this.input ?? this.analyser!);
      const done = (flushReveals: boolean) => {
        this.clearReveals(flushReveals);
        this.currentStop = null;
        src.disconnect();
        resolve();
      };
      // stop() = barge-in / Escape — pause kills playback, resolve (not
      // reject) so drain treats it like a normal finish
      this.currentStop = () => {
        audio.pause();
        audio.removeAttribute("src");
        done(false);
      };
      // sequenced callouts start counting when sound actually starts
      if (utt.reveals && utt.reveals.length > 0) {
        audio.addEventListener("playing", () => this.scheduleReveals(utt.reveals!), { once: true });
      }
      audio.addEventListener("ended", () => done(true), { once: true });
      audio.addEventListener(
        "error",
        () => {
          this.clearReveals(false);
          this.currentStop = null;
          src.disconnect();
          reject(new Error("audio element error"));
        },
        { once: true }
      );
      audio.play().catch((e) => {
        this.clearReveals(false);
        this.currentStop = null;
        src.disconnect();
        reject(e);
      });
    });
  }

  private async checkDisabled(): Promise<boolean> {
    try {
      const res = await fetch("/api/speak", { cache: "no-store" });
      if (res.status === 503) {
        this.disabled = true;
        return true;
      }
    } catch {}
    return false;
  }
}

// short noise-burst impulse response — a tiny metallic room, decays fast
function makeImpulse(ctx: AudioContext, seconds: number, decay: number): AudioBuffer {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return buf;
}

// keep speech clean: markdown, urls, and code noise read terribly
function sanitize(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[*_`#>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800); // briefing replies run long; /api/speak caps at 900
}

export const voice = new VoiceClient();
