"""
pull_youtube.py — YouTube channel stats for Chase AI agentic-OS cockpit.

Modes:
  - Real: YOUTUBE_API_KEY + YOUTUBE_CHANNEL_ID → calls Data API v3 channels.list.
  - Mock: missing creds → synthetic subs + views.

Writes two rows per invocation:
  - youtube / subscribers
  - youtube / views_28d  (lifetime views as proxy; switch to 28d via Analytics API once OAuth is wired)
"""

from __future__ import annotations

import json
import random
import sys
import urllib.error
import urllib.request
from pathlib import Path

from _common import VAULT_METRICS, emit, env, now_iso, parse_common_args

SOURCE = "youtube"
API_URL = (
    "https://www.googleapis.com/youtube/v3/channels"
    "?part=statistics&id={channel_id}&key={api_key}"
)
PLAYLIST_URL = (
    "https://www.googleapis.com/youtube/v3/playlistItems"
    "?part=snippet,contentDetails&maxResults=1&playlistId={pid}&key={api_key}"
)
VIDEOS_URL = (
    "https://www.googleapis.com/youtube/v3/videos"
    "?part=statistics,snippet&id={vid}&key={api_key}"
)
LATEST_VIDEO_PATH = VAULT_METRICS / "latest-video.json"


def pull_real(api_key: str, channel_id: str) -> tuple[dict, str, str]:
    url = API_URL.format(channel_id=channel_id, api_key=api_key)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "chase-cc/0.1"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        items = body.get("items") or []
        if not items:
            return ({}, "error", "channel_not_found")
        stats = items[0].get("statistics", {})
        return (
            {
                "subscribers": int(stats.get("subscriberCount", 0)),
                "views_28d": int(stats.get("viewCount", 0)),
            },
            "ok",
            "",
        )
    except urllib.error.HTTPError as exc:
        return ({}, "error", f"yt_http:{exc.code}")
    except urllib.error.URLError:
        return ({}, "error", "yt_network")
    except Exception as exc:
        return ({}, "error", f"yt:{type(exc).__name__}")


def pull_mock() -> tuple[dict, str, str]:
    return (
        {
            "subscribers": 7900 + random.randint(-15, 40),
            "views_28d": 412_000 + random.randint(-2_000, 6_000),
        },
        "mock",
        "",
    )


def pull_latest_video(api_key: str, channel_id: str) -> tuple[dict, str, str]:
    pid = "UU" + channel_id[2:]
    try:
        url = PLAYLIST_URL.format(pid=pid, api_key=api_key)
        req = urllib.request.Request(url, headers={"User-Agent": "chase-cc/0.1"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        items = body.get("items") or []
        if not items:
            return ({}, "error", "no_uploads")
        item = items[0]
        details = item.get("contentDetails", {})
        snippet = item.get("snippet", {})
        video_id = details.get("videoId")
        if not video_id:
            return ({}, "error", "no_video_id")
        published_at = details.get("videoPublishedAt") or snippet.get("publishedAt", "")
        title = snippet.get("title", "")

        vurl = VIDEOS_URL.format(vid=video_id, api_key=api_key)
        vreq = urllib.request.Request(vurl, headers={"User-Agent": "chase-cc/0.1"})
        with urllib.request.urlopen(vreq, timeout=15) as vresp:
            vbody = json.loads(vresp.read().decode("utf-8"))
        vitems = vbody.get("items") or []
        if not vitems:
            return ({}, "error", "video_not_found")
        stats = vitems[0].get("statistics", {})
        return (
            {
                "video_id": video_id,
                "title": title,
                "url": f"https://youtu.be/{video_id}",
                "published_at": published_at,
                "views": int(stats.get("viewCount", 0)),
                "likes": int(stats.get("likeCount", 0)),
                "comments": int(stats.get("commentCount", 0)),
            },
            "ok",
            "",
        )
    except urllib.error.HTTPError as exc:
        return ({}, "error", f"yt_http:{exc.code}")
    except urllib.error.URLError:
        return ({}, "error", "yt_network")
    except Exception as exc:
        return ({}, "error", f"yt:{type(exc).__name__}")


def latest_video_mock() -> tuple[dict, str, str]:
    return (
        {
            "video_id": "dQw4w9WgXcQ",
            "title": "Building an Agentic OS in Obsidian (mock)",
            "url": "https://youtu.be/dQw4w9WgXcQ",
            "published_at": "2026-05-09T18:00:00Z",
            "views": 4321 + random.randint(0, 200),
            "likes": 187 + random.randint(0, 10),
            "comments": 23 + random.randint(0, 4),
        },
        "mock",
        "",
    )


def write_latest_video_snapshot(data: dict, status: str, error: str, ts: str) -> None:
    payload = {**data, "ts": ts, "status": status, "error": error}
    VAULT_METRICS.mkdir(parents=True, exist_ok=True)
    LATEST_VIDEO_PATH.write_text(
        json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8"
    )


def main(argv: list[str]) -> int:
    ts_override, force_mock = parse_common_args(argv)
    api_key = None if force_mock else env("YOUTUBE_API_KEY")
    channel_id = None if force_mock else env("YOUTUBE_CHANNEL_ID")

    if api_key and channel_id:
        values, status, error = pull_real(api_key, channel_id)
    else:
        values, status, error = pull_mock()

    if not values:
        # error path — still write zero rows so cockpit sees the error state
        payloads = [
            emit(SOURCE, "subscribers", 0, status, error, ts=ts_override),
            emit(SOURCE, "views_28d", 0, status, error, ts=ts_override),
        ]
    else:
        payloads = [
            emit(SOURCE, metric, values[metric], status, error, ts=ts_override)
            for metric in ("subscribers", "views_28d")
        ]

    # latest video — separate fetch, separate snapshot file
    if api_key and channel_id:
        lv_data, lv_status, lv_error = pull_latest_video(api_key, channel_id)
    else:
        lv_data, lv_status, lv_error = latest_video_mock()

    lv_ts = ts_override or now_iso()
    if lv_data:
        write_latest_video_snapshot(lv_data, lv_status, lv_error, lv_ts)
        payloads.append(
            emit(SOURCE, "latest_video_views", lv_data["views"], lv_status, lv_error, ts=ts_override)
        )
    else:
        write_latest_video_snapshot({}, lv_status, lv_error, lv_ts)
        payloads.append(
            emit(SOURCE, "latest_video_views", 0, lv_status, lv_error, ts=ts_override)
        )

    print(json.dumps(payloads, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
