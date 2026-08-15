---
name: yt-week-review
version: 1.0.0
description: "Reviews Chase AI's YouTube channel performance for the past 7 days. Pulls every video uploaded in the window via the YouTube Data API, computes views/likes/comments + per-video deltas vs the rolling baseline (last 10 videos), surfaces outliers (top performer + underperformer), and proposes concrete repackaging or follow-up content for each outlier. Writes a structured review to inbox/reports/yt-reviews/. Trigger phrases: 'review my YouTube week', 'how did my channel do', 'YouTube week review', '/yt-week-review'."
---

# YouTube Week Review v1.0.0

Channel-level retrospective for the trailing 7 days. Surfaces what hit, what didn't, and what to do about it next week.

## Why this exists

Subs/views numbers on a dashboard tell you the trend but not the why. This skill pulls the actual videos uploaded in the past week, ranks them by performance against your own rolling baseline, and gives back actionable next moves (repackage the winner, reframe the loser, or move on).

## How it works

### Step 1: Read env

Pull `YOUTUBE_API_KEY` and `YOUTUBE_CHANNEL_ID` from `~/.claude/.env`. If either is missing, write a review note that says "creds missing — set up env vars" and exit early with status note. Do not fabricate data.

### Step 2: List recent uploads

Use the uploads-playlist trick — channel uploads playlist ID = channel ID with `UC` → `UU` prefix swap.

```
https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&maxResults=25&playlistId=UU<channel-suffix>&key=<key>
```

Filter to videos with `videoPublishedAt` within the last 7 days. Capture: video_id, title, published_at.

### Step 3: Fetch per-video stats + 10-video baseline

For each video in the week's window AND for the 10 most recent uploads (whether in window or not — for baseline):

```
https://www.googleapis.com/youtube/v3/videos?part=statistics,contentDetails,snippet&id=<id1,id2,...>&key=<key>
```

Capture per video: viewCount, likeCount, commentCount, duration, title. (Batch up to 50 IDs per request to save quota — 1 unit per call.)

### Step 3.5: Segment long-form vs Shorts

Parse `contentDetails.duration` (ISO 8601 like `PT45S`, `PT12M34S`) to seconds. Classify:
- **Short** — duration <= 180 seconds (3 minutes). Excluded from primary metrics. (3min cutoff intentionally includes "long-Short" hybrids in the Shorts bucket — those compete with Short distribution, not long-form.)
- **Long-form** — duration > 180 seconds. The PRIMARY focus of this review.

The 10-video baseline is computed from the 10 most recent **long-form** uploads only — Shorts have wildly different view distributions and would skew the median.

The upload table, Hit/Steady/Miss classification, top performer, and underperformer all operate on long-form videos only.

Shorts get one compact summary section at the end (see Step 6).

### Step 4: Compute baseline + deltas (long-form only)

From the 10 most recent **long-form** uploads:
- `baseline_views = median views across the 10`
- `baseline_likes = median likes`
- `baseline_engagement = median (likes + comments) / views ratio`

For each weekly **long-form** upload, compute `views_pct_of_baseline = views / baseline_views * 100`.

Classify each weekly long-form upload:
- **Hit** — `views_pct_of_baseline >= 150`
- **Steady** — `60 <= views_pct_of_baseline < 150`
- **Miss** — `views_pct_of_baseline < 60`

Note that videos <24h old are likely still climbing — flag them but don't classify confidently.

### Step 5: Identify outliers + propose follow-ups

For the top performer of the week (highest absolute views):
- Suggest 2-3 specific repackaging angles. Examples:
  - "Short-form cut of the strongest moment (X:XX to Y:YY)"
  - "Long-form sequel diving deeper into [subtopic mentioned]"
  - "LinkedIn carousel summarizing the 3 key takeaways"
  - "Tweet thread version with the framework"

For the worst performer (if it's clearly a miss — not just young):
- 1-2 diagnostic questions: was it thumbnail, title framing, or topic-fit?
- 1 concrete follow-up: "Same topic, recut intro to start with the result not the setup" or "Skip a re-attempt — kill this angle"

### Step 6: Write the review note

Path: `inbox/reports/yt-reviews/<today>-yt-week-review.md`

Structure:

```markdown
---
date: <today>
window: <today-6>..<today>
channel: <channel title>
skill: yt-week-review
tags: [review, youtube, weekly]
---

# YouTube Week Review — <today-6> → <today>

## TL;DR
<3-4 bullets — top performer, biggest miss, one repackaging move worth doing this week>

## Uploads this week
| Video | Views | vs Baseline | Likes | Comments | Verdict |
|---|---|---|---|---|---|
| <title> | N | XXX% | N | N | Hit / Steady / Miss / Climbing |
| ... | | | | | |

(Long-form only. Baseline: median of last 10 long-form uploads = N views, N likes.)

## Top performer — <title>
**Why it worked (best guess):** <ONE tight sentence — keep under 140 chars so the cockpit card can show it without truncation>.

**Repackaging plays:**
1. <concrete play>
2. <concrete play>
3. <concrete play>

## Underperformer — <title> (if any)
**Likely culprit:** <ONE tight sentence — under 140 chars — naming the most-likely cause (thumbnail / title / topic / timing / format mismatch)>.

**Move:** <kill, retry, or reframe — one short phrase>

## Channel-wide signal
- Total weekly views: N (vs N last week — Δ pct)
- Subs gained: N (Data API rounds to nearest 1k; treat as approximate)
- Avg time between uploads: N days
- Pacing note: <on-track / slowing / accelerating>

## Short-form snapshot
<ONE line: count of Shorts uploaded this week, total Shorts views, brief verdict — e.g. "3 Shorts shipped · 4.2K combined views · steady, no breakouts" or "0 Shorts this week — gap worth filling next week".>

## Recommended next 7 days
<3 concrete moves — pick from the repackaging plays above + any obvious gap (e.g. "no shorts shipped this week — pull 2 from the top performer").>
```

### Step 7: Brief summary

End your reply with:

```
SAVED inbox/reports/yt-reviews/<today>-yt-week-review.md · N videos · top: <title-short> · Δbaseline: XXX%
```

## Boundaries

- Use Data API only — no OAuth. (CTR + retention need Analytics API, not in scope here.)
- Subs count rounds to nearest 1k per YouTube public API behavior — note this in output if relevant.
- DO NOT make claims about CTR, watch time, or retention. Those require OAuth.
- Quota cost: ~3-5 units per run (1 playlistItems + 1-2 videos.list batches). Safe at any frequency.
- If a video is <24h old, label it "Climbing" not Hit/Miss — the data isn't settled.

## Related

- [[pull_youtube.py]] — the script that powers the YouTube cards in the cockpit
- [[yt-titles]] — title-generation skill for the repackaging plays
- [[yt-hooks]] — hook framework
- [[content-cascade]] — for repurposing one video across multiple channels
