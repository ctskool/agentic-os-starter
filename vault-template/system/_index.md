# System

Agentic-OS plumbing. Plugin + skills read/write here. Not for hand-editing unless schema doc says so.

## Contents

- **schemas/** — frozen contracts (daily-note format, metric CSV, queue/runs JSON). Read [[daily-note]] before touching daily notes.
- **templates/** — Templater templates fed by Daily Notes plugin. Mirrors schemas exactly.
- **metrics/** — `metrics.csv` (append-only) + `last-pull.json` (per-source status snapshot).
- **queue/** — action intents written by plugin, consumed by `~/.claude/agentic-os-runner/runner.js`.
- **runs/** — runner status + log output per intent (uuid-keyed).
- **dashboards/** — optional DataView fallbacks if plugin breaks.

## Pipeline

```
plugin click → queue/<uuid>.json → runner picks up → claude -p → runs/<uuid>.json (status) + runs/<uuid>.log
```

See [[CLAUDE]] for agent SOP and [[reference_local-cron-pattern]] for scheduler setup.
