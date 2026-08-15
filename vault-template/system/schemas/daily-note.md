---
schema: daily-note
schema_version: 1
status: frozen
since: 2026-05-11
---

# Daily Note Schema

Frozen contract. Source of truth for:
- `system/templates/daily.md` (Templater template)
- `chase-command-center` plugin parser (`lib/vault.ts`)
- `/today` skill (writer)
- `/close-day` skill (writer)
- `activity-log.js` hook (appender)

**Breaking changes bump `schema_version`.** Plugin/parsers MUST refuse unknown versions, not silently coerce. Bumping requires touching every consumer above.

---

## File Conventions

- **Location:** `daily-notes/`
- **Filename:** `YYYY-MM-DD.md` (ISO 8601, hyphen-separated)
- **Encoding:** UTF-8, LF or CRLF (parser tolerant)
- **Idempotency:** `/today` MUST NOT overwrite existing file. Re-run = no-op.

---

## Frontmatter (YAML)

```yaml
---
date: 2026-05-11               # required, ISO 8601 string, matches filename
schema_version: 1              # required, int
focus: ""                      # optional, single string, 0-200 chars
top3:                          # optional, array length 0-3
  - ""
top3_done: [false, false, false]   # parallel array to top3; same length
effort: null                   # optional, int 1-10 (set by /close-day)
focus_blocks: null             # optional, int (set by /close-day)
posts_shipped:                 # optional, object (set by /close-day)
  youtube: 0
  blog: 0
  linkedin: 0
  x: 0
  instagram: 0
  tiktok: 0
videos_shipped_today: 0        # optional, int
---
```

### Rules

- `date` MUST match filename (parser asserts).
- `schema_version` MUST be present. Unknown values → parser error, not coerce.
- `top3` and `top3_done` are parallel arrays of equal length (≤3).
- Nulls mean "not yet set." Zeros mean "set, value is zero."
- Plugin reads frontmatter via Obsidian `MetadataCache.getFileCache().frontmatter`, not raw YAML parse.

---

## Markdown Body (sections in exact order, exact headings)

```
# YYYY-MM-DD

## Current Focus
<single paragraph>

## Top 3 Priorities
1. [ ] ...
2. [ ] ...
3. [ ] ...

## Schedule
- HH:MM — <event title>

## Daily Drivers
- [ ] Skool post
- [ ] YouTube recording
- [ ] Inbox triage
- [ ] Daily review

## Activity Log
<appended by PostToolUse hook>

## Notes
<freeform, plugin ignores>

## EOD Reflection
<appended by /close-day>
```

### Section rules

| Section | Heading match | Writer | Reader |
|---|---|---|---|
| `# YYYY-MM-DD` | exact, h1 | template | display only |
| `## Current Focus` | exact | user / `/today` | plugin `FocusCard.tsx` |
| `## Top 3 Priorities` | exact | user / `/today` | plugin `Top3Priorities.tsx` |
| `## Schedule` | exact | `/today` (gcal pull) | plugin `ScheduleList.tsx` |
| `## Daily Drivers` | exact | template | plugin `DailyDriversChecklist.tsx` |
| `## Activity Log` | exact | `activity-log.js` hook (append) | plugin (optional render) |
| `## Notes` | exact | user | ignored |
| `## EOD Reflection` | exact | `/close-day` (append) | display only |

### Parser contract

- Plugin parses by exact heading match. Whitespace inside sections preserved.
- Unknown headings = ignored, not error (forward-compat for user-added sections).
- Missing required heading (`## Top 3 Priorities`, `## Current Focus`, `## Daily Drivers`) → plugin renders empty placeholder card with "section missing" badge, does NOT crash.
- Top 3 items: parse lines matching `/^\d+\. \[([ x])\] (.+)$/`. `[x]` → done, `[ ]` → pending. Position in list = index into `top3_done` array.
- Daily Drivers: same regex, no positional index (just a flat checklist).
- Schedule: parse lines matching `/^- (\d{2}:\d{2}) — (.+)$/`.

---

## Version history

| Version | Date | Change |
|---|---|---|
| 1 | 2026-05-11 | Initial freeze. |
