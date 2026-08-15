---
name: metrics-pull
description: Pull current values for Chase AI audience + Claude usage metrics (Claude 5h tokens, YouTube subs/views, Instagram followers, TikTok followers) and append rows to the vault metrics CSV. Each source writes its own status (ok/stale/error/mock) so the cockpit shows partial failures without crashing. Trigger on phrases like 'pull metrics', '/metrics-pull', 'refresh dashboard data', 'update the cockpit', or any explicit metric refresh request. Also fires on a 6-hour Windows Task Scheduler.
---

# metrics-pull

Refresh the metric strip that feeds the Obsidian Command Center plugin + Streamlit dashboard.

## Output contract (frozen)

**CSV:** `<vault>/system/metrics/metrics.csv` — append-only, never rewrite.

Schema:
```
timestamp,source,metric,value,status,error
2026-05-13T03:20:30Z,claude_code,tokens_5h,1055478,ok,
2026-05-13T03:20:29Z,youtube,subscribers,124000,ok,
2026-05-13T03:20:29Z,tiktok,followers,1102,stale,layout_change
```

- `timestamp` — ISO 8601 UTC, `Z` suffix.
- `source` — one of: `claude_code`, `youtube`, `instagram`, `tiktok`.
- `metric` — one of: `tokens_5h`, `billable_5h`, `cache_read_5h`, `subscribers`, `views_28d`, `latest_video_views`, `followers`.
- `value` — numeric. Floats for currency, ints for counts.
- `status` — `ok` (fresh, real) | `mock` (synthetic, no creds) | `stale` (last-known, scraper failed) | `error` (could not pull, value=0).
- `error` — short machine-readable reason string when status≠ok, empty otherwise.

**Snapshot:** `<vault>/system/metrics/last-pull.json` — per-source `{ ts, status, error }`, rewritten each pull (NOT append-only).

## Workflow

Run pull scripts in parallel. Each script is independent — failures in one don't block others.

```bash
python "$HOME/.claude/skills/metrics-pull/scripts/pull_claude_usage.py"
python "$HOME/.claude/skills/metrics-pull/scripts/pull_youtube.py"
python "$HOME/.claude/skills/metrics-pull/scripts/pull_instagram.py"
python "$HOME/.claude/skills/metrics-pull/scripts/pull_tiktok.py"
```

Wrapper: `scripts/run_all.ps1` runs all four in parallel via Start-Job with a
90s timeout. Cron-friendly — never throws.

## Sources + auth

| Source | Auth | Notes |
|---|---|---|
| Claude 5h tokens | none — reads local ccusage/ledger | always ok unless ledger missing |
| YouTube subs/views | `YOUTUBE_API_KEY` (Data API v3) + `YOUTUBE_CHANNEL_ID` in `~/.claude/.env` | real |
| Instagram followers | `INSTAGRAM_HANDLE` in `~/.claude/.env` + playwright + chromium | scrapes public meta tag; falls back to stale on layout change |
| TikTok followers | `TIKTOK_HANDLE` in `~/.claude/.env` + playwright + chromium | scrapes public profile; falls back to stale on layout change |

## Idempotency

Scripts may be run any frequency — each invocation = one new row per source. Plugin reads latest row per source for current value and 24h-ago row for delta. Multiple rows per day = fine.

## Error handling

- **No creds:** write row with `status=mock` and synthetic value. Never fail the pull.
- **API call fails:** write row with `status=error`, `value=last_known_or_0`, `error=<reason>`. Cockpit dims that card.
- **Scraper layout change (M2 Playwright sources):** write row with `status=stale`, `value=last_known`, `error=layout_change`.

## See also

- Schema: [[daily-note]] sibling — `system/schemas/` directory
- Plugin consumer: `~/projects/chase-command-center/src/lib/metrics.ts`
- Task Scheduler setup: [[reference_local-cron-pattern]] (M5)
