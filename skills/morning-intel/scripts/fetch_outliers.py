"""
Small-channel outlier videos from the outlier-radar skill (last 24h of runs).

Costs ZERO YouTube quota: the OutlierRadar scheduled task (every 6h) already
did the searching/scoring — this just parses its vault reports:
  <VAULT>/inbox/research/outlier-radar/YYYY-MM-DD-outliers.md

Bullet format written by that skill's fetch.py (the "(vel Nx)" velocity part
was added 2026-08-11; the regex accepts lines with or without it):
  - **[TITLE](https://youtu.be/ID)** — **2.3x** (vel 12.3x) | 45.1k views in
    38h | [CHANNEL](https://www.youtube.com/channel/CID) (12.3k subs) | via
    search "q"

Status: ok (items, possibly 0 = radar ran but found nothing new),
stale (no radar report in the window — task likely not running).
"""
from __future__ import annotations

import re
import sys
from datetime import datetime, timedelta

from common import CT, vault_root, write_result

RADAR_DIR = vault_root() / "inbox" / "research" / "outlier-radar"
WINDOW_HOURS = 24

RUN_RE = re.compile(r"^## Run (\d{2}):(\d{2})\s*$")
BULLET_RE = re.compile(
    r"^- \*\*\[(?P<title>.*?)\]\(https://youtu\.be/(?P<id>[\w-]+)\)\*\* — "
    r"\*\*(?P<mult>>?[\d.]+)x\*\*(?: \(vel (?P<vel>>?[\d.?]+)x?\))? \| "
    r"(?P<views>\S+) views in (?P<age>\S+) \| "
    r"\[(?P<channel>.*?)\]\(https://www\.youtube\.com/channel/(?P<cid>[\w-]+)\) "
    r"\((?P<subs>\S+) subs\) \| via (?P<source>.+)$"
)


def main() -> None:
    now = datetime.now(CT)
    cutoff = now - timedelta(hours=WINDOW_HOURS)
    items: list[dict] = []
    files_seen = 0
    runs_in_window = 0

    for day in (now, now - timedelta(days=1)):
        path = RADAR_DIR / f"{day:%Y-%m-%d}-outliers.md"
        if not path.exists():
            continue
        files_seen += 1
        run_dt: datetime | None = None
        run_fresh = False
        for line in path.read_text(encoding="utf-8").splitlines():
            m = RUN_RE.match(line)
            if m:
                run_dt = day.replace(
                    hour=int(m.group(1)), minute=int(m.group(2)),
                    second=0, microsecond=0,
                )
                run_fresh = run_dt >= cutoff
                if run_fresh:
                    runs_in_window += 1
                continue
            b = BULLET_RE.match(line)
            if b and run_fresh:
                items.append({
                    "title": b["title"],
                    "url": f"https://youtu.be/{b['id']}",
                    "video_id": b["id"],
                    "multiplier": b["mult"] + "x",
                    "velocity": (b["vel"] + "x") if b["vel"] else None,
                    "views": b["views"],
                    "age": b["age"],
                    "channel": b["channel"],
                    "channel_url": f"https://www.youtube.com/channel/{b['cid']}",
                    "subs": b["subs"],
                    "found_via": b["source"],
                    "run_at": run_dt.strftime("%Y-%m-%d %H:%M") if run_dt else "",
                })

    if runs_in_window == 0:
        note = (
            "no outlier-radar report found for today/yesterday"
            if files_seen == 0
            else f"reports exist but no runs in last {WINDOW_HOURS}h"
        ) + " — check the OutlierRadar scheduled task"
        write_result("outliers", "stale", items, note)
    else:
        write_result("outliers", "ok", items)
    sys.exit(0)


if __name__ == "__main__":
    main()
