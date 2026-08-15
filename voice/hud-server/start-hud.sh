#!/usr/bin/env bash
# start-hud.sh — launches the HUD/voice-router Next server on :3107 (Mac/Linux).
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"
nohup npx next dev -p 3107 >> .next-dev.log 2>&1 &
echo "hud server started on :3107 (pid $!)"
