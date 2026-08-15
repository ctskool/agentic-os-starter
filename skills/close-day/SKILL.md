---
name: close-day
description: Chase AI's end-of-day routine. Reads today's daily note, takes a short reflection (effort score 1-10, focus blocks count, posts shipped per platform, freeform notes), updates the frontmatter (effort, focus_blocks, posts_shipped, videos_shipped_today, top3_done), and appends the EOD Reflection section. Use when Chase says '/close-day', 'close out the day', 'end of day', 'wrap up today', 'log my day', or 'reflect on today'. Idempotent — re-running merges into the same daily note rather than duplicating.
---

# /close-day

End-of-day write-back to today's daily note.

## Workflow

### Step 1 — Ensure today's daily note exists

If `daily-notes/YYYY-MM-DD.md` doesn't exist, prompt: "no daily note for today — run `/today` first to create one." Halt.

### Step 2 — Collect reflection

Ask in one prompt (or accept as a single freeform sentence and parse):

- **Effort (1-10):** how hard did you push?
- **Focus blocks:** how many deep-work blocks did you get in?
- **Posts shipped:** which platforms today? (youtube/blog/linkedin/x/instagram/tiktok)
- **Reflection:** 2-3 sentences. What worked? What didn't?

Accept as either:
- Structured CLI args (when scripted): `--effort 7 --blocks 3 --posts "youtube=1,linkedin=2" --text "Good day. Shipped..."`
- Freeform Claude conversation that maps to the above

### Step 3 — Update the daily note

Invoke the script:

```bash
python "$HOME/.claude/skills/close-day/scripts/close_day.py" \
  --effort 7 \
  --blocks 3 \
  --posts "youtube=1,linkedin=2" \
  --text "Decent day. Cockpit M5 shipped, M6 prep started."
```

The script:
- Reads today's daily note
- Parses frontmatter
- Parses current Top 3 checkbox state (`[x]` items → mark `top3_done[i]=true`)
- Updates frontmatter: `effort`, `focus_blocks`, `posts_shipped`, `videos_shipped_today` (sum of all platform posts, or explicit `--videos`), `top3_done`
- Appends content to `## EOD Reflection` section (overwriting any existing content there to keep the section clean)
- Preserves everything else verbatim (Activity Log, Notes, Schedule)

### Step 4 — Confirm

Read back the updated frontmatter values + the reflection text. Cockpit auto-refreshes within 1 sec via vault.modify watcher.

## Idempotency

Re-running on the same day with new values **overwrites** the prior effort / blocks / posts / videos / EOD Reflection. This is intentional — typing the wrong number once shouldn't lock the note. To preserve history, version-control the vault.

## See also

- Schema: [[daily-note]]
- Sibling: [[today]]
- Plugin reader: `~/projects/chase-command-center/src/lib/vault.ts`
