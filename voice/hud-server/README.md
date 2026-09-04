# V.A.U.L.T. — Voice-Activated Unified Logic Terminal

Ember Core HUD: a Jarvis-style sci-fi dashboard wired to a **real** Agentic OS — the Obsidian vault that the Chase Command Center cockpit and runner daemon already read/write. Every widget on screen traces to a real file. No theater.

## System architecture

What's local vs cloud, the voice round trip, router tiers, and the skill lifecycle:

```
┌──────────────────────────── YOUR MACHINE ────────────────────────────┐   ┌─ CLOUD (opt) ─┐
│                                                                      │   │               │
│  Browser HUD ──── Next.js server ──── THE VAULT ──── Runner daemon ──┼───┼─ Anthropic    │
│  :3107 orb/PTT    :3107 router        plain files    polls queue,    │   │  API          │
│       │           rules→Haiku→qwen    md/json/csv    spawns headless │   │  · Haiku route│
│       │                │                             claude -p       │   │  · claude -p  │
│  Voice server :3108 ───┘              Ollama :11434                  │   │    (tier 3 +  │
│  Kokoro TTS · whisper STT             offline router fallback        │   │     skills)   │
└──────────────────────────────────────────────────────────────────────┘   └───────────────┘
```

- **Voice never leaves the machine** — STT (faster-whisper) and TTS (Kokoro) are local; the
  full push-to-talk round trip is 175–500ms.
- **Three router tiers**: 1 = dispatch a skill (intent JSON → queue), 2 = instant answer from
  the vault snapshot (~25ms), 3 = background headless-Claude ask (answer spoken when it lands).
- **Mental model**: the voice layer is a dispatcher, not a worker. Files are the message bus.

## Data sources (read-only)

| Widget | Source file |
|---|---|
| System Vitals | `system/metrics/metrics.csv` (append-only) |
| Primary Objective (MRR) | `metrics.csv` `stripe/mrr` rows |
| Latest Deploy | `system/metrics/latest-video.json` |
| Pipeline / Diagnostics | `system/runner-status.json` (30s heartbeat) |
| Telemetry feed | `system/runs/*.json` |
| Directives (Top 3) | `daily-notes/YYYY-MM-DD.md` (frozen v1 schema) |

`VAULT_ROOT` env var overrides the vault path (default: `AGENTIC_OS_VAULT` from `~/.claude/.env`, falling back to `~/the-vault`).

## Run

```
npm install
npm run dev -- -p 3107    # http://localhost:3107
```

Or use the launchers the installer registers: `start-hud.vbs` (Windows, hidden, logs to
`.next-dev.log`) / `start-hud.sh` (Mac). The port must be 3107 — the cockpit orb and the
voice server are both wired to it.

## Architecture

- **Next.js 15 app router.** `/api/state` reads the vault fresh per request (no cache); client polls every 5s.
- **GraphCore** (`components/GraphCore.tsx`) — JARVIS-reference centerpiece: 2,200-node volumetric knowledge-graph cloud (center-dense), k-nearest edges that follow per-node drift, constant rotation, UnrealBloom. White core ignites only while speaking, driven by AnalyserNode RMS from the Kokoro TTS stream. Blue palette per reference; error mode goes red.
- **DitherCore** (`components/DitherCore.tsx` + `components/ui/dithering-shader.tsx`) — retained alternate: WebGL2 dithered sphere with voice-reactive swell. Color + speed are the state language: idle ember / working gold / listening cobalt / speaking amber / error red, eased in the render loop. Mode wired to runner `busy` + fetch errors; keys 1–5 override, 0/Esc auto.
- **Core Lab** (`/lab`) — 10 alternative Three.js centerpiece candidates on one scissor-rendered canvas; click or keys 1–0 to isolate. `components/EmberCore.tsx` (particle reactor + UnrealBloom) kept as the strongest three.js variant.
- **Design system** — "Ember Core": near-black, Claude-terracotta, hairline strokes, Chakra Petch + IBM Plex Mono. Deliberately NOT Iron-Man blue.
- Data honesty: every metric row carries its CSV `status`; non-`ok` values are tagged (`SIM` for mock).

## Voice stack

Fully local: Kokoro TTS + faster-whisper STT on `:3108` (start via
`voice-server\start-voice-server.vbs`), push-to-talk (hold Space), three-tier intent
router. Setup and troubleshooting live in the repo root `README.md` (Voice mode notes) and
`docs/setup-windows.md` / `docs/setup-mac.md`.
