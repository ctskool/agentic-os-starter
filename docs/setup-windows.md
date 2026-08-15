# Windows setup — step by step

Total time: ~15 minutes (plus API-key signups if you want every metric source).

## 1. Prerequisites

- [Node.js 20+](https://nodejs.org) (installer, default options)
- [Python 3.10+](https://python.org) — check **"Add python.exe to PATH"** during install
- [Obsidian](https://obsidian.md)
- Claude Code:

```powershell
npm install -g @anthropic-ai/claude-code
claude   # log in when prompted, then exit
```

## 2. Run the installer

```powershell
git clone https://github.com/ctskool/agentic-os-starter.git
cd agentic-os-starter
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

It will ask:

- **Vault folder** — accept the default (`%USERPROFILE%\the-vault`) or point at an existing vault; existing notes are never overwritten.
- **Autostart + schedule?** — say yes. This drops a shortcut to `start-runner.vbs` into your Startup folder (runner launches hidden at every login, no admin needed) and registers a Task Scheduler job **AgenticOS Metrics Pull** every 6 hours.

## 3. Fill in your env file

```powershell
notepad $env:USERPROFILE\.claude\.env
```

Set what you have; blank entries are skipped gracefully:

- `AGENTIC_OS_VAULT` — set automatically by the installer (forward slashes), verify it.
- `YOUTUBE_API_KEY` + `YOUTUBE_CHANNEL_ID` — [create a key](https://console.cloud.google.com/apis/credentials) with YouTube Data API v3 enabled; channel id from YouTube advanced settings.
- `INSTAGRAM_HANDLE` / `TIKTOK_HANDLE` — public handles, no `@`.

## 4. Open the vault + enable the plugin

1. Obsidian → **Open folder as vault** → pick your vault folder.
2. Settings → **Community plugins** → turn off Restricted mode if asked → enable **Chase Command Center**.
3. The cockpit view appears in the right sidebar (ribbon icon if not).

## 5. Authenticate MCP connectors (Gmail + Calendar skills)

```powershell
cd <your-vault>; claude
```

Inside Claude Code run `/mcp` and connect Gmail and Google Calendar. Headless runner sessions inherit these credentials. Skip this if you don't want `/inbox-brief`, `/today` calendar pulls, or `/morning-intel` Gmail triage.

## 6. Verify

```powershell
# runner alive? (ts should be < 60s old)
Get-Content <your-vault>\system\runner-status.json
# metrics pull works?
powershell -ExecutionPolicy Bypass -File $env:USERPROFILE\.claude\skills\metrics-pull\scripts\run_all.ps1
Get-Content <your-vault>\system\metrics\metrics.csv -Tail 5
```

Then click a cockpit button (e.g. Plan Today) and watch the run feed.

## Runner cheat sheet

- **Restart runner** (picks up edits): double-click `%USERPROFILE%\.claude\agentic-os-runner\start-runner.vbs`
- **Logs**: `%USERPROFILE%\.claude\agentic-os-runner\runner.log`
- **Metrics task**: Task Scheduler → "AgenticOS Metrics Pull" → Run to test on demand
