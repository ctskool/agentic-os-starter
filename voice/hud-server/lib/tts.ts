import { normalizeForSpeech } from "./spokenText";

// ---------------------------------------------------------------------------
// speak(text) → audio stream. The ONE place TTS vendors live.
// Engine: local Kokoro voice-server on :3108 (free, offline, no network lag).
// The ElevenLabs cloud fallback was removed 2026-06-12 — the stack is fully
// local; if a fallback ever returns, it slots back in behind this function
// without touching any caller.
// ---------------------------------------------------------------------------

const KOKORO_URL = "http://127.0.0.1:3108";

export class VoiceConfigError extends Error {}

export interface SpeechStream {
  stream: ReadableStream<Uint8Array>;
  mime: string;
  engine: "kokoro";
}

// health probe cached briefly so every utterance doesn't pre-flight
let kokoroAliveUntil = 0;
let kokoroAlive = false;

async function kokoroUp(): Promise<boolean> {
  const now = Date.now();
  if (now < kokoroAliveUntil) return kokoroAlive;
  try {
    const res = await fetch(`${KOKORO_URL}/health`, { signal: AbortSignal.timeout(400) });
    kokoroAlive = res.ok;
  } catch {
    kokoroAlive = false;
  }
  // re-check dead servers sooner than live ones
  kokoroAliveUntil = now + (kokoroAlive ? 30_000 : 5_000);
  return kokoroAlive;
}

export async function ttsStatus(): Promise<{ ok: boolean; engine: string | null }> {
  if (await kokoroUp()) return { ok: true, engine: "kokoro" };
  return { ok: false, engine: null };
}

export async function speak(text: string): Promise<SpeechStream> {
  text = normalizeForSpeech(text); // "$4,200" → "four thousand dollars"

  if (await kokoroUp()) {
    const res = await fetch(`${KOKORO_URL}/speak?text=${encodeURIComponent(text)}`);
    if (res.ok && res.body) {
      return { stream: res.body, mime: "audio/wav", engine: "kokoro" };
    }
    kokoroAliveUntil = 0; // generation failed mid-flight — drop the cache
    throw new Error(`kokoro ${res.status}`);
  }
  throw new VoiceConfigError(
    "no TTS engine: the voice-server on :3108 is down (voice-server\\start-voice-server.vbs)"
  );
}
