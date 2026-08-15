import { NextResponse } from "next/server";
import { readVaultMarkdown } from "@/lib/vault";

// GET /api/report?path=inbox/... — serve a vault markdown deliverable to the
// HUD overlay. readVaultMarkdown enforces .md-only under inbox/ or
// system/runs/, no traversal.

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const path = new URL(req.url).searchParams.get("path") ?? "";
  if (!path) return NextResponse.json({ error: "path required" }, { status: 400 });
  const content = readVaultMarkdown(path);
  if (content === null) {
    return NextResponse.json({ error: "not found or not readable" }, { status: 404 });
  }
  return NextResponse.json({ path, content });
}
