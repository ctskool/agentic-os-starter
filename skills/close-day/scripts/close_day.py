"""
close_day.py — End-of-day write-back to today's daily note.

Updates frontmatter (effort, focus_blocks, posts_shipped, videos_shipped_today,
top3_done) and overwrites the ## EOD Reflection section. Preserves all other
content verbatim.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path

VAULT_ROOT = Path(os.environ.get("AGENTIC_OS_VAULT") or os.environ.get("CHASE_VAULT_ROOT") or (Path.home() / "the-vault"))
DAILY_DIR = VAULT_ROOT / "daily-notes"


def parse_posts(raw: str | None) -> dict[str, int]:
    out = {
        "youtube": 0,
        "blog": 0,
        "linkedin": 0,
        "x": 0,
        "instagram": 0,
        "tiktok": 0,
    }
    if not raw:
        return out
    for chunk in raw.split(","):
        chunk = chunk.strip()
        if "=" not in chunk:
            continue
        k, v = chunk.split("=", 1)
        k = k.strip().lower()
        try:
            out[k] = int(v.strip())
        except (ValueError, KeyError):
            continue
    return out


def split_frontmatter(raw: str) -> tuple[str, str]:
    """Returns (frontmatter_yaml_no_fences, body_starting_after_---)."""
    if not raw.startswith("---"):
        raise ValueError("no frontmatter fence at start of file")
    end = raw.find("\n---", 3)
    if end < 0:
        raise ValueError("no closing frontmatter fence")
    fm = raw[3:end].lstrip("\n")
    body = raw[end + 4 :].lstrip("\n")
    return fm, body


def parse_top3_done_from_body(body: str) -> list[bool]:
    """Parse the `## Top 3 Priorities` section for `[x]` checkboxes (in order)."""
    out = [False, False, False]
    in_section = False
    for line in body.split("\n"):
        if line.strip().startswith("## "):
            in_section = line.strip() == "## Top 3 Priorities"
            continue
        if not in_section:
            continue
        m = re.match(r"^\s*(\d+)\.\s+\[([ xX])\]\s+", line)
        if m:
            idx = int(m.group(1)) - 1
            if 0 <= idx < 3:
                out[idx] = m.group(2).lower() == "x"
    return out


def update_frontmatter(
    fm: str,
    effort: int | None,
    blocks: int | None,
    posts: dict[str, int],
    videos: int | None,
    top3_done: list[bool],
) -> str:
    """Crude line-based YAML edit. Schema is small + flat so this is safer than
    a full YAML round-trip (which may reorder + reflow user-edited keys)."""
    lines = fm.split("\n")
    out: list[str] = []
    i = 0
    in_posts_block = False
    posts_replaced = False

    while i < len(lines):
        line = lines[i]
        stripped = line.lstrip()

        # Stay inside posts_shipped block until indent decreases
        if in_posts_block:
            if line.startswith("  ") and ":" in stripped:
                # consumed by replacement; skip original lines
                i += 1
                continue
            else:
                in_posts_block = False

        if stripped.startswith("effort:") and effort is not None:
            out.append(f"effort: {effort}")
        elif stripped.startswith("focus_blocks:") and blocks is not None:
            out.append(f"focus_blocks: {blocks}")
        elif stripped.startswith("videos_shipped_today:") and videos is not None:
            out.append(f"videos_shipped_today: {videos}")
        elif stripped.startswith("top3_done:"):
            done_lit = (
                "[" + ", ".join("true" if v else "false" for v in top3_done) + "]"
            )
            out.append(f"top3_done: {done_lit}")
        elif stripped.startswith("posts_shipped:"):
            out.append("posts_shipped:")
            for k in ("youtube", "blog", "linkedin", "x", "instagram", "tiktok"):
                out.append(f"  {k}: {posts.get(k, 0)}")
            in_posts_block = True
            posts_replaced = True
        else:
            out.append(line)
        i += 1

    if not posts_replaced and any(posts.values()):
        out.append("posts_shipped:")
        for k in ("youtube", "blog", "linkedin", "x", "instagram", "tiktok"):
            out.append(f"  {k}: {posts.get(k, 0)}")

    return "\n".join(out)


def replace_eod_section(body: str, text: str) -> str:
    lines = body.split("\n")
    out: list[str] = []
    in_eod = False
    replaced = False
    for line in lines:
        if line.strip().startswith("## "):
            if line.strip() == "## EOD Reflection":
                out.append(line)
                out.append("")
                out.append(text.strip())
                out.append("")
                in_eod = True
                replaced = True
                continue
            else:
                in_eod = False
                out.append(line)
                continue
        if in_eod:
            continue  # discard old EOD content
        out.append(line)

    if not replaced:
        # Append a new section at end.
        if out and out[-1].strip() != "":
            out.append("")
        out.append("## EOD Reflection")
        out.append("")
        out.append(text.strip())
        out.append("")

    return "\n".join(out)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--effort", type=int, default=None)
    ap.add_argument("--blocks", type=int, default=None)
    ap.add_argument(
        "--posts", default=None, help='e.g. "youtube=1,linkedin=2,x=1"'
    )
    ap.add_argument("--videos", type=int, default=None)
    ap.add_argument("--text", default="", help="reflection body")
    ap.add_argument("--date", default=None)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    date = args.date or datetime.now().strftime("%Y-%m-%d")
    path = DAILY_DIR / f"{date}.md"

    if not path.exists():
        print(
            json.dumps(
                {
                    "status": "missing",
                    "path": str(path),
                    "message": "no daily note for that date — run /today first",
                },
                indent=2,
            )
        )
        return 1

    raw = path.read_text(encoding="utf-8")
    fm, body = split_frontmatter(raw)
    posts = parse_posts(args.posts)
    top3_done = parse_top3_done_from_body(body)

    # videos_shipped_today is independent of posts_shipped (YouTube video uploads,
    # not generic post counts). Only update if --videos explicitly given.
    fm_new = update_frontmatter(
        fm,
        effort=args.effort,
        blocks=args.blocks,
        posts=posts,
        videos=args.videos,
        top3_done=top3_done,
    )
    body_new = replace_eod_section(body, args.text)

    rebuilt = f"---\n{fm_new}\n---\n\n{body_new}"
    if not rebuilt.endswith("\n"):
        rebuilt += "\n"

    if args.dry_run:
        print(
            json.dumps(
                {
                    "status": "dry-run",
                    "path": str(path),
                    "top3_done": top3_done,
                    "posts": posts,
                    "effort": args.effort,
                    "blocks": args.blocks,
                    "videos": args.videos,
                    "preview": rebuilt,
                },
                indent=2,
            )
        )
        return 0

    path.write_text(rebuilt, encoding="utf-8")
    print(
        json.dumps(
            {
                "status": "updated",
                "path": str(path),
                "effort": args.effort,
                "blocks": args.blocks,
                "posts": posts,
                "videos_shipped_today": args.videos,
                "top3_done": top3_done,
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
