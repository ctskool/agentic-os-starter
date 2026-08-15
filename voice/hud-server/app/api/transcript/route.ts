import { NextResponse } from "next/server";
import { allExchanges, clearMemory } from "@/lib/voiceMemory";

// GET /api/transcript — the voice conversation so far, composed as markdown
// for the report overlay. Source = system/voice/memory.jsonl (last 40
// exchanges, survives restarts). Chronological: read top-to-bottom.

export const dynamic = "force-dynamic";

function hhmm(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

export async function GET() {
  const ex = allExchanges();
  const lines: string[] = ["# Voice Transcript", ""];
  if (ex.length === 0) {
    lines.push("*No exchanges yet — hold Space and say something.*");
  }
  let lastDay = "";
  for (const e of ex) {
    const day = e.ts.slice(0, 10);
    if (day !== lastDay) {
      lastDay = day;
      lines.push(`## ${day}`, "");
    }
    const skill = e.skill ? ` *(dispatched ${e.skill})*` : "";
    lines.push(`**${hhmm(e.ts)} — You:** ${e.you}`, "");
    lines.push(`**Jarvis:** ${e.jarvis}${skill}`, "");
  }
  return NextResponse.json({ path: "system/voice/transcript", content: lines.join("\n") });
}

// DELETE /api/transcript — wipe the conversation ring (also resets the
// router's short-term memory and any pending offer follow-through)
export async function DELETE() {
  clearMemory();
  return NextResponse.json({ ok: true });
}
