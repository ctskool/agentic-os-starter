import fs from "fs";
import path from "path";
import os from "os";

// ---------------------------------------------------------------------------
// ~/.claude/.env loader — the one place keys live (same pattern metrics-pull
// uses). Loaded once per server process; process.env wins over the file.
// ---------------------------------------------------------------------------

let loaded = false;

export function loadHomeEnv() {
  if (loaded) return;
  loaded = true;
  const file = path.join(os.homedir(), ".claude", ".env");
  try {
    for (const line of fs.readFileSync(file, "utf-8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    // no home env file — process.env may still have the keys
  }
}

export function homeEnv(name: string): string | undefined {
  loadHomeEnv();
  return process.env[name];
}
