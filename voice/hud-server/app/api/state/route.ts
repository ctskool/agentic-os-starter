import { NextResponse } from "next/server";
import { readVaultState } from "@/lib/vault";

export const dynamic = "force-dynamic";

export async function GET() {
  const state = readVaultState();
  return NextResponse.json(state, {
    headers: { "Cache-Control": "no-store" },
  });
}
