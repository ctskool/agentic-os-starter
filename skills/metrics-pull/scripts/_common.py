"""Shared helpers for metrics-pull source scripts.

Each source script imports these to keep CSV/snapshot writes consistent
with the frozen schema in `the vault/system/schemas/`.
"""

from __future__ import annotations

import csv
import json
import os
from datetime import datetime, timezone
from pathlib import Path

ENV_PATH = Path.home() / ".claude" / ".env"


def _vault_root() -> Path:
    v = os.environ.get("AGENTIC_OS_VAULT")
    if not v and ENV_PATH.exists():
        for raw in ENV_PATH.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if line.startswith("AGENTIC_OS_VAULT="):
                v = line.split("=", 1)[1].strip().strip("\"'")
                break
    return Path(v) if v else Path.home() / "the-vault"


VAULT_METRICS = _vault_root() / "system" / "metrics"
CSV_PATH = VAULT_METRICS / "metrics.csv"
SNAPSHOT_PATH = VAULT_METRICS / "last-pull.json"

CSV_HEADER = ["timestamp", "source", "metric", "value", "status", "error"]


def load_env_file(path: Path = ENV_PATH) -> dict[str, str]:
    if not path.exists():
        return {}
    out: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def env(name: str) -> str | None:
    if val := os.environ.get(name):
        return val
    return load_env_file().get(name)


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def ensure_csv() -> None:
    VAULT_METRICS.mkdir(parents=True, exist_ok=True)
    if not CSV_PATH.exists():
        with CSV_PATH.open("w", newline="", encoding="utf-8") as fh:
            csv.writer(fh).writerow(CSV_HEADER)


def append_row(
    ts: str, source: str, metric: str, value: float, status: str, error: str
) -> None:
    ensure_csv()
    with CSV_PATH.open("a", newline="", encoding="utf-8") as fh:
        csv.writer(fh).writerow([ts, source, metric, value, status, error])


def update_snapshot(source: str, ts: str, status: str, error: str) -> None:
    snapshot: dict = {}
    if SNAPSHOT_PATH.exists():
        try:
            snapshot = json.loads(SNAPSHOT_PATH.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            snapshot = {}
    snapshot[source] = {"ts": ts, "status": status, "error": error}
    SNAPSHOT_PATH.write_text(
        json.dumps(snapshot, indent=2, sort_keys=True), encoding="utf-8"
    )


def emit(
    source: str,
    metric: str,
    value: float,
    status: str,
    error: str,
    ts: str | None = None,
) -> dict:
    """One-shot write of CSV row + snapshot. Returns the payload as dict."""
    final_ts = ts or now_iso()
    append_row(final_ts, source, metric, value, status, error)
    update_snapshot(source, final_ts, status, error)
    return {
        "ts": final_ts,
        "source": source,
        "metric": metric,
        "value": value,
        "status": status,
        "error": error,
    }


def parse_common_args(argv: list[str]) -> tuple[str | None, bool]:
    """Returns (ts_override, force_mock)."""
    ts_override = None
    if "--ts" in argv:
        idx = argv.index("--ts")
        if idx + 1 < len(argv):
            ts_override = argv[idx + 1]
    return ts_override, "--force-mock" in argv


def last_known_value(source: str, metric: str) -> float:
    """Find the most recent non-zero CSV value for a (source, metric).

    Used by scrapers as fallback when a pull fails with status=stale.
    """
    if not CSV_PATH.exists():
        return 0.0
    last = 0.0
    with CSV_PATH.open("r", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            if row.get("source") == source and row.get("metric") == metric:
                try:
                    v = float(row.get("value", "0"))
                    if v > 0:
                        last = v
                except ValueError:
                    continue
    return last
