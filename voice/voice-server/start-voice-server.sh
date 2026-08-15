#!/usr/bin/env bash
# start-voice-server.sh — launches the Kokoro TTS + whisper STT server on :3108 (Mac/Linux).
# Wake word defaults off (speaker bleed makes hands-free overlap replies —
# push-to-talk is the recommended mode). Set WAKE_WORD=on to re-arm.
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"
export WAKE_WORD="${WAKE_WORD:-off}"
nohup "$DIR/.venv/bin/python" -u server.py >> voice-server.log 2>&1 &
echo "voice server started on :3108 (pid $!)"
