import fs from "fs";
import path from "path";
import { resolveVaultRoot } from "./vaultRoot";

// ---------------------------------------------------------------------------
// Conversational memory for the voice loop — a file-backed ring of recent
// exchanges so "make it shorter" / "what about the second one" has context.
// JSONL on disk (vault system/voice/memory.jsonl) instead of process RAM:
// survives Next dev restarts, readable for debugging, no dependency on the
// voice-server being up. Only exchanges from the active conversation window
// (default 10 min) are surfaced; the file itself is pruned to MAX_KEEP lines.
// ---------------------------------------------------------------------------

const VAULT_ROOT = resolveVaultRoot();
const MEMORY_FILE = path.join(VAULT_ROOT, "system", "voice", "memory.jsonl");

const MAX_KEEP = 40; // lines retained on disk
const WINDOW_MS = 10 * 60 * 1000; // "same conversation" horizon
const MAX_RECENT = 6; // exchanges surfaced to router/ask prompts

export interface Exchange {
  ts: string;
  you: string;
  jarvis: string;
  tier: number;
  skill?: string;
}

/** wipe the conversation ring — fresh demo takes, stale-context reset */
export function clearMemory(): void {
  try {
    fs.writeFileSync(MEMORY_FILE, "", "utf-8");
  } catch {
    /* best-effort, same as writes */
  }
}

export function rememberExchange(e: Omit<Exchange, "ts">): void {
  try {
    fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
    const lines = readLines();
    lines.push(JSON.stringify({ ts: new Date().toISOString(), ...e }));
    fs.writeFileSync(MEMORY_FILE, lines.slice(-MAX_KEEP).join("\n") + "\n", "utf-8");
  } catch {
    /* memory is best-effort — never break the voice loop over it */
  }
}

export function recentExchanges(maxN = MAX_RECENT): Exchange[] {
  try {
    const cutoff = Date.now() - WINDOW_MS;
    return readLines()
      .map((l) => {
        try {
          return JSON.parse(l) as Exchange;
        } catch {
          return null;
        }
      })
      .filter((e): e is Exchange => !!e && Date.parse(e.ts) > cutoff)
      .slice(-maxN);
  } catch {
    return [];
  }
}

/** everything on disk (up to MAX_KEEP), no conversation window — feeds the
 *  HUD transcript overlay, where older exchanges are the point */
export function allExchanges(): Exchange[] {
  try {
    return readLines()
      .map((l) => {
        try {
          return JSON.parse(l) as Exchange;
        } catch {
          return null;
        }
      })
      .filter((e): e is Exchange => e !== null);
  } catch {
    return [];
  }
}

/** compact transcript block for prompts — empty string when no live convo */
export function conversationContext(): string {
  const parts: string[] = [];
  const recent = recentExchanges();
  if (recent.length > 0) {
    parts.push(recent.map((e) => `Chase: ${e.you}\nJarvis: ${e.jarvis}`).join("\n"));
  }
  const runs = recentRunResults();
  if (runs.length > 0) {
    parts.push(`Background results recently delivered (these are what "that"/"it" may refer to):\n${runs.join("\n")}`);
  }
  const live = runningRuns();
  if (live.length > 0) {
    parts.push(
      `Still working in the background ("where's that X?" refers to these — they are IN PROGRESS, not lost):\n${live.join("\n")}`
    );
  }
  return parts.join("\n\n");
}

// in-flight runs — without these, "where are we at with that draft?" has
// nothing to anchor to and the router answers about something else entirely
function runningRuns(maxN = 3): string[] {
  try {
    const cutoff = Date.now() - RUN_WINDOW_MS;
    return fs
      .readdirSync(RUNS_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          const st = fs.statSync(path.join(RUNS_DIR, f));
          if (st.mtimeMs < cutoff) return null;
          const j = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, f), "utf-8")) as {
            skill?: string;
            status?: string;
            ts_started?: string | null;
            args?: { prompt?: string };
          };
          if (j.status !== "running") return null;
          return { mtime: st.mtimeMs, j };
        } catch {
          return null;
        }
      })
      .filter((x): x is { mtime: number; j: { skill?: string; ts_started?: string | null; args?: { prompt?: string } } } => x !== null)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, maxN)
      .map(({ j }) => {
        const mins = j.ts_started ? Math.round((Date.now() - Date.parse(j.ts_started)) / 60000) : null;
        const what = j.args?.prompt ? ` — "${j.args.prompt.slice(0, 90)}"` : "";
        return `[${j.skill}]${what} (running${mins !== null ? ` ${mins} min` : ""})`;
      });
  } catch {
    return [];
  }
}

// finished background runs are part of the conversation too — without them,
// "bring up the html for that" has no referent for "that"
const RUNS_DIR = path.join(VAULT_ROOT, "system", "runs");
const RUN_WINDOW_MS = 45 * 60 * 1000;

function recentRunResults(maxN = 3): string[] {
  try {
    const cutoff = Date.now() - RUN_WINDOW_MS;
    return fs
      .readdirSync(RUNS_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          const st = fs.statSync(path.join(RUNS_DIR, f));
          if (st.mtimeMs < cutoff) return null;
          const j = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, f), "utf-8")) as {
            skill?: string;
            status?: string;
            summary?: string;
            deliverable_path?: string | null;
            ts_completed?: string | null;
          };
          if (j.status !== "ok") return null;
          return { mtime: st.mtimeMs, j };
        } catch {
          return null;
        }
      })
      .filter((x): x is { mtime: number; j: { skill?: string; summary?: string; deliverable_path?: string | null } } => x !== null)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, maxN)
      .map(
        ({ j }) =>
          `[${j.skill}] ${(j.summary ?? "").slice(0, 140)}${j.deliverable_path ? ` (doc: ${j.deliverable_path})` : ""}`
      );
  } catch {
    return [];
  }
}

function readLines(): string[] {
  if (!fs.existsSync(MEMORY_FILE)) return [];
  return fs
    .readFileSync(MEMORY_FILE, "utf-8")
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);
}
