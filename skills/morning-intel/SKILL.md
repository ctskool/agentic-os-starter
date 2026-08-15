---
name: morning-intel
description: The morning brief on steroids — full AI-sphere intelligence sweep (last-24h AI news via smol.ai + HN, X/Twitter announcements from Anthropic/OpenAI devs, trending YouTube in the Claude Code/Codex sphere, GitHub trending 7d/30d/velocity, Gmail last-24h triage) synthesized into one vault brief ending in a "So What" content plan (video ideas, LinkedIn posts, shorts/carousels). Use when Chase says '/morning-intel', 'intel brief', 'AI intel sweep', 'what happened in AI in the last 24 hours', 'morning brief on steroids', or wants a combined news + inbox + content-angle briefing. NOT the same as /today (daily note) or the anthropic 'morning' skill (calendar-centric).
---

# morning-intel

Many thin deterministic fetchers, one synthesis pass. The fetchers are plain
Python (no AI in loop, metrics-pull error contract); Claude does Gmail triage,
X gap-fill, and the editorial synthesis.

## Step 1 — Run the fetch layer (parallel)

Run all six in parallel (independent; failures don't block each other):

```bash
python "$HOME/.claude/skills/morning-intel/scripts/fetch_smol.py"
python "$HOME/.claude/skills/morning-intel/scripts/fetch_hn.py"
python "$HOME/.claude/skills/morning-intel/scripts/fetch_youtube.py"
python "$HOME/.claude/skills/morning-intel/scripts/fetch_github.py"
python "$HOME/.claude/skills/morning-intel/scripts/fetch_changelogs.py"
python "$HOME/.claude/skills/morning-intel/scripts/fetch_outliers.py"
```

(Headless/cron wrapper: `scripts/run_all.ps1` — same scripts via Start-Job, 6min timeout, never throws.)

Each writes `<VAULT>/inbox/research/morning-intel/cache/YYYY-MM-DD/<source>.json`
with `{status: ok|stale|error|mock, error, items}`. Always exit 0. github's
"items" embeds the full github-trending report (it delegates to that skill's
fetch.py, which also writes its own file for the cockpit card as usual).

| Source | What it covers | Fallback when status != ok |
|---|---|---|
| smol | X (544 accts) + Reddit + Discords, pre-aggregated daily | lean harder on Step 3 X searches |
| hn | front page + last-24h AI stories by points | skip section, note in status table |
| youtube | last-7d videos for 4 queries, views + views/subs outlier ratio | skip this source |
| github | 7d/30d new repos + 24h/30d star velocity | read yesterday's github-trending file |
| changelogs | Codex changelog + Claude Code releases (raw text) | skip, note it |
| outliers | last-24h small-channel outliers from the outlier-radar skill's vault reports (zero quota — parses, doesn't fetch) | skip section; if status=stale flag that the OutlierRadar task may be dead |

## Step 2 — Gmail triage (read-only, ~5 tool calls)

Load Gmail MCP tools via ToolSearch, then:

1. `search_threads` with query `newer_than:1d in:inbox`, pageSize 50.
2. Dedupe by THREAD; use the latest message date per thread (old threads with
   fresh replies match `newer_than:1d`, so classify off the newest message).
3. Snippets classify ~80% of mail. Call `get_thread` ONLY for: transactional/
   operational senders (Supabase, Stripe, Vercel, site notifications), and
   personalized inbound (a human who clearly knows Chase's content).
4. Categories: **needs-reply** / **opportunity** / **newsletter-worth-reading** /
   **FYI** / **ignore**. One why-care sentence each.
5. Standing rule: quota/billing/site-breakage emails surface at the TOP of the
   brief as 🚨 operational items, above everything else.
6. Read-only. Never label, draft, archive, or click tracking links.

If the Gmail connector is unauthorized (headless run), degrade gracefully:
skip the section, mark `gmail: unavailable` in the status table.

## Step 3 — X/Twitter gap-fill (WebSearch battery)

smol.ai covers most X discourse but lags ~1-2 days. Fill the gap with a fixed
WebSearch battery (direct x.com fetches fail with HTTP 402; Nitter is dead —
do not try them):

- `site:x.com AnthropicAI OR claudeai OR ClaudeDevs <topic keywords>`
- `site:x.com bcherny OR _catwu OR alexalbert__ claude code`
- `site:x.com sama OR gdb OR OpenAIDevs OR Codex_Changelog`
- `Anthropic OR "Claude Code" announcement news <today's date>`
- `OpenAI OR Codex announcement news <today's date>`

Snippets return tweet text but NOT engagement counts — don't invent numbers.
Date-check results: site:x.com recency ranking is unreliable, so verify a tweet
is actually fresh (snowflake-ID magnitude or corroborating dated coverage)
before presenting it as last-24h. Skip this step entirely if WebSearch is
unavailable; smol + hn still carry the news sections.

## Step 4 — Synthesize the brief

Read all cache JSONs + Gmail triage + X results, then write:

`<VAULT>/inbox/research/morning-intel/YYYY-MM-DD-intel.md`

Idempotent: re-running the same day regenerates (overwrites) the file.

Section schema (keep headings stable):

```
# Morning Intel - YYYY-MM-DD (Weekday)

## TL;DR
3-6 bullets. The single most important story first. Any 🚨 operational email
items belong here too.

## Top Story
The one dominant narrative, 1-2 paragraphs, with links + the quotable stat.

## AI News (last 24h)
Grouped: Anthropic/Claude · OpenAI/Codex · Everyone else. Source links on
every claim. Changelog deltas fold in here.

## Hacker News Pulse
Front-page reads + last-24h AI stories worth knowing (points/comments).

## YouTube Radar
Table: title, channel (subs), views, ratio. Flag outliers (ratio >= 0.3) —
those are the angles resonating. Note formula convergence (multiple channels,
same hook). Non-English videos appear despite the US region hint — lead with
English results but call out international outliers as a lane signal (e.g.
non-English mega-courses overperforming = underserved market).

### Small-Channel Outliers (last 24h)
From `outliers.json` (the outlier-radar skill: < 100k-sub channels doing
>= 1.5x the median LIFETIME views of their own recent uploads; `velocity`
is a secondary VPH-ratio metric that runs hot for young videos — treat the
main multiplier as the calibrated number). Table: title (linked), channel
(subs), views/age, multiplier, found-via. These are the strongest angle
signals in the brief — a small channel massively overperforming its baseline
means the TOPIC did the work, not the channel. Call out any topic that shows
up both here and in the main YouTube Radar table (double confirmation). If
status=stale, note the OutlierRadar scheduled task needs checking; if ok with
0 items, say "no new outliers in the last 24h" (that's signal, not failure).

## GitHub Radar
Top new repos (7d/30d) + fastest-growing, AI-relevant picks only — pull from
the embedded github-trending report. One line each on why it matters to Chase.

## Inbox (last 24h)
🚨 Operational first, then 💰 opportunities/needs-reply, then FYI. Ignore-tier
gets one collapsed line with count, not a listing.

## So What - Content Plan
The payoff section. Synthesize against Chase's formats:
- 3-5 YouTube video ideas RANKED by opportunity: working title, hook (first
  2 sentences he'd say), which findings it rides, timing urgency (ride-now
  with expiry date vs evergreen). Weight small-channel outlier topics
  heavily — they prove demand exceeds current supply on that topic.
- 2-3 LinkedIn posts in the "Steal my X for Y" lead-magnet format.
- 1-2 shorts/carousel ideas (carousels reference the ref-deck pipeline).
Cross-check angles against Chase's existing franchises (Agentic OS, codex
skills, taste/anti-slop, skills content) — an angle that extends a franchise
beats a cold one.

## Source Status
| source | status | note |
One row per source incl. gmail + x-search. Honest about failures.

_Generated at HH:MM CT_
```

## Step 5 — Deliver

Chat summary: TL;DR + top story + the #1 content angle + any 🚨 inbox items.
Link the vault file. Don't paste the whole brief into chat.

## Cost + cadence notes

- YouTube: ~410 quota units/run of the 10k/day (shares YOUTUBE_API_KEY with metrics-pull) — fine daily, don't hammer manually.
- GitHub: unauthenticated is fine; set GITHUB_TOKEN for burst headroom (same note as github-trending skill).
- Reddit has NO direct path (all free routes 403) — smol.ai is the Reddit proxy. If direct Reddit ever matters, it needs a free Reddit script-app OAuth token (future work).
- Optional upgrade: SOCIALDATA_API_KEY (socialdata.tools, ~$0.20/1k tweets) would add real X engagement numbers for a ~20-account watchlist; not wired yet.
- Local-only: this stays on the local runner / manual invocation, never cloud /schedule (per Chase's standing preference for personal-inbox workflows).
