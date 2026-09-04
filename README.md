<div align="center">

<pre>
  █████╗  ██████╗ ███████╗███╗   ██╗████████╗██╗ ██████╗      ██████╗ ███████╗
 ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝██║██╔════╝     ██╔═══██╗██╔════╝
 ███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║   ██║██║          ██║   ██║███████╗
 ██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║   ██║██║          ██║   ██║╚════██║
 ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║   ██║╚██████╗     ╚██████╔╝███████║
 ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝   ╚═╝ ╚═════╝      ╚═════╝ ╚══════╝
</pre>

**Claude Code × Obsidian, packaged as a command center.**
A cockpit, a runner, a skill fleet, and a fully local voice — installed with one word.

[![Install](https://img.shields.io/badge/install-%2Fsetup--agentic--os-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](#quick-start)
[![Windows](https://img.shields.io/badge/Windows-verified-0078D4?style=for-the-badge&logo=windows11&logoColor=white)](docs/setup-windows.md)
[![macOS](https://img.shields.io/badge/macOS-supported-000000?style=for-the-badge&logo=apple&logoColor=white)](docs/setup-mac.md)
[![Obsidian](https://img.shields.io/badge/Obsidian-plugin-7C3AED?style=for-the-badge&logo=obsidian&logoColor=white)](#what-you-get)
[![Voice](https://img.shields.io/badge/voice-100%25%20local-2EA043?style=for-the-badge&logo=audiomack&logoColor=white)](#voice-mode)

<br/>

<img src="docs/assets/cockpit.png" alt="The cockpit inside Obsidian: metric cards, one-click skill runs, today's schedule, morning headlines, the activity feed, and the voice orb" width="100%"/>

<sub>The cockpit, live inside Obsidian. Every card is the output of a skill you can read and edit.</sub>

</div>

<br/>

## Quick start

```bash
git clone https://github.com/ctskool/agentic-os-starter.git && cd agentic-os-starter
claude
```

Then type **`/setup-agentic-os`** and hit enter.

Claude takes it from there: checks your machine, runs the installer for your platform, personalizes it to you, walks you through API keys and MCP auth without ever seeing a secret, verifies every layer end to end, and hands you a working cockpit. Pointing it at an **existing Obsidian vault is fine**, nothing you already have gets overwritten. If anything breaks later, run `/setup-agentic-os` again: it doubles as the doctor and skips straight to diagnosis.

You need [Obsidian](https://obsidian.md) and [Claude Code](https://claude.com/claude-code) installed and logged in first. Claude handles, or walks you through, the rest.

<br/>

## What you get

| | | |
|:--|:--|:--|
| 🛸 **The Cockpit** | A pre-built Obsidian plugin, no compile step. Live metric cards, radial arcs, today's schedule and Top 3, a run feed, and one-click buttons that queue AI skill runs. | `plugin/` |
| 🗂️ **The Vault template** | The Karpathy 3-stage structure (`inbox → projects → content` + `wiki`), the frozen daily-note schema, Bases sidebar views, and the machine-readable `system/` plumbing the cockpit reads. | `vault-template/` |
| ⚙️ **The Runner** | A zero-dependency Node daemon. Watches `system/queue/`, spawns headless `claude -p` runs three at a time, writes results and a heartbeat the cockpit displays. Background runs pin to Sonnet so your default model never burns on automations. | `runner/` |
| 🧰 **The Skills** | The daily loop, as editable markdown: `/today`, `/plan-today`, `/close-day`, `/plan-tomorrow`, `/morning-intel`, `/inbox-brief`, `/metrics-pull`, `/github-trending`, `/weekly-review`, `/vault-cleanup`, `/harvest`. | `skills/` `skills-vault/` |
| 🎙️ **Voice mode** *(optional)* | The orb talks. Push-to-talk STT (faster-whisper) and spoken replies (Kokoro TTS), 100% local and free, no API keys. Works from any app with a global hotkey while Obsidian sits minimized. | `voice/` |

<br/>

## How the pieces talk

Files are the message bus. Nothing here needs a database or a server you have to babysit.

```mermaid
flowchart LR
    subgraph Obsidian
        UI[Cockpit plugin]
        ORB((Voice orb))
    end
    subgraph Vault["Your vault (plain files)"]
        Q[/system/queue/*.json/]
        R[/system/runs/*.json/]
        M[/system/metrics/metrics.csv/]
        D[/daily-notes/ + inbox/reports/]
    end
    RUN[runner.js daemon]
    CC["claude -p (headless)"]

    UI -- click a button --> Q
    ORB -- "&quot;run morning intel&quot;" --> Q
    Q --> RUN
    RUN -- spawns --> CC
    CC -- writes deliverables --> D
    RUN -- run record + heartbeat --> R
    R --> UI
    M --> UI
    D --> UI
    D -. read aloud .-> ORB
```

1. You click a cockpit button, or say the skill's name to the orb. The plugin writes an intent JSON to `system/queue/`.
2. The runner picks it up, builds the skill prompt, and spawns `claude -p` headless with your vault as the working directory.
3. The skill writes its deliverable into the vault. The runner records the run in `system/runs/`, which the cockpit renders in its feed and the orb announces.
4. Independently, a scheduled metrics pull appends to `system/metrics/metrics.csv` every 6 hours, which drives the metric cards.

The daily-note format is a **frozen parser contract** (`system/schemas/daily-note.md`, v1). The plugin parses those exact headings. Customize content, not section names.

<br/>

## Voice mode

<div align="center">
<img src="docs/assets/voice-architecture.png" alt="Voice system under the hood: orb in Obsidian, HUD server on 3107 with the three-tier router, voice server on 3108 with Whisper STT and Kokoro TTS, all local" width="100%"/>
</div>

### What happens when you talk to it

1. **You speak.** Click the orb in Obsidian, or press **`Ctrl+Alt+J`** from any app with Obsidian minimized. Recording stops after 1.6s of silence.
2. **Local Whisper turns it into text.** On your GPU if you have one, CPU if not. Nothing leaves the machine.
3. **The router decides which of three tiers the ask belongs to.** Exact phrases match rules in ~15ms. Loose phrasing goes to Haiku, which takes about a second and a half and lands on the same fixed set of actions. The model can pick an action from the list; it can never invent one.
4. **The tier does its job**, and **Kokoro speaks the result.** UI actions reply silently, because the thing happening is the confirmation. Every state change plays a short earcon.

### The three tiers, with examples

| Tier | You say | What actually happens | Wait |
|:--|:--|:--|:--|
| **1 · Dispatch** | "Run the intel brief" · "pull metrics" · "outlier radar" | Writes one intent JSON to `system/queue/`. The runner does the work in the background. The orb says "on it" and tells you when it lands. | instant |
| **2 · Answer** | "What's the biggest thing on my schedule today?" · "What was the top AI story?" · "Any new outliers?" · "How's the channel doing?" | Reads the answer out of files that already exist: today's daily note, the latest morning-intel brief, `metrics.csv`, the outlier radar. **No search, no research, no new Claude run.** | ~1s |
| **3 · Delegate** | "**Go research** what changed in Claude Code this week and draft a summary" · "**Go plan** the launch email" | The only tier that spends real model time. Spawns a headless `claude -p` through the runner, keeps working while you work, then speaks the first line of the result and drops the deliverable in the vault. Fires only when you explicitly hand something off. | minutes |

### Why tier 2 is fast

The voice layer is a **read head over work that already ran**, not a voice-controlled Claude Code.

Every morning the skills do the heavy lifting: `/morning-intel` scans the news, `/plan-today` writes the schedule and Top 3, `/metrics-pull` refreshes the numbers, `/inbox-brief` triages email. Each one leaves a file in the vault. The router keeps a small **snapshot** of those files: the Top 3, today's schedule, the four metric cards, the intel brief's top stories, the inbox triage, the latest outliers, and the last few runs.

When you ask a question, tier 2 answers from that snapshot. It never opens a browser, never calls a search API, never starts a fresh model session. That is the whole trick: the expensive thinking happened once, on a schedule, and the voice just reads it back.

A concrete number: "what's in my inbox" used to route to tier 3 and take **43 seconds**, because it spun up a Claude run that re-read Gmail. Moving the inbox triage into the snapshot made the same question a tier-2 answer at **about 1.5 seconds**. Same answer, thirty times faster, zero tokens.

The rule the router follows: **if the answer already exists in the vault, read it. If it doesn't, ask before doing anything expensive.** Tier 3 fires only on explicit delegation ("go research", "go draft", "go plan") or when you say yes to an offer like "want me to dig deeper?"

### What it can do inside Obsidian

Say any of these, from the orb or from the hotkey with Obsidian minimized. Add "in a split", "on the right sidebar", or "in a tab" to any open command; the default is a tab in the main pane.

| Say | It does |
|:--|:--|
| "open my daily note" | opens today's note |
| "open the cockpit" | brings up the command center |
| "open the lighthouse plan" | fuzzy-matches any note in the vault and opens it |
| "search for retention" | Obsidian global search |
| "open the intel brief" · "open github trending" · "open the outlier radar" · "open the inbox brief" | opens the latest saved report of that kind |
| "read me the outlier radar" | speaks the document |
| "bring up that repo" | resolves a GitHub repo from the conversation or the trending list and opens it |
| "go back" · "go forward" · "close tab" · "split right" · "split down" · "toggle sidebar" · "graph view" · "open the terminal" | the matching Obsidian command |

### What it can write

The voice edits your vault, not a UI. Writes happen server-side on the markdown files, and Obsidian sees them as normal edits.

| Say | It does |
|:--|:--|
| "check off priority two" | flips the second Top 3 checkbox in today's note |
| "check off the thumbnail task" | fuzzy-matches a task across Top 3 and Daily Drivers and checks it |
| "add 'send the deck to Marco' to my tasks" | appends a Daily Driver |

### Picking the model per run

Background runs pin to Sonnet so your default model never burns on automations. Say **"use fable"** or **"use opus"** anywhere inside a tier-3 ask and only that one run escalates. The run feed shows which model did it.

### Async work finds you

Anything you dispatch shows up as a **task chip riding the orb**: running chips pulse, finished ones wait for a click that opens the deliverable, errors open the log. Completions are also spoken, so you don't have to watch the feed.

### Settings

Push-to-talk is the default. The wake word ships off because speaker bleed makes hands-free talk over its own replies; set `WAKE_WORD=on` in `~/.claude/.env` if you use a headset. Change the hotkey with `VOICE_HOTKEY`, or set it to `off`. Models download once (~350MB); GPU is optional, CPU int8 works.

<br/>

## Customizing

- **Vault conventions** live in `vault-template/CLAUDE.md`, which becomes your vault's `CLAUDE.md`. It's the source of truth Claude reads every session: the folder map, the navigation pattern, the writers table.
- **Background model** is `AGENTIC_OS_MODEL` in `~/.claude/.env` (default `sonnet`, keep it cheap). Escalate single runs by voice instead of raising the default.
- **Skills** are folders with a `SKILL.md`. Edit the prompts freely, they're markdown. Every skill here is a working example: read one, copy its shape, and use `/skill-creator` in Claude Code to scaffold and test your own.
- **Metrics sources** with blank keys are skipped gracefully. The cockpit shows per-source status instead of crashing.

<br/>

<details>
<summary><b>Manual install</b> (if you'd rather not let Claude drive)</summary>

<br/>

**Mac / Linux**

```bash
bash install.sh
```

**Windows**

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

The installer asks where you want the vault, copies the template without overwriting existing notes, installs the plugin, skills, and runner, creates `~/.claude/.env` from the template, and offers to register autostart (launchd on Mac, a Startup shortcut plus a Task Scheduler job on Windows). Re-running it is safe. Both take non-interactive flags: `--vault <path> --autostart yes` / `-Vault <path> -Autostart yes`.

Then finish with the four steps the installer prints. Full walkthroughs: [docs/setup-mac.md](docs/setup-mac.md) · [docs/setup-windows.md](docs/setup-windows.md).

</details>

<details>
<summary><b>Prerequisites</b></summary>

<br/>

| Requirement | Why |
|:--|:--|
| [Obsidian](https://obsidian.md) | The cockpit lives in it |
| [Claude Code](https://claude.com/claude-code), logged in | Runs every skill; the runner shells `claude -p` |
| Node.js 20+ | The runner daemon (no npm installs needed) |
| Python 3.10+ | Metric pullers and a few skill scripts |

Optional, feature by feature: a YouTube Data API key (channel metrics + morning-intel YouTube scan), Instagram and TikTok handles (follower scrapes), Gmail and Calendar MCP connectors (morning intel + inbox triage).

</details>

<details>
<summary><b>Repo layout</b></summary>

<br/>

```
install.sh / install.ps1   guided installers (idempotent)
.env.example               all secrets/config live in ~/.claude/.env, nothing hardcoded
.claude/skills/            the /setup-agentic-os skill Claude runs from inside this repo
plugin/                    pre-built Obsidian plugin (main.js + manifest + styles)
runner/                    runner.js + per-platform launchers (VBS / shell + launchd plist)
skills/                    global skills → ~/.claude/skills/
skills-vault/              vault-scoped skills → <vault>/.claude/skills/
vault-template/            folder skeleton, CLAUDE.md conventions, schemas, templates, Bases
voice/                     optional voice module: hud-server (:3107) + voice-server (:3108)
docs/                      per-platform setup + assets
```

</details>

<details>
<summary><b>Troubleshooting</b></summary>

<br/>

First move, always: run `/setup-agentic-os` again. It detects an existing install and goes straight to the verify phase.

- **Cockpit shows "runner offline"**: the heartbeat in `system/runner-status.json` is stale. Start it: Mac `bash ~/.claude/agentic-os-runner/start-runner.sh`, Windows double-click `start-runner.vbs`. Read `~/.claude/agentic-os-runner/runner.log`.
- **Buttons queue but nothing happens**: `claude` isn't on the runner's PATH, or you're not logged into Claude Code. Run `claude -p "say hi"` in a terminal to verify.
- **Metric cards empty**: run the pull manually (`run_all.sh` / `run_all.ps1`) and read the newest log in `~/.claude/skills/metrics-pull/logs/`.
- **Gmail/Calendar skills fail auth**: run `claude` inside the vault and `/mcp` to (re)authenticate connectors.
- **Orb says "voice offline"**: the voice servers aren't running. Check `curl http://127.0.0.1:3108/health` and `curl http://127.0.0.1:3107/api/speak`; logs at `voice/voice-server/voice-server.log` and `voice/hud-server/.next-dev.log`. Repair with `voice/install-voice.sh` (Mac) / `voice\install-voice.ps1` (Windows), both idempotent.

</details>

<details>
<summary><b>Known limitations</b></summary>

<br/>

Three cockpit buttons are wired to skills from Chase's extended stack that aren't included here because they depend on infrastructure you'd have to build separately:

- **Cascade** (`content-cascade`) needs a Supabase project and a blog pipeline
- **Deep Research** (`deep-research-chase`) and **YT Pipeline** (`yt-pipeline`) need NotebookLM auth and companion skills

Clicking them queues a run that fails gracefully and shows as failed in the run feed. Nothing breaks. Everything else on the action bar works out of the box.

Windows is verified end to end on a clean install and on an existing vault. The Mac path shares the same code but has had fewer eyes on it. If you run it on a Mac, an issue with what you saw is the most useful thing you can send.

</details>

<br/>

<div align="center">

</div>
