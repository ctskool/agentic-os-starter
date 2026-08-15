"""
pull_claude_usage.py — Claude Code usage in rolling 5h window.

Scans ~/.claude/projects/*/*.jsonl for assistant messages with usage info
and sums tokens consumed in the last 5 hours.

Anthropic does not publish exact 5h quotas. Community trackers (ccusage,
claudefa.st) report Max20x at ~220K-440K tokens per 5h post the April 2026
policy + later doubling. Empirical observation: real billable consumption
can run 10-50× higher than published, suggesting the published number counts
OUTPUT tokens only. We expose output as the primary rate-limit signal.

Emits:
  claude_code / tokens_5h         (output tokens — primary rate-limit signal)
  claude_code / billable_5h       (input + output + cache_creation — info)
  claude_code / cache_read_5h     (cache-read served — info, not billed)
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from _common import emit, parse_common_args

SOURCE = "claude_code"
PROJECTS_DIR = Path.home() / ".claude" / "projects"
WINDOW_HOURS = 5


def parse_ts(ts: str) -> datetime | None:
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return None


def pull_real() -> tuple[int, int, int, str, str]:
    """Returns (output_tokens, billable_tokens, cache_read, status, error)."""
    if not PROJECTS_DIR.exists():
        return (0, 0, 0, "error", "projects_dir_missing")

    cutoff = datetime.now(timezone.utc) - timedelta(hours=WINDOW_HOURS)
    output = 0
    billable = 0
    cache_read = 0

    try:
        for jsonl in PROJECTS_DIR.rglob("*.jsonl"):
            try:
                with jsonl.open("r", encoding="utf-8", errors="ignore") as fh:
                    for line in fh:
                        try:
                            rec = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        ts = parse_ts(rec.get("timestamp", ""))
                        if not ts or ts < cutoff:
                            continue
                        usage = (rec.get("message") or {}).get("usage") or {}
                        if not usage:
                            continue
                        out = int(usage.get("output_tokens", 0) or 0)
                        inp = int(usage.get("input_tokens", 0) or 0)
                        cache_create = int(
                            usage.get("cache_creation_input_tokens", 0) or 0
                        )
                        cache_r = int(usage.get("cache_read_input_tokens", 0) or 0)
                        output += out
                        billable += inp + out + cache_create
                        cache_read += cache_r
            except OSError:
                continue
    except Exception as exc:
        return (0, 0, 0, "error", f"scan:{type(exc).__name__}")

    return (output, billable, cache_read, "ok", "")


def main(argv: list[str]) -> int:
    ts_override, force_mock = parse_common_args(argv)

    if force_mock:
        import random
        output = random.randint(80_000, 380_000)
        billable = output * random.randint(15, 30)
        cache_read = billable * random.randint(8, 20)
        status, error = "mock", ""
    else:
        output, billable, cache_read, status, error = pull_real()

    payloads = [
        emit(SOURCE, "tokens_5h", output, status, error, ts=ts_override),
        emit(SOURCE, "billable_5h", billable, status, error, ts=ts_override),
        emit(SOURCE, "cache_read_5h", cache_read, status, error, ts=ts_override),
    ]
    print(json.dumps(payloads, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
