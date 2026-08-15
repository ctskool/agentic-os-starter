---
name: setup-agentic-os
description: Guided install + personalization + health check for the Agentic OS command center. Use when the user says /setup-agentic-os, "set me up", "install this", "get me started", asks for help installing or configuring the starter kit, or reports something broken after install (runner offline, empty metrics, cockpit not updating) — this skill doubles as the doctor.
---

# Setup Agentic OS

You are the installer, personalizer, and doctor for the Agentic OS starter kit. The user just cloned this repo (you are running inside it). Your job: get them from clone → fully working cockpit with as little typing on their part as possible. Be warm, keep momentum, never dump all questions at once.

**Mode detection first:** if `~/.claude/agentic-os-runner/runner.js` already exists, this is a RE-RUN — skip to Phase 5 (verify) and fix only what's broken. Otherwise run all phases in order.

## Phase 0 — Platform + prerequisites

Detect the platform (`uname` / `$env:OS`). Then check each prerequisite and FIX what you can rather than reporting failures:

| Check | Command | If missing |
|---|---|---|
| Node 20+ | `node --version` | Mac: `brew install node`. Windows: direct them to nodejs.org (needs GUI installer), then re-check. |
| Python 3.10+ | `python3 --version` (Mac) / `python --version` (Win) | Mac: `brew install python`. Windows: python.org — remind them to tick "Add to PATH". |
| Claude Code logged in | you are running — it works | — |
| Obsidian | Mac: `/Applications/Obsidian.app`; Win: `%LOCALAPPDATA%\Obsidian` | Point to obsidian.md/download; setup can continue without it, flag for later. |

Don't block on Obsidian; do block on Node and Python (offer to wait while they install).

## Phase 1 — One question: where does the vault live?

Ask ONE question: "Where do you want your vault? Press enter for `~/the-vault`, or give me a path (an existing Obsidian vault works too — nothing gets overwritten)."

Then run the installer non-interactively from the repo root:

- Mac/Linux: `bash install.sh --vault "<path>" --autostart yes`
- Windows: `powershell -ExecutionPolicy Bypass -File install.ps1 -Vault "<path>" -Autostart yes`

Read the output. If any step failed, fix it directly (create the missing directory, correct permissions, etc.) and re-run — the installer is idempotent.

## Phase 2 — Personalize

Interview conversationally, one topic at a time. Everything is optional — "skip" is always a valid answer and nothing crashes when blank.

1. **Name + email** → update `<vault>/.claude/skills/inbox-brief/config.json` (`fromName`, `email`) and replace placeholder identity in `<vault>/CLAUDE.md` if present.
2. **YouTube** — ask if they have a channel. If yes: walk them through creating a YouTube Data API v3 key (console.cloud.google.com/apis/credentials → create project → enable YouTube Data API v3 → create API key) and finding their channel ID (youtube.com/account_advanced).
3. **Instagram / TikTok handles** — public handles, no @.

For secrets (the API key): do NOT ask them to paste it into chat. Open `~/.claude/.env` in their editor (`open -e` / `notepad`), tell them exactly which lines to fill, and wait for them to say done. Then read the file yourself ONLY to check which keys are non-empty (never print values back).

Non-secret values (handles, channel ID, name, email) you may take in chat and write into `.env` / config files yourself.

## Phase 3 — MCP connectors (optional but recommended)

Gmail + Google Calendar power `/inbox-brief`, `/today`, and `/morning-intel` triage. You cannot run the OAuth flow for them. Tell them: run `/mcp` right here in this session (or in a new `claude` session inside the vault) and connect **Gmail** and **Google Calendar**. Offer to continue without it — the skills degrade gracefully.

## Phase 3.5 — Voice mode (optional, the fun one)

Ask: "Want voice mode? The orb in your cockpit can listen (push-to-talk) and talk back — all local, free (Kokoro TTS + whisper STT), no API keys. It's a ~350MB one-time model download."

If yes, run from the repo root:

- Mac/Linux: `bash voice/install-voice.sh --autostart yes`
- Windows: `powershell -ExecutionPolicy Bypass -File voice\install-voice.ps1 -Autostart yes`

Watch for the usual failure points and fix them: `npm install` needs network; the Python venv needs python3.10+; `sounddevice` needs PortAudio on Mac (`brew install portaudio` then re-run pip). GPU is optional — whisper falls back to CPU int8 automatically.

Verify after install:
1. `curl -s "http://127.0.0.1:3108/health"` → `{"ok": true, ...}` (voice server)
2. `curl -s "http://127.0.0.1:3107/api/speak"` → 200 with `{"engine": "kokoro"}` (HUD router — give `next dev` ~20s to boot first)
3. TTS smoke test: hit `http://127.0.0.1:3108/speak?text=voice online` and play the WAV.
4. Tell them: in Obsidian → plugin settings → enable the orb; first push-to-talk will trigger the OS microphone permission prompt — allow it. First STT call is slow (whisper downloads its model once).

Wake word ("hey jarvis") ships OFF by default — speaker bleed into the mic makes hands-free talk over its own replies. Push-to-talk is the recommended mode; `WAKE_WORD=on` in `~/.claude/.env` re-arms it for headset users.

If they said no: mention they can add it any time by running this skill again or `voice/install-voice.*` directly.

## Phase 4 — Obsidian handoff

The two clicks you can't do for them:

1. Obsidian → Open folder as vault → their vault path.
2. Settings → Community plugins → (disable Restricted mode) → enable **Chase Command Center**.

Ask them to tell you when the cockpit sidebar is visible.

## Phase 5 — Verify everything (also the doctor entry point)

Run each check; on failure apply the matching fix, then re-check:

| Check | Pass condition | Fix if failing |
|---|---|---|
| Runner heartbeat | `<vault>/system/runner-status.json` `ts` < 60s old | Start it: Mac `bash ~/.claude/agentic-os-runner/start-runner.sh`; Win `wscript ~/.claude/agentic-os-runner/start-runner.vbs`. Then read `~/.claude/agentic-os-runner/runner.log` for the real error (usually: `claude` not on PATH, or AGENTIC_OS_VAULT wrong in `~/.claude/.env`). |
| Claude headless | `claude -p "reply with exactly: ok" --model haiku` returns ok | They're not logged in → `claude` interactive login. |
| Metrics pull | run `run_all.sh` / `run_all.ps1`, then new rows in `<vault>/system/metrics/metrics.csv` | Read newest log in `~/.claude/skills/metrics-pull/logs/`. Blank keys are fine (source shows `skipped`) — only investigate `error` rows. |
| Queue round-trip | Write `{"id":"<uuid>","skill":"noop","ts":"<iso>"}` to `system/queue/` — runner should consume the file and log an unknown-skill result within ~15s | If the file sits there: runner not watching the right vault — check AGENTIC_OS_VAULT vs actual vault path. |
| Plugin reads vault | User confirms metric cards render (may say "no data" until first pull — that's fine) | Plugin settings → vault system path must point at `system/`. |
| Voice (if installed) | `:3108/health` ok AND `:3107/api/speak` returns engine kokoro | Read `voice/voice-server/voice-server.log` and `voice/hud-server/.next-dev.log`. Common: models not downloaded (re-run `download_models.py`), port already in use, mic permission denied (OS settings). |

## Phase 6 — Done + orientation

Give them a short, personal wrap-up:

- What's now running on autopilot: runner at login, metrics every 6h.
- Heads-up: three cockpit buttons (Cascade, Deep Research, YT Pipeline) are wired to Chase's extended stack (Supabase, NotebookLM) and aren't included in v1 — clicking them shows a failed run, nothing breaks. All the daily-loop buttons work.
- Their first three commands to try: `/today` (creates the daily note), `/plan-today`, and clicking a cockpit button.
- Where things live: deliverables in `inbox/reports/`, conventions in `CLAUDE.md`, every skill is editable markdown in `~/.claude/skills/` — "read one, tweak one, that's how you make it yours."
- If anything breaks later: run `/setup-agentic-os` again — it skips straight to diagnosis.

## Rules

- Never print secret values. Never ask for secrets in chat.
- Never overwrite existing vault notes or an existing `.env` — the installer already guarantees this; keep the guarantee in your manual fixes too.
- One question at a time. Prefer doing over asking: if a fix is safe and reversible, just do it and say what you did.
- If something fails twice with the same error, stop looping — show the user the exact error and your best manual workaround.
