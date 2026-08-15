import fs from "fs";
import os from "os";
import path from "path";

// Vault root resolution, matching the agentic-os runner:
// 1. VAULT_ROOT / AGENTIC_OS_VAULT env var
// 2. AGENTIC_OS_VAULT in ~/.claude/.env
// 3. ~/the-vault (starter default)
export function resolveVaultRoot(): string {
  const env = process.env.VAULT_ROOT ?? process.env.AGENTIC_OS_VAULT;
  if (env) return env;
  try {
    const envFile = path.join(os.homedir(), ".claude", ".env");
    if (fs.existsSync(envFile)) {
      for (const raw of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
        const line = raw.trim();
        if (line.startsWith("AGENTIC_OS_VAULT=")) {
          const v = line.slice("AGENTIC_OS_VAULT=".length).trim().replace(/^["']|["']$/g, "");
          if (v) return v;
        }
      }
    }
  } catch {
    /* fall through */
  }
  return path.join(os.homedir(), "the-vault");
}
