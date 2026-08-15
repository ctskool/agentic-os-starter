import fs from "fs";
import path from "path";
import { resolveVaultRoot } from "./vaultRoot";
import crypto from "crypto";

// ---------------------------------------------------------------------------
// Queue intent contract — shared by /api/queue (deck buttons) and /api/voice
// (spoken commands). ALLOWED_SKILLS must match runner.js buildPrompt() cases.
// ---------------------------------------------------------------------------

const VAULT_ROOT = resolveVaultRoot();

export const ALLOWED_SKILLS = new Set([
  "metrics-pull",
  "morning-report",
  "inbox-brief",
  "github-trending",
  "ai-trend-scan",
  "vault-cleanup",
  "yt-week-review",
  "plan-today",
  "plan-tomorrow",
  "weekly-review",
  "morning-intel", // 2026-08 stack: morning brief on steroids
  "outlier-radar", // 2026-08 stack: small-channel outlier scan
  "lead-research", // 2026-08 stack: lead briefings from the site's Supabase
  "voice-ask", // tier-3 open-ended asks → headless claude -p via runner
]);

export function writeIntent(
  skill: string,
  source: string,
  args: Record<string, unknown> = {}
): string {
  const id = crypto.randomUUID();
  const intent = { id, skill, args, ts: new Date().toISOString(), source };
  const queueDir = path.join(VAULT_ROOT, "system", "queue");
  fs.mkdirSync(queueDir, { recursive: true });
  fs.writeFileSync(path.join(queueDir, `${id}.json`), JSON.stringify(intent, null, 2), "utf-8");
  return id;
}
