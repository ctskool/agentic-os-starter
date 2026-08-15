import { NextResponse } from "next/server";
import { speak, ttsStatus, VoiceConfigError } from "@/lib/tts";

// ---------------------------------------------------------------------------
// GET /api/speak?text=...  → audio/mpeg stream (used as <audio src> so the
//   browser starts playback before the file finishes — Flash v2.5 first
//   byte lands in ~75ms).
// GET /api/speak           → config probe: 200 {ok:true} | 503 {ok:false}
// POST {text}              → same stream, for callers that outgrow URLs.
// P1 note: lives as a Next route per the handoff exception (announce-only,
// nothing persistent). Moves into voice-server in P2.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

const MAX_CHARS = 900;

async function stream(text: string): Promise<Response> {
  const trimmed = text.trim().slice(0, MAX_CHARS);
  if (!trimmed) return NextResponse.json({ error: "empty text" }, { status: 400 });
  try {
    const out = await speak(trimmed);
    return new Response(out.stream, {
      headers: {
        "Content-Type": out.mime,
        "Cache-Control": "no-store",
        "X-Voice-Engine": out.engine,
      },
    });
  } catch (e) {
    if (e instanceof VoiceConfigError) {
      return NextResponse.json({ ok: false, error: e.message }, { status: 503 });
    }
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}

export async function GET(req: Request) {
  const text = new URL(req.url).searchParams.get("text");
  if (text === null) {
    // probe — lets the client find out which engine (if any) is live
    const status = await ttsStatus();
    return status.ok
      ? NextResponse.json(status)
      : NextResponse.json({ ok: false, error: "no TTS engine available" }, { status: 503 });
  }
  return stream(text);
}

export async function POST(req: Request) {
  let body: { text?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  return stream(String(body.text ?? ""));
}
