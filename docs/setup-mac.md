# Mac setup — step by step

Total time: ~15 minutes (plus API-key signups if you want every metric source).

## 1. Prerequisites

```bash
# Node 20+ and Python 3.10+
brew install node python
# Claude Code
npm install -g @anthropic-ai/claude-code
claude   # log in when prompted, then exit
```

Install [Obsidian](https://obsidian.md) if you don't have it.

## 2. Run the installer

```bash
git clone https://github.com/ctskool/agentic-os-starter.git && cd agentic-os-starter
bash install.sh
```

It will ask:

- **Vault folder** — where your vault lives. Accept the default (`~/the-vault`) or point it at an existing vault; existing notes are never overwritten.
- **launchd agents?** — say yes. This installs two LaunchAgents: `com.agentic-os.runner` (starts the runner at login, keeps it alive) and `com.agentic-os.metrics` (metrics pull every 6 hours).

## 3. Fill in your env file

```bash
open -e ~/.claude/.env
```

Set what you have; blank entries are skipped gracefully:

- `AGENTIC_OS_VAULT` — set automatically by the installer, verify it.
- `YOUTUBE_API_KEY` + `YOUTUBE_CHANNEL_ID` — [create a key](https://console.cloud.google.com/apis/credentials) with YouTube Data API v3 enabled; channel id from YouTube advanced settings.
- `INSTAGRAM_HANDLE` / `TIKTOK_HANDLE` — public handles, no `@`.

## 4. Open the vault + enable the plugin

1. Obsidian → **Open folder as vault** → pick your vault folder.
2. Settings → **Community plugins** → turn off Restricted mode if asked → enable **Chase Command Center**.
3. The cockpit view appears in the right sidebar (ribbon icon if not).

## 5. Authenticate MCP connectors (Gmail + Calendar skills)

```bash
cd <your-vault> && claude
```

Inside Claude Code run `/mcp` and connect Gmail and Google Calendar. Headless runner sessions inherit these credentials. Skip this if you don't want `/inbox-brief`, `/today` calendar pulls, or `/morning-intel` Gmail triage.

## 6. Verify

```bash
# runner alive?
cat <your-vault>/system/runner-status.json    # ts should be < 60s old
# metrics pull works?
bash ~/.claude/skills/metrics-pull/scripts/run_all.sh
tail -5 <your-vault>/system/metrics/metrics.csv
```

Then click a cockpit button (e.g. Plan Today) and watch the run feed.

## launchd cheat sheet

```bash
launchctl list | grep agentic-os                 # loaded?
launchctl unload ~/Library/LaunchAgents/com.agentic-os.runner.plist   # stop
launchctl load ~/Library/LaunchAgents/com.agentic-os.runner.plist     # start
tail -f ~/.claude/agentic-os-runner/runner.log   # logs
```
