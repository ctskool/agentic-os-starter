---
name: weekly-review
version: 1.1.0
description: "Comprehensive 7-day retrospective. Aggregates the last 7 daily notes (effort, focus blocks, posts shipped, top3 completion, theme detection from EOD reflections) AND pulls the YouTube channel's performance over the same window (uploads, views vs baseline, hit/miss classification, repackaging recommendations). Writes one consolidated coaching review with personal-productivity section + channel-performance section + cross-cutting recommendations. Trigger phrases: 'weekly review', 'review the week', 'how was last week', 'review my YouTube week', '/weekly-review'."
---

# Weekly Review v1.1.0

Self-coaching brief built from the structured data in daily notes PLUS the YouTube channel's performance in the same window. One consolidated synthesis note instead of two separate reviews.

## Why this exists

Daily notes + channel analytics each tell half the story. Personal effort without output context is hollow self-coaching; channel performance without effort context misses the WHY. This skill combines both into one weekly synthesis so the user can spot drift (personal) AND opportunities (channel) in a single review pass.

## How it works

### Step 1: Compute date range

Window = last 7 calendar days ending today. ISO dates `<today-6>..<today>`.

### Step 2: Read all 7 daily notes in parallel

Glob `daily-notes/<date>.md` for each of the 7 dates. Read in parallel. For each note, extract from frontmatter:

- `effort` (1-10, may be null if `/close-day` wasn't run)
- `focus_blocks` (int, may be null)
- `posts_shipped` (object: youtube/blog/linkedin/x/instagram/tiktok)
- `videos_shipped_today` (int)
- `top3_done` (array of 3 booleans, may differ from body checkbox state — prefer body state if conflict)
- `top3` (the 3 priorities for context)

And from body:
- `## Top 3 Priorities` — count `[x]` vs `[ ]` for the day's completion rate
- `## EOD Reflection` — short excerpt if present, used for theme detection
- `## Daily Drivers` — count `[x]` vs `[ ]` for drivers completion rate

If a note is missing entirely, mark that day "no note" and continue.

### Step 3: Compute aggregates

- **Effort trend** — daily effort scores, 7 points. Note direction (up/down/flat) and outliers.
- **Focus blocks total + daily avg.**
- **Posts shipped — sum per platform.** Flag platforms with zero output if user normally posts there.
- **Top 3 completion rate** — (completed top3 / 21 possible) as percentage.
- **Drivers completion rate** — same calc on Daily Drivers items.
- **Videos shipped this week.**

### Step 4: Theme detection from EOD reflections

Read each EOD reflection (if present). Look for:
- Repeating blockers (the same word/concept appearing 3+ times across the week)
- Energy notes ("low energy" / "high energy" days clustered around what?)
- Win patterns (what shipped well and why)
- Friction patterns (where did time bleed)

Synthesize 2-4 themes in plain English.

### Step 5: Pull YouTube channel data for the same 7-day window

Read `YOUTUBE_API_KEY` + `YOUTUBE_CHANNEL_ID` from `~/.claude/.env`. If either missing, SKIP this section entirely and add a one-line note `(YouTube creds missing — channel section skipped)` in the output. Do not fabricate.

Steps (all use the Data API, no OAuth):

1. **List uploads in window** — uploads playlist ID = channel ID with `UC` → `UU`:
   ```
   https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&maxResults=25&playlistId=UU<suffix>&key=<key>
   ```
   Filter to videos with `videoPublishedAt` in last 7 days.

2. **Fetch per-video stats + 10-video baseline** (one batch call up to 50 IDs):
   ```
   https://www.googleapis.com/youtube/v3/videos?part=statistics,contentDetails,snippet&id=<id1,id2,...>&key=<key>
   ```

3. **Compute baseline** — median views/likes from last 10 uploads (whether in window or not). Compute `views_pct_of_baseline = views / baseline_views * 100` for each weekly upload.

4. **Classify each weekly upload**:
   - **Hit** — `views_pct_of_baseline >= 150`
   - **Steady** — `60 <= views_pct_of_baseline < 150`
   - **Miss** — `views_pct_of_baseline < 60`
   - **Climbing** — uploaded <24h ago (data not settled)

5. **Identify top performer** — highest absolute views in window. Suggest 2-3 specific repackaging plays (short-form cut, long-form sequel, carousel summary, X thread).

6. **Identify worst performer** (only if clearly a miss, not climbing) — diagnose: thumbnail / title framing / topic / timing. Recommend: kill, retry, or reframe.

### Step 6: Write the review note

Path: `inbox/reports/weekly/<today>-weekly-review.md`

Use this exact structure:

```markdown
---
date: <today>
window: <today-6>..<today>
skill: weekly-review
tags: [review, weekly]
---

# Weekly Review — <today-6> → <today>

## TL;DR
<3-5 bullets — the most important takeaways. Lead with the surprising finding.>

## Numbers
| Metric | Value | Note |
|---|---|---|
| Effort avg | X.X / 10 | <trend direction> |
| Focus blocks | N total · N.N/day avg | |
| Posts shipped | YT N · Blog N · LI N · X N · IG N · TT N | <flag zero-output platforms> |
| Videos shipped | N | |
| Top 3 completion | XX% (N/21) | |
| Daily Drivers completion | XX% | |

## Effort Trend
<7-day visualization. Use a simple text bar chart, one row per day:>
```
Mon  ████████░░  8/10
Tue  ██████░░░░  6/10
Wed  ──no note──
Thu  █████████░  9/10
…
```

## Themes
<2-4 themes detected from EOD reflections. Each: one-line headline + 2-3 sentence elaboration.>

## What shipped
<bullet list of concrete output — videos, posts, projects closed>

## What stalled
<bullet list of items that appeared in Top 3 multiple days and never got done>

## Channel — YouTube
| Video | Views | vs Baseline | Likes | Comments | Verdict |
|---|---|---|---|---|---|
| <title> | N | XXX% | N | N | Hit / Steady / Miss / Climbing |
| ... | | | | | |

Baseline: median of last 10 uploads = N views, N likes.

### Top performer this week — <title>
**Why it worked (best guess):** <one paragraph reading title + thumbnail framing>

**Repackaging plays:**
1. <concrete play>
2. <concrete play>
3. <concrete play>

### Underperformer — <title> (skip if none clearly underperformed)
**Likely culprit:** <thumbnail / title / topic / timing>

**Move:** <kill, retry, or reframe>

### Channel-wide
- Total weekly views: N (Δ vs last week)
- Subs gained (approx): N (Data API rounds to nearest 1k)
- Avg time between uploads: N days
- Pacing note: <on-track / slowing / accelerating>

## Recommendations for next week
<3-5 concrete actions combining the personal + channel signals. Examples:>
- "Block Tue 9-11 for X video script — it slipped 4 days running, and the top performer angle calls for a sequel"
- "Cut a 30s short from <top performer> Y:YY-Z:ZZ — no shorts shipped this week"
- "Kill the [X] series — both attempts missed baseline by >50%"

## Raw data
<expandable section with day-by-day daily-note rows + per-video stats for archive>
```

### Step 7: Brief summary

End your reply with:

```
SAVED inbox/reports/weekly/<today>-weekly-review.md · effort avg X.X · top3 XX% · N videos shipped · top YT: <short-title> (XXX% baseline)
```

## Boundaries

- DO NOT modify daily notes. Read-only.
- If fewer than 3 daily notes exist in window, write the review anyway but caveat "limited data — review next week with full window."
- Don't fabricate numbers. If `effort` is null for a day, mark "no score" — do not assume.

## Related

- [[close-day]] — populates the frontmatter this skill consumes
- [[today]] — creates daily notes
- [[daily-note]] — schema contract
