#!/usr/bin/env bash
# start-runner.sh — (re)launches the Agentic OS Runner on Mac/Linux.
# Kills the previous instance (pid from runner.pid) so a relaunch picks up
# runner.js edits, then starts a fresh detached instance.
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIDFILE="$DIR/runner.pid"
if [ -f "$PIDFILE" ]; then
  PID=$(cat "$PIDFILE" 2>/dev/null)
  [ -n "$PID" ] && kill "$PID" 2>/dev/null
  rm -f "$PIDFILE"
  sleep 1
fi
nohup node "$DIR/runner.js" >> "$DIR/runner.log" 2>&1 &
echo "runner started (pid $!)"
