"""
Hacker News via the Algolia API (no auth, never rate-limited us).

Two pulls:
  1. Current front page (tags=front_page) — the day's dev-sentiment read.
  2. Last-24h AI/agent stories by points (query battery, deduped, points >= 10).
"""
from __future__ import annotations

import json
import sys
import time
import urllib.parse

from common import http_get, write_result

API = "https://hn.algolia.com/api/v1/search"
QUERIES = ["claude code", "codex", "anthropic", "openai", "coding agent", "llm"]
MIN_POINTS = 10


def hit_to_item(h: dict, bucket: str) -> dict:
    return {
        "bucket": bucket,
        "title": h.get("title") or "",
        "url": h.get("url") or f"https://news.ycombinator.com/item?id={h.get('objectID')}",
        "hn_url": f"https://news.ycombinator.com/item?id={h.get('objectID')}",
        "points": h.get("points") or 0,
        "comments": h.get("num_comments") or 0,
        "created_at": h.get("created_at") or "",
        "objectID": h.get("objectID"),
    }


def main() -> None:
    items, errors = [], []
    # 1. front page
    try:
        raw = json.loads(http_get(f"{API}?tags=front_page&hitsPerPage=30"))
        items += [hit_to_item(h, "front_page") for h in raw.get("hits", [])]
    except Exception as e:
        errors.append(f"front_page:{e}")
    # 2. last-24h AI stories
    seen = {i["objectID"] for i in items}
    cutoff = int(time.time()) - 86400
    for q in QUERIES:
        try:
            url = (
                f"{API}?query={urllib.parse.quote(q)}&tags=story"
                f"&numericFilters=created_at_i%3E{cutoff}&hitsPerPage=20"
            )
            raw = json.loads(http_get(url))
            for h in raw.get("hits", []):
                if h.get("objectID") in seen or (h.get("points") or 0) < MIN_POINTS:
                    continue
                seen.add(h.get("objectID"))
                items.append(hit_to_item(h, "ai_24h"))
        except Exception as e:
            errors.append(f"{q}:{e}")
    items.sort(key=lambda i: i["points"], reverse=True)
    status = "ok" if items else "error"
    write_result("hn", status, items, "; ".join(str(e)[:80] for e in errors))
    sys.exit(0)


if __name__ == "__main__":
    main()
