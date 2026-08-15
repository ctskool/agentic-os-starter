"""
today_init.py — Idempotent creator for today's daily note.

Writes daily-notes/YYYY-MM-DD.md matching frozen schema v1 (see
`the vault/system/schemas/daily-note.md`). If the file already exists,
this script is a no-op — Chase's notes are never overwritten by automation.

Args:
  --carryover "item text"     (repeatable; sets Top 3 lines in order)
  --schedule "HH:MM — Title"  (repeatable; sets Schedule lines)
  --focus "today's focus"     (optional; sets frontmatter focus + section)
  --date YYYY-MM-DD           (override today; useful for backfill)
  --dry-run                   (print path + planned content, write nothing)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path

VAULT_ROOT = Path(os.environ.get("AGENTIC_OS_VAULT") or os.environ.get("CHASE_VAULT_ROOT") or (Path.home() / "the-vault"))
DAILY_DIR = VAULT_ROOT / "daily-notes"
SCHEMA_VERSION = 1


def build_body(date: str, focus: str, top3: list[str], schedule: list[str]) -> str:
    # Pad/truncate carryover to exactly 3 slots.
    items = list(top3[:3])
    while len(items) < 3:
        items.append("")

    top3_yaml = "\n".join(
        f"  - {json.dumps(item)}" if item else '  - ""' for item in items
    )

    schedule_lines = (
        "\n".join(f"- {entry}" for entry in schedule) if schedule else "- "
    )

    focus_yaml_value = json.dumps(focus) if focus else '""'

    return f"""---
date: {date}
schema_version: {SCHEMA_VERSION}
focus: {focus_yaml_value}
top3:
{top3_yaml}
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

# {date}

## Current Focus
{focus}

## Top 3 Priorities
1. [ ] {items[0]}
2. [ ] {items[1]}
3. [ ] {items[2]}

## Schedule
{schedule_lines}

## Daily Drivers
- [ ] Skool post
- [ ] YouTube recording
- [ ] Inbox triage
- [ ] Daily review

## Activity Log


## Notes


## EOD Reflection

"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--carryover", action="append", default=[])
    ap.add_argument("--schedule", action="append", default=[])
    ap.add_argument("--focus", default="")
    ap.add_argument("--date", default=None)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    date = args.date or datetime.now().strftime("%Y-%m-%d")
    path = DAILY_DIR / f"{date}.md"

    if path.exists():
        print(
            json.dumps(
                {
                    "status": "exists",
                    "path": str(path),
                    "date": date,
                    "message": "daily note already exists; no overwrite",
                },
                indent=2,
            )
        )
        return 0

    body = build_body(date, args.focus, args.carryover, args.schedule)

    if args.dry_run:
        print(
            json.dumps(
                {
                    "status": "dry-run",
                    "path": str(path),
                    "date": date,
                    "preview": body,
                },
                indent=2,
            )
        )
        return 0

    DAILY_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")

    print(
        json.dumps(
            {
                "status": "created",
                "path": str(path),
                "date": date,
                "carryover_count": len(args.carryover),
                "schedule_count": len(args.schedule),
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
