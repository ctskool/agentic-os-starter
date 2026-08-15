#!/usr/bin/env bash
# run_all.sh — Mac/Linux wrapper (launchd/cron). Mirror of run_all.ps1.
# Runs all four metric-pull scripts in parallel, waits with a timeout,
# logs each result. Never exits nonzero — the scheduler should never see a failure.
set +e
ROOT="$HOME/.claude/skills/metrics-pull/scripts"
LOGDIR="$HOME/.claude/skills/metrics-pull/logs"
mkdir -p "$LOGDIR"
TS=$(date +"%Y-%m-%dT%H-%M-%S")
LOG="$LOGDIR/run-$TS.log"
echo "=== Metrics Pull run started at $TS ===" > "$LOG"
PIDS=()
for SRC in pull_claude_usage.py pull_youtube.py pull_instagram.py pull_tiktok.py; do
  ( python3 "$ROOT/$SRC" >> "$LOG" 2>&1 ) & PIDS+=($!)
done
# 90s timeout watchdog
( sleep 90; for P in "${PIDS[@]}"; do kill "$P" 2>/dev/null; done ) & WATCHDOG=$!
for P in "${PIDS[@]}"; do wait "$P"; done
kill "$WATCHDOG" 2>/dev/null
echo "=== run finished at $(date +"%Y-%m-%dT%H-%M-%S") ===" >> "$LOG"
exit 0
