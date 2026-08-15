---
name: github-trending
description: Pull last-7-days + last-30-days top GitHub repos by stars PLUS a fastest-growing (this-month star velocity) metric, classify AI/dev relevance, write to inbox/research/github-trending/YYYY-MM-DD-trending.md. Direct-exec (no AI in loop) — runner spawns the Python script directly. Use when the cockpit "GitHub Trending" card fires a refresh-new intent, or when manually invoked via /github-trending.
---

# GitHub Trending

Mechanical fetch — no AI judgment needed. Three metrics, ranks by stars / star-growth, flags AI/dev relevance from topics + description, writes markdown that the cockpit's `GithubTrendingCard` parses.

## The four metrics

1. **This Week** — repos `created:>7d`, sorted by stars (REST search API).
2. **This Month** — repos `created:>30d`, sorted by stars (REST search API).
3. **Fastest Growing (24h)** — top AI/dev repos by **stars gained today**, scraped from `github.com/trending?since=daily`. Catches same-day spikes before they build a monthly number.
4. **Fastest Growing (30d)** — top AI/dev repos by **stars gained this month**, scraped from `github.com/trending?since=monthly`. The durable breakouts.

Metrics 3 & 4 are the velocity pair. Unlike 1 & 2 (which filter on `created:<date>` and so only ever see brand-new repos), they surface a repo of **any age** that is suddenly ripping — the "came out two months ago and is now taking off" case. The trending page gives the star-growth number directly (no cross-run state needed); each AI/dev pick is enriched with one `GET /repos/{full}` call for stars + `created_at` + topics. If a scrape fails, that section degrades gracefully ("_Trending feed unavailable this run._") and the others still render.

_Note: a pure stars-sorted API query CANNOT do velocity — the top of that list is all mega-repos (50k+ stars), so a single-digit-k sleeper never appears in the sampled pool. The trending page is GitHub's own growth ranking and reaches those mid-size sleepers._

## Output

`inbox/research/github-trending/YYYY-MM-DD-trending.md`

Schema (frozen — `lib/reports.ts → parseTrendingRepos` depends on it):

```
# GitHub Trending - YYYY-MM-DD (Weekday)

## Top 10 Trending This Week
_Repos created in the last 7 days, ranked by stars_

### N. [owner/name](url) **[AI/DEV]?**
- **Stars:** N | **Language:** L
- **Created:** YYYY-MM-DD
- **Topics:** comma list or "none"
- **Description:** …

---

## Top 5 Trending This Month
_Repos created in the last 30 days, ranked by stars_

(same shape)

---

## Top 10 Fastest Growing (24h)
_AI/dev repos from GitHub's daily trending, ranked by stars gained today — any age_

### N. [owner/name](url) **[AI/DEV]?**
- **Growth:** +N stars today (created YYYY-MM-DD)
- **Stars:** N | **Language:** L
- **Created:** YYYY-MM-DD
- **Topics:** comma list or "none"
- **Description:** …

---

## Top 10 Fastest Growing (30d)
_AI/dev repos from GitHub's monthly trending, ranked by stars gained this month — any age_

(same shape, Growth line reads "+N stars this month")

(extra `**Growth:**` line vs sections 1 & 2 — `parseTrendingRepos` tags each block
with its section via the `## ` heading; "(24h)" → velocity-day, else velocity-month.)

---

## Content Radar
- **AI/Dev-relevant repos today:** X out of 10
- **Top AI pick:** [owner/name](url) - N stars
- **Why it matters:** description

_Generated automatically at HH:MM on YYYY-MM-DD_
```

## How runner invokes

Listed in `runner.js → isDirectExec` set. Runner spawns `python scripts/fetch.py` with `cwd: VAULT_ROOT`. Script writes the file. Runner logs exit code + first line.

## Manual invocation

```bash
python "$HOME/.claude/skills/github-trending/scripts/fetch.py"
```

Writes to vault if `AGENTIC_OS_VAULT` env var set, else `~/the-vault`.

## AI/Dev classifier

Substring match (case-insensitive) on topics OR description against:
`ai, llm, gpt, claude, anthropic, agent, mcp, prompt, embedding, rag, deepseek, kimi, gemini, openai, copilot, codex, fine-tun, transformer, ollama, langchain, ai-`

Not perfect — false positives on "DarkGPT"-style spam, false negatives on AI projects with vague descriptions. Good enough for a glance card.

## Rate limit

Calls per run: 2 Search API (week + month) + 1 HTML GET (trending page, not rate-limited) + up to ~1 enrich call per trending repo scanned until 5 AI/dev picks are found (`GET /repos/{full}`, typically 5–12 of the ~25 trending repos).

- Search API: unauthenticated = 10 req/min, 30 results/min — 2 reqs is fine.
- Core REST (the enrich calls): unauthenticated = 60/hr per IP — ~12 calls/run is fine for the 6-hourly schedule, but **bursty manual re-runs can exhaust it**. Set `GITHUB_TOKEN` to lift both to 5000/hr and remove the worry.

If `GITHUB_TOKEN` env var present, script uses it for the higher limit.
