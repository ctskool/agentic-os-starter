"""
pull_tiktok.py — TikTok follower count for Chase AI agentic-OS cockpit.

Same shape as pull_instagram.py. Best-effort Playwright scrape; on failure
returns last_known_value with status='stale'.

TikTok's public profile DOM hides counts behind h2[data-e2e="followers-count"]
or a strong tag with the same data-e2e attribute. Layout changes often.
"""

from __future__ import annotations

import json
import random
import sys
from pathlib import Path

from _common import emit, env, last_known_value, parse_common_args

SOURCE = "tiktok"
METRIC = "followers"
AUTH_STATE = Path.home() / ".playwright-cli" / "tt-state"


def _parse_count(raw: str) -> int:
    """TikTok shows '12.3K', '4.2M' etc. Parse to int."""
    raw = raw.strip().upper().replace(",", "")
    if raw.endswith("K"):
        return int(float(raw[:-1]) * 1_000)
    if raw.endswith("M"):
        return int(float(raw[:-1]) * 1_000_000)
    if raw.endswith("B"):
        return int(float(raw[:-1]) * 1_000_000_000)
    return int(float(raw))


def pull_real(handle: str) -> tuple[int, str, str]:
    try:
        from playwright.sync_api import sync_playwright  # type: ignore
    except ImportError:
        return (int(last_known_value(SOURCE, METRIC)), "stale", "playwright_missing")

    AUTH_STATE.mkdir(parents=True, exist_ok=True)
    try:
        with sync_playwright() as p:
            ctx = p.chromium.launch_persistent_context(
                str(AUTH_STATE), headless=True
            )
            page = ctx.new_page()
            page.goto(f"https://www.tiktok.com/@{handle}", timeout=15000)
            raw = page.locator(
                'strong[data-e2e="followers-count"]'
            ).inner_text(timeout=8000)
            ctx.close()
        return (_parse_count(raw), "ok", "")
    except Exception as exc:
        return (
            int(last_known_value(SOURCE, METRIC)),
            "stale",
            f"tt_scrape:{type(exc).__name__}",
        )


def pull_mock() -> tuple[int, str, str]:
    base = 1102
    drift = random.randint(-3, 8)
    return (base + drift, "mock", "")


def main(argv: list[str]) -> int:
    ts_override, force_mock = parse_common_args(argv)
    handle = None if force_mock else env("TIKTOK_HANDLE")

    if handle:
        value, status, error = pull_real(handle)
    else:
        value, status, error = pull_mock()

    payload = emit(SOURCE, METRIC, value, status, error, ts=ts_override)
    print(json.dumps(payload, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
