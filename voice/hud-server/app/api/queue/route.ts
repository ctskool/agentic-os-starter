import { NextResponse } from "next/server";
import { ALLOWED_SKILLS, writeIntent } from "@/lib/skills";

// ---------------------------------------------------------------------------
// POST /api/queue {skill} — drops an intent JSON into system/queue/.
// Same contract the Chase Command Center plugin uses; the runner daemon
// picks it up. This is the "buttons are real" part. Skill list + intent
// shape live in lib/skills.ts (shared with /api/voice).
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: { skill?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const skill = String(body.skill ?? "");
  if (!ALLOWED_SKILLS.has(skill)) {
    return NextResponse.json({ error: `unknown skill: ${skill}` }, { status: 400 });
  }

  try {
    const id = writeIntent(skill, "vault-hud");
    return NextResponse.json({ ok: true, id, skill });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
