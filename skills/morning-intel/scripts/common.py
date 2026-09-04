"""
Shared helpers for morning-intel fetchers.

Every fetcher:
  - writes <VAULT>/inbox/research/morning-intel/cache/YYYY-MM-DD/<source>.json
  - ALWAYS exits 0 (metrics-pull pattern) — failures become status=error in the
    JSON so the synthesis pass can degrade gracefully instead of crashing.

JSON contract:
  { "source": str, "status": "ok"|"stale"|"error"|"mock",
    "error": str, "fetched_at": iso8601Z, "items": [...] }
"""
from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

CT = ZoneInfo("America/Chicago")
USER_AGENT = "chase-agentic-os-morning-intel/1.0"


def vault_root() -> Path:
    """Mirror runner.js / github-trending path resolution."""
    env = os.environ.get("AGENTIC_OS_VAULT")
    if env:
        return Path(env)
    dotenv = Path.home() / ".claude" / ".env"
    if dotenv.exists():
        for line in dotenv.read_text(encoding="utf-8-sig").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            if k.strip() == "AGENTIC_OS_VAULT":
                return Path(v.strip().strip('"').strip("'"))
    return Path.home() / "the-vault"


def dotenv_get(key: str) -> str | None:
    if os.environ.get(key):
        return os.environ[key]
    dotenv = Path.home() / ".claude" / ".env"
    if dotenv.exists():
        for line in dotenv.read_text(encoding="utf-8-sig").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            if k.strip() == key:
                return v.strip().strip('"').strip("'")
    return None


def today_str() -> str:
    return datetime.now(CT).strftime("%Y-%m-%d")


def cache_dir() -> Path:
    d = vault_root() / "inbox" / "research" / "morning-intel" / "cache" / today_str()
    d.mkdir(parents=True, exist_ok=True)
    return d


def http_get(url: str, timeout: int = 30, headers: dict | None = None) -> bytes:
    req = urllib.request.Request(url)
    req.add_header("User-Agent", USER_AGENT)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def strip_html(text: str, limit: int = 400) -> str:
    text = re.sub(r"<(script|style)\b[^>]*>.*?</\1>", " ", text, flags=re.S | re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"&amp;", "&", text)
    text = re.sub(r"&lt;", "<", text)
    text = re.sub(r"&gt;", ">", text)
    text = re.sub(r"&#?\w+;", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:limit]


def write_result(source: str, status: str, items: list, error: str = "") -> None:
    out = cache_dir() / f"{source}.json"
    payload = {
        "source": source,
        "status": status,
        "error": error,
        "fetched_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "items": items,
    }
    out.write_text(json.dumps(payload, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"{source}: {status} ({len(items)} items) -> {out}")
