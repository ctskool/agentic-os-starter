"""
YouTube trending in the Claude Code / Codex sphere via the Data API v3
(YOUTUBE_API_KEY from ~/.claude/.env — same key metrics-pull uses).

Cost: 4 search.list calls (100 units each) + 2 batch lookups = ~410 units of
the 10,000/day quota. Fine for daily runs alongside metrics-pull.

Signal: views AND views/subs engagement ratio (the outlier detector — a 20K-view
video on a 40K-sub channel beats a 100K-view video on a 2M-sub channel).
"""
from __future__ import annotations

import json
import sys
import urllib.parse
from datetime import datetime, timedelta, timezone

from common import dotenv_get, http_get, write_result

QUERIES = ["claude code", "openai codex", "ai coding agent", "claude skills"]
DAYS_BACK = 7
PER_QUERY = 15
API = "https://www.googleapis.com/youtube/v3"


def get_json(path: str, params: dict, key: str) -> dict:
    params = {**params, "key": key}
    url = f"{API}/{path}?{urllib.parse.urlencode(params)}"
    return json.loads(http_get(url))


def main() -> None:
    key = dotenv_get("YOUTUBE_API_KEY")
    if not key:
        write_result("youtube", "mock", [], "no YOUTUBE_API_KEY")
        sys.exit(0)
    try:
        published_after = (
            datetime.now(timezone.utc) - timedelta(days=DAYS_BACK)
        ).strftime("%Y-%m-%dT%H:%M:%SZ")
        vid_ids: dict[str, str] = {}  # id -> query that found it
        for q in QUERIES:
            data = get_json("search", {
                "part": "id", "q": q, "type": "video", "order": "viewCount",
                "publishedAfter": published_after, "maxResults": PER_QUERY,
                "relevanceLanguage": "en", "regionCode": "US",
            }, key)
            for it in data.get("items", []):
                vid_ids.setdefault(it["id"]["videoId"], q)
        if not vid_ids:
            write_result("youtube", "error", [], "no videos returned")
            sys.exit(0)

        # batch video stats (50/call max)
        ids = list(vid_ids)
        videos = []
        for i in range(0, len(ids), 50):
            data = get_json("videos", {
                "part": "snippet,statistics", "id": ",".join(ids[i:i + 50]),
            }, key)
            videos += data.get("items", [])

        # batch channel subs
        ch_ids = sorted({v["snippet"]["channelId"] for v in videos})
        subs: dict[str, int] = {}
        for i in range(0, len(ch_ids), 50):
            data = get_json("channels", {
                "part": "statistics", "id": ",".join(ch_ids[i:i + 50]),
            }, key)
            for c in data.get("items", []):
                subs[c["id"]] = int(c["statistics"].get("subscriberCount", 0) or 0)

        items = []
        for v in videos:
            sn, st = v["snippet"], v.get("statistics", {})
            views = int(st.get("viewCount", 0) or 0)
            ch_subs = subs.get(sn["channelId"], 0)
            items.append({
                "title": sn["title"],
                "channel": sn["channelTitle"],
                "channel_subs": ch_subs,
                "published": sn["publishedAt"][:10],
                "views": views,
                "ratio": round(views / ch_subs, 2) if ch_subs else None,
                "url": f"https://youtube.com/watch?v={v['id']}",
                "query": vid_ids.get(v["id"], ""),
            })
        # keep: top 15 by views + top 10 outliers by ratio (subs >= 1000)
        by_views = sorted(items, key=lambda i: i["views"], reverse=True)[:15]
        outliers = sorted(
            (i for i in items if i["channel_subs"] >= 1000 and i["ratio"]),
            key=lambda i: i["ratio"], reverse=True,
        )[:10]
        seen, merged = set(), []
        for i in by_views + outliers:
            if i["url"] not in seen:
                seen.add(i["url"])
                i["outlier"] = i in outliers
                merged.append(i)
        write_result("youtube", "ok", merged)
    except Exception as e:
        write_result("youtube", "error", [], str(e)[:200])
    sys.exit(0)


if __name__ == "__main__":
    main()
