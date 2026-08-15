import fs from "fs";
import path from "path";
import { resolveVaultRoot } from "./vaultRoot";

// ---------------------------------------------------------------------------
// V.A.U.L.T. data layer — reads the SAME files the Obsidian cockpit reads.
// Zero new plumbing: metrics.csv, runner-status.json, latest-video.json,
// system/runs/*.json, daily-notes/YYYY-MM-DD.md.
// ---------------------------------------------------------------------------

const VAULT_ROOT =
  resolveVaultRoot();

export interface MetricPoint {
  timestamp: string;
  value: number;
  status: string;
}

export interface Metric {
  source: string;
  metric: string;
  value: number;
  status: string; // ok | stale | error | mock
  timestamp: string;
  history: MetricPoint[]; // oldest → newest, capped
  delta: number | null; // vs previous reading
  deltaWeek: number | null; // vs oldest point in history window (~6 days at 6h pulls)
}

export interface RunEntry {
  id: string;
  skill: string;
  /** topic tag for voice-asks ("fable 5 news") — null for named skills */
  label: string | null;
  /** external URL when the run's REAL output lives elsewhere (Gmail draft,
   *  video) — parsed from `link:` in the deliverable's frontmatter */
  link: string | null;
  status: string;
  summary: string;
  ts_completed: string | null;
  ts_started: string | null;
  duration_s: number | null;
  deliverable_path: string | null; // vault-relative md the run produced
}

export interface QueueEntry {
  id: string;
  skill: string;
  label: string | null;
  ts: string;
}

export interface RunnerStatus {
  ts: string;
  pid: number;
  version: string;
  busy: boolean;
  active: number;
  max_concurrent: number;
  pending: number;
  heartbeat_age_s: number | null;
  alive: boolean;
}

export interface LatestVideo {
  title: string;
  url: string;
  video_id: string;
  views: number;
  likes: number;
  comments: number;
  published_at: string;
  status: string;
}

export interface DailyNote {
  date: string;
  isToday: boolean;
  top3: { text: string; done: boolean }[];
  schedule: { time: string; item: string }[];
  focus: string;
}

export interface VaultState {
  generated_at: string;
  vault_root: string;
  metrics: Metric[];
  runner: RunnerStatus | null;
  latestVideo: LatestVideo | null;
  daily: DailyNote | null;
  runs: RunEntry[];
  queue: QueueEntry[];
  morning: MorningReport | null;
  outliers: OutlierState | null;
  trendingRepos: string[];
  etas: Record<string, number>; // skill → median duration_s of past ok runs
}

const HISTORY_CAP = 24;

function safeRead(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return null;
  }
}

function safeJson<T>(p: string): T | null {
  const raw = safeRead(p);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// --- metrics.csv ------------------------------------------------------------
// schema: timestamp,source,metric,value,status,error  (append-only)
export function readMetrics(): Metric[] {
  const raw = safeRead(path.join(VAULT_ROOT, "system", "metrics", "metrics.csv"));
  if (!raw) return [];

  const byKey = new Map<string, { source: string; metric: string; points: MetricPoint[] }>();

  const lines = raw.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = line.split(",");
    if (cols.length < 5) continue;
    const [timestamp, source, metric, valueStr, status] = cols;
    const value = parseFloat(valueStr);
    if (Number.isNaN(value)) continue;
    const key = `${source}:${metric}`;
    if (!byKey.has(key)) byKey.set(key, { source, metric, points: [] });
    const bucket = byKey.get(key)!;
    bucket.points.push({ timestamp, value, status });
    if (bucket.points.length > HISTORY_CAP * 4) bucket.points.splice(0, bucket.points.length - HISTORY_CAP * 4);
  }

  const out: Metric[] = [];
  for (const { source, metric, points } of byKey.values()) {
    const history = points.slice(-HISTORY_CAP);
    const latest = history[history.length - 1];
    const prev = history.length > 1 ? history[history.length - 2] : null;
    // weekly delta needs enough window to mean something (≥6 pulls ≈ 1.5 days)
    const oldest = history.length >= 6 ? history[0] : null;
    out.push({
      source,
      metric,
      value: latest.value,
      status: latest.status,
      timestamp: latest.timestamp,
      history,
      delta: prev ? latest.value - prev.value : null,
      deltaWeek: oldest ? latest.value - oldest.value : null,
    });
  }
  return out;
}

// --- runner-status.json -------------------------------------------------------
export function readRunnerStatus(): RunnerStatus | null {
  const j = safeJson<Record<string, unknown>>(path.join(VAULT_ROOT, "system", "runner-status.json"));
  if (!j) return null;
  const ts = String(j.ts ?? "");
  let age: number | null = null;
  const parsed = Date.parse(ts);
  if (!Number.isNaN(parsed)) age = Math.round((Date.now() - parsed) / 1000);
  return {
    ts,
    pid: Number(j.pid ?? 0),
    version: String(j.version ?? "?"),
    busy: Boolean(j.busy),
    active: Number(j.active ?? 0),
    max_concurrent: Number(j.max_concurrent ?? 0),
    pending: Number(j.pending ?? 0),
    heartbeat_age_s: age,
    alive: age !== null && age < 120, // heartbeat every ~30s; 2min = dead
  };
}

// --- latest-video.json --------------------------------------------------------
export function readLatestVideo(): LatestVideo | null {
  const j = safeJson<Record<string, unknown>>(
    path.join(VAULT_ROOT, "system", "metrics", "latest-video.json")
  );
  if (!j) return null;
  return {
    title: String(j.title ?? ""),
    url: String(j.url ?? ""),
    video_id: String(j.video_id ?? ""),
    views: Number(j.views ?? 0),
    likes: Number(j.likes ?? 0),
    comments: Number(j.comments ?? 0),
    published_at: String(j.published_at ?? ""),
    status: String(j.status ?? "?"),
  };
}

// --- system/runs/*.json --------------------------------------------------------
// short topic tag for a voice-ask — every ask shows as "voice ask" otherwise,
// which is useless when two are in flight ("fable 5 news" vs "gmail thing").
// First 3 content words of the prompt.
const ASK_STOP = new Set([
  "a", "an", "the", "me", "my", "i", "you", "your", "please", "jarvis", "hey",
  "ok", "okay", "can", "could", "would", "tell", "about", "like", "little",
  "bit", "more", "just", "that", "this", "what", "whats", "is", "are", "do",
  "does", "of", "for", "to", "in", "on", "and", "or", "so", "um", "uh",
  "once", "when", "after", "with", "go", "run", "really", "actually", "know",
  "want", "wanted", "give", "get", "out", "up", "some", "any", "how",
  "ahead", "also", "then", "now", "again", "came", "thing", "things", "stuff",
]);
function askLabel(args: unknown): string | null {
  const prompt = (args as { prompt?: unknown } | null)?.prompt;
  if (typeof prompt !== "string") return null;
  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !ASK_STOP.has(w));
  return words.length ? words.slice(0, 3).join(" ") : null;
}

// peek a deliverable's frontmatter for `link: <url>` — when present, the
// run's real output lives at that URL and callouts open it instead of the md
function deliverableLink(relPath: unknown): string | null {
  if (typeof relPath !== "string" || !relPath) return null;
  // same guard as readVaultMarkdown — deliverable_path comes from runner-written
  // run JSON, and runs process untrusted content (emails, web); never follow it
  // outside the dirs runs write to
  const clean = relPath.replace(/\\/g, "/");
  if (!READABLE_PREFIXES.some((p) => clean.startsWith(p))) return null;
  const abs = path.resolve(VAULT_ROOT, clean);
  if (!abs.startsWith(path.resolve(VAULT_ROOT) + path.sep)) return null;
  try {
    const raw = fs.readFileSync(abs, "utf-8").slice(0, 800);
    if (!raw.startsWith("---")) return null;
    const fm = raw.split(/\r?\n---/)[0];
    const m = fm.match(/^link:\s*["']?(https?:\/\/\S+?)["']?\s*$/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export function readRecentRuns(limit = 8): RunEntry[] {
  const dir = path.join(VAULT_ROOT, "system", "runs");
  let files: string[];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => path.join(dir, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
      .slice(0, limit);
  } catch {
    return [];
  }
  const out: RunEntry[] = [];
  for (const f of files) {
    const j = safeJson<Record<string, unknown>>(f);
    if (!j) continue;
    const started = j.ts_started ? Date.parse(String(j.ts_started)) : NaN;
    const completed = j.ts_completed ? Date.parse(String(j.ts_completed)) : NaN;
    const duration =
      !Number.isNaN(started) && !Number.isNaN(completed)
        ? Math.max(0, Math.round((completed - started) / 1000))
        : null;
    out.push({
      id: String(j.id ?? path.basename(f, ".json")),
      skill: String(j.skill ?? "?"),
      label: String(j.skill) === "voice-ask" ? askLabel(j.args) : null,
      link: String(j.status) === "ok" ? deliverableLink(j.deliverable_path) : null,
      status: String(j.status ?? "?"),
      summary: String(j.summary ?? ""),
      ts_completed: j.ts_completed ? String(j.ts_completed) : null,
      ts_started: j.ts_started ? String(j.ts_started) : null,
      duration_s: duration,
      deliverable_path: j.deliverable_path ? String(j.deliverable_path) : null,
    });
  }
  return out;
}

// median past runtime per skill — feeds the task callout's progress estimate.
// Only ok runs count (errors die early and would drag the estimate down).
export function readSkillEtas(): Record<string, number> {
  const dir = path.join(VAULT_ROOT, "system", "runs");
  let files: string[];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => path.join(dir, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
      .slice(0, 200);
  } catch {
    return {};
  }
  const bySkill: Record<string, number[]> = {};
  for (const f of files) {
    const j = safeJson<Record<string, unknown>>(f);
    if (!j || j.status !== "ok") continue;
    const started = j.ts_started ? Date.parse(String(j.ts_started)) : NaN;
    const completed = j.ts_completed ? Date.parse(String(j.ts_completed)) : NaN;
    if (Number.isNaN(started) || Number.isNaN(completed)) continue;
    const d = Math.max(1, Math.round((completed - started) / 1000));
    (bySkill[String(j.skill ?? "?")] ??= []).push(d);
  }
  const out: Record<string, number> = {};
  for (const [skill, ds] of Object.entries(bySkill)) {
    ds.sort((a, b) => a - b);
    out[skill] = ds[Math.floor(ds.length / 2)];
  }
  return out;
}

// --- system/queue/*.json — intents waiting for the runner ----------------------
export function readQueue(): QueueEntry[] {
  const dir = path.join(VAULT_ROOT, "system", "queue");
  let files: string[];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => path.join(dir, f))
      .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
  } catch {
    return [];
  }
  const out: QueueEntry[] = [];
  for (const f of files) {
    const j = safeJson<Record<string, unknown>>(f);
    if (!j) continue;
    out.push({
      id: String(j.id ?? path.basename(f, ".json")),
      skill: String(j.skill ?? "?"),
      label: String(j.skill) === "voice-ask" ? askLabel(j.args) : null,
      ts: String(j.ts ?? ""),
    });
  }
  return out;
}

// --- daily note -----------------------------------------------------------------
// Today's note if present, else the most recent. Parser contract: frozen v1
// schema — `## Top 3 Priorities` numbered checkboxes + `## Schedule` bullets.
export function readDailyNote(): DailyNote | null {
  const dir = path.join(VAULT_ROOT, "daily-notes");
  // local (America/Chicago) date — toISOString() is UTC and flips to
  // tomorrow after ~7pm CT, which made evening sessions claim today's
  // note didn't exist (same fix as runner.js todayDate())
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(
    new Date()
  );
  let file = path.join(dir, `${today}.md`);
  let isToday = true;
  let date = today;

  if (!fs.existsSync(file)) {
    isToday = false;
    let names: string[];
    try {
      names = fs
        .readdirSync(dir)
        .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
        .sort()
        .reverse();
    } catch {
      return null;
    }
    if (names.length === 0) return null;
    file = path.join(dir, names[0]);
    date = names[0].replace(".md", "");
  }

  const raw = safeRead(file);
  if (!raw) return null;

  const top3: { text: string; done: boolean }[] = [];
  const schedule: { time: string; item: string }[] = [];
  let focus = "";

  let section = "";
  for (const line of raw.split(/\r?\n/)) {
    const h = line.match(/^##\s+(.*)/);
    if (h) {
      section = h[1].trim();
      continue;
    }
    if (section === "Top 3 Priorities") {
      const m = line.match(/^\d+\.\s+\[( |x)\]\s+(.*)/);
      if (m) top3.push({ text: m[2].trim(), done: m[1] === "x" });
    } else if (section === "Schedule") {
      const m = line.match(/^-\s+(\d{1,2}:\d{2})\s*[—–-]+\s*(.*)/);
      if (m) schedule.push({ time: m[1], item: m[2].trim() });
    } else if (section === "Current Focus") {
      if (line.trim() && !focus) focus = line.trim();
    }
  }

  return { date, isToday, top3, schedule, focus };
}

// --- daily note write — flip a Top 3 checkbox -----------------------------------
// Only today's note is writable (stale notes are history). Index = nth
// checkbox under `## Top 3 Priorities`, matching the parser above.
export function toggleTop3(index: number, done: boolean): boolean {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(
    new Date()
  );
  const file = path.join(VAULT_ROOT, "daily-notes", `${today}.md`);
  const raw = safeRead(file);
  if (!raw) return false;

  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(/\r?\n/);
  let section = "";
  let seen = -1;
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^##\s+(.*)/);
    if (h) {
      section = h[1].trim();
      continue;
    }
    if (section !== "Top 3 Priorities") continue;
    const m = lines[i].match(/^(\d+\.\s+)\[( |x)\](\s+.*)/);
    if (!m) continue;
    seen++;
    if (seen === index) {
      lines[i] = `${m[1]}[${done ? "x" : " "}]${m[3]}`;
      fs.writeFileSync(file, lines.join(eol), "utf-8");
      return true;
    }
  }
  return false;
}

// --- daily note write — driver toggles + quick-add --------------------------------
// Voice-initiated writes happen HERE (server-side, fs) so both the browser
// HUD and the Obsidian cockpit get real writes; Obsidian's file watcher
// picks the change up like any external edit.

function todayNotePath(): string {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(
    new Date()
  );
  return path.join(VAULT_ROOT, "daily-notes", `${today}.md`);
}

/** fuzzy checkbox toggle across Top 3 (numbered) and Daily Drivers (dashed).
 *  Scores word overlap between the spoken target and each item's text. */
export function toggleTaskFuzzy(
  target: string
): { ok: boolean; item?: string; done?: boolean; section?: string } {
  const file = todayNotePath();
  const raw = safeRead(file);
  if (!raw) return { ok: false };

  const wanted = target
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
  if (wanted.length === 0) return { ok: false };

  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(/\r?\n/);
  let section = "";
  let bestLine = -1;
  let bestScore = 0;
  let bestSection = "";
  const CHECKBOX = /^(?:\d+\.|-)\s+\[( |x)\]\s+(.*)/;
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^##\s+(.*)/);
    if (h) {
      section = h[1].trim();
      continue;
    }
    if (section !== "Top 3 Priorities" && section !== "Daily Drivers") continue;
    const m = lines[i].match(CHECKBOX);
    if (!m) continue;
    const hay = m[2].toLowerCase();
    const score = wanted.reduce((s, w) => s + (hay.includes(w) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      bestLine = i;
      bestSection = section;
    }
  }
  // require a real match — at least half the content words, min 1
  if (bestLine < 0 || bestScore < Math.max(1, Math.ceil(wanted.length / 2))) {
    return { ok: false };
  }
  const m = lines[bestLine].match(/^((?:\d+\.|-)\s+)\[( |x)\](\s+)(.*)/)!;
  const nowDone = m[2] !== "x";
  lines[bestLine] = `${m[1]}[${nowDone ? "x" : " "}]${m[3]}${m[4]}`;
  fs.writeFileSync(file, lines.join(eol), "utf-8");
  return { ok: true, item: m[4].trim(), done: nowDone, section: bestSection };
}

/** append `- [ ] text` under ## Daily Drivers in today's note */
export function addDriver(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const file = todayNotePath();
  const raw = safeRead(file);
  if (!raw) return false;

  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const marker = "## Daily Drivers";
  const idx = raw.indexOf(marker);
  if (idx < 0) return false;
  const afterHeading = idx + marker.length;
  const nextSection = raw.indexOf("\n## ", afterHeading);
  const insertAt = nextSection < 0 ? raw.length : nextSection;
  const sectionContent = raw.slice(afterHeading, insertAt).replace(/\s+$/, "");
  const newSection = `${sectionContent}${eol}- [ ] ${trimmed}${eol}`;
  fs.writeFileSync(file, raw.slice(0, afterHeading) + newSection + raw.slice(insertAt), "utf-8");
  return true;
}

// --- outlier radar (inbox/research/outlier-radar/) --------------------------------
// Latest radar file → count + top entries, so tier 2 can answer "any new
// outliers?" without a background session.
export interface OutlierState {
  rel: string;
  date: string;
  count: number;
  top: { title: string; mult: string; channel: string }[];
}

export function readOutliers(): OutlierState | null {
  try {
    const dir = path.join(VAULT_ROOT, "inbox", "research", "outlier-radar");
    const file = fs
      .readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}.*\.md$/.test(f))
      .sort()
      .pop();
    if (!file) return null;
    const raw = fs.readFileSync(path.join(dir, file), "utf-8");
    // bullets: - **[title](url)** — **12.3x** | ... | [channel](url) (subs) | ...
    const seen = new Set<string>();
    const top: OutlierState["top"] = [];
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(
        /^-\s+\*\*\[([^\]]+)\]\([^)]*\)\*\*\s+—\s+\*\*([^*]+)\*\*.*?\[([^\]]+)\]/
      );
      if (!m || seen.has(m[1])) continue;
      seen.add(m[1]);
      top.push({ title: m[1], mult: m[2].trim(), channel: m[3] });
    }
    return {
      rel: `inbox/research/outlier-radar/${file}`,
      date: file.slice(0, 10),
      count: seen.size,
      top: top.slice(0, 3),
    };
  } catch {
    return null;
  }
}

// --- github trending slugs ---------------------------------------------------------
// owner/name list from the latest trending report — lets the router resolve
// "bring up that repo" against repos the OS actually knows about.
export function readTrendingSlugs(max = 20): string[] {
  try {
    const dir = path.join(VAULT_ROOT, "inbox", "research", "github-trending");
    const file = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md") && !f.startsWith("_"))
      .sort()
      .pop();
    if (!file) return [];
    const raw = fs.readFileSync(path.join(dir, file), "utf-8");
    const out: string[] = [];
    const seen = new Set<string>();
    const re = /^###\s+\d+\.\s+\[([^\]]+)\]/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null && out.length < max) {
      const slug = m[1].trim();
      if (slug.includes("/") && !seen.has(slug)) {
        seen.add(slug);
        out.push(slug);
      }
    }
    return out;
  } catch {
    return [];
  }
}

// --- latest report file (voice "open the …" targets) -------------------------------
// Newest markdown in a report folder, optionally filtered by filename —
// "open morning intel" must land on the last run even when it ran yesterday
// (readMorningReport is today-only by design; this is not).
export function latestReportIn(relDir: string, filter?: RegExp): string | null {
  try {
    const dir = path.join(VAULT_ROOT, ...relDir.split("/"));
    const file = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md") && !f.startsWith("_"))
      .filter((f) => (filter ? filter.test(f) : true))
      .sort()
      .pop();
    return file ? `${relDir}/${file}` : null;
  } catch {
    return null;
  }
}

// --- read a vault markdown deliverable (report overlay) ---------------------------
// Path must stay inside the vault and under the dirs runs write to.
const READABLE_PREFIXES = ["inbox/", "system/runs/"];

export function readVaultMarkdown(rel: string): string | null {
  const clean = rel.replace(/\\/g, "/");
  if (!clean.endsWith(".md")) return null;
  if (!READABLE_PREFIXES.some((p) => clean.startsWith(p))) return null;
  const abs = path.resolve(VAULT_ROOT, clean);
  if (!abs.startsWith(path.resolve(VAULT_ROOT) + path.sep)) return null; // no traversal
  return safeRead(abs);
}

// --- today's morning report headlines ---------------------------------------------
// `## Headlines` bullets, markdown stripped — feeds the AI Wire panel and the
// spoken briefing (lib/router.ts). rel = vault-relative path for the overlay.
export interface MorningReport {
  rel: string;
  heads: string[];
  /** first source URL per headline (parallel to heads; null = no link) */
  links: (string | null)[];
  /** condensed "## Inbox" triage from the intel brief — the email heavy
   *  lifting is already DONE there; surfacing it in the router snapshot is
   *  what keeps "any important emails?" a 1-second tier-2 answer instead of
   *  a 43-second background session re-reading Gmail */
  inbox: string[];
}

export function readMorningReport(max = 4): MorningReport | null {
  try {
    // morning-intel has TWO homes: interactive runs write
    // inbox/research/morning-intel/, runner-queued runs write
    // inbox/reports/morning/ — today's files from both compete
    const homes = ["inbox/research/morning-intel", "inbox/reports/morning"];
    const prefix = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(
      new Date()
    );
    const todays: { rel: string; abs: string; file: string }[] = [];
    for (const home of homes) {
      const dir = path.join(VAULT_ROOT, ...home.split("/"));
      let files: string[] = [];
      try {
        files = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const f of files) {
        if (f.startsWith(prefix) && f.endsWith(".md")) {
          todays.push({ rel: `${home}/${f}`, abs: path.join(dir, f), file: f });
        }
      }
    }
    todays.sort((a, b) => a.file.localeCompare(b.file));
    // morning-intel is THE morning source; legacy formats are fallback
    const pick = todays.filter((x) => /-intel/.test(x.file)).pop() ?? todays.pop();
    if (!pick) return null;
    const raw = fs.readFileSync(pick.abs, "utf-8");
    const heads: string[] = [];
    const links: (string | null)[] = [];
    let inHeads = false;
    for (const line of raw.split(/\r?\n/)) {
      // intel's ## TL;DR or legacy ##/### Headlines both count
      if (/^#{2,3}\s/.test(line)) {
        if (inHeads) break;
        inHeads = /^##\s+TL;DR/i.test(line) || /^#{2,3}\s+Headlines/i.test(line);
        continue;
      }
      if (inHeads && /^[-*]\s+/.test(line)) {
        // first http(s) URL on the bullet — markdown link or bare
        const url = line.match(/https?:\/\/[^\s)\]"']+/)?.[0] ?? null;
        const clean = line
          .replace(/^[-*]\s+/, "")
          .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // [text](url) → text
          .replace(/https?:\/\/[^\s)\]"']+/g, "")
          .replace(/[*_`]/g, "")
          .trim();
        if (clean) {
          heads.push(clean.slice(0, 160));
          links.push(url);
        }
        if (heads.length >= max) break;
      }
    }
    // inbox triage digest — category headers, per-thread bullets, and the
    // thread-count line, markdown stripped
    const inbox: string[] = [];
    const mInbox = raw.match(/^## Inbox[^\n]*\r?\n([\s\S]*?)(?=^## |\Z)/m);
    if (mInbox) {
      for (const line of mInbox[1].split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        if (/^~/.test(t) || /^\*\*/.test(t) || /^[-*]\s+\*\*/.test(t)) {
          const clean = t
            .replace(/^[-*]\s+/, "")
            .replace(/\*\*/g, "")
            .replace(/[`_]/g, "")
            .trim();
          if (clean) inbox.push(clean.slice(0, 220));
        }
        if (inbox.length >= 12) break;
      }
    }
    return { rel: pick.rel, heads, links, inbox };
  } catch {
    return null;
  }
}

// --- consolidated snapshot --------------------------------------------------------
export function readVaultState(): VaultState {
  return {
    generated_at: new Date().toISOString(),
    vault_root: VAULT_ROOT,
    metrics: readMetrics(),
    runner: readRunnerStatus(),
    latestVideo: readLatestVideo(),
    daily: readDailyNote(),
    runs: readRecentRuns(),
    queue: readQueue(),
    morning: readMorningReport(),
    outliers: readOutliers(),
    trendingRepos: readTrendingSlugs(),
    etas: readSkillEtas(),
  };
}
