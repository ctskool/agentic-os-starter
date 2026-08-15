# Agentic OS Starter

Chase AI's Obsidian command center — the exact setup, packaged so you can run it on **Mac or Windows**.

## Quick start (2 commands + 1 word)

```bash
git clone https://github.com/ctskool/agentic-os-starter.git && cd agentic-os-starter
claude
```

Then type **`/setup-agentic-os`** and hit enter. That's it — Claude takes it from there: checks your machine, installs everything, personalizes it to you, and verifies it all works. You need [Obsidian](https://obsidian.md) and [Claude Code](https://claude.com/claude-code) installed and logged in first; Claude handles (or walks you through) the rest.

---

What you get:

- **The Cockpit** — an Obsidian plugin (pre-built, no compile step) with live metric cards, radial arcs, a run feed, and one-click buttons that queue AI skill runs.
- **The Vault template** — the Karpathy 3-stage folder structure (`inbox → projects → content` + `wiki`), the frozen daily-note schema, Bases sidebar views, and the machine-readable `system/` plumbing the cockpit reads.
- **The Runner** — a zero-dependency Node daemon that watches `system/queue/`, spawns headless `claude -p` runs, and writes results + a heartbeat the cockpit displays.
- **The Skills** — the daily loop: `/today`, `/plan-today`, `/close-day`, `/plan-tomorrow`, `/morning-intel`, `/inbox-brief`, `/metrics-pull`, `/github-trending`, `/weekly-review`, `/vault-cleanup`, `/harvest` and more.
- **Voice mode (optional)** — the orb talks. Push-to-talk STT (faster-whisper) + spoken replies (Kokoro TTS), 100% local and free — no API keys. Two small servers: a Next voice-router on `:3107` and a Python TTS/STT server on `:3108`; the cockpit orb is the client.

```
Obsidian plugin (cockpit UI)
      │  writes intent JSON            reads metrics.csv, runs/, heartbeat
      ▼                                ▲
vault/system/queue/<uuid>.json ──► runner.js (daemon) ──► claude -p "<skill prompt>"
                                       │
                                       └─► vault/system/runs/<uuid>.json + deliverable notes
```

## Prerequisites

| Requirement | Why |
|---|---|
| [Obsidian](https://obsidian.md) | The cockpit lives in it |
| [Claude Code](https://claude.com/claude-code) (logged in) | Runs every skill; the runner shells `claude -p` |
| Node.js 20+ | The runner daemon (no npm installs needed) |
| Python 3.10+ | Metric pullers + a few skill scripts |

Optional (feature-by-feature): a YouTube Data API key (channel metrics + morning-intel YouTube scan), Instagram/TikTok handles (follower scrapes), Gmail/Calendar MCP connectors (morning intel + inbox triage).

## Install — the easy way (recommended)

Let Claude set you up. Clone, start Claude Code inside the repo, say the magic words:

```bash
git clone https://github.com/ctskool/agentic-os-starter.git && cd agentic-os-starter
claude
```

Then type **`/setup-agentic-os`**. Claude checks your prerequisites (and fixes what it can), runs the installer, interviews you for personalization (name, channel, handles), walks you through API keys and MCP auth, verifies every layer end-to-end, and hands you a working cockpit. If anything breaks later, run `/setup-agentic-os` again — it doubles as the doctor and skips straight to diagnosis.

## Install — manual

**Mac / Linux**: `bash install.sh` &nbsp;·&nbsp; **Windows**: `powershell -ExecutionPolicy Bypass -File .\install.ps1`

The installer asks where you want the vault, copies the template (never overwriting existing notes), installs the plugin + skills + runner, creates `~/.claude/.env` from the template, and offers to register autostart (launchd on Mac, Startup shortcut + Task Scheduler on Windows). Re-running it is safe. Both installers also take non-interactive flags (`--vault <path> --autostart yes` / `-Vault <path> -Autostart yes`).

Then finish with the 4 steps the installer prints — full walkthroughs in [docs/setup-mac.md](docs/setup-mac.md) and [docs/setup-windows.md](docs/setup-windows.md).

## Repo layout

```
install.sh / install.ps1   guided installers (idempotent)
.env.example               all secrets/config live in ~/.claude/.env — nothing hardcoded
plugin/                    pre-built Obsidian plugin (main.js + manifest + styles)
runner/                    runner.js + per-platform launchers (VBS / shell + launchd plist)
skills/                    global skills → ~/.claude/skills/
skills-vault/              vault-scoped skills → <vault>/.claude/skills/
vault-template/            folder skeleton, CLAUDE.md conventions, schemas, templates, Bases
voice/                     optional voice module: hud-server (:3107) + voice-server (:3108)
docs/                      per-platform setup + architecture notes
```

## How the pieces talk

1. You click a cockpit button in Obsidian → the plugin writes an intent JSON to `system/queue/`.
2. The runner (watching that folder) picks it up, builds the skill prompt, and spawns `claude -p` headless with your vault as the working directory.
3. The skill writes its deliverable into the vault (`inbox/reports/...`, daily notes, etc.) and the runner records the run in `system/runs/` — which the cockpit renders in its feed.
4. Independently, the metrics schedule (every 6h) appends to `system/metrics/metrics.csv`, which drives the cockpit's metric cards.

The daily-note format is a **frozen parser contract** (`system/schemas/daily-note.md`, v1). The plugin parses those exact headings — customize content, not section names.

## Customizing

- **Vault conventions** — read `vault-template/CLAUDE.md` (becomes your vault's `CLAUDE.md`). It's the source of truth Claude reads every session.
- **Which model background runs use** — `AGENTIC_OS_MODEL` in `~/.claude/.env` (default `sonnet`; keep it cheap).
- **Skills** — each is a folder with a `SKILL.md`. Edit prompts freely; they're markdown. Want to build your own? Every skill here is a working example — read one, copy its shape, and use Anthropic's `skill-creator` skill (`/skill-creator` in Claude Code) to scaffold and test new ones.
- **Metrics sources** — blank keys in `.env` are skipped gracefully; the cockpit shows per-source status instead of crashing.

## Troubleshooting

- **Cockpit shows "runner offline"** — the runner heartbeat (`system/runner-status.json`) is stale. Start it: Mac `bash ~/.claude/agentic-os-runner/start-runner.sh`, Windows double-click `start-runner.vbs`. Check `~/.claude/agentic-os-runner/runner.log`.
- **Buttons queue but nothing happens** — `claude` isn't on the runner's PATH, or you're not logged into Claude Code. Run `claude -p "say hi"` in a terminal to verify.
- **Metric cards empty** — run the pull manually (`run_all.sh` / `run_all.ps1`) and read the newest log in `~/.claude/skills/metrics-pull/logs/`.
- **Gmail/Calendar skills fail auth** — run `claude` inside the vault and `/mcp` to (re)authenticate connectors.
- **Orb says "voice offline"** — the voice servers aren't running. Check `curl http://127.0.0.1:3108/health` and `curl http://127.0.0.1:3107/api/speak`; logs at `voice/voice-server/voice-server.log` and `voice/hud-server/.next-dev.log`. Install/repair with `voice/install-voice.sh` (Mac) / `voice\install-voice.ps1` (Windows) — both are idempotent.

## Known limitations (v1)

Three cockpit buttons are wired to skills from Chase's extended stack that aren't included in this kit, because they depend on external infrastructure you'd have to build separately:

- **Cascade** (`content-cascade`) — needs a Supabase project + blog pipeline
- **Deep Research** (`deep-research-chase`) and **YT Pipeline** (`yt-pipeline`) — need NotebookLM auth + companion skills

Clicking them queues a run that will fail gracefully and show as failed in the run feed — nothing breaks, they just don't produce output. Everything else on the action bar (Metrics, Morning Intel, Plan Today, Plan Tomorrow, Inbox Brief, Weekly Review, Vault Cleanup) works out of the box.

## Voice mode notes

- Everything runs locally: Kokoro-82M (TTS) + faster-whisper (STT) + openwakeword. No accounts, no keys, ~350MB one-time model download (Whisper's model fetches itself on first use).
- **Push-to-talk is the default.** The wake word ("hey jarvis") ships off because speaker bleed makes hands-free talk over its own replies — set `WAKE_WORD=on` in `~/.claude/.env` if you use a headset.
- Voice settings live in `~/.claude/.env`: `KOKORO_VOICE` (default `bm_george`), `KOKORO_SPEED`, `WHISPER_MODEL` (drop to `tiny.en` on a slow CPU).
- GPU optional: whisper uses CUDA when available, otherwise CPU int8 — first spoken reply on CPU takes a couple seconds, then it warms up.
