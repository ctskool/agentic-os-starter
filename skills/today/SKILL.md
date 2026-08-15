---
name: today
version: 1.1.0
description: Chase AI's start-of-day routine. Creates today's daily note in the vault (from frozen schema template), carries over yesterday's unchecked Top 3 priorities, pulls Google Calendar events for today via the Anthropic Google Calendar MCP connector, and (optionally) chains the morning + inbox-brief skills for a full kickoff. Idempotent — re-running on the same day does NOT overwrite an existing daily note. Use when Chase says '/today', 'start the day', 'open today's note', 'create today's daily', 'init today', or any morning kickoff that should ground in the cockpit's daily-note schema.
---

# /today

Sets up today's daily note + cockpit, then hands off to morning routine.

## Why this exists

The Chase Command Center plugin reads today's daily note as its source of truth for Current Focus, Top 3, Schedule, and Daily Drivers. This skill creates that file in the format the plugin expects (schema_version=1, see `system/schemas/daily-note.md`).

It is intentionally **idempotent**: re-running on the same day reads the existing file and does NOT overwrite it. Safe to call from a cron, a hotkey, or by mistake.

## Workflow

### Step 1 — Read yesterday's daily note for carryover

Find the most recent daily note that isn't today (typically `daily-notes/YYYY-MM-DD.md` for yesterday). Parse its `## Top 3 Priorities` section. Filter to **unchecked** items (`1. [ ] item` — skip `[x]`). These are the carryover Top 3 for today.

If there is no yesterday daily note, carryover is empty.

### Step 2 — Pull today's Gcal events

Call `mcp__claude_ai_Google_Calendar__list_events` with:
- `startTime`: `<today>T00:00:00`
- `endTime`: `<today+1>T00:00:00`
- `timeZone`: `America/Chicago`
- `orderBy`: `startTime`
- `pageSize`: 100

Parse each event into `HH:MM — Title` lines (24h CT). All-day events: prefix with `(all-day)`. Recurring events: use the today instance time, not the series anchor.

Fallback: if MCP server is disconnected, invoke `gws-calendar-agenda` ONLY if `gws auth status` shows `token_valid: true`. Otherwise proceed with empty schedule + a `(calendar fetch failed)` marker.

### Step 3 — Init the daily note

Run the init script with parsed carryover + schedule:

```bash
python "$HOME/.claude/skills/today/scripts/today_init.py" \
  --carryover "Item 1 from yesterday" \
  --carryover "Item 2 from yesterday" \
  --schedule "09:00 — Standup" \
  --schedule "14:00 — Customer call"
```

The script:
- Computes today's path as `daily-notes/YYYY-MM-DD.md`.
- If the file already exists → reads it, returns `exists` status. NO overwrite.
- Otherwise → writes the file from the frozen schema (YAML frontmatter + 8 sections in order), populating Top 3 with carryover lines and Schedule with HH:MM entries.

### Step 4 — Run morning brief (optional, recommended)

After the daily note exists, chain to the `morning` skill for trend briefing + inbox triage. The morning skill output is for context only — it does NOT write to the daily note (the PostToolUse hook in M7 will be the one auto-logging activity).

### Step 5 — Summarize

Tell Chase:
- Whether daily note was newly created or already existed
- Carryover count + items
- Number of calendar events
- One-line cue to set the day's Current Focus manually (cockpit will pick up the edit live)

## Idempotency contract

- File created today exists → script returns without writing
- Templater config also fires when Daily Notes plugin creates the file in Obsidian — same template, same result
- Either path produces the same canonical schema-v1 structure

## See also

- Schema: [[daily-note]]
- Sibling: [[close-day]]
- Plugin reader: `~/projects/chase-command-center/src/lib/vault.ts`
- Carryover format: top3 with `[ ]` → carries, top3 with `[x]` → drops
