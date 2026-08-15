---
name: plan-today
version: 1.1.0
description: "Opinionated start-of-day planner. Reads today's Google Calendar (via Anthropic Google Calendar MCP connector), the last 3 daily notes for incomplete priorities and emerging themes, and the content pipeline. Creates today's daily note at daily-notes/<today>.md if missing (using the frozen v1 schema), then writes 3 suggested Top 3 priorities + seeds Daily Drivers + drops the calendar into the Schedule section. Idempotent — re-running on the same day MERGES suggestions into the existing note rather than overwriting. Trigger phrases: 'plan today', 'plan my day', 'start the day', '/plan-today'."
---

# Plan Today v1.1.0

The cockpit's start-of-day brain. Unlike a simple "open today's note" stitch, this skill is opinionated — it reads context and recommends Top 3 + Daily Drivers, so the user starts the day with a structured plan rather than a blank page.

## Why this exists

Most "start day" automations just create a blank file with a template. That leaves all the priority-setting work on the human, every morning, for the rest of their life. This skill reads the last few days of context + today's calendar + the content pipeline, then recommends WHAT to focus on today. The user reviews + tweaks, doesn't author from zero.

## How it works

### Step 1: Compute today's date + path

ISO `YYYY-MM-DD` (local). Path: `daily-notes/<today>.md`.

### Step 2: Read context — parallel

Read in parallel (single message with multiple tool calls):

1. **Last 3 daily notes** — glob `daily-notes/<today-1>.md`, `<today-2>.md`, `<today-3>.md`. For each:
   - Unfinished `## Top 3 Priorities` (lines matching `^\d+\. \[ \]`)
   - Unfinished `## Daily Drivers` (`^- \[ \]`)
   - `## EOD Reflection` excerpt (if present — useful for theme detection)
2. **Today's calendar** via the Anthropic Google Calendar MCP connector. Call `mcp__claude_ai_Google_Calendar__list_events` with `startTime: <today>T00:00:00`, `endTime: <today+1>T00:00:00`, `timeZone: America/Chicago`, `orderBy: startTime`, `pageSize: 100`. The connector requires no extra auth — it shares the same OAuth session granted via `/mcp` once. If the call fails (server disconnected, etc.), fall back to the legacy `gws-calendar-agenda` skill ONLY if `gws auth status` shows `token_valid: true`; otherwise emit `(calendar fetch failed)` per Step 7 and continue without schedule data.
3. **Content pipeline** — glob `projects/*.md` for files modified in last 14 days. Look for:
   - `status: in-progress` or `status: draft` in frontmatter
   - `due:` date on/before today (overdue) or `due: <today>`
4. **Existing today's note** — if it exists, read its current Top 3 and Daily Drivers state so we MERGE rather than overwrite.

### Step 3: Build suggested Top 3 (RANKED)

Score each candidate 0-100 by these signals (sum, then pick top 3):

- **+50** if item appeared in yesterday's incomplete Top 3 (highest priority — already chosen, still unfinished)
- **+40** if `due: <today>` in projects/
- **+30** if `due: <overdue-date>` in projects/ (urgent past-due)
- **+25** if calendar has a commitment that needs prep work (e.g. recording session → "write video outline")
- **+20** if same theme appears in EOD reflections of last 3 days (repeating blocker — worth attacking directly)
- **+15** if it appeared in incomplete top3 of `<today-2>` or `<today-3>` (recurring drift)

Pick the 3 highest-scored, unique-themed candidates. If existing note already has Top 3 items set by user, KEEP THEM — add suggestions only into empty slots.

Top 3 is ASPIRATIONAL. Better 1 great pick than 3 mediocre ones — if scoring produces less than 3 clear winners, leave the rest empty.

### Step 4: Compute Daily Drivers seed

Default drivers (always present, user toggles):
```
- [ ] Skool post
- [ ] YouTube recording
- [ ] Inbox triage
- [ ] Daily review
```

Add conditional drivers based on context:
- If a sponsor email is currently in `drafts/awaiting/` → add `- [ ] Send pending sponsor reply (drafts/awaiting/<file>)`
- If a content-cascade draft is in `drafts/` → add `- [ ] Review + ship cascade for <video>`
- If a video is recorded but not yet uploaded → add `- [ ] Upload + schedule <title>`

If existing note already has Daily Drivers, MERGE — don't duplicate existing items, only append the conditional ones.

### Step 5: Write the daily note

Use the frozen v1 schema (see `system/schemas/daily-note.md`). Section order is FIXED — don't reorder.

**If note doesn't exist:** create with this exact structure:

```
---
date: <today>
schema_version: 1
focus: ""
top3:
  - "<suggested 1>"
  - "<suggested 2>"
  - "<suggested 3>"
top3_done: [false, false, false]
effort: null
focus_blocks: null
posts_shipped:
  youtube: 0
  blog: 0
  linkedin: 0
  x: 0
  instagram: 0
  tiktok: 0
videos_shipped_today: 0
---

# <today>

## Current Focus


## Top 3 Priorities
1. [ ] <suggested 1>
2. [ ] <suggested 2>
3. [ ] <suggested 3>

## Schedule
<calendar entries, one per line, format: `- HH:MM — Title`, 24h, sorted by start>

## Daily Drivers
- [ ] Skool post
- [ ] YouTube recording
- [ ] Inbox triage
- [ ] Daily review
<+ any conditional drivers from Step 4>

## Activity Log

## Notes
<one-paragraph "context for today" — synthesize the theme from last 3 EOD reflections + flag any overdue projects>

## EOD Reflection
```

**If note already exists:** read it, then MERGE:
- Top 3: only fill empty slots; never overwrite user-set text
- Schedule: replace section content with today's calendar (most-recent wins; user can edit after)
- Daily Drivers: append conditional drivers that aren't already present; don't touch existing rows or their check state
- Notes: append "## Notes — Plan Today refresh <HH:MM>" sub-paragraph with re-synthesized theme

### Step 6: Brief summary

End your reply with:

```
PLANNED <today> · Top3=[N suggestions] · cal=[M events] · drivers=[K total] · saved daily-notes/<today>.md
```

## Boundaries

- DO NOT overwrite user-set Top 3 text. Merge into empty slots only.
- DO NOT mark anything as `[x]`. The user toggles their own progress.
- DO NOT modify `## EOD Reflection`. That's `/close-day`'s territory (or whatever EOD skill is in use).
- DO NOT touch `posts_shipped` frontmatter. That's set at EOD, not planned at AM.
- If calendar pull fails (MCP server disconnected AND gws fallback unavailable), write the note WITHOUT schedule and add a marker `(calendar fetch failed)` in Notes.
- The calendar Schedule entries should render one event per line as `- HH:MM — Title` (24h CT). Recurring events: include the today instance, not the original series anchor. All-day events: prefix with `(all-day)` instead of a time.
- If less than 3 daily notes exist in history, score what's available, don't fabricate.

## Related

- [[plan-tomorrow]] — EOD bookend that drafts the next day's note
- [[weekly-review]] — 7-day aggregate for higher-level patterns
- [[daily-note]] — schema contract
