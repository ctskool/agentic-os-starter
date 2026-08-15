---
name: plan-tomorrow
version: 1.0.0
description: "Drafts tomorrow's daily note. Reads tomorrow's Google Calendar, today's unfinished Top 3 + Daily Drivers, the content pipeline, and any pending sponsor obligations. Writes a new daily note at daily-notes/<tomorrow>.md with carryover Top 3 suggestions, time-blocked schedule, and Daily Drivers seeded from defaults plus any open content commitments. Trigger phrases: 'plan tomorrow', 'set up tomorrow', 'draft tomorrow's daily', '/plan-tomorrow'."
---

# Plan Tomorrow v1.0.0

Drafts the next day's daily note end-to-end so the user wakes up with a structured plan, not a blank page.

## Why this exists

Manually setting up a daily note every night is a friction tax. This skill reads the cockpit's surrounding context (today's progress, tomorrow's calendar, content obligations, sponsor commitments) and writes a complete daily note that the user can tweak in seconds instead of build from scratch.

## How it works

### Step 1: Compute tomorrow's date

Use the current local date + 1 day. ISO format `YYYY-MM-DD`. Path: `daily-notes/<tomorrow>.md`.

If the file already exists, STOP and report "tomorrow's note already exists at <path> — edit it manually or delete + rerun." Do not overwrite.

### Step 2: Read context — parallel

Read in parallel (single message with multiple tool calls):

1. **Today's daily note** at `daily-notes/<today>.md`. Extract:
   - Unfinished `## Top 3 Priorities` items (lines matching `^\d+\. \[ \]`)
   - Unfinished `## Daily Drivers` items (lines matching `^- \[ \]`)
   - `## Notes` content
2. **Tomorrow's calendar** via the `gws-calendar-agenda` skill, scoped to tomorrow's date.
3. **Content pipeline** — glob `projects/*.md` for files modified in last 7 days. Look for ones tagged `status: in-progress` or with a `due:` date on/before tomorrow.

### Step 3: Build suggested Top 3

Rank by these signals, pick top 3:
1. Today's incomplete Top 3 items (high priority — they were already selected and didn't ship)
2. Items with `due: <tomorrow>` in projects/ frontmatter
3. Calendar commitments that need prep work (e.g. a podcast recording needs a brief)
4. Sponsor obligations from `personal/sponsors.md` or `projects/sponsors-pipeline.md` if present

Top 3 is ASPIRATIONAL — the 3 most impactful, not a kitchen sink. If only 1-2 obvious choices exist, that's fine; leave slots empty (`- [ ] `).

### Step 4: Write tomorrow's daily note

Use the frozen v1 schema (see `system/schemas/daily-note.md`). Exact section order:

```
---
date: <tomorrow>
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

# <tomorrow>

## Current Focus


## Top 3 Priorities
1. [ ] <suggested 1>
2. [ ] <suggested 2>
3. [ ] <suggested 3>

## Schedule
<calendar entries, one per line, format: `- HH:MM — Title`, 24h, sorted>

## Daily Drivers
- [ ] Skool post
- [ ] YouTube recording
- [ ] Inbox triage
- [ ] Daily review

## Activity Log

## Notes
<freeform — paste a one-paragraph "context for tomorrow" summarizing today's drift, blockers, and momentum>

## EOD Reflection
```

### Step 5: Brief summary

End your reply with a single-line summary:

```
PLANNED <tomorrow> · Top3=[N] · cal=[M events] · saved daily-notes/<tomorrow>.md
```

## Boundaries

- DO NOT overwrite an existing daily note. The `/today` skill already creates the note on the actual day; this one only runs the night before.
- DO NOT touch today's daily note. Read-only there.
- DO NOT auto-check completed items into tomorrow's Top 3.
- If calendar pull fails, write the note WITHOUT schedule and add a marker `(calendar fetch failed)` in Notes.

## Related

- [[today]] — morning skill that opens today's note (idempotent)
- [[close-day]] — EOD bookend that closes today
- [[daily-note]] — schema contract
