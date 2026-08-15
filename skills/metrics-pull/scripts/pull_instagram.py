"""
pull_instagram.py — Instagram follower count for Chase AI agentic-OS cockpit.

Modes:
  - Real: Playwright scrape of instagram.com/<handle> (requires `playwright`
    Python package + persistent auth context). Best-effort — IG layout changes
    will silently break it; we flip to status='stale' and reuse last_known_value.
  - Mock: missing handle / no Playwright → synthetic.

M2 ships with the real-scrape implementation stubbed. To enable:
  1. `pip install playwright` and `playwright install chromium`
  2. Set INSTAGRAM_HANDLE in env or ~/.claude/.env
  3. Run pull_instagram.py once interactively to seed auth state
     (currently uses persistent context dir at ~/.playwright-cli/ig-state).
"""

from __future__ import annotations

import json
import random
import sys
from pathlib import Path

from _common import emit, env, last_known_value, parse_common_args

SOURCE = "instagram"
METRIC = "followers"
AUTH_STATE = Path.home() / ".playwright-cli" / "ig-state"


def _parse_count(raw: str) -> int:
    """IG meta shows '1,234' on small accounts, '195K' / '1.2M' on larger ones
    (rounded for anon viewers). Parse all forms to int."""
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
            page.goto(
                f"https://www.instagram.com/{handle}/", timeout=15000
            )
            # Instagram exposes follower count in og:description meta on public profiles
            # and in the header for logged-in views. Try meta first (cheap).
            content = page.locator('meta[name="description"]').get_attribute(
                "content", timeout=8000
            )
            ctx.close()
        if not content:
            return (
                int(last_known_value(SOURCE, METRIC)),
                "stale",
                "ig_meta_missing",
            )
        # e.g. "1,234 Followers..." (small accts) or "195K Followers..." (rounded)
        followers_str = content.split(" Followers")[0].split()[-1]
        followers = _parse_count(followers_str)
        return (followers, "ok", "")
    except Exception as exc:
        return (
            int(last_known_value(SOURCE, METRIC)),
            "stale",
            f"ig_scrape:{type(exc).__name__}",
        )


def pull_mock() -> tuple[int, str, str]:
    base = 1450
    drift = random.randint(-5, 12)
    return (base + drift, "mock", "")


def main(argv: list[str]) -> int:
    ts_override, force_mock = parse_common_args(argv)
    handle = None if force_mock else env("INSTAGRAM_HANDLE")

    if handle:
        value, status, error = pull_real(handle)
    else:
        value, status, error = pull_mock()

    payload = emit(SOURCE, METRIC, value, status, error, ts=ts_override)
    print(json.dumps(payload, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
