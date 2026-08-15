"""
smol.ai AI News RSS — the highest-leverage single source: machine-monitors
~544 X accounts + 12 subreddits + top AI Discords daily (weekdays only).
"""
from __future__ import annotations

import sys
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

from common import http_get, strip_html, write_result

FEED = "https://news.smol.ai/rss.xml"


def main() -> None:
    try:
        raw = http_get(FEED)
        root = ET.fromstring(raw)
        items = []
        for it in root.iter("item"):
            title = (it.findtext("title") or "").strip()
            link = (it.findtext("link") or "").strip()
            pub = (it.findtext("pubDate") or "").strip()
            desc = strip_html(it.findtext("description") or "", 1200)
            items.append({"title": title, "link": link, "pubDate": pub, "summary": desc})
        items = items[:5]  # newest issues only
        status = "ok"
        # weekdays-only feed: flag stale if newest item > 4 days old
        if items:
            try:
                newest = parsedate_to_datetime(items[0]["pubDate"])
                age_days = (datetime.now(timezone.utc) - newest).total_seconds() / 86400
                if age_days > 4:
                    status = "stale"
            except Exception:
                pass
        write_result("smol", status, items)
    except Exception as e:
        write_result("smol", "error", [], str(e)[:200])
    sys.exit(0)


if __name__ == "__main__":
    main()
