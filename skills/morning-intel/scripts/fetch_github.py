"""
GitHub trending — delegates to the existing github-trending skill script
(don't re-solve a solved problem), then records the path + Content Radar
section of today's report so the synthesis pass can inline it.
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from common import today_str, vault_root, write_result

FETCH = Path.home() / ".claude" / "skills" / "github-trending" / "scripts" / "fetch.py"


def main() -> None:
    report = (
        vault_root() / "inbox" / "research" / "github-trending"
        / f"{today_str()}-trending.md"
    )
    try:
        proc = subprocess.run(
            [sys.executable, str(FETCH)],
            capture_output=True, text=True, timeout=300,
            cwd=str(vault_root()),
        )
        ok = proc.returncode == 0 and report.exists()
        excerpt = ""
        if report.exists():
            text = report.read_text(encoding="utf-8")
            # inline the whole report — synthesis pass reads items from here
            excerpt = text
        write_result(
            "github",
            "ok" if ok else "error",
            [{"report_path": str(report), "report": excerpt}] if excerpt else [],
            "" if ok else (proc.stderr or proc.stdout or "fetch.py failed")[:300],
        )
    except Exception as e:
        write_result("github", "error", [], str(e)[:200])
    sys.exit(0)


if __name__ == "__main__":
    main()
