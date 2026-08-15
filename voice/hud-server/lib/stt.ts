import { VoiceConfigError } from "./tts";

// ---------------------------------------------------------------------------
// transcribe(audio) → text. The ONE place STT vendors live — mirrors the
// speak() rule in lib/tts.ts. Engine: local faster-whisper in the
// voice-server on :3108 (GPU, ~100ms, no network). The ElevenLabs Scribe
// cloud fallback was removed 2026-06-12 alongside the TTS one.
// ---------------------------------------------------------------------------

const LOCAL_URL = "http://127.0.0.1:3108";

// health probe cached briefly so every utterance doesn't pre-flight —
// separate from tts.ts's probe because stt readiness is its own flag
let localAliveUntil = 0;
let localAlive = false;

async function localSttUp(): Promise<boolean> {
  const now = Date.now();
  if (now < localAliveUntil) return localAlive;
  try {
    const res = await fetch(`${LOCAL_URL}/health`, { signal: AbortSignal.timeout(400) });
    const j = res.ok ? ((await res.json()) as { stt?: { ok?: boolean } }) : null;
    localAlive = Boolean(j?.stt?.ok);
  } catch {
    localAlive = false;
  }
  // re-check dead servers sooner than live ones
  localAliveUntil = now + (localAlive ? 30_000 : 5_000);
  return localAlive;
}

export async function transcribe(audio: Buffer, mime: string): Promise<string> {
  if (!(await localSttUp())) {
    throw new VoiceConfigError(
      "no STT engine: the voice-server stt on :3108 is down (voice-server\\start-voice-server.vbs)"
    );
  }
  try {
    const res = await fetch(`${LOCAL_URL}/stt`, {
      method: "POST",
      headers: { "Content-Type": mime || "audio/webm" },
      body: new Uint8Array(audio),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`local stt ${res.status}`);
    const json = (await res.json()) as { text?: string };
    return (json.text ?? "").trim();
  } catch (e) {
    localAliveUntil = 0; // failed mid-flight — drop the cache
    throw e;
  }
}
