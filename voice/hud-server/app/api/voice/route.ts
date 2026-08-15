import { NextResponse } from "next/server";
import { transcribe } from "@/lib/stt";
import { dispatchTranscript } from "@/lib/voiceDispatch";
import { VoiceConfigError } from "@/lib/tts";

// ---------------------------------------------------------------------------
// POST /api/voice — raw audio body (PTT clip) → STT → shared dispatch
// (lib/voiceDispatch.ts: router → maybe queue write → convo memory) → JSON
// {transcript, tier, skill, reply}. Client speaks `reply` through /api/speak.
// Wake-word transcripts skip STT and enter via /api/voice/text instead.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

const MAX_BYTES = 8 * 1024 * 1024; // ~8MB ≈ well over a minute of opus

export async function POST(req: Request) {
  let audio: Buffer;
  try {
    audio = Buffer.from(await req.arrayBuffer());
  } catch {
    return NextResponse.json({ error: "bad body" }, { status: 400 });
  }
  if (audio.length < 1000) {
    return NextResponse.json({ error: "clip too short" }, { status: 400 });
  }
  if (audio.length > MAX_BYTES) {
    return NextResponse.json({ error: "clip too long" }, { status: 413 });
  }

  const mime = req.headers.get("content-type") || "audio/webm";

  try {
    const transcript = await transcribe(audio, mime);
    if (!transcript) {
      return NextResponse.json({
        transcript: "",
        tier: 3,
        reply: "I didn't catch that.",
      });
    }

    return NextResponse.json(await dispatchTranscript(transcript, "voice-ptt"));
  } catch (e) {
    if (e instanceof VoiceConfigError) {
      return NextResponse.json({ ok: false, error: e.message }, { status: 503 });
    }
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
