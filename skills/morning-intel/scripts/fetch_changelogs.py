"""
Official changelogs, best-effort (both are ordinary HTML that may drift):
  - Codex CLI: developers.openai.com/codex/changelog (308s to learn.chatgpt.com)
  - Claude Code releases: releasebot.io/updates/anthropic/claude-code

Raw text excerpts only — synthesis pass extracts what's new.
"""
from __future__ import annotations

import sys

from common import http_get, strip_html, write_result

SOURCES = [
    ("codex-changelog", "https://learn.chatgpt.com/docs/changelog"),
    ("claude-code-releases", "https://releasebot.io/updates/anthropic/claude-code"),
]
EXCERPT = 6000


def main() -> None:
    items, errors = [], []
    for name, url in SOURCES:
        try:
            raw = http_get(url).decode("utf-8", "ignore")
            items.append({"name": name, "url": url, "text": strip_html(raw, EXCERPT)})
        except Exception as e:
            errors.append(f"{name}:{str(e)[:80]}")
    status = "ok" if len(items) == len(SOURCES) else ("stale" if items else "error")
    write_result("changelogs", status, items, "; ".join(errors))
    sys.exit(0)


if __name__ == "__main__":
    main()
