#!/usr/bin/env node
/**
 * Chase Agentic OS Runner
 *
 * Watches `the vault/system/queue/<uuid>.json`, processes one intent at a time,
 * shells `claude -p "<prompt>"`, writes `system/runs/<uuid>.json` + `<uuid>.log`.
 *
 * Designed to be process-supervised by Windows Task Scheduler at user login.
 * Crash-safe: restarts on uncaughtException. No external deps — Node 20+.
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  appendFileSync,
} from "node:fs";
import { join, basename } from "node:path";
import { homedir, platform } from "node:os";
import { watch } from "node:fs/promises";

// --- Path resolution — cross-platform + env-var overridable.
// Resolution order:
//   1. AGENTIC_OS_VAULT env var (set in shell or ~/.claude/.env)
//   2. ~/.claude/.env file's AGENTIC_OS_VAULT entry
//   3. fallback ~/the-vault (template default)
function loadEnvFile() {
  const envPath = join(homedir(), ".claude", ".env");
  if (!existsSync(envPath)) return {};
  const out = {};
  try {
    for (const raw of readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#") || !line.includes("=")) continue;
      const idx = line.indexOf("=");
      const k = line.slice(0, idx).trim();
      const v = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
      out[k] = v;
    }
  } catch {
    /* ignore */
  }
  return out;
}

const _env = loadEnvFile();
const VAULT_ROOT =
  process.env.AGENTIC_OS_VAULT ||
  _env.AGENTIC_OS_VAULT ||
  join(homedir(), "the-vault");
const RUNNER_DIR = join(homedir(), ".claude", "agentic-os-runner");
const QUEUE_DIR = join(VAULT_ROOT, "system", "queue");
const RUNS_DIR = join(VAULT_ROOT, "system", "runs");
const STATUS_FILE = join(VAULT_ROOT, "system", "runner-status.json");
const RUNNER_LOG = join(RUNNER_DIR, "runner.log");

// Platform-aware binary names + script paths.
const IS_WINDOWS = platform() === "win32";
const CLAUDE_BIN = IS_WINDOWS ? "claude.exe" : "claude";
// Pin the model for ALL headless spawns — background skill runs should never
// burn the interactive default (Fable/Opus). Override via AGENTIC_OS_MODEL.
const CLAUDE_MODEL = process.env.AGENTIC_OS_MODEL || _env.AGENTIC_OS_MODEL || "sonnet";
// Per-run override — voice asks may carry args.model ("use opus" spoken in
// the ask). Allowlist only; anything else falls back to CLAUDE_MODEL.
const MODEL_ALLOWLIST = new Set([
  "claude-opus-4-8",
  "claude-fable-5",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
]);

/**
 * Trim text for TTS: within `max` chars, prefer the last sentence end,
 * then the last word boundary + ellipsis. Never cuts mid-word.
 */
function spokenTrim(text, max) {
  const s = String(text).trim();
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  const sentence = Math.max(
    head.lastIndexOf(". "),
    head.lastIndexOf("! "),
    head.lastIndexOf("? ")
  );
  if (sentence > max * 0.5) return head.slice(0, sentence + 1);
  const word = head.lastIndexOf(" ");
  return (word > 0 ? head.slice(0, word) : head) + "…";
}

function modelFor(intent) {
  const m = intent?.args?.model;
  return typeof m === "string" && MODEL_ALLOWLIST.has(m) ? m : CLAUDE_MODEL;
}
const METRICS_PULL_SCRIPT = IS_WINDOWS
  ? join(homedir(), ".claude", "skills", "metrics-pull", "scripts", "run_all.ps1")
  : join(homedir(), ".claude", "skills", "metrics-pull", "scripts", "run_all.sh");
const GITHUB_TRENDING_SCRIPT = join(
  homedir(),
  ".claude",
  "skills",
  "github-trending",
  "scripts",
  "fetch.py"
);

function writeHeartbeat() {
  try {
    writeFileSync(
      STATUS_FILE,
      JSON.stringify(
        {
          ts: new Date().toISOString(),
          pid: process.pid,
          version: "0.3.0",
          busy: active > 0,
          active,
          max_concurrent: MAX_CONCURRENT,
          pending: pending.length,
          in_flight: [...inFlight],
        },
        null,
        2
      ) + "\n"
    );
  } catch {
    /* ignore */
  }
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    appendFileSync(RUNNER_LOG, line, "utf8");
  } catch {
    /* ignore */
  }
  console.log(line.trimEnd());
}

function ensureDirs() {
  for (const d of [QUEUE_DIR, RUNS_DIR]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, obj) {
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function slugify(s, max = 48) {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, max) || "untitled";
}

function todayDate() {
  // Local (America/Chicago) YYYY-MM-DD. toISOString() returns UTC which flips
  // to tomorrow's date after 7pm CT — wrong for a "today" planner.
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
}

/**
 * Per-skill deliverable path inside the vault. Where the user-facing artifact
 * is expected to land. Plugin clicks this on Activity Feed row.
 */
function tomorrowDate() {
  // Local (America/Chicago) YYYY-MM-DD for tomorrow.
  const todayLocal = todayDate();
  const [y, m, d] = todayLocal.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(next);
}

/**
 * Build a markdown summary by reading last-pull.json + metrics.csv after the
 * metrics-pull PowerShell scripts complete. Pure file-read — no AI judgment needed.
 */
function buildMetricsPullSummary() {
  const snapshotPath = join(VAULT_ROOT, "system", "metrics", "last-pull.json");
  const csvPath = join(VAULT_ROOT, "system", "metrics", "metrics.csv");

  let snap = {};
  try {
    snap = JSON.parse(readFileSync(snapshotPath, "utf8"));
  } catch {
    /* ignore */
  }

  const latest = new Map();
  try {
    const lines = readFileSync(csvPath, "utf8").trim().split(/\r?\n/);
    if (lines.length > 1) lines.shift(); // header
    for (const line of lines) {
      const parts = line.split(",");
      if (parts.length < 4) continue;
      const [, source, metric, value, st, err] = parts;
      const key = `${source}:${metric}`;
      latest.set(key, { value, status: st || "", error: err || "" });
    }
  } catch {
    /* ignore */
  }

  const sources = Object.keys(snap).sort();
  if (sources.length === 0) {
    return "_(no last-pull.json — pull may have failed silently)_\n";
  }

  let body = "| Source | Status | Last Pull (UTC) | Latest Values |\n|---|---|---|---|\n";
  for (const src of sources) {
    const s = snap[src] || {};
    const values = [];
    for (const [k, v] of latest) {
      if (k.startsWith(src + ":")) {
        values.push(`\`${k.split(":")[1]}\`=${v.value}`);
      }
    }
    const statusCell = s.error ? `${s.status} (${s.error})` : s.status || "—";
    body += `| ${src} | ${statusCell} | ${s.ts || "—"} | ${values.join(", ") || "—"} |\n`;
  }
  return body;
}

function deliverablePathFor(intent) {
  const id8 = (intent.id || "x").slice(0, 8);
  const date = todayDate();
  const args = intent.args || {};
  switch (intent.skill) {
    case "plan-today":
    case "refresh-schedule":
      return `daily-notes/${date}.md`;
    case "plan-tomorrow":
      return `daily-notes/${tomorrowDate()}.md`;
    case "morning":
      return `inbox/reports/morning/${date}-${id8}.md`;
    case "morning-report":
      return `inbox/reports/morning/${date}-morning-report-${id8}.md`;
    case "inbox-brief":
      return `inbox/reports/inbox-briefs/${date}-${id8}.md`;
    case "deep-research-chase":
      return `inbox/research/${date}-${slugify(args.topic)}.md`;
    case "content-cascade":
      return `inbox/reports/cascades/${date}-${id8}.md`;
    case "weekly-review":
      return `inbox/reports/weekly/${date}-weekly-review.md`;
    case "yt-pipeline":
      return `inbox/research/${date}-yt-pipeline-${slugify(args.topic)}.md`;
    case "vault-cleanup":
      return `inbox/reports/vault-cleanup/${date}-cleanup-${id8}.md`;
    case "metrics-pull":
      return `inbox/reports/metrics/${date}-pull-${id8}.md`;
    case "yt-week-review":
      return `inbox/reports/yt-reviews/${date}-yt-week-review.md`;
    case "github-trending":
      return `inbox/research/github-trending/${date}-trending.md`;
    case "ai-trend-scan":
      return `inbox/reports/trend-scan/${date}-trend-scan-${id8}.md`;
    case "morning-intel":
      // converged 2026-08-14: interactive /morning-intel writes here natively;
      // the runner now matches (was inbox/reports/morning/) so the voice
      // "open morning intel" target and the briefing reader have ONE home
      return `inbox/research/morning-intel/${date}-intel-${id8}.md`;
    case "outlier-radar":
      return `inbox/research/outlier-radar/${date}-outliers.md`;
    case "lead-research":
      return `inbox/reports/lead-research/${date}-leads-${id8}.md`;
    case "voice-ask":
      return `inbox/voice/${date}-${slugify(args.prompt || "ask")}-${id8}.md`;
    case "angle-brainstorm":
      return `inbox/reports/angles/${date}-angles-${slugify(args.seed || args.topic || id8)}.md`;
    case "outline-build":
      return `inbox/reports/outlines/${date}-outline-${slugify(args.angle || args.topic || id8)}.md`;
    default:
      return null;
  }
}

/**
 * Map intent.skill → prompt string passed to `claude -p`.
 * Intent shape: { id, ts, skill, args, from }
 *
 * Each prompt is responsible for instructing the model to persist its
 * deliverable to the path returned by `deliverablePathFor(intent)` so the
 * Activity Feed can deep-link to it.
 */
// Standard headless preamble — mirrors the working Streamlit pattern
// (~/agentic-os-dashboard/config.example.py). Blocks AskUserQuestion which
// is what stalls skills like /deep-research-chase in non-interactive -p mode.
//
// Leads with "Execute" (not "Act") so caveman-mode SessionStart hooks in the
// spawned session don't misread the first word as caveman-compressed input.
const AUTONOMOUS_PREFIX =
  "Execute the requested skill autonomously in headless mode. Do not ask the user for confirmation. Do not call AskUserQuestion. Continue until the deliverable is written.\n\nSPOKEN SUMMARY CONTRACT: the FIRST line of your final reply is read aloud to the user by a voice assistant. Make it ONE conversational sentence (max ~140 chars) a calm butler would say - lead with the outcome PLUS two or three concrete highlights from what you produced (names, titles, the numbers that matter) — 'the report is done' with no specifics is useless, round big numbers to clean magnitudes (say 'about 13 thousand', never '13,206'). Never mention: headless, autonomous, task, deliverable, file paths, markdown, or process narration ('waiting for', 'running'). Every other detail belongs in the written deliverable, not the spoken line.";

function buildPrompt(intent, deliverable) {
  const skill = intent.skill;
  const args = intent.args || {};

  switch (skill) {
    case "plan-today":
      return `${AUTONOMOUS_PREFIX}\n\nTask: plan today's daily note at exactly ${deliverable}.\n\nSteps:\n1. Read the last 3 daily notes under daily-notes/ for incomplete Top 3 + Daily Drivers + EOD reflections (carryover candidates).\n2. Pull today's calendar via the Anthropic Google Calendar MCP connector. Call mcp__claude_ai_Google_Calendar__list_events with startTime=<today>T00:00:00, endTime=<today+1>T00:00:00, timeZone=America/Chicago, orderBy=startTime, pageSize=100. The connector is pre-authenticated. Do NOT use gws-calendar-agenda.\n3. Glob projects/*.md for files modified in the last 14 days with status: active|in-progress|blocked|draft frontmatter or due: dates on/before today.\n4. Build suggested Top 3 from the scoring rubric in the /plan-today SKILL.md (carryover +50, due-today +40, overdue +30, calendar-prep +25, recurring-theme +20, drift +15). Pick top 3.\n5. Write the daily note using the frozen v1 schema at system/schemas/daily-note.md — exact section order. If the note already exists, MERGE only into empty Top 3 slots and replace ## Schedule content; do not overwrite user-set text.\n\nEnd your reply with: SAVED ${deliverable}`;
    case "refresh-schedule":
      return `${AUTONOMOUS_PREFIX}\n\nTask: refresh the ## Schedule section of today's daily note at ${deliverable}.\n\nSteps:\n1. Pull today's calendar via mcp__claude_ai_Google_Calendar__list_events with startTime=<today>T00:00:00, endTime=<today+1>T00:00:00, timeZone=America/Chicago, orderBy=startTime, pageSize=100.\n2. Edit ${deliverable} — replace the contents of the \`## Schedule\` section ONLY. Format each event as \`- HH:MM — Title\` (24h CT, sorted by start time). Prefix all-day events with \`(all-day)\` instead of a time.\n3. Leave every other section untouched.\n\nEnd with a one-line summary: how many events were written.`;
    case "morning":
      return `${AUTONOMOUS_PREFIX}\n\nTask: run the consolidated /morning routine and save the result at exactly ${deliverable}.\n\nSteps:\n1. Run /morning-report (AI/Claude Code trend briefing) and /inbox-brief (Gmail triage via Anthropic Gmail MCP connector — mcp__claude_ai_Gmail__search_threads with query "in:inbox newer_than:1d") in parallel.\n2. Consolidate both outputs into one briefing.\n3. Save as a single Obsidian markdown note at ${deliverable}. Use YAML frontmatter with \`date\`, \`skill: morning\`, and \`tags: [morning, briefing]\`. Body should be the full briefing in clean markdown with sections.\n\nEnd your reply with: SAVED ${deliverable}`;
    case "morning-report":
      return `${AUTONOMOUS_PREFIX}\n\nTask: run /morning-report (AI/Claude Code daily trend briefing). Save the FULL briefing as a single Obsidian markdown note at exactly ${deliverable}. Follow the skill's standard structure — top-level "# Morning Report" + "**Date:** <today>", then sections "## Headlines" (3-5 bulleted top beats, ranked by relevance to a Claude Code / agentic-AI YouTube channel; each bullet MUST end with a markdown link to its primary source, e.g. [source](https://...)), "## YouTube — What's Trending" (markdown table + commentary), "## Web — News & Articles" (bulleted with linked sources), "## X / Twitter — The Conversation" (mood + voices + takes), "## GitHub — Builder Activity" (bullets, key repos in inline code), "## Content Opportunities" (3 numbered video ideas, each with a bolded headline followed by paragraph), "## Sources". End your reply with: SAVED ${deliverable}`;
    case "inbox-brief":
      return `${AUTONOMOUS_PREFIX}\n\nTask: triage Gmail inbox and save the brief at exactly ${deliverable}.\n\nSteps:\n1. Pull the last 24h of inbox via mcp__claude_ai_Gmail__search_threads with query "in:inbox newer_than:1d" and pageSize 50.\n2. Triage per the /inbox-brief SKILL.md classification rules (urgent / warm / sponsor / meetings / noise).\n3. Save the triage output at ${deliverable}. YAML frontmatter \`date\`, \`skill: inbox-brief\`, \`tags: [inbox, triage]\`. Body groups messages by category.\n4. Do NOT send any drafts — draft-sending is reserved for interactive sessions.\n\nEnd your reply with: SAVED ${deliverable}`;
    case "deep-research-chase": {
      const topic = (args.topic || "").trim();
      if (!topic) return null;
      return `${AUTONOMOUS_PREFIX} Run /deep-research-chase on: ${topic}\n\nSave the full research brief as a single markdown note at exactly this vault path: ${deliverable}. Use YAML frontmatter with \`date\`, \`topic: ${JSON.stringify(topic)}\`, \`skill: deep-research-chase\`, \`tags: [research]\`. Include sources cited inline. End your reply with: SAVED ${deliverable}`;
    }
    case "content-cascade": {
      const url = (args.url || "").trim();
      if (!url) return null;
      if (args.mode === "blog-only") {
        return `${AUTONOMOUS_PREFIX} Run /content-cascade in BLOG-ONLY mode on: ${url}\n\nHeadless full-autonomy rules (override the skill's ask-before-saving default):\n1. Fetch the transcript per the skill's method ladder. If ALL transcript methods fail, STOP and write the summary note marked status: failed — do NOT write a blog without a transcript.\n2. Generate the blog post following the blog system prompt exactly, check for an existing Supabase row first (Step 4.5), insert if absent.\n3. AUTO-PUBLISH the blog: PATCH the posts row with published: true + published_at set to the VIDEO'S ORIGINAL UPLOAD TIMESTAMP (get it via \`yt-dlp --print "%(timestamp)s" <url>\` or the YouTube Data API) — blog-only mode is a backfill tool, so the blog must be backdated to when the video came out, NOT today. No review pause.\n4. Save the vault copy to content/blog/ — date-prefix the filename and \`date:\` frontmatter with the video's upload date, not today.\n5. Write a summary index at exactly this vault path: ${deliverable} — YAML frontmatter \`date\`, \`source_url: ${url}\`, \`skill: content-cascade\`, \`mode: blog-only\`, \`tags: [cascade]\`, body lists the blog title, supabase id, published status. End your reply with: SAVED ${deliverable}`;
      }
      return `${AUTONOMOUS_PREFIX} Run /content-cascade on: ${url}\n\nHeadless full-autonomy rules (override the skill's ask-before-saving default — save everything without review pauses):\n1. Fetch the transcript per the skill's method ladder. If ALL transcript methods fail (captions likely not generated yet), STOP and write the summary note marked status: failed so the next scheduled check retries — do NOT generate content without a transcript.\n2. Blog: generate, insert into Supabase (Step 4.5 existing-row check first), then AUTO-PUBLISH (PATCH published: true + published_at). Save vault copy to content/blog/.\n3. X native-video tweet: generate the tweet copy per the skill's Step 6, save to Supabase social_content as draft, save vault copy to content/twitter/. Do NOT attempt the Playwright posting script — that's an interactive step Chase runs later.\n4. LinkedIn: generate post + first comment per the skill, save to Supabase as draft, save vault copy to content/linkedin/. Then AUTO-SCHEDULE via LeadShark (Step 9.5): build the payload (next day 9:00 AM ET, automation template "Agent Skool", thumbnail attachment) and run post-leadshark.js — it fills, clicks Schedule Post itself, and verifies. On success PATCH the Supabase row to status "scheduled" with scheduled_at. If the script fails (expired session etc.), log the error in the summary and leave the draft — NON-FATAL, do not retry more than once.\n5. Delete the pending marker: ~/.claude/cascade-pending.json (ignore if absent).\n6. Write a summary index at exactly this vault path: ${deliverable} — YAML frontmatter \`date\`, \`source_url: ${url}\`, \`skill: content-cascade\`, \`tags: [cascade]\`, body lists each piece (title, platform, supabase id, published/scheduled/draft status, first 200 chars) plus the one manual step remaining (X video tweet via post-video-tweet.js). End your reply with: SAVED ${deliverable}`;
    }
    case "plan-tomorrow":
      return `${AUTONOMOUS_PREFIX}\n\nTask: draft tomorrow's daily note at exactly ${deliverable}.\n\nSteps:\n1. Read today's daily note for unfinished Top 3 + Daily Drivers (carryover).\n2. Pull tomorrow's calendar via mcp__claude_ai_Google_Calendar__list_events with startTime=<tomorrow>T00:00:00, endTime=<tomorrow+1>T00:00:00, timeZone=America/Chicago, orderBy=startTime, pageSize=100.\n3. Glob projects/*.md for due-tomorrow or overdue items.\n4. Suggest 3 Top 3 priorities, seed Daily Drivers from defaults + open content commitments.\n5. Write to disk using the frozen v1 daily-note schema at system/schemas/daily-note.md.\n\nEnd your reply with: SAVED ${deliverable}`;
    case "weekly-review":
      return `${AUTONOMOUS_PREFIX} Run the /weekly-review skill.\n\nReview the last 7 days — both personal (daily notes aggregate) and channel (YouTube via Data API). Read all daily notes in the window, aggregate frontmatter (effort, focus_blocks, posts_shipped, top3_done), detect themes from EOD reflections. Then pull the YouTube channel's uploads in the same window using YOUTUBE_API_KEY + YOUTUBE_CHANNEL_ID from ~/.claude/.env, classify each upload Hit/Steady/Miss/Climbing vs the 10-video baseline, and recommend repackaging plays. Write the consolidated coaching review at exactly this vault path: ${deliverable}. Follow the skill's template exactly. End your reply with: SAVED ${deliverable}`;
    case "yt-pipeline": {
      const topic = (args.topic || "").trim();
      if (!topic) return null;
      return `${AUTONOMOUS_PREFIX} Run /yt-pipeline on: ${topic}\n\nSearch YouTube for the topic, auto-select the best videos, create a NotebookLM notebook, add them as sources, run analysis, and generate the default deliverable. ALSO write a one-page summary at exactly this vault path: ${deliverable} — YAML frontmatter \`date\`, \`topic: ${JSON.stringify(topic)}\`, \`skill: yt-pipeline\`, \`tags: [research, youtube]\`. Body: which videos were selected, key creators, the analysis summary, content gaps. End your reply with: SAVED ${deliverable}`;
    }
    case "vault-cleanup":
      return `${AUTONOMOUS_PREFIX} Run the /vault-cleanup skill.\n\nScan the vault for stale files (older than 7 days, outside /wiki/ and /_archive-vault/). Show a preview, then archive into the appropriate /archive/ subfolders. Wiki-links must continue to resolve from archive. Write a one-page cleanup report at exactly this vault path: ${deliverable} — YAML frontmatter \`date\`, \`skill: vault-cleanup\`, \`tags: [cleanup, ops]\`. Body lists what was moved and any files skipped. End your reply with: SAVED ${deliverable}`;
    case "metrics-pull":
      return `${AUTONOMOUS_PREFIX} Run the /metrics-pull skill.\n\nForce-refresh all cockpit metrics (Claude usage, YouTube subs/views/latest-video, Instagram, TikTok) by invoking the metrics-pull scripts at ~/.claude/skills/metrics-pull/scripts/. After all sources finish, summarize at exactly this vault path: ${deliverable} — YAML frontmatter \`date\`, \`skill: metrics-pull\`, \`tags: [metrics, ops]\`. Body: a per-source status table (source, value, status ok/mock/error, error msg) + the diff from previous values where available. End your reply with: SAVED ${deliverable}`;
    case "github-trending":
      // Direct-exec — prompt unused, but must be non-null to clear the null-guard
      // in processOne(). Script writes the deliverable itself.
      return `(direct-exec) github-trending → ${deliverable}`;
    case "ai-trend-scan":
      return `${AUTONOMOUS_PREFIX}\n\nRun /ai-trend-scan${args.focus ? ` (focus override: ${args.focus})` : ""}. Scan YouTube + X for the last ~24h of trending AI content, score by velocity, dedupe, and produce the ranked seed list. Save the FULL markdown report at exactly this vault path: ${deliverable}. YAML frontmatter \`date\`, \`skill: ai-trend-scan\`, \`tags: [trend-scan, research]\`. End your reply with: SAVED ${deliverable}`;
    case "morning-intel":
      return `${AUTONOMOUS_PREFIX}\n\nRun the /morning-intel skill — the full AI-sphere intelligence sweep (smol.ai + HN news, X announcements, trending YouTube in the Claude Code sphere, GitHub trending, Gmail last-24h triage) synthesized into one brief ending in the "So What" content plan. Save the FULL brief at exactly this vault path: ${deliverable}. YAML frontmatter \`date\`, \`skill: morning-intel\`, \`tags: [morning, intel]\`.\n\nIMPORTANT: the FIRST LINE of your final reply is read aloud by text-to-speech. Make it ONE conversational sentence (under 200 chars) with the single biggest takeaway. After that line, end with: SAVED ${deliverable}`;
    case "outlier-radar":
      return `${AUTONOMOUS_PREFIX}\n\nRun the /outlier-radar skill — scan YouTube for recent outlier videos from small channels in the AI niche per the skill's seed-query + watchlist method, and append new outliers to the dated radar file. The skill writes its own deliverable at ${deliverable}.\n\nIMPORTANT: the FIRST LINE of your final reply is read aloud by text-to-speech. Make it ONE conversational sentence (under 200 chars): how many new outliers and the top one. After that line, end with: SAVED ${deliverable}`;
    case "lead-research":
      return `${AUTONOMOUS_PREFIX}\n\nRun the /lead-research skill — research unresearched leads from the Chase AI site's Supabase leads table, write a pre-discovery-call briefing per lead into the leads table, and save the daily briefing doc at exactly this vault path: ${deliverable}. YAML frontmatter \`date\`, \`skill: lead-research\`, \`tags: [leads, research]\`. If there are no unresearched leads, write a one-line note saying so.\n\nIMPORTANT: the FIRST LINE of your final reply is read aloud by text-to-speech. Make it ONE conversational sentence (under 200 chars): how many leads researched and the most promising one. After that line, end with: SAVED ${deliverable}`;
    case "angle-brainstorm": {
      const seed = (args.seed || args.topic || "").trim();
      if (!seed) return null;
      return `${AUTONOMOUS_PREFIX}\n\nRun /angle-brainstorm on seed: ${seed}\n\nProduce 8-12 distinct YouTube angles across the framing buckets (contrarian / how-to / story / listicle / news-reaction / explainer / behind-the-scenes / prediction) with audience-desire tag + one-line justification per angle. Save the FULL output at exactly this vault path: ${deliverable}. YAML frontmatter \`date\`, \`seed: ${JSON.stringify(seed)}\`, \`skill: angle-brainstorm\`, \`tags: [angles, ideation]\`. End your reply with: SAVED ${deliverable}`;
    }
    case "outline-build": {
      const angle = (args.angle || args.topic || "").trim();
      if (!angle) return null;
      return `${AUTONOMOUS_PREFIX}\n\nRun /outline-build on angle: ${angle}\n\nProduce a complete retention-aware long-form YouTube outline — working title, hook seed, stakes, 3-5 numbered body beats (purpose + 2-4 sub-bullets + optional re-hook), payoff/demo, CTA, runtime estimates, per-beat b-roll notes. Save the FULL outline at exactly this vault path: ${deliverable}. YAML frontmatter \`date\`, \`angle: ${JSON.stringify(angle)}\`, \`skill: outline-build\`, \`tags: [outline, content-pipeline]\`. End your reply with: SAVED ${deliverable}`;
    }
    case "voice-ask": {
      const ask = (args.prompt || "").trim();
      if (!ask) return null;
      const convo = (args.context || "").trim();
      const convoBlock = convo
        ? `\n\nRecent voice conversation (context — the ask may refer back to it):\n${convo}`
        : "";
      return `${AUTONOMOUS_PREFIX}\n\nVoice request from Chase (spoken via push-to-talk, machine-transcribed — minor transcription errors possible): ${JSON.stringify(ask)}${convoBlock}\n\nDo the task fully. Write the complete result as a markdown note at exactly ${deliverable} — YAML frontmatter \`date\`, \`skill: voice-ask\`, \`prompt: ${JSON.stringify(ask)}\`, \`tags: [voice]\`. If the REAL output of the task lives at a URL — a Gmail draft you created (the create_draft response includes the draft's message id — deep-link it: https://mail.google.com/mail/u/0/#drafts?compose=<message id>; only if no id came back, fall back to https://mail.google.com/mail/#drafts), a video, a doc, a page — ALSO add \`link: <that url>\` to the frontmatter; the dashboard will send the user there directly instead of to this note.\n\nIMPORTANT: the FIRST LINE of your final reply is read aloud to Chase by text-to-speech. Make it ONE conversational sentence (under 200 characters) that directly answers the ask or states the outcome — no markdown, no file paths in it. After that line, end with: SAVED ${deliverable}`;
    }
    case "yt-week-review":
      return `${AUTONOMOUS_PREFIX} Run the /yt-week-review skill.\n\nReview the YouTube channel's last 7 days of uploads. Read YOUTUBE_API_KEY + YOUTUBE_CHANNEL_ID from ~/.claude/.env, pull uploads via the uploads-playlist (UC → UU prefix swap), fetch per-video stats for the weekly window + 10-video baseline. IMPORTANT: segment LONG-FORM (duration > 180s) from SHORTS (duration <= 180s — includes "long-Short" hybrids that compete with Short distribution). All primary analytics — baseline, Hit/Steady/Miss classification, uploads table, top performer, underperformer — operate on LONG-FORM ONLY. Shorts get one compact summary line in a "## Short-form snapshot" section (count + combined views + one-line verdict). The "Why it worked" + "Likely culprit" sections must each be ONE tight sentence under 140 chars so the cockpit card displays them without truncation. Write the structured review at exactly this vault path: ${deliverable}. Follow the template in the SKILL.md — frontmatter (date, window, channel, skill: yt-week-review, tags: [review, youtube, weekly]), then ## TL;DR bullets, ## Uploads this week table (Video | Views | vs Baseline | Likes | Comments | Verdict — long-form only), ## Top performer — <title>, ## Underperformer — <title> (if any), ## Channel-wide signal, ## Short-form snapshot (one line), ## Recommended next 7 days. End your reply with: SAVED ${deliverable}`;
    default:
      return null;
  }
}

// Worker pool — parallel execution gated by category.
//
// MAX_CONCURRENT caps total in-flight claude -p / direct-exec subprocesses.
// SERIAL_SKILLS share a single in-flight slot among themselves (write the same
// shared file — daily-note, wiki index, etc). DEDUPE_SKILLS reject a new
// intent if the same skill is already in-flight (avoids duplicate work + API
// contention).
const MAX_CONCURRENT = 3;
const SERIAL_SKILLS = new Set([
  "plan-today",
  "plan-tomorrow",
  "refresh-schedule",
  "close-day",
  "harvest",
]);
const DEDUPE_SKILLS = new Set(["metrics-pull", "ai-trend-scan"]);

let active = 0;
const inFlight = new Set();      // intent.skill values currently running
const pending = [];               // queue filenames awaiting a slot
const processing = new Set();     // queue filenames currently being processed

function enqueueNew() {
  if (!existsSync(QUEUE_DIR)) return;
  const files = readdirSync(QUEUE_DIR).filter((f) => f.endsWith(".json"));
  for (const f of files) {
    // processing guard — the queue file stays on disk until processOne
    // unlinks it at the end of the run, so without this every poll re-adds
    // an in-flight intent and the scheduler spawns DUPLICATE claude
    // sessions (observed 2-5x per slow run before the fix)
    if (!pending.includes(f) && !processing.has(f)) pending.push(f);
  }
}

function peekSkill(fileName) {
  // Lightweight peek — read intent.skill without bumping retry budget.
  // Used by scheduler gate. processOne() still does full retry-tolerant read.
  try {
    const intent = readJson(join(QUEUE_DIR, fileName));
    return intent.skill || null;
  } catch {
    return null;
  }
}

function pickNext() {
  // Scan pending for the first intent whose skill is runnable right now.
  // Returns index into pending[], or -1 if nothing runnable.
  const serialBusy = [...inFlight].some((s) => SERIAL_SKILLS.has(s));
  for (let i = 0; i < pending.length; i++) {
    const skill = peekSkill(pending[i]);
    if (!skill) {
      // Unreadable yet (race vs Obsidian write) — try later.
      continue;
    }
    if (DEDUPE_SKILLS.has(skill) && inFlight.has(skill)) continue;
    if (SERIAL_SKILLS.has(skill) && serialBusy) continue;
    return i;
  }
  return -1;
}

async function processOne(fileName) {
  const queuePath = join(QUEUE_DIR, fileName);
  if (!existsSync(queuePath)) return; // file vanished

  let intent;
  let lastErr = null;
  // Retry up to 5x with backoff — covers race where vault.adapter.write
  // has created the file but not yet flushed content.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      intent = readJson(queuePath);
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
    }
  }
  if (lastErr || !intent) {
    const runId = basename(fileName, ".json");
    const runJsonPath = join(RUNS_DIR, `${runId}.json`);
    const runMdPath = join(RUNS_DIR, `${runId}.md`);
    const ts = new Date().toISOString();
    writeJson(runJsonPath, {
      id: runId,
      skill: "(unknown)",
      args: {},
      ts_queued: ts,
      ts_started: ts,
      ts_completed: ts,
      status: "error",
      exit_code: -3,
      summary: `bad intent json after 5 retries: ${lastErr?.message || "empty"}`.slice(0, 200),
      md_path: `system/runs/${runId}.md`,
      log_path: `system/runs/${runId}.md`,
      deliverable_path: null,
    });
    writeFileSync(
      runMdPath,
      `---\nrun_id: ${runId}\nskill: unknown\nstatus: error\n---\n\n# rejected intent\n\nQueue file ${fileName} could not be parsed.\n\n\`${lastErr?.message || "empty file"}\`\n`,
      "utf8"
    );
    log(`${runId}: bad json — wrote error run record: ${lastErr?.message}`);
    try {
      unlinkSync(queuePath);
    } catch {
      /* ignore */
    }
    return;
  }

  const runId = intent.id || basename(fileName, ".json");
  const runJsonPath = join(RUNS_DIR, `${runId}.json`);
  const runMdPath = join(RUNS_DIR, `${runId}.md`);
  const deliverable = deliverablePathFor({ ...intent, id: runId });

  // Dedup of duplicate skills is handled at scheduling time in pickNext()
  // (DEDUPE_SKILLS pending items are skipped while the same skill is
  // already in inFlight). By the time processOne runs, the worker loop has
  // already added this skill to inFlight — so a self-check here always
  // misfires and the run gets dropped on its first attempt.

  const tsStarted = new Date().toISOString();
  const status = {
    id: runId,
    skill: intent.skill,
    args: intent.args || {},
    ts_queued: intent.ts || tsStarted,
    ts_started: tsStarted,
    ts_completed: null,
    status: "running",
    exit_code: null,
    summary: "",
    md_path: `system/runs/${runId}.md`,
    log_path: `system/runs/${runId}.md`,
    deliverable_path: deliverable,
  };
  writeJson(runJsonPath, status);

  const prompt = buildPrompt({ ...intent, id: runId }, deliverable);
  if (!prompt) {
    status.status = "error";
    status.exit_code = -1;
    status.summary = `unknown or invalid intent: ${intent.skill}`;
    status.ts_completed = new Date().toISOString();
    writeJson(runJsonPath, status);
    try {
      unlinkSync(queuePath);
    } catch {
      /* ignore */
    }
    log(`${runId}: rejected — ${status.summary}`);
    return;
  }

  const runModel = modelFor(intent);
  log(
    `${runId}: running skill=${intent.skill}` +
      (runModel !== CLAUDE_MODEL ? ` model=${runModel} (per-ask override)` : "")
  );

  // Initialize markdown file with frontmatter so Obsidian renders it as a note.
  const argsJson = JSON.stringify(intent.args || {});
  writeFileSync(
    runMdPath,
    `---
run_id: ${runId}
skill: ${intent.skill}
status: running
ts_queued: ${intent.ts || tsStarted}
ts_started: ${tsStarted}
args: ${argsJson}
---

# ${intent.skill} run

> in progress — output streams below.

\`\`\`
`,
    "utf8"
  );

  // Direct-exec path — for mechanical skills that don't need AI judgment.
  // Bypasses claude entirely, runs the script directly. Faster + immune to
  // SessionStart-hook side effects (e.g. caveman mode shortcutting responses).
  const isDirectExec =
    intent.skill === "metrics-pull" || intent.skill === "github-trending";

  const out = [];
  await new Promise((resolve) => {
    // Direct-exec spawn — platform-aware launcher.
    // metrics-pull → powershell/bash script. github-trending → python script.
    const directExecSpawn = () => {
      if (intent.skill === "github-trending") {
        return spawn("python", [GITHUB_TRENDING_SCRIPT], {
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          cwd: VAULT_ROOT,
        });
      }
      // metrics-pull
      return IS_WINDOWS
        ? spawn(
            "powershell.exe",
            [
              "-NoProfile",
              "-ExecutionPolicy", "Bypass",
              "-File",
              METRICS_PULL_SCRIPT,
            ],
            {
              shell: false,
              windowsHide: true,
              stdio: ["ignore", "pipe", "pipe"],
              cwd: VAULT_ROOT,
            }
          )
        : spawn("bash", [METRICS_PULL_SCRIPT], {
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
            cwd: VAULT_ROOT,
          });
    };

    const proc = isDirectExec
      ? directExecSpawn()
      : spawn(CLAUDE_BIN, ["-p", prompt, "--model", runModel], {
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          cwd: VAULT_ROOT,
        });

    proc.stdout.on("data", (chunk) => {
      out.push(chunk.toString());
      try {
        appendFileSync(runMdPath, chunk);
      } catch {
        /* ignore */
      }
    });
    proc.stderr.on("data", (chunk) => {
      out.push(chunk.toString());
      try {
        appendFileSync(runMdPath, chunk);
      } catch {
        /* ignore */
      }
    });

    // long-haul skills get extra headroom — ai-trend-scan's MEDIAN is ~7 min,
    // a 10 min cap was killing its slow half
    const LONG_SKILLS = new Set(["ai-trend-scan", "yt-pipeline", "deep-research-chase", "yt-week-review"]);
    const HARD_TIMEOUT_MS = 1000 * 60 * (LONG_SKILLS.has(intent.skill) ? 20 : 10);
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
      out.push("\n[runner: hard timeout 10m — killed]\n");
    }, HARD_TIMEOUT_MS);

    proc.on("close", (code) => {
      clearTimeout(timer);
      const tsCompleted = new Date().toISOString();
      const joined = out.join("").trim();
      const lines = joined.split(/\r?\n/);
      const firstLine =
        lines.find(
          (l) =>
            l.trim().length > 0 &&
            !l.startsWith("Warning:") &&
            !l.startsWith("warning:")
        ) ||
        lines.find((l) => l.trim().length > 0) ||
        "(no output)";
      status.status = code === 0 ? "ok" : "error";
      status.exit_code = code ?? -1;
      status.ts_completed = tsCompleted;
      // summary is SPOKEN by the orb — never chop mid-word. Cut at a
      // sentence end when one lands late enough, else the last word
      // boundary ("…a contrarian 'is AI coding really b" was read aloud
      // verbatim before this guard).
      status.summary = spokenTrim(firstLine, 300);
      writeJson(runJsonPath, status);
      try {
        appendFileSync(
          runMdPath,
          `\n\`\`\`\n\n---\n*exit code=${code} · status=${status.status} · completed ${tsCompleted}*\n`
        );
      } catch {
        /* ignore */
      }

      // For metrics-pull (direct exec), also write a clean summary at the
      // deliverable path so Activity Feed click opens a readable report.
      if (isDirectExec && intent.skill === "metrics-pull" && deliverable) {
        try {
          const summaryBody = buildMetricsPullSummary();
          // Cross-platform path join — deliverable is forward-slash relative.
          const deliverableAbs = join(VAULT_ROOT, ...deliverable.split("/"));
          const parentDir = join(deliverableAbs, "..");
          if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true });
          const frontmatter = `---\ndate: ${tsCompleted.slice(0, 10)}\nskill: metrics-pull\nrun_id: ${runId}\ntags: [metrics, ops]\n---\n\n# Metrics Pull — ${tsCompleted.slice(0, 10)}\n\nForce-refresh run via cockpit. PowerShell exec, no AI in the loop.\n\n## Per-source status\n\n${summaryBody}\n\n## Notes\n\n- This run wrote new rows to \`system/metrics/metrics.csv\` and updated \`system/metrics/last-pull.json\`.\n- The 6h Windows Task Scheduler does the same thing on cadence — this is the manual override.\n`;
          writeFileSync(deliverableAbs, frontmatter, "utf8");
          // Also overwrite the firstLine summary to be more useful
          const okCount = Object.values(JSON.parse(readFileSync(join(VAULT_ROOT, "system", "metrics", "last-pull.json"), "utf8")))
            .filter((s) => s.status === "ok").length;
          const totalCount = Object.keys(JSON.parse(readFileSync(join(VAULT_ROOT, "system", "metrics", "last-pull.json"), "utf8"))).length;
          status.summary =
            okCount === totalCount
              ? `All ${totalCount} metric sources came back fresh.`
              : `Metrics refreshed — ${okCount} of ${totalCount} sources answered.`;
          writeJson(runJsonPath, status);
        } catch (e) {
          log(`${runId}: metrics-pull post-process failed: ${e.message}`);
        }
      }

      // github-trending (direct exec): the script's first output line is a
      // file path — useless spoken. Mine the report for top repo names
      // (AI/DEV-tagged first) and speak those instead.
      if (isDirectExec && intent.skill === "github-trending" && deliverable && status.status === "ok") {
        try {
          const md = readFileSync(join(VAULT_ROOT, ...deliverable.split("/")), "utf8");
          const entries = [...md.matchAll(/^### \d+\. \[([^\]\/]+)\/([^\]]+)\]\([^)]*\)( \*\*\[AI\/DEV\]\*\*)?/gm)]
            .map((m) => ({ name: m[2], ai: Boolean(m[3]) }));
          const picks = [...entries.filter((e) => e.ai), ...entries.filter((e) => !e.ai)]
            .slice(0, 3)
            .map((e) => e.name);
          if (picks.length) {
            status.summary = `GitHub trending is in. Standouts this week: ${picks.join(", ")}.`;
            writeJson(runJsonPath, status);
          }
        } catch (e) {
          log(`${runId}: github-trending post-process failed: ${e.message}`);
        }
      }

      log(`${runId}: completed exit=${code} status=${status.status}`);
      resolve();
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      status.status = "error";
      status.exit_code = -2;
      status.ts_completed = new Date().toISOString();
      status.summary = `spawn error: ${err.message}`.slice(0, 200);
      writeJson(runJsonPath, status);
      try {
        appendFileSync(
          runMdPath,
          `\n\`\`\`\n\n[runner spawn error] ${err.message}\n`
        );
      } catch {
        /* ignore */
      }
      log(`${runId}: spawn error ${err.message}`);
      resolve();
    });
  });

  try {
    unlinkSync(queuePath);
  } catch {
    /* ignore */
  }
}

async function loop() {
  while (true) {
    enqueueNew();
    // Greedy fill — keep grabbing the next runnable intent until we hit the
    // concurrency cap or pending has nothing schedulable right now.
    let progress = true;
    while (progress && active < MAX_CONCURRENT && pending.length > 0) {
      const idx = pickNext();
      if (idx < 0) {
        progress = false;
        break;
      }
      const next = pending.splice(idx, 1)[0];
      const skill = peekSkill(next);
      active++;
      if (skill) inFlight.add(skill);
      processing.add(next);
      // Fire-and-forget — slot is released in .finally().
      processOne(next)
        .catch((e) => log(`processOne crashed: ${e.message}`))
        .finally(() => {
          active--;
          if (skill) inFlight.delete(skill);
          processing.delete(next);
        });
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

async function watchLoop() {
  try {
    const watcher = watch(QUEUE_DIR, { persistent: true });
    for await (const ev of watcher) {
      if (ev.filename && ev.filename.endsWith(".json")) {
        enqueueNew();
      }
    }
  } catch (e) {
    log(`watcher error: ${e.message} — falling back to polling`);
  }
}

process.on("uncaughtException", (err) => {
  log(`uncaught: ${err.stack || err.message}`);
});

// --- Singleton lock — refuse to boot if another runner is alive.
// Prevents the "5 runners competing for same queue" bug where Startup VBS
// + manual restarts left zombies behind.
const PIDFILE = join(RUNNER_DIR, "runner.pid");

function pidAlive(pid) {
  try {
    process.kill(pid, 0); // signal 0 = liveness check, throws if dead
    return true;
  } catch {
    return false;
  }
}

if (existsSync(PIDFILE)) {
  try {
    const otherPid = parseInt(readFileSync(PIDFILE, "utf8").trim(), 10);
    if (Number.isInteger(otherPid) && otherPid !== process.pid && pidAlive(otherPid)) {
      log(`another runner alive at pid ${otherPid} — exiting this one (pid ${process.pid})`);
      process.exit(0);
    }
  } catch {
    /* stale pidfile — overwrite */
  }
}
writeFileSync(PIDFILE, String(process.pid), "utf8");
process.on("exit", () => {
  try {
    const cur = parseInt(readFileSync(PIDFILE, "utf8").trim(), 10);
    if (cur === process.pid) unlinkSync(PIDFILE);
  } catch {
    /* ignore */
  }
});

ensureDirs();
log(`runner booted (pid ${process.pid})`);
writeHeartbeat();
setInterval(writeHeartbeat, 15_000);
watchLoop();
loop();
