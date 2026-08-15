#!/usr/bin/env bash
# Voice module installer — Mac/Linux. Idempotent.
# Installs the HUD/voice-router server (:3107) + Kokoro/whisper voice server
# (:3108), downloads models (~350MB), and optionally registers launchd agents.
# Flags: --autostart yes|no  (skips the prompt)
set -e
VDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUTOSTART=""
while [ $# -gt 0 ]; do
  case "$1" in
    --autostart) AUTOSTART="$2"; shift 2 ;;
    *) shift ;;
  esac
done

echo ""
echo "=== Voice module installer (Mac/Linux) ==="
echo ""

# 1. HUD server deps
echo "-> npm install (HUD server)"
(cd "$VDIR/hud-server" && npm install --no-audit --no-fund)

# 2. Python venv + deps
echo "-> Python venv + deps (voice server)"
cd "$VDIR/voice-server"
[ -d .venv ] || python3 -m venv .venv
./.venv/bin/pip install -q --upgrade pip
./.venv/bin/pip install -q -r requirements.txt

# 3. Models (~350MB, idempotent)
echo "-> Downloading voice models"
./.venv/bin/python download_models.py

# 4. launchd agents
if [ -z "$AUTOSTART" ]; then
  read -r -p "Start voice servers at login (launchd)? [Y/n]: " YN
else
  YN=$([ "$AUTOSTART" = "yes" ] && echo Y || echo n)
fi
if [ "${YN:-Y}" != "n" ] && [ "${YN:-Y}" != "N" ]; then
  LA="$HOME/Library/LaunchAgents"
  mkdir -p "$LA"
  NPX_BIN="$(command -v npx || echo /usr/local/bin/npx)"
  cat > "$LA/com.agentic-os.hud.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.agentic-os.hud</string>
  <key>ProgramArguments</key>
  <array><string>$NPX_BIN</string><string>next</string><string>dev</string><string>-p</string><string>3107</string></array>
  <key>WorkingDirectory</key><string>$VDIR/hud-server</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$VDIR/hud-server/.next-dev.log</string>
  <key>StandardErrorPath</key><string>$VDIR/hud-server/.next-dev.log</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string></dict>
</dict>
</plist>
PLIST
  cat > "$LA/com.agentic-os.voice.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.agentic-os.voice</string>
  <key>ProgramArguments</key>
  <array><string>$VDIR/voice-server/.venv/bin/python</string><string>-u</string><string>$VDIR/voice-server/server.py</string></array>
  <key>WorkingDirectory</key><string>$VDIR/voice-server</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$VDIR/voice-server/voice-server.log</string>
  <key>StandardErrorPath</key><string>$VDIR/voice-server/voice-server.log</string>
  <key>EnvironmentVariables</key>
  <dict><key>WAKE_WORD</key><string>off</string></dict>
</dict>
</plist>
PLIST
  launchctl unload "$LA/com.agentic-os.hud.plist" 2>/dev/null || true
  launchctl unload "$LA/com.agentic-os.voice.plist" 2>/dev/null || true
  launchctl load "$LA/com.agentic-os.hud.plist"
  launchctl load "$LA/com.agentic-os.voice.plist"
  echo "-> launchd agents installed and loaded"
else
  echo "-> Start manually: bash $VDIR/voice-server/start-voice-server.sh && bash $VDIR/hud-server/start-hud.sh"
fi

echo ""
echo "=== Voice module done ==="
echo "Test TTS:  curl -s 'http://127.0.0.1:3108/speak?text=voice+online' -o /tmp/t.wav && afplay /tmp/t.wav"
echo "Then in Obsidian: plugin settings -> enable the orb. First reply may be slow while whisper downloads its model."
echo "macOS will ask for microphone permission on first push-to-talk — allow it."
echo ""
