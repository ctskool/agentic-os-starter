#!/usr/bin/env bash
# Agentic OS starter — Mac/Linux installer.
# Idempotent: safe to re-run. Never overwrites an existing vault note or your .env.
set -e
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Non-interactive flags (used by the /setup-agentic-os skill):
#   --vault <path>      vault folder (skips the prompt)
#   --autostart yes|no  install launchd agents without asking
#   --voice yes|no      install the voice module (Kokoro TTS + wake/PTT servers)
VAULT="" ; AUTOSTART="" ; VOICE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --vault) VAULT="$2"; shift 2 ;;
    --autostart) AUTOSTART="$2"; shift 2 ;;
    --voice) VOICE="$2"; shift 2 ;;
    *) shift ;;
  esac
done

echo ""
echo "=== Agentic OS installer (Mac/Linux) ==="
echo ""

# 1. Vault location
DEFAULT_VAULT="$HOME/the-vault"
if [ -z "$VAULT" ]; then
  read -r -p "Vault folder [$DEFAULT_VAULT]: " VAULT
  VAULT="${VAULT:-$DEFAULT_VAULT}"
fi
mkdir -p "$VAULT"

# 2. Vault template (copy without clobbering existing files)
echo "-> Copying vault template into $VAULT (existing files kept)"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --ignore-existing "$REPO/vault-template/" "$VAULT/"
else
  cp -Rn "$REPO/vault-template/." "$VAULT/" 2>/dev/null || true
fi

# 3. Obsidian plugin
PLUG="$VAULT/.obsidian/plugins/chase-command-center"
echo "-> Installing cockpit plugin to $PLUG"
mkdir -p "$PLUG"
cp -R "$REPO/plugin/chase-command-center/." "$PLUG/"

# 4. Skills
echo "-> Installing global skills to ~/.claude/skills"
mkdir -p "$HOME/.claude/skills"
cp -R "$REPO/skills/." "$HOME/.claude/skills/"
echo "-> Installing vault-level skills to $VAULT/.claude/skills"
mkdir -p "$VAULT/.claude/skills"
cp -R "$REPO/skills-vault/." "$VAULT/.claude/skills/"

# 5. Runner
RUNNER="$HOME/.claude/agentic-os-runner"
echo "-> Installing runner to $RUNNER"
mkdir -p "$RUNNER"
cp "$REPO/runner/runner.js" "$REPO/runner/package.json" "$REPO/runner/start-runner.sh" "$RUNNER/"
chmod +x "$RUNNER/start-runner.sh"

# 6. Env file (never overwrite)
ENVF="$HOME/.claude/.env"
if [ ! -f "$ENVF" ]; then
  echo "-> Creating $ENVF from template"
  cp "$REPO/.env.example" "$ENVF"
fi
# ensure AGENTIC_OS_VAULT is set
if grep -q "^AGENTIC_OS_VAULT=..*" "$ENVF"; then
  echo "-> AGENTIC_OS_VAULT already set in $ENVF (leaving as-is)"
else
  sed -i.bak "s|^AGENTIC_OS_VAULT=.*|AGENTIC_OS_VAULT=$VAULT|" "$ENVF" && rm -f "$ENVF.bak"
  echo "-> Set AGENTIC_OS_VAULT=$VAULT"
fi

# 7. launchd: runner at login + metrics pull every 6h
if [ -z "$AUTOSTART" ]; then
  read -r -p "Install launchd agents (runner at login + metrics every 6h)? [Y/n]: " YN
else
  YN=$([ "$AUTOSTART" = "yes" ] && echo Y || echo n)
fi
if [ "${YN:-Y}" != "n" ] && [ "${YN:-Y}" != "N" ]; then
  LA="$HOME/Library/LaunchAgents"
  mkdir -p "$LA"
  NODE_BIN="$(command -v node || echo /usr/local/bin/node)"
  sed -e "s|__HOME__|$HOME|g" -e "s|/usr/local/bin/node|$NODE_BIN|g" \
    "$REPO/runner/com.agentic-os.runner.plist" > "$LA/com.agentic-os.runner.plist"
  cat > "$LA/com.agentic-os.metrics.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.agentic-os.metrics</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$HOME/.claude/skills/metrics-pull/scripts/run_all.sh</string></array>
  <key>StartInterval</key><integer>21600</integer>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
PLIST
  launchctl unload "$LA/com.agentic-os.runner.plist" 2>/dev/null || true
  launchctl unload "$LA/com.agentic-os.metrics.plist" 2>/dev/null || true
  launchctl load "$LA/com.agentic-os.runner.plist"
  launchctl load "$LA/com.agentic-os.metrics.plist"
  echo "-> launchd agents installed and loaded"
fi

# 8. Voice module (optional — ~350MB model download)
if [ -z "$VOICE" ]; then
  read -r -p "Install voice mode (orb TTS/STT — local Kokoro + whisper, ~350MB download)? [y/N]: " VYN
else
  VYN=$([ "$VOICE" = "yes" ] && echo y || echo n)
fi
if [ "$VYN" = "y" ] || [ "$VYN" = "Y" ]; then
  bash "$REPO/voice/install-voice.sh" --autostart "${AUTOSTART:-yes}"
fi

echo ""
echo "=== Done. Next steps (see docs/setup-mac.md for detail) ==="
echo "1. Fill in API keys:        open ~/.claude/.env"
echo "2. Open the vault in Obsidian, then Settings > Community plugins >"
echo "   enable 'Chase Command Center'."
echo "3. Authenticate Claude Code MCP connectors (Gmail/Calendar): run"
echo "   'claude' inside the vault, then /mcp."
echo "4. Test: click a cockpit button, or run 'bash ~/.claude/skills/metrics-pull/scripts/run_all.sh'"
echo ""
