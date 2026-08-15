# Vault Conventions

_Last reviewed: 2026-05-15_

> **DO NOT TOUCH:** `.claude/`, `.obsidian/`, `.firecrawl/`, `.playwright-cli/`, `.agents/`, `_archive-vault/`. Plumbing or cold storage — write into the live folders below instead.

## Vault Structure

Mental model — **Karpathy 3-stage:** `inbox → projects → content` (staging → working → output) plus `wiki` for evergreen distillation + utility folders for plumbing.

Top-level folders (each has its own `_index.md` — read it first):

- **`inbox/`** — Stage 1 staging. Source material + skill deliverables + untriaged capture. Subfolders: `notes/` (quick capture), `research/` (deep-research briefs; nested `github-trending/`), `reports/` (skill outputs grouped by source: `morning/`, `weekly/`, `cascades/`, `inbox-briefs/`, `plan-tomorrow/`, `vault-cleanup/`, `metrics/`, `yt-reviews/`), `personal/` (journal, drafts), `demo-assets/` (reusable diagrams + image host — never archive), `archive/` (7d auto-archive).
- **`projects/`** — Stage 2 working. Active video plans, outlines, scripts, sponsor playbooks. Frontmatter `status:` required (see Taxonomy).
- **`content/`** — Stage 3 output. Per-platform shipped artifacts: `blog/`, `linkedin/`, `x-articles/`, `twitter/`, `carousels/`, `guides/`.
- **`wiki/`** — Evergreen knowledge. Post-ship harvest target (see Wiki Doctrine).
- **`daily-notes/`** — Schema-locked daily rhythm. Format frozen at `system/schemas/daily-note.md` v1.
- **`ops/`** — Business operations (finance, dashboards, ops reports). Audience: CPA, partner.
- **`system/`** — Machine-readable plumbing. Subfolders: `schemas/`, `templates/`, `metrics/`, `queue/`, `runs/`, `bases/`, `dashboards/`, plus `runner-status.json` heartbeat.

All folders except `wiki/` and `system/` have an `archive/` subfolder. Run `/vault-cleanup` weekly — moves 7d+ stale files into archive. Wiki-links keep resolving from archive.

## Navigation Pattern

**Each navigable folder has an `_index.md` mapping its contents.** Per-folder context lives there — NOT in subfolder `CLAUDE.md` files. `_index.md` doubles as Obsidian navigation + agent SOP for that folder.

1. Read this `CLAUDE.md` for conventions
2. Read top-level `_index.md` for vault map
3. Read target folder's `_index.md` (and nested subfolders' `_index.md` if going deeper)
4. Read specific file

Total: 3-4 reads regardless of vault size.

**Required `_index.md`:** all top-level folders + any nested folder with substantive content (e.g. `wiki/<topic>/`, `inbox/research/`, `inbox/reports/<source>/`).
**Skip `_index.md`:** machine-managed (`system/queue/`, `system/runs/`, `system/metrics/`), `archive/` subfolders, image-only folders (`demo-assets/`), and any folder with <5 files.

If a navigable folder lacks `_index.md` and would benefit, create one.

## Wiki Doctrine

The wiki is NOT a duplicate of `content/` or `inbox/research/`. It's where knowledge gets DISTILLED after a project ships:

- `projects/<video>.md` = the plan (work-product)
- `content/<platform>/<video>.md` = the shipped artifact
- `wiki/<topic>/<concept>.md` = the harvested learning (evergreen, survives 6 months)

When a project flips to `status: done`, run `/harvest <project-file>` to draft a wiki article + cross-link to siblings + update topic `_index.md` + `wiki/_master-index.md`. Manual invocation — no auto-trigger.

Entry point: `wiki/_master-index.md`. Each topic folder has its own `_index.md`.

## Conventions

### File names + organization

- File names: `YYYY-MM-DD-slug.md` (lowercase, hyphens). Exception: wiki articles are evergreen — slug only, no date prefix.
- Brain dumps → split: tasks/plans → `projects/`, untriaged ideas → `inbox/notes/`, research → `inbox/research/`.
- Research notes in `inbox/research/` must include date, source, key findings, links to related projects.
- Research + wiki articles must include a `## Key Takeaways` section.
- Notes: bullets over paragraphs.

### Obsidian markdown (parser-compatible across vault)

- **Wiki-link:** `[[filename]]` short-form (survives folder moves). Use `[[folder/filename]]` only on collisions. Never include `.md` extension.
- **Embed / transclusion:** `![[file]]` — pulls content inline. Use for image embeds and note inclusions. `[[file]]` alone = link only.
- **Block reference:** `[[file#heading]]` jumps to a heading; `[[file#^block-id]]` jumps to a block. Useful for cross-doc citation.
- **Tags:** flat `#topic-name` (lowercase, hyphens). Avoid nested `#parent/child` unless documented in an `_index.md`.
- **Callouts:** `> [!note] Title` / `[!warning]` / `[!tip]` / `[!info]`. Render as cards in Obsidian.
- **Images:** store in `inbox/demo-assets/`, embed via `![[image.png]]`. Never link absolute paths.
- **Frontmatter:** raw YAML at top of file. Obsidian's Properties UI edits the same block — don't fight it.
- **Do NOT:** use Markdown footnotes (`[^1]`), absolute file paths, or `.md` link suffixes — third-party plugins won't resolve them.

### Frontmatter status taxonomy (applies to `projects/*.md` ONLY)

| value | meaning |
|---|---|
| `active` | working on it right now (rare, 1-3 items) |
| `in-progress` | started, paused, will return |
| `blocked` | waiting on external (review, dependency, decision) |
| `done` | finished, kept for reference |
| `archived` | finished + demoted from sidebar |

Bases sidebar filters `status != done AND status != archived`. Non-canonical values get hidden silently. If a new value is needed, add it HERE first + update Bases queries in `system/bases/`.

`content/`, `wiki/`, `inbox/` use different schemas — see each folder's `_index.md`.

## Agent SOP — Agentic OS layer

`system/` is the cockpit's machine-readable plumbing. Treat as parser contract — don't hand-edit unless a schema doc says so.

### Source of truth

- **Daily-note format:** `system/schemas/daily-note.md`, frozen at `schema_version: 1`. Section headings + order are the parser contract. Bumping version = update template + plugin parser + every writer.
- **Metric CSV:** `system/metrics/metrics.csv`, schema `timestamp,source,metric,value,status,error`. Append-only.
- **Queue/runs:** `system/queue/<uuid>.json` (plugin writes, runner consumes), `system/runs/<uuid>.json` (runner writes per invocation).

### Writers (don't hand-edit their outputs)

| Writer | What it touches |
|---|---|
| `/metrics-pull` | `metrics.csv`, `last-pull.json`, `latest-video.json` |
| `/today` + `/plan-today` | new/merged daily note from frozen v1 schema |
| `/plan-tomorrow` | tomorrow's daily note |
| `/close-day` | appends `## EOD Reflection`, fills effort/focus_blocks/posts_shipped frontmatter |
| `/morning-report`, `/inbox-brief`, `/weekly-review`, `/yt-week-review`, `/content-cascade`, `/deep-research-chase`, `/vault-cleanup` | deliverables in `inbox/reports/<source>/` or `inbox/research/` |
| `/morning-intel` | `inbox/research/morning-intel/YYYY-MM-DD-intel*.md` — SINGLE home since 2026-08-14 (interactive + runner); `inbox/reports/morning/` is legacy fallback for readers |
| `/github-trending` | `inbox/research/github-trending/YYYY-MM-DD-trending.md` (direct-exec, Python) |
| `/harvest` | new wiki article + topic `_index.md` + `wiki/_master-index.md` |
| `/proposal` | `projects/proposals/YYYY-MM-DD-<client>-proposal.md` + optional `inbox/research/call-transcripts/` + Gmail draft |
| `activity-log.js` hook | appends to `## Activity Log` in today's daily note |
| Chase Command Center plugin | intent JSON to `system/queue/` (button click); daily-note checkbox toggle/edit/add via writer lib |
| Agentic-OS runner daemon | `system/runs/<uuid>.json` + log + heartbeat in `runner-status.json` |

**Adding a new writer:** update this table + `runner.js → deliverablePathFor()` + `buildPrompt()` (or `isDirectExec` for mechanical skills). Document the deliverable path.

### Readers

| Reader | What it consumes |
|---|---|
| Chase Command Center plugin | `metrics.csv`, `last-pull.json`, `latest-video.json`, today's daily note, recent `runs/*.json`, `runner-status.json`. Refuses unknown `schema_version`. |
| Obsidian Bases sidebar | `system/bases/*.base` → renders project + content tables driven by `status:` frontmatter. |

### When editing daily notes

- Whole markdown body is parser contract. Don't rename `## Top 3 Priorities` or reorder sections. Freeform content goes under `## Notes`.
- Top 3 checkboxes: `1. [ ] item` / `1. [x] item`. List position = index into `top3_done[]` frontmatter array.
- New sections OK — plugin ignores unknown headings (forward-compat).

### MCP connectors

Skills (`/plan-today`, `/today`, `/inbox-brief`, `/morning`) call Anthropic MCP connectors for Gmail/Calendar/Drive. Authenticated once per machine via `/mcp` in Claude Code. Headless runner sessions inherit credentials. If a connector errors auth, re-run `/mcp`. Legacy `gws-*` skills are opt-in fallback for autonomous-send + Sheets/Docs/Chat — not the default path.

### Cockpit

Plugin source: `~/projects/chase-command-center/`. Build: `npm run build` writes directly into `the vault/.obsidian/plugins/chase-command-center/`. Hot Reload picks up. Don't hand-edit built `main.js`.

Runner: `~/.claude/agentic-os-runner/runner.js`. Spawns `claude.exe -p` with `shell: false` + `cwd: VAULT_ROOT` + autonomy preamble. Restart via `start-runner.vbs` (kills + relaunches singleton). Singleton lock at `runner.pid`. Heartbeat every ~30s to `system/runner-status.json`.

## Quick-ref ops

| Command | When |
|---|---|
| `/today` | morning kickoff — creates/loads today's daily note |
| `/plan-today` | morning planning — Top 3 + schedule from calendar |
| `/close-day` | end-of-day reflection + frontmatter |
| `/plan-tomorrow` | drafts tomorrow's daily note |
| `/morning` | unified AI trend brief + inbox triage |
| `/harvest <project>` | post-ship: distill project → wiki article |
| `/vault-cleanup` | weekly stale-file sweep into archive/ |
| `/metrics-pull` | force-refresh cockpit metrics (auto every 6h) |
| `/github-trending` | refresh GitHub trending capture |
