import { homeEnv } from "./homeEnv";
import { ALLOWED_SKILLS } from "./skills";
import {
  addDriver,
  latestReportIn,
  readMorningReport,
  readVaultMarkdown,
  readVaultState,
  toggleTaskFuzzy,
  toggleTop3,
  type VaultState,
  type Metric,
} from "./vault";
import { recentExchanges } from "./voiceMemory";

// ---------------------------------------------------------------------------
// route(transcript) → {tier, skill?, reply}. Tier 1 = dispatch a skill to the
// queue, tier 2 = answer from the vault snapshot, tier 3 = needs real
// thinking (not wired yet — honest about it).
// Two engines: Haiku when ANTHROPIC_API_KEY exists (~/.claude/.env), else a
// rule matcher that covers the known commands and dashboard questions.
// Haiku failure falls back to rules — the PTT loop never dies on a 4xx.
// ---------------------------------------------------------------------------

export interface RouteResult {
  tier: 1 | 2 | 3;
  skill?: string;
  reply: string;
  engine: "haiku" | "rules" | "local";
  /** HUD panels the reply talks about — P3 choreography highlights them */
  panels?: PanelId[];
  /** vault-relative md the reply references — HUD offers it via the reveal chip */
  deliverable?: string;
  /** "open" = pop the deliverable overlay immediately instead of offering a chip */
  reveal?: "open";
  /** callouts sequenced to the speech — `at` = char offset into the reply
   *  where the relevant sentence starts; the client converts to time */
  reveals?: Reveal[];
  /** rules engine matched nothing concrete — a smarter engine may retry */
  fallthrough?: boolean;
  /** UI action for the Obsidian orb — see ObsidianAction */
  obsidian?: ObsidianAction;
  /** model-proposed vault write — route() executes it server-side and
   *  replaces the reply with the real outcome */
  write?: VaultWrite;
}

export type VaultWrite =
  | { kind: "top3"; index: number; undo: boolean }
  | { kind: "task"; target: string }
  | { kind: "add"; text: string };

export interface Reveal {
  kind: "doc" | "link";
  /** vault-relative md (doc) or full URL (link) */
  target: string;
  label: string;
  at: number;
}

/** UI action executed by the Obsidian cockpit orb (the browser HUD ignores
 *  these). Replies stay EMPTY for these — the action executing is the
 *  confirmation; a spoken ack would double the perceived latency. */
export type ObsidianWhere = "tab" | "split" | "right-sidebar" | "left-sidebar";
export type ObsidianAction =
  | { op: "daily-note"; where?: ObsidianWhere }
  | { op: "cockpit" }
  | { op: "open-note"; query: string; where?: ObsidianWhere }
  | { op: "search"; query: string }
  | { op: "command"; id: string; label: string }
  | { op: "web"; url: string; label: string; where?: ObsidianWhere }
  | { op: "repo"; slug: string; where?: ObsidianWhere };

// command ids the orb may execute — ALSO the allowlist for model-emitted
// actions (a model must never invoke arbitrary command ids)
export const COMMAND_ALLOW: Record<string, string> = {
  "app:go-back": "back",
  "app:go-forward": "forward",
  "workspace:close": "close tab",
  "workspace:split-vertical": "split right",
  "workspace:split-horizontal": "split down",
  "app:toggle-left-sidebar": "left sidebar",
  "app:toggle-right-sidebar": "right sidebar",
  "graph:open": "graph view",
  // opens in a bottom split via the terminal plugin's own newInstanceBehavior.
  // id format is open-terminal.<default|integrated|external|select>.<root|current>
  // since the plugin's 3.27 update (the old open-terminal.default died silently);
  // verified against main.js: for m of [kinds] for o of [places] → `open-terminal.${m}.${o}`
  "terminal:open-terminal.default.root": "terminal",
};

// named web targets → urls (model picks a NAME, never a raw url); opened in
// Obsidian's core Web Viewer
export const WEB_TARGETS: Record<string, { url: string; label: string }> = {
  calendar: { url: "https://calendar.google.com", label: "google calendar" },
  gmail: { url: "https://mail.google.com", label: "gmail" },
  "youtube-studio": { url: "https://studio.youtube.com", label: "youtube studio" },
};

// named report targets → vault report folders; "open morning intel" opens the
// NEWEST file as a native note in a main tab (deliverable + reveal channel).
// Born 2026-08-14 when Google blocked embedded sign-in and took the
// calendar/gmail web targets with it — vault docs can't be walled off.
export const REPORT_TARGETS: Record<
  string,
  { dirs: string[]; filter?: RegExp; label: string }
> = {
  // morning-intel's output is THE morning report these days — the filter
  // skips legacy morning-report files unless nothing else exists. TWO homes:
  // interactive /morning-intel writes inbox/research/morning-intel/, the
  // runner queue writes inbox/reports/morning/ — newest date wins.
  "morning-intel": {
    dirs: ["inbox/research/morning-intel", "inbox/reports/morning"],
    filter: /-intel/,
    label: "morning intel",
  },
  "github-trending": { dirs: ["inbox/research/github-trending"], label: "github trending" },
  "outlier-radar": { dirs: ["inbox/research/outlier-radar"], label: "outlier radar" },
  "inbox-brief": { dirs: ["inbox/reports/inbox-briefs"], label: "inbox brief" },
};

function resolveReport(name: string): string | null {
  const t = REPORT_TARGETS[name];
  if (!t) return null;
  // per-dir newest (filtered, falling back unfiltered), then newest across
  // dirs by the YYYY-MM-DD filename prefix; earlier dir wins date ties
  let best: string | null = null;
  for (const dir of t.dirs) {
    const c = latestReportIn(dir, t.filter) ?? (t.filter ? latestReportIn(dir) : null);
    if (!c) continue;
    if (!best) {
      best = c;
      continue;
    }
    const db = best.split("/").pop()!.slice(0, 10);
    const dc = c.split("/").pop()!.slice(0, 10);
    if (dc > db) best = c;
  }
  return best;
}

export const PANEL_IDS = [
  "vitals",
  "pipeline",
  "diagnostics",
  "priorities",
  "schedule",
  "objective",
  "documents",
] as const;
export type PanelId = (typeof PANEL_IDS)[number];

const HAIKU_MODEL = "claude-haiku-4-5-20251001";

// alias → skill; order matters ("github trending" must not hit "trend scan")
const SKILL_ALIASES: [RegExp, string][] = [
  [/github/, "github-trending"],
  [/trend scan|ai trend/, "ai-trend-scan"],
  [/metric|pull the numbers/, "metrics-pull"],
  [/morning report|am report/, "morning-report"],
  [/inbox/, "inbox-brief"],
  [/clean ?up/, "vault-cleanup"],
  [/week review|youtube week|yt week/, "yt-week-review"],
  [/plan today|plan the day|plan my day/, "plan-today"],
  [/plan tomorrow/, "plan-tomorrow"],
  [/weekly review/, "weekly-review"],
  [/morning intel|intel brief|intel sweep/, "morning-intel"],
  [/outlier|radar/, "outlier-radar"],
  [/lead research|research (?:my |the )?leads|new leads/, "lead-research"],
];

const QUESTION_START = /^(what|how|is|are|was|did|when|who|where|why|any|do i|does|tell me)\b/;
// The full ~25s rundown fires ONLY on deliberate whole-utterance triggers —
// "give me the rundown", "brief me", "good morning". The old wide net (~20
// loose phrasings) hijacked specific questions ("what's going on with the
// github trending report today" got the whole daily spiel). Specific asks
// now fall through to the model engines, which answer about the THING asked.
const BRIEFING_RE =
  /^(?:hey |ok |okay |so )*(?:jarvis,? )?(?:(?:can you |could you |what'?s |whats )?(?:give me |read me |run )?(?:the |my )?(?:daily |morning |full )?(?:rundown|briefing)|brief me|catch me up|good morning|morning,? jarvis)(?: for today| on today| today)?(?: please)?(?:,? jarvis)?$/;

// Engine order (VOICE_ROUTER=auto, the default): rules answer everything they
// recognize at ~0ms; only an unrecognized utterance pays for a model call —
// Haiku if the key exists, else the local Ollama model, else the generic
// tier-3 fallthrough (voice-ask dispatch). VOICE_ROUTER=local|haiku|rules
// forces one engine first (model engines still degrade to rules on error).
export async function route(transcript: string, convo = ""): Promise<RouteResult> {
  warmHaiku(); // no-op when already warmed — retries a failed module-load ping
  const state = readVaultState();
  let result = await pickEngine(transcript, state, convo);
  // model-proposed writes execute HERE, server-side, and the reply becomes
  // the real outcome — the model proposes, the fs result speaks
  if (result.write) {
    result = {
      ...result,
      write: undefined,
      reply: performWrite(result.write, state),
      panels: ["priorities"],
      tier: 2,
    };
  }
  return inFlightGuard(result, transcript, state);
}

function performWrite(w: VaultWrite, state: VaultState): string {
  if (!state.daily?.isToday) {
    return "There's no daily note for today yet — say plan today first.";
  }
  if (w.kind === "top3") {
    const ok = toggleTop3(w.index, !w.undo);
    if (!ok) return "I couldn't find that slot on today's board.";
    const item = state.daily.top3[w.index]?.text;
    const tail = item ? `: ${stripParens(item).slice(0, 60)}` : ".";
    return w.undo
      ? `Unchecked priority ${SPOKEN_IDX[w.index]}${tail}`
      : `Done — priority ${SPOKEN_IDX[w.index]} checked off${tail}`;
  }
  if (w.kind === "task") {
    const res = toggleTaskFuzzy(w.target);
    if (!res.ok) return `I couldn't find a task matching "${w.target}" on today's board.`;
    return `${res.done ? "Checked off" : "Unchecked"}: ${res.item}.`;
  }
  return addDriver(w.text)
    ? `Added to today's drivers: ${w.text}.`
    : "I couldn't find the Daily Drivers section in today's note.";
}

// --- exact-phrase fast path (model-first mode) -------------------------------
// Model-first routing pays ~1.5s per utterance. Verbatim commands never needed
// the model's judgment — the misfire day came from fuzzy regexes GUESSING on
// sloppy phrasings, and an exact match can't guess. Only utterances that
// normalize to exactly one of these phrases consult rules; everything else
// (and any rules fallthrough on these) still goes to the model.
const FAST_EXACT = new Set([
  "open my daily note", "open the daily note", "open daily note",
  "open the cockpit", "open my cockpit", "open the dashboard", "open my dashboard",
  "go back", "go forward", "close tab", "close this tab",
  "split right", "split down",
  "toggle sidebar", "toggle the sidebar", "toggle left sidebar", "toggle right sidebar",
  "open my calendar", "pull up my calendar", "open my gmail", "open youtube studio",
  "intel brief", "run the intel brief", "outlier radar", "run the outlier radar",
  "github trending", "run github trending", "metrics pull", "pull metrics",
  "open morning intel", "open the morning intel", "open the intel brief",
  "open the intel report", "open the morning report",
  "open github trending", "open the github trending", "open the trending report",
  "open the outlier radar", "open the inbox brief",
  "good morning",
  "open the terminal", "open terminal", "open a terminal",
  "pull up the terminal", "pull up a terminal", "bring up the terminal",
  "show me the terminal", "launch the terminal", "terminal",
]);

function fastNorm(t: string): string {
  return t
    .toLowerCase()
    .replace(/[.,!?']/g, "")
    .replace(/^(?:hey |ok |okay )*(?:jarvis,? )?/, "")
    .replace(/,? please$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function fastPath(transcript: string, state: VaultState): RouteResult | null {
  const norm = fastNorm(transcript);
  if (!FAST_EXACT.has(norm)) return null;
  // rules see the normalized phrase — "hey jarvis ... please." wrappers are
  // already verified harmless by the exact match above
  const viaRules = rulesRoute(norm, state);
  return viaRules.fallthrough ? null : viaRules;
}

async function pickEngine(
  transcript: string,
  state: VaultState,
  convo: string
): Promise<RouteResult> {
  const pref = (homeEnv("VOICE_ROUTER") || "auto").toLowerCase();

  if (pref === "haiku") {
    const fast = fastPath(transcript, state);
    if (fast) return fast;
    const r = await haikuRoute(transcript, state, convo).catch(() => null);
    return r ?? rulesRoute(transcript, state);
  }
  if (pref === "local") {
    const fast = fastPath(transcript, state);
    if (fast) return fast;
    const r = await localRoute(transcript, state, convo).catch(() => null);
    return r ?? rulesRoute(transcript, state);
  }
  if (pref === "rules") return rulesRoute(transcript, state);

  // auto — rules first, smarter engine only for the generic fallthrough
  const viaRules = rulesRoute(transcript, state);
  if (!viaRules.fallthrough) return viaRules;
  if (homeEnv("ANTHROPIC_API_KEY")) {
    const viaHaiku = await haikuRoute(transcript, state, convo).catch(() => null);
    if (viaHaiku) return viaHaiku;
  }
  const viaLocal = await localRoute(transcript, state, convo).catch(() => null);
  return viaLocal ?? viaRules;
}

// --- in-flight guard ----------------------------------------------------------
// A skill mention isn't always a dispatch: "once you're done with that inbox
// brief, tell me about Fable 5" REFERENCES the running brief — it doesn't
// order a second one. When any engine routes tier 1 for a skill that's
// already queued or running (and the user didn't explicitly ask for a
// repeat), reroute: substantial residue beyond the alias → tier-3 background
// ask with the full sentence; bare re-dispatch → "already running".

const RERUN_RE = /\b(again|another|re-?run|one more|fresh|new one)\b/;
// dispatch verbs, temporal connectives, and politeness — NOT content words
const RESIDUE_FILLER =
  /\b(once|when|after|while|you'?re?|are|is|it'?s?|done|finished|finish(es)?|complete(s|d)?|with|that|the|a|an|and|then|can|could|would|you|please|jarvis|hey|ok|okay|so|also|me|my|run|pull|do|start|fire|kick|queue|launch|scan|fetch|refresh|get|brief|report|audit)\b/g;

function skillInFlight(skill: string, state: VaultState): boolean {
  return (
    state.queue.some((q) => q.skill === skill) ||
    state.runs.some((r) => r.skill === skill && r.status === "running")
  );
}

// exported for tests — route() applies it internally
export function inFlightGuard(r: RouteResult, transcript: string, state: VaultState): RouteResult {
  if (r.tier !== 1 || !r.skill || !skillInFlight(r.skill, state)) return r;
  const t = transcript.toLowerCase();
  if (RERUN_RE.test(t)) return r; // explicit repeat — let it through
  const name = r.skill.replace(/-/g, " ");
  const alias = SKILL_ALIASES.find(([re]) => re.test(t))?.[0];
  const residue = t
    .replace(alias ?? /$^/, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(RESIDUE_FILLER, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (residue.length >= 3) {
    // there's a real ask riding along with the reference — background it
    return {
      tier: 3,
      reply: `The ${name} is already in the works — I'll dig into the rest of that and get back to you.`,
      engine: r.engine,
      panels: ["pipeline"],
    };
  }
  return {
    tier: 2,
    reply: `The ${name} is already running — I'll let you know the moment it lands.`,
    engine: r.engine,
    panels: ["pipeline"],
  };
}

// --- rules engine -----------------------------------------------------------

// --- offer follow-through ----------------------------------------------------
// The kickoff brief ends with "Want me to run the inbox audit?" — a bare "yes"
// must dispatch that skill. The offer is recovered from the LAST exchange in
// convo memory (fresh within 3 min), so this stays stateless per-request.

const AFFIRM_RE =
  /^(yes|yeah|yep|sure|absolutely|go ahead|do it|let'?s do it|please do|yes please|go for it|sounds good)( please)?,?( jarvis)?$/;
const DECLINE_RE =
  /^(no|nope|nah|not (right )?now|not yet|later|maybe later|hold off|skip it)( thanks| thank you)?,?( jarvis)?$/;
const OFFER_SKILLS: Record<string, string> = {
  "morning report": "morning-report",
  "inbox audit": "inbox-brief",
  "fresh metrics": "metrics-pull",
  "a trend scan": "ai-trend-scan",
};

function pendingOffer(): string | null {
  const last = recentExchanges(1)[0];
  if (!last || Date.now() - Date.parse(last.ts) > 3 * 60 * 1000) return null;
  const m = last.jarvis
    .toLowerCase()
    .match(/want me to (?:run|pull) (?:the )?(?:daily )?(morning report|inbox audit|fresh metrics|a trend scan)/);
  return m ? OFFER_SKILLS[m[1]] ?? null : null;
}

// dispatch acks must not lie: the intent always queues, but if the runner
// daemon's heartbeat is gone it won't START until someone restarts it —
// say so instead of a cheery "On it"
function runnerDownNote(state: VaultState): string | null {
  return state.runner?.alive
    ? null
    : "but heads up — the runner daemon looks down, so it'll sit in the queue until that's restarted.";
}

// exported for tests — route() applies it internally
export function rulesRoute(transcript: string, state: VaultState): RouteResult {
  const t = transcript.toLowerCase().replace(/[^a-z0-9$:'\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return { tier: 3, reply: "I didn't catch that.", engine: "rules" };

  // answer to a standing offer beats everything else
  if (AFFIRM_RE.test(t) || DECLINE_RE.test(t)) {
    const offered = pendingOffer();
    if (offered && AFFIRM_RE.test(t)) {
      return {
        tier: 1,
        skill: offered,
        reply: `On it — ${offered.replace(/-/g, " ")} ${runnerDownNote(state) ?? "running now."}`,
        engine: "rules",
        panels: ["pipeline"],
      };
    }
    if (offered) return { tier: 2, reply: "Standing by.", engine: "rules" };
  }

  // Obsidian UI control — "open my daily note", "go back", "split right".
  // Reply stays EMPTY: the orb executes the action and the UI changing IS
  // the confirmation (a spoken ack would double perceived latency).
  const ui = obsidianAnswer(t);
  if (ui) return { tier: 2, reply: "", engine: "rules", obsidian: ui };

  // named reports — "open morning intel" / "open github trending" → the
  // newest report file, opened as a native note in a main tab. Must run
  // BEFORE repoAnswer ("trending repos" contains the repo word) and before
  // openDocAnswer (whose runs-list scoring is recency-limited).
  const rep = reportOpenAnswer(t);
  if (rep) {
    return {
      tier: 2,
      reply: rep.text,
      engine: "rules",
      panels: rep.panels,
      deliverable: rep.deliverable,
      reveal: rep.reveal,
    };
  }

  // github repos — "bring up that repo" resolves against the conversation
  // AND the trending list ("that repo" once opened a random vault doc)
  const repo = repoAnswer(t, state);
  if (repo) {
    return {
      tier: 2,
      reply: typeof repo === "string" ? repo : "",
      engine: "rules",
      obsidian: typeof repo === "string" ? undefined : repo,
    };
  }

  // voice vault WRITES — "check off priority two", "add record the demo to
  // my tasks". Performed here server-side (fs) so the browser HUD and the
  // Obsidian cockpit both see the real file change; imperative-anchored
  // regexes so questions never trigger a write.
  const write = vaultWriteAnswer(t, state);
  if (write) {
    return { tier: 2, reply: write.text, engine: "rules", panels: write.panels };
  }

  const isQuestion = QUESTION_START.test(t) || transcript.includes("?");

  // open-verbs preempt skill dispatch — "show me the trend scan" means the
  // DOCUMENT from the last run, not "run a fresh scan"
  const doc = openDocAnswer(t, state);
  if (doc) {
    return {
      tier: 2,
      reply: doc.text,
      engine: "rules",
      panels: doc.panels,
      deliverable: doc.deliverable,
      reveal: doc.reveal,
      obsidian: doc.obsidian,
    };
  }

  // NO verb-based dispatch here. A command-verb-anywhere + alias-anywhere
  // rule misfired twice on questions that merely mention a skill ("…do you
  // have any you think we should video?" — interrogative "do" counted as a
  // verb and re-ran github-trending). Sentence-level intent is the model
  // engines' job; rules dispatch ONLY the bare-alias short utterances below.

  const answer = stateAnswer(t, state);
  if (answer) {
    return {
      tier: 2,
      reply: answer.text,
      engine: "rules",
      panels: answer.panels,
      deliverable: answer.deliverable,
      reveal: answer.reveal,
      reveals: answer.reveals,
      obsidian: answer.obsidian,
    };
  }

  // chitchat — instant tier-2 reply; without this, "hey what's up" fell
  // through to tier 3 and burned a 30s+ background run on a greeting
  const chat = smalltalk(t, state);
  if (chat) return { tier: 2, reply: chat, engine: "rules" };

  // bare alias, short utterance ("trend scan", "the inbox brief please") —
  // clear-cut dispatch. Longer sentences that name-drop a skill without a
  // command verb are ambiguous: defer to the model engines (when in doubt,
  // let something that can read decide).
  const skill = matchSkill(t);
  if (skill && !isQuestion && t.split(/\s+/).length <= 5) {
    return {
      tier: 1,
      skill,
      reply: `On it — ${skill.replace(/-/g, " ")} ${runnerDownNote(state) ?? "coming up."}`,
      engine: "rules",
      panels: ["pipeline"],
    };
  }

  return {
    tier: 3,
    reply: runnerDownNote(state)
      ? "I've queued that, but heads up — the runner daemon looks down, so it'll wait until that's restarted."
      : "Working on it — I'll speak up when it lands.",
    engine: "rules",
    fallthrough: true,
  };
}

// --- smalltalk -----------------------------------------------------------
// Greetings, acks, mic checks — answered instantly, NEVER dispatched to the
// runner. Note: `t` is already lowercased with ?!. stripped (apostrophes kept).

function smalltalk(t: string, state: VaultState): string | null {
  if (/\b(can you hear me|are you there|you there|you up|mic check|testing testing|test test)\b/.test(t)) {
    return "Loud and clear.";
  }
  if (/\b(thank you|thanks|appreciate it|appreciate you)\b/.test(t)) {
    return "Anytime.";
  }
  if (/\b(good ?night|i'?m off|heading to bed|signing off|see you tomorrow)\b/.test(t)) {
    return "Goodnight. I'll keep watch.";
  }
  // bare acks in any short combo: "ok", "okay cool", "nice one jarvis"
  if (/^((ok(ay)?|cool|nice|got it|sounds good|great|perfect|alright|sweet|then|one|man|jarvis)\s*){1,4}$/.test(t)) {
    return "Standing by.";
  }
  if (/\b(how are you|how'?s it going|how you doing|you good|you doing ok)\b/.test(t)) {
    return "Running smooth — all systems green. What do you need?";
  }
  if (
    /\b(what'?s up|whats up|wassup|what is up)\b/.test(t) ||
    /^(hey|hi|hello|yo|sup|hey there|good (morning|afternoon|evening))( there)?( jarvis)?$/.test(t)
  ) {
    return greetingReply(state);
  }
  return null;
}

// greeting gets a one-breath status so "what's up" actually answers the
// question — and points at the briefing for the long version
function greetingReply(state: VaultState): string {
  const bits: string[] = [];
  if (state.runner?.busy) bits.push("the runner's mid-job");
  const open = state.daily?.isToday ? state.daily.top3.filter((p) => !p.done).length : 0;
  if (open > 0) bits.push(`${open === 1 ? "one directive" : `${open} directives`} still open`);
  const status = bits.length > 0 ? bits.join(" and ") : "all quiet on my end";
  return `Not much — ${status}. Say brief me if you want the rundown.`;
}

function matchSkill(t: string): string | null {
  for (const [re, skill] of SKILL_ALIASES) {
    if (re.test(t) && ALLOWED_SKILLS.has(skill)) return skill;
  }
  return null;
}

// --- Obsidian UI control ------------------------------------------------------
// Fixed spoken phrases → workspace actions the orb executes via the Obsidian
// API. Anchored + narrow: "open the trend scan" (a deliverable) never lands
// here — openDocAnswer owns deliverables; unmatched generic opens fall back
// to a vault-wide fuzzy open-note (see openDocAnswer's no-match branch).

const OBSIDIAN_FIXED: [RegExp, ObsidianAction][] = [
  [
    /^(?:open|go to|show me|bring up|pull up)\s+(?:my\s+|the\s+|up\s+)*(?:today s\s+|todays\s+)?daily(?:\s+note)?$/,
    { op: "daily-note" },
  ],
  [
    /\b(?:open|show|bring up|pull up|go to)\b.*\b(?:cockpit|command center|dashboard)\b/,
    { op: "cockpit" },
  ],
  [/^go back$/, { op: "command", id: "app:go-back", label: "back" }],
  [/^go forward$/, { op: "command", id: "app:go-forward", label: "forward" }],
  [/^close (?:this |the )?tab$/, { op: "command", id: "workspace:close", label: "close tab" }],
  [
    /^split (?:the )?(?:screen |pane |window )?right$/,
    { op: "command", id: "workspace:split-vertical", label: "split right" },
  ],
  [
    /^split (?:the )?(?:screen |pane |window )?down$/,
    { op: "command", id: "workspace:split-horizontal", label: "split down" },
  ],
  [
    /^(?:toggle|hide|show|open|close) (?:the )?left sidebar$|^(?:toggle|hide|show) (?:the )?sidebar$/,
    { op: "command", id: "app:toggle-left-sidebar", label: "left sidebar" },
  ],
  [
    /^(?:toggle|hide|show|open|close) (?:the )?right sidebar$/,
    { op: "command", id: "app:toggle-right-sidebar", label: "right sidebar" },
  ],
  [
    /^(?:open |show )?(?:the )?graph(?: view)?$/,
    { op: "command", id: "graph:open", label: "graph view" },
  ],
  [
    /^(?:open|pull up|bring up|show me|show|launch|start)(?: up)? (?:a |the |my )?terminal$|^terminal$/,
    { op: "command", id: "terminal:open-terminal.default.root", label: "terminal" },
  ],
];
const SEARCH_RE =
  /^(?:search|look up)\s+(?:the vault\s+|my notes\s+)?(?:for\s+)?(.+)$|^find\s+(.+?)\s+in (?:my |the )?(?:vault|notes)$/;

// placement clause — "on the right (sidebar)", "in a split", "over on the
// left side". Extracted AND stripped so target matching sees a clean phrase.
const WHERE_RE =
  /\s*(?:(?:on|in|to|at|over(?: on)?)\s+)?(?:a\s+|the\s+)?\b(?:(right|left)\s*(?:hand\s+)?(?:side\s*bar|sidebar|side|panel|pane)?|(split|side by side))\b\s*/;

function extractWhere(t: string): { where?: ObsidianWhere; rest: string } {
  const m = WHERE_RE.exec(t);
  if (!m) return { rest: t };
  // bare "right"/"left" with no sidebar-ish word only counts trailing
  // ("open my calendar on the right"), not mid-phrase ("split right" is a
  // fixed phrase and never reaches here)
  let where: ObsidianWhere | undefined;
  if (m[1] === "right") where = "right-sidebar";
  else if (m[1] === "left") where = "left-sidebar";
  else if (m[2]) where = "split";
  const rest = (t.slice(0, m.index) + " " + t.slice(m.index + m[0].length))
    .replace(/\s+/g, " ")
    .trim();
  return { where, rest };
}

const OPEN_VERBS = "(?:open(?: up)?|pull up|show(?: me)?|bring up|put(?: up)?|go to)";

// spoken report names — keywords are anchored so "bring up that repo" (repo
// resolution) and bare "github trending" (skill dispatch) never land here
const REPORT_ARTICLES = "(?:the\\s+|my\\s+|todays?\\s+|latest\\s+|last\\s+)*";
const REPORT_RES: [RegExp, keyof typeof REPORT_TARGETS][] = [
  [
    new RegExp(
      `^${OPEN_VERBS}\\s+${REPORT_ARTICLES}(?:morning\\s+(?:intel|report)|intel)(?:\\s+(?:brief|report|sweep))?$`
    ),
    "morning-intel",
  ],
  [
    new RegExp(
      `^${OPEN_VERBS}\\s+${REPORT_ARTICLES}(?:github\\s+|get\\s?hub\\s+)?trending(?:\\s+(?:report|repos|list))?$`
    ),
    "github-trending",
  ],
  [
    new RegExp(
      `^${OPEN_VERBS}\\s+${REPORT_ARTICLES}(?:outlier\\s+)?radar(?:\\s+(?:report|sweep))?$`
    ),
    "outlier-radar",
  ],
  [
    new RegExp(`^${OPEN_VERBS}\\s+${REPORT_ARTICLES}inbox\\s+brief(?:\\s+report)?$`),
    "inbox-brief",
  ],
];

function reportOpenAnswer(t: string): StateAnswer | null {
  const clean = t.replace(POLITE_RE, "").trim();
  const { rest } = extractWhere(clean);
  for (const [re, name] of REPORT_RES) {
    if (!re.test(rest)) continue;
    const target = REPORT_TARGETS[name];
    const rel = resolveReport(name);
    if (!rel) {
      return {
        text: `I don't have a ${target.label} report on file yet.`,
        panels: ["documents"],
      };
    }
    // reply stays empty — the note opening in a tab IS the confirmation
    return { text: "", panels: ["documents"], deliverable: rel, reveal: "open" };
  }
  return null;
}

const WEB_RES: [RegExp, keyof typeof WEB_TARGETS][] = [
  [new RegExp(`^${OPEN_VERBS}\\s+(?:my\\s+|the\\s+|our\\s+)*(?:google\\s+)?calendar$`), "calendar"],
  [new RegExp(`^${OPEN_VERBS}\\s+(?:my\\s+|the\\s+|our\\s+)*(?:gmail|google mail)$`), "gmail"],
  [new RegExp(`^${OPEN_VERBS}\\s+(?:my\\s+|the\\s+|our\\s+)*youtube studio$`), "youtube-studio"],
];

// spoken commands arrive wrapped in politeness — strip the whole preamble
// ("hey jarvis can you go ahead and pull up…" → "pull up…")
const POLITE_RE =
  /^(?:hey |ok |okay |so |um |uh |well )*(?:jarvis,? )?(?:can you |could you |would you |will you |please |go ahead and |go ahead |just )*/;

function obsidianAnswer(t: string): ObsidianAction | null {
  const clean = t.replace(POLITE_RE, "").trim();
  // fixed phrases first, on the RAW text — "toggle the right sidebar" must
  // not have its target eaten by the placement extractor
  for (const [re, action] of OBSIDIAN_FIXED) {
    if (re.test(clean)) return action;
  }
  const { where, rest } = extractWhere(clean);
  // web targets — calendar defaults to the right sidebar (its natural home)
  for (const [re, name] of WEB_RES) {
    if (re.test(rest)) {
      const w = where ?? (name === "calendar" ? "right-sidebar" : undefined);
      return { op: "web", ...WEB_TARGETS[name], where: w };
    }
  }
  // daily note with a placement ("open my daily note on the left")
  if (
    /^(?:open|go to|show me|bring up|pull up|put)\s+(?:my\s+|the\s+|up\s+)*(?:today s\s+|todays\s+)?daily(?:\s+note)?$/.test(
      rest
    )
  ) {
    return { op: "daily-note", where };
  }
  const s = SEARCH_RE.exec(clean);
  if (s) {
    const query = (s[1] ?? s[2] ?? "").trim();
    if (query) return { op: "search", query };
  }
  return null;
}

// --- github repos -------------------------------------------------------------
// "bring up that repo" / "open mattpocock/skills". Resolution ladder:
//   1. explicit owner/name in the utterance
//   2. owner/name mentioned in the recent conversation
//   3. word overlap between recent conversation + utterance and the
//      trending-report slug list (spoken replies rarely include the slug —
//      "a remover tool hit number two on GitHub" → watermarks-remover)
// Returns an action, a spoken fallback string, or null (not repo-related).

const REPO_WORD = /\brepos?\b|\brepository\b/;
const SLUG_RE = /\b([A-Za-z0-9_.-]{2,})\/([A-Za-z0-9_.-]{2,})\b/g;
const SLUG_SKIP = /^(inbox|system|content|projects|daily-notes|wiki|ops)\//i;

function slugsIn(text: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  SLUG_RE.lastIndex = 0;
  while ((m = SLUG_RE.exec(text)) !== null) {
    const slug = `${m[1]}/${m[2]}`;
    if (!SLUG_SKIP.test(slug) && !slug.endsWith(".md")) out.push(slug);
  }
  return out;
}

function repoAnswer(t: string, state: VaultState): ObsidianAction | string | null {
  if (!REPO_WORD.test(t) && slugsIn(t).length === 0) return null;
  if (!OPEN_VERB_ANY.test(t)) return null;
  const { where } = extractWhere(t);

  // 1. slug spoken directly
  const direct = slugsIn(t);
  if (direct.length > 0) return { op: "repo", slug: direct[0], where };

  // 2. slug in the recent conversation
  const convoText = recentExchanges(3)
    .map((e) => `${e.you} ${e.jarvis}`)
    .join(" ");
  const fromConvo = slugsIn(convoText);
  if (fromConvo.length > 0) {
    return { op: "repo", slug: fromConvo[fromConvo.length - 1], where };
  }

  // 3. fuzzy: conversation words vs trending slug name-parts
  const hayWords = new Set(
    `${convoText} ${t}`.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 3)
  );
  let best: string | null = null;
  let bestScore = 0;
  for (const slug of state.trendingRepos) {
    const parts = slug.toLowerCase().split(/[/_.-]+/).filter((p) => p.length > 3);
    const score = parts.reduce((s, p) => s + (hayWords.has(p) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      best = slug;
    }
  }
  if (best && bestScore > 0) return { op: "repo", slug: best, where };

  return "Which repo? Give me the owner slash name and I'll pull it up.";
}

const OPEN_VERB_ANY = /\b(bring up|pull up|open|show me|show us|put up|display|go to)\b/;

// --- voice vault writes -------------------------------------------------------
// Imperative-anchored: the verb must START the utterance (minus wake filler),
// so "did I check off priority two" (question) never writes. Targets that
// look like skills or state topics fall through to their existing handlers.

const WRITE_VERB =
  "(?:check(?: off)?|mark|complete|finish|tick|knock out|uncheck|untick)";
const TOP3_WRITE_RE = new RegExp(
  `^(?:hey |ok |okay )*(?:jarvis,? )?${WRITE_VERB}\\s+(?:off\\s+)?(?:my\\s+|the\\s+)?(?:priority|directive|top ?(?:three|3))\\s*(?:number\\s*)?(one|two|three|1|2|3)(?:\\s+(?:as\\s+)?(?:done|complete|finished|off))?$`
);
const TASK_WRITE_RE = new RegExp(
  `^(?:hey |ok |okay )*(?:jarvis,? )?${WRITE_VERB}\\s+(?:off\\s+)?(?:my\\s+|the\\s+)?(.+)$`
);
const ADD_TASK_RE =
  /^(?:hey |ok |okay )*(?:jarvis,? )?add\s+(?:a\s+)?(?:task\s+|driver\s+)?(.+?)(?:\s+to\s+(?:my\s+|the\s+)?(?:tasks?|drivers?|daily drivers?|list|board|today))?$/;
const IDX: Record<string, number> = { one: 0, "1": 0, two: 1, "2": 1, three: 2, "3": 2 };
const SPOKEN_IDX = ["one", "two", "three"];
// targets that belong to other handlers — never fuzzy-toggle these
const WRITE_SKIP =
  /\b(inbox|email|mail|queue|schedule|metrics?|runner|numbers|stats|out)\b/;

function vaultWriteAnswer(
  t: string,
  state: VaultState
): { text: string; panels: PanelId[] } | null {
  const panels: PanelId[] = ["priorities"];
  const noNote = !state.daily?.isToday;

  const top3 = TOP3_WRITE_RE.exec(t);
  if (top3) {
    if (noNote) {
      return { text: "There's no daily note for today yet — say plan today first.", panels };
    }
    const idx = IDX[top3[1]] ?? 0;
    const undo = /\bun(?:check|tick)\b/.test(t);
    const ok = toggleTop3(idx, !undo);
    if (!ok) return { text: "I couldn't find that slot on today's board.", panels };
    const item = state.daily?.top3[idx]?.text;
    const tail = item ? `: ${stripParens(item).slice(0, 60)}` : ".";
    return {
      text: undo
        ? `Unchecked priority ${SPOKEN_IDX[idx]}${tail}`
        : `Done — priority ${SPOKEN_IDX[idx]} checked off${tail}`,
      panels,
    };
  }

  const add = ADD_TASK_RE.exec(t);
  if (add && add[1] && !matchSkill(add[1])) {
    if (noNote) {
      return { text: "There's no daily note for today yet — say plan today first.", panels };
    }
    const text = add[1].trim();
    return addDriver(text)
      ? { text: `Added to today's drivers: ${text}.`, panels }
      : { text: "I couldn't find the Daily Drivers section in today's note.", panels };
  }

  const task = TASK_WRITE_RE.exec(t);
  if (task && task[1]) {
    const target = task[1].trim();
    // "check my inbox" = inbox-brief, "check the queue" = state answer, etc.
    if (matchSkill(target) || WRITE_SKIP.test(target)) return null;
    if (noNote) {
      return { text: "There's no daily note for today yet — say plan today first.", panels };
    }
    const res = toggleTaskFuzzy(target);
    if (!res.ok) {
      return {
        text: `I couldn't find a task matching "${target}" on today's board.`,
        panels,
      };
    }
    return {
      text: `${res.done ? "Checked off" : "Unchecked"}: ${res.item}.`,
      panels,
    };
  }

  return null;
}

// --- read a report aloud ------------------------------------------------------
// "read me the morning report" — resolve the doc like openDocAnswer, then
// speak its CONTENT (sanitized, capped) instead of just popping it on screen.

const READ_RE = /^(?:hey |ok |okay )*(?:jarvis,? )?read(?: me| out loud| out| aloud)?\b/;
const READ_STOP =
  /\b(read|me|out|loud|aloud|the|that|it|my|please|jarvis|from|todays|today|latest|last|report|reports)\b/g;

function readAloudAnswer(t: string, state: VaultState): StateAnswer | null {
  if (!READ_RE.test(t)) return null;
  if (/rundown|briefing|brief me/.test(t)) return null; // that's the briefing's job

  const words = t.replace(READ_STOP, " ").replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2);
  const cands = state.runs.filter((r) => r.status === "ok" && r.deliverable_path);
  let best = null as (typeof cands)[number] | null;
  let bestScore = 0;
  for (const r of cands) {
    const file = r.deliverable_path?.split("/").pop() ?? "";
    const hay = `${r.skill} ${r.label ?? ""} ${r.summary} ${file}`.toLowerCase();
    const score = words.reduce((s, w) => s + (hay.includes(w) ? 1 : 0), 0);
    if (score > bestScore) {
      best = r;
      bestScore = score;
    }
  }

  let rel: string | null = null;
  let name = "";
  if (bestScore > 0 && best) {
    rel = best.deliverable_path;
    name = best.skill.replace(/-/g, " ");
  } else if (/morning|headline|news/.test(t) && state.morning) {
    rel = state.morning.rel;
    name = "morning report";
  } else if (/outlier|radar/.test(t) && state.outliers) {
    rel = state.outliers.rel;
    name = "outlier radar";
  } else if (words.length === 0 && best) {
    // bare "read it" — newest doc
    rel = best.deliverable_path;
    name = best.skill.replace(/-/g, " ");
  }
  if (!rel) {
    return { text: "I don't have a report like that on file yet.", panels: ["documents"] };
  }
  const raw = readVaultMarkdown(rel);
  if (!raw) return { text: "I couldn't open that file.", panels: ["documents"] };
  return {
    text: `From the ${name}: ${speakable(raw)}`,
    panels: ["documents"],
    deliverable: rel,
  };
}

// markdown → something a TTS voice can read without stumbling
function speakable(raw: string): string {
  let s = raw;
  if (s.startsWith("---")) {
    const end = s.indexOf("\n---");
    if (end > 0) s = s.slice(end + 4);
  }
  s = s
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\|.*\|\s*$/gm, " ") // tables read as word salad
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^#+\s+/gm, "")
    .replace(/[*_`>#|]/g, "")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > 700) {
    s = s.slice(0, 700);
    const cut = Math.max(s.lastIndexOf(". "), s.lastIndexOf("! "), s.lastIndexOf("? "));
    if (cut > 200) s = s.slice(0, cut + 1);
  }
  return s;
}

function metric(state: VaultState, source: string, name: string): Metric | null {
  return state.metrics.find((m) => m.source === source && m.metric === name) ?? null;
}

// --- spoken-friendly formatting ----------------------------------------------
// Raw digits ("13,913") make TTS stumble; rounded magnitudes ("about 14
// thousand") flow like a person talking — and that's the register we want.

function spokenNum(v: number): string {
  const x = Math.round(Math.abs(v));
  if (x >= 1_000_000) {
    const m = x / 1_000_000;
    return `${m >= 10 ? Math.round(m) : Math.round(m * 10) / 10} million`;
  }
  // whole thousands only — "4.7 thousand" makes TTS stumble ("four…seven");
  // the demo register is clean wave-tops, precision lives on screen
  if (x >= 1_000) return `${Math.round(x / 1000)} thousand`;
  return String(x);
}

function spokenMoney(v: number): string {
  const x = Math.round(v);
  if (x >= 1000) return `about $${(Math.round(x / 100) * 100).toLocaleString("en-US")}`;
  return `$${x}`;
}

function spokenTime(t: string): string {
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return t;
  const h24 = parseInt(m[1], 10);
  const h = h24 % 12 || 12;
  const ap = h24 >= 12 ? "PM" : "AM";
  return m[2] === "00" ? `${h} ${ap}` : `${h}:${m[2]} ${ap}`;
}

function weekDelta(m: Metric): string {
  if (m.deltaWeek === null || m.deltaWeek === 0) return "";
  return m.deltaWeek > 0
    ? ` — up about ${spokenNum(m.deltaWeek)} this week`
    : ` — down about ${spokenNum(m.deltaWeek)} this week`;
}

// --- daily briefing ----------------------------------------------------------

function localHour(): number {
  return parseInt(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      hour: "numeric",
      hour12: false,
    }).format(new Date()),
    10
  );
}

// `## Headlines` mining lives in lib/vault.ts (readMorningReport) — shared
// with the AI Wire panel; the briefing speaks the top two

function nextScheduleItem(state: VaultState): { time: string; item: string } | null {
  const d = state.daily;
  if (!d?.isToday || d.schedule.length === 0) return null;
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  return (
    d.schedule.find((s) => {
      const m = s.time.match(/^(\d{1,2}):(\d{2})$/);
      return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) > nowMin : false;
    }) ?? null
  );
}

// parentheticals read terribly out loud — "(PTT loop + barge-in on camera)"
function stripParens(s: string): string {
  return s.replace(/\s*\([^)]*\)/g, "").trim();
}

// one headline, parentheticals stripped, cut at a CLAUSE boundary — a dangling
// "beating X by 10%+ on some." reads worse than stopping a clause early
function trimHead(h: string): string {
  let s = stripParens(h);
  if (s.length > 120) {
    const head = s.slice(0, 120);
    const clause = Math.max(head.lastIndexOf(","), head.lastIndexOf(" — "), head.lastIndexOf("; "));
    s = clause > 60 ? head.slice(0, clause) : head.slice(0, head.lastIndexOf(" "));
    s = s.replace(/[,;:—–-]\s*$/, "").trim();
  }
  return s;
}

// "wave-top" headline — first clause only, the kind of thing you'd expand on
// if asked ("Claude released Fable"), not the whole paragraph
function waveTop(h: string): string {
  const s = stripParens(h);
  const dash = s.indexOf(" — ");
  const comma = s.indexOf(", ");
  const cuts = [dash, comma].filter((i) => i > 25);
  const cut = cuts.length > 0 ? Math.min(...cuts) : -1;
  return (cut > 0 ? s.slice(0, cut) : trimHead(s)).slice(0, 90);
}

// Morning-kickoff template — the shape, not a script. Every slot fills from
// live state at ask-time:
//   audience pulse (all platforms) → latest-video momentum → ONE wave-top AI
//   headline → today's mission → "where do you want me to start?"
// Wave tops only; everything is one follow-up question away. ~55 words.
function briefing(state: VaultState): {
  text: string;
  deliverable?: string;
  reveals: Reveal[];
} {
  const parts: string[] = [];
  const reveals: Reveal[] = [];
  // char offset where the NEXT sentence will start — reveals fire when the
  // voice reaches their sentence
  const mark = () => parts.join(" ").length + (parts.length > 0 ? 1 : 0);
  const d = state.daily;

  // total audience, summed live across platforms
  const reachMetrics = [
    metric(state, "youtube", "subscribers"),
    metric(state, "instagram", "followers"),
    metric(state, "tiktok", "followers"),
  ].filter((m): m is Metric => m !== null && m.status !== "mock");
  const reach = reachMetrics.reduce((s, m) => s + m.value, 0);
  const reachDelta = reachMetrics.reduce((s, m) => s + (m.deltaWeek ?? 0), 0);

  const h = localHour();
  const opener =
    h < 5 ? "Burning the midnight oil." : h < 12 ? "Good morning." : h < 17 ? "Good afternoon." : "Good evening.";
  if (reach > 0) {
    parts.push(
      `${opener} You're at about ${spokenNum(reach)} followers across all platforms${
        reachDelta > 0 ? ` — up about ${spokenNum(reachDelta)} this week` : ""
      }.`
    );
  } else {
    parts.push(opener);
  }

  const v = state.latestVideo;
  if (v) {
    if (v.url) reveals.push({ kind: "link", target: v.url, label: "latest deploy", at: mark() });
    const days = Math.max((Date.now() - Date.parse(v.published_at)) / 86_400_000, 0.25);
    parts.push(
      `The latest video's pulling about ${spokenNum(v.views / days)} views a day — ${spokenNum(v.views)} so far.`
    );
  }

  const report = readMorningReport(2);
  const heads = report?.heads ?? [];
  if (heads[0]) {
    if (report?.rel) reveals.push({ kind: "doc", target: report.rel, label: "morning report", at: mark() });
    const src = report?.links?.[0];
    if (src) reveals.push({ kind: "link", target: src, label: "source", at: mark() });
    parts.push(`Big story in AI today: ${waveTop(heads[0])}.`);
  }

  // real revenue only — mock numbers stay off the spoken brief
  const mrr = metric(state, "stripe", "mrr");
  if (mrr && mrr.status !== "mock") parts.push(`Revenue's at ${spokenMoney(mrr.value)} monthly.`);

  if (d?.isToday) {
    const open = d.top3.filter((p) => !p.done);
    if (open.length > 0) {
      parts.push(`Biggest thing on today's board: ${stripParens(open[0].text).slice(0, 80)}.`);
    } else if (d.top3.length > 0) {
      parts.push("The board's clear — all three directives done.");
    }
  } else {
    parts.push("No daily note yet — say plan today and I'll set one up.");
  }

  const r = state.runner;
  if (r && !r.alive) parts.push("Heads-up — the background runner looks offline.");

  // hand the mic back with a CONCRETE offer — "yes" dispatches it (see
  // pendingOffer / AFFIRM_RE). Phrasing must match OFFER_SKILLS keys.
  const offer = briefingOffer(state, heads.length > 0);
  if (/inbox audit/.test(offer)) {
    reveals.push({ kind: "link", target: "https://mail.google.com", label: "inbox", at: mark() });
  }
  parts.push(offer);

  // safety cap — drop whole sentences, never chop mid-word
  let text = parts.join(" ");
  if (text.length > 750) {
    text = text.slice(0, 750);
    const cut = text.lastIndexOf(". ");
    if (cut > 200) text = text.slice(0, cut + 1);
  }
  return {
    text,
    deliverable: report?.rel,
    reveals: reveals.filter((r) => r.at < text.length),
  };
}

// state-picked closing offer — wording is load-bearing: pendingOffer() parses
// it back out of convo memory when the user answers "yes"
function briefingOffer(state: VaultState, hasReport: boolean): string {
  // the offer phrase must stay verbatim-matchable by pendingOffer()'s regex;
  // the open-ended tail rides AFTER it and never reaches the capture group
  const TAIL = ", or do you have anything else in mind?";
  const h = localHour();
  if (!hasReport && h < 16) return `Want me to run the morning report${TAIL}`;
  if (h < 15) return `Want me to run the daily inbox audit${TAIL}`;
  const stale = state.metrics.some(
    (m) => !m.timestamp || Date.now() - Date.parse(m.timestamp) > 13 * 3600 * 1000
  );
  if (stale) return `Want me to pull fresh metrics${TAIL}`;
  return `Want me to run a trend scan for content leads${TAIL}`;
}

interface StateAnswer {
  text: string;
  panels: PanelId[];
  deliverable?: string;
  reveal?: "open";
  reveals?: Reveal[];
  obsidian?: ObsidianAction;
}

// "bring up the html" / "open that report" — find the deliverable a recent
// run produced and pop it on screen NOW. Without this, asking to see a doc
// burned a whole background claude session just to open a file.
const OPEN_VERB = /\b(bring up|pull up|open|show me|show us|put up|display)\b/;
const DOC_WORD = /\b(that|it|html|page|explainer|doc|document|report|file|deliverable|note|results?)\b/;
const OPEN_STOPWORDS =
  /\b(bring|pull|up|open|show|me|us|put|display|the|that|it|for|can|you|please|jarvis|again|back|one|thing|doc|document|file|note|report|reports|today|todays|right|left|sidebar|side|panel|split|over|in|on|a)\b/g;

function openDocAnswer(t: string, state: VaultState): StateAnswer | null {
  if (!OPEN_VERB.test(t)) return null;
  // "give me the rundown"-style asks stay with the briefing
  if (/\brundown|briefing|brief me|catch me up\b/.test(t)) return null;
  // web-target and repo words are NEVER vault docs — if their rules didn't
  // claim it, let the model tier parse it rather than opening whatever
  // deliverable scores highest ("pull up my calendar" / "bring up that
  // repo" both opened random voice-ask docs this way)
  if (/\b(calendar|gmail|google mail|youtube studio)\b/.test(t)) return null;
  if (REPO_WORD.test(t)) return null;
  const cands = state.runs.filter((r) => r.status === "ok" && r.deliverable_path);
  const words = t.replace(OPEN_STOPWORDS, " ").split(/\s+/).filter((w) => w.length > 2);
  // newest first; keyword overlap against skill + summary + filename promotes
  // an older doc only when the ask clearly names it ("the trend scan")
  let best = cands[0] ?? null;
  let bestScore = 0;
  for (const r of cands) {
    // skill + label + summary + FILENAME only — full paths poisoned scoring
    // (every inbox-brief lives under inbox/reports/, which substring-matched
    // "repo" and "report" and outscored the doc actually being asked for)
    const file = r.deliverable_path?.split("/").pop() ?? "";
    const hay = `${r.skill} ${r.label ?? ""} ${r.summary} ${file}`.toLowerCase();
    const score = words.reduce((s, w) => s + (hay.includes(w) ? 1 : 0), 0);
    if (score > bestScore) {
      best = r;
      bestScore = score;
    }
  }
  // bare open-verb with no target words needs a generic doc word ("open
  // that" / "bring it up") to count as ours
  if (!DOC_WORD.test(t) && bestScore === 0 && words.length === 0) return null;
  // the morning report lives outside the runs list — resolve it directly
  if (bestScore === 0 && /\bmorning\b/.test(t) && state.morning) {
    return {
      text: "Here's this morning's report. On screen now.",
      panels: ["documents"],
      deliverable: state.morning.rel,
      reveal: "open",
    };
  }
  // target words but no deliverable matched — DEFER to the model tier
  // rather than guess. Haiku has the conversation + snapshot + the same
  // action schema (incl. open-note), so "bring up that thing you
  // mentioned" resolves with context instead of fuzzy-matching filenames.
  if (bestScore === 0 && words.length > 0) return null;
  if (!best) {
    return { text: "I don't have any documents on file yet.", panels: ["documents"] };
  }
  return {
    text: `Here it is — the ${best.skill.replace(/-/g, " ")} from earlier. On screen now.`,
    panels: ["documents"],
    deliverable: best.deliverable_path!,
    reveal: "open",
  };
}

function stateAnswer(t: string, state: VaultState): StateAnswer | null {
  const readAloud = readAloudAnswer(t, state);
  if (readAloud) return readAloud;
  const doc = openDocAnswer(t, state);
  if (doc) return doc;
  if (BRIEFING_RE.test(t)) {
    const b = briefing(state);
    return {
      text: b.text,
      panels: b.deliverable
        ? ["priorities", "schedule", "objective", "vitals", "documents"]
        : ["priorities", "schedule", "objective", "vitals"],
      deliverable: b.deliverable,
      reveals: b.reveals,
    };
  }
  // outlier radar — question forms answer from the latest sweep; the bare
  // "outlier radar" dispatch alias still runs a fresh scan
  if (
    /outlier|radar/.test(t) &&
    (/^(any|what|how many|did|are there|tell me|whats|what s)\b/.test(t) ||
      /new outlier|outliers? (today|this week|lately)/.test(t))
  ) {
    const o = state.outliers;
    if (!o) {
      return {
        text: "No outlier radar data yet — say outlier radar and I'll run a sweep.",
        panels: ["documents"],
      };
    }
    const tops = o.top.map((x) => `${x.title.slice(0, 60)} at ${x.mult}`);
    return {
      text: `The latest radar sweep from ${o.date} flagged ${o.count} outlier${o.count === 1 ? "" : "s"}. Top of the board: ${listOut(tops)}.`,
      panels: ["documents"],
      deliverable: o.rel,
    };
  }

  // "m r r" / "m r are" — STT splits or mishears the acronym after the
  // normalizer strips dots ("M.R.R." → "m r r")
  if (/mrr|\bm r r\b|\bm r are\b|revenue|recurring|money/.test(t)) {
    const m = metric(state, "stripe", "mrr");
    if (!m) return { text: "I don't have an MRR reading yet.", panels: ["objective"] };
    const pct = Math.round((m.value / 10_000) * 100);
    const sim = m.status === "mock" ? " Fair warning — that's still a simulated number." : "";
    return {
      text: `Revenue's sitting at ${spokenMoney(m.value)} a month — ${pct} percent of the way to ten K.${sim}`,
      panels: ["objective"],
    };
  }
  if (/runner|daemon/.test(t)) {
    const r = state.runner;
    if (!r) return { text: "The runner looks down — I'm not seeing a status file.", panels: ["diagnostics"] };
    return {
      text: r.alive
        ? `Runner's alive and ${r.busy ? `working — ${r.active} job${r.active === 1 ? "" : "s"} active` : "idle"}${r.pending > 0 ? `, ${r.pending} waiting in the queue` : ""}.`
        : "The runner's heartbeat has gone stale — it looks down.",
      panels: ["diagnostics", "pipeline"],
    };
  }
  if (/subscriber|subs\b/.test(t)) {
    const m = metric(state, "youtube", "subscribers");
    return {
      text: m
        ? `You're at ${spokenNum(m.value)} YouTube subscribers${weekDelta(m)}.`
        : "I don't have a subscriber reading.",
      panels: ["vitals"],
    };
  }
  if (/youtube.*views|views.*youtube|28 day/.test(t)) {
    const m = metric(state, "youtube", "views_28d");
    return {
      text: m
        ? `${spokenNum(m.value)} YouTube views over the last 28 days${weekDelta(m)}.`
        : "I don't have a views reading.",
      panels: ["vitals"],
    };
  }
  if (/instagram/.test(t)) {
    const m = metric(state, "instagram", "followers");
    return {
      text: m
        ? `Instagram's at ${spokenNum(m.value)} followers${weekDelta(m)}.`
        : "I don't have an Instagram reading.",
      panels: ["vitals"],
    };
  }
  if (/tiktok/.test(t)) {
    const m = metric(state, "tiktok", "followers");
    return {
      text: m
        ? `TikTok's at ${spokenNum(m.value)} followers${weekDelta(m)}.`
        : "I don't have a TikTok reading.",
      panels: ["vitals"],
    };
  }
  if (/latest video|last video|video doing/.test(t)) {
    const v = state.latestVideo;
    return {
      text: v
        ? `The latest video — ${v.title} — is at ${spokenNum(v.views)} views and ${spokenNum(v.likes)} likes.`
        : "I don't have video data yet.",
      panels: ["vitals", "objective"],
    };
  }
  if (/token|claude usage/.test(t)) {
    const m = metric(state, "claude_code", "tokens_5h");
    return {
      text: m
        ? `You've used ${spokenNum(m.value)} Claude tokens in the current five-hour window.`
        : "I don't have a token reading.",
      panels: ["vitals"],
    };
  }
  if (/queue/.test(t)) {
    if (state.queue.length === 0) return { text: "The queue's empty.", panels: ["pipeline"] };
    const names = state.queue.map((q) => q.skill.replace(/-/g, " ")).join(", ");
    return {
      text: `${state.queue.length === 1 ? "One thing" : `${state.queue.length} things`} in the queue: ${names}.`,
      panels: ["pipeline"],
    };
  }
  if (/top 3|top three|priorit|directive/.test(t)) {
    const d = state.daily;
    if (!d || d.top3.length === 0) return { text: "Nothing's on the board yet.", panels: ["priorities"] };
    const open = d.top3.filter((p) => !p.done);
    return {
      text:
        open.length === 0
          ? "You've cleared all three priorities. Strong day."
          : `${open.length === 1 ? "One left" : `${open.length} still open`}: ${listOut(open.map((p) => p.text))}.`,
      panels: ["priorities"],
    };
  }
  if (/schedule|next today|what s next|whats next|next up/.test(t)) {
    const d = state.daily;
    if (!d || d.schedule.length === 0) return { text: "Nothing's on the schedule.", panels: ["schedule"] };
    const next = d.isToday ? nextScheduleItem(state) : null;
    return {
      text: next
        ? `Coming up at ${spokenTime(next.time)} — ${next.item}.`
        : d.isToday
          ? "You're clear for the rest of the day."
          : "No schedule for today yet — say plan today and I'll set one up.",
      panels: ["schedule"],
    };
  }
  if (/focus/.test(t)) {
    const d = state.daily;
    return {
      text: d?.focus ? `Today's focus is ${d.focus}.` : "No focus set for today.",
      panels: ["schedule"],
    };
  }
  if (/last run|last fail|recent run/.test(t)) {
    const r = state.runs.find((x) => x.status === "ok" || x.status === "error");
    if (!r) return { text: "No recent runs.", panels: ["pipeline"] };
    return {
      text: `The last run was ${r.skill.replace(/-/g, " ")} — it ${r.status === "ok" ? "finished fine" : "failed"}. ${r.summary.slice(0, 120)}`,
      panels: ["pipeline", "diagnostics"],
    };
  }
  return null;
}

// "A, B, and C" — spoken list with a natural and-join
function listOut(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

// --- Haiku engine -----------------------------------------------------------

function stateSummary(state: VaultState): string {
  const lines: string[] = [];
  for (const m of state.metrics) {
    lines.push(`${m.source}.${m.metric} = ${m.value} (${m.status}${m.deltaWeek !== null ? `, week delta ${m.deltaWeek}` : ""})`);
  }
  const r = state.runner;
  lines.push(r ? `runner: ${r.alive ? "alive" : "down"}, busy=${r.busy}, pending=${r.pending}` : "runner: no status");
  if (state.latestVideo) lines.push(`latest video: "${state.latestVideo.title}" views=${state.latestVideo.views}`);
  if (state.daily) {
    lines.push(`top3: ${state.daily.top3.map((p) => `${p.done ? "[x]" : "[ ]"} ${p.text}`).join("; ")}`);
    lines.push(`schedule: ${state.daily.schedule.map((s) => `${s.time} ${s.item}`).join("; ")}`);
    if (state.daily.focus) lines.push(`focus: ${state.daily.focus}`);
  }
  if (state.morning?.heads.length) {
    lines.push(`this morning's intel brief TL;DR: ${state.morning.heads.join(" | ")}`);
  }
  if (state.morning?.inbox.length) {
    lines.push("email/inbox triage (ALREADY DONE this morning — answer email questions from these lines):");
    for (const b of state.morning.inbox) lines.push(`  ${b}`);
  }
  if (state.queue.length) lines.push(`queue: ${state.queue.map((q) => q.label ?? q.skill).join(", ")}`);
  if (state.trendingRepos.length) {
    lines.push(`github trending repos: ${state.trendingRepos.slice(0, 12).join(", ")}`);
  }
  // summaries included — without them the model can't answer "what did the
  // trending report find?" and conflates reports with each other
  if (state.runs.length) {
    lines.push("recent runs (newest first):");
    for (const x of state.runs.slice(0, 6)) {
      const name = x.label ? `${x.skill} "${x.label}"` : x.skill;
      const sum = x.summary ? ` — ${x.summary.slice(0, 140)}` : "";
      lines.push(`  ${name} [${x.status}]${sum}`);
    }
  }
  return lines.join("\n");
}

function routerSystem(state: VaultState, convo: string): string {
  return `You are Jarvis — the voice layer of Chase's Obsidian vault (his "Agentic OS"). You are physically embedded IN Obsidian: when he says "bring up / show / open / pull up" something, he means show it INSIDE Obsidian — notes and reports via the obsidian actions below, web pages and GitHub repos via the built-in web viewer. Referential asks ("that repo", "the thing you mentioned") resolve against the recent conversation and the snapshot. Prefer EXECUTING an action over describing one. Classify the utterance and reply in strict JSON only:
{"tier": 1|2|3, "skill": "<skill-name or omit>", "reply": "<short spoken response, max 2 sentences, plain text>", "panels": ["<dashboard panels the reply references, from: ${PANEL_IDS.join(", ")}>"]}

Tier 1: user wants to RUN one of these skills: ${[...ALLOWED_SKILLS].join(", ")}. Set "skill". Reply = brief ack. ONLY when they want it run or refreshed — asking what's IN a report / what it said / its highlights is tier 2: answer from the recent-runs summaries in the snapshot, do NOT re-run the skill.
Tier 2: user asks about dashboard state. Answer ONLY from the snapshot below — NEVER invent specifics that aren't in it. If they ask for detail beyond what the snapshot holds (e.g. "which three sponsor emails?" when only a count is listed), that is tier 3: the background session can read the full report. If they ask for the daily briefing / "what's going on today", compose a tight rundown: open directives, next schedule item, focus, latest video, MRR.
Tier 3: ONLY when the user EXPLICITLY delegates background work ("go research X", "dig into X", "have a session look at X", "work on X", "figure out X and report back") or says yes to a dig-deeper offer you just made. Tier 3 costs 30-60 seconds of a background Claude session — it is for DOING work, never for answering questions. Reply = a brief "working on it" style ack.
NEVER send a question to tier 3 just because the snapshot lacks the answer. The heavy lifting (email triage, news, outliers, research) is already done by the morning skills and lives in the snapshot; answer from it. If a question truly isn't covered, tier 2: say what you DO have in one sentence, then offer — "want me to dig into it?" — and dispatch only if they say yes.

Greetings and chitchat ("hey", "what's up", "how are you", "thanks", "can you hear me") are tier 2 — reply conversationally in one or two short sentences, optionally flavored with the snapshot. NEVER send chitchat to tier 3; a background session for a greeting wastes half a minute.

OBSIDIAN UI CONTROL: when the user wants to open, place, navigate, or arrange something in their Obsidian workspace (open a note, pull up their calendar/gmail/youtube studio, pull up the terminal, split the screen, toggle a sidebar, go back, search their vault) — even phrased sloppily ("can you like put my calendar over on the right somewhere") — add an "obsidian" object to your JSON and set tier 2 with reply "" (empty string — the action executing IS the confirmation; do not narrate it):
"obsidian": {"op": "daily-note"|"cockpit"|"open-note"|"search"|"command"|"web"|"repo"|"report", "query": "<note words for open-note / search terms for search>", "id": "<for command, EXACTLY one of: ${Object.keys(COMMAND_ALLOW).join(", ")}>", "target": "<for web, EXACTLY one of: ${Object.keys(WEB_TARGETS).join(", ")}; for report, EXACTLY one of: ${Object.keys(REPORT_TARGETS).join(", ")} — report opens the LATEST saved report file of that kind as a note in a tab; prefer report over open-note when the user names one of these reports>", "slug": "<for repo: owner/name of a GitHub repo — resolve 'that repo' from the conversation or the github trending list in the snapshot>", "where": "tab"|"split"|"right-sidebar"|"left-sidebar"}
Omit "where" when no placement was asked for. Only emit "obsidian" for workspace/UI requests — questions about content stay tier 2/3 as usual.

VAULT WRITES: when the user wants to check off / uncheck / add tasks on today's daily note, add a "write" object (tier 2, reply "" — the server executes it and speaks the real outcome):
"write": {"kind":"top3","index":0|1|2,"undo":true|false} — priority slots (index 0 = priority one)
"write": {"kind":"task","target":"<the user's words for the task>"} — fuzzy toggle across Top 3 + Daily Drivers
"write": {"kind":"add","text":"<task text>"} — append a new driver
Only emit "write" for clear imperatives; questions about tasks ("did I finish priority two?") answer from the snapshot instead.

Dashboard snapshot:
${stateSummary(state)}${
    convo
      ? `

Recent conversation (use it to resolve follow-ups and pronouns — "that", "the second one", "make it shorter" refer to this):
${convo}`
      : ""
  }`;
}

interface RoutedJson {
  tier?: number;
  skill?: string;
  reply?: string;
  panels?: unknown;
  obsidian?: {
    op?: string;
    query?: string;
    id?: string;
    target?: string;
    slug?: string;
    where?: string;
  } | null;
  write?: {
    kind?: string;
    index?: number;
    undo?: boolean;
    target?: string;
    text?: string;
  } | null;
}

// model-proposed writes pass validation before route() executes them
function validateWrite(w: RoutedJson["write"]): VaultWrite | undefined {
  if (!w || typeof w !== "object") return undefined;
  if (w.kind === "top3") {
    const index = Number(w.index);
    if (index === 0 || index === 1 || index === 2) {
      return { kind: "top3", index, undo: Boolean(w.undo) };
    }
    return undefined;
  }
  if (w.kind === "task") {
    const target = String(w.target ?? "").slice(0, 80).trim();
    return target ? { kind: "task", target } : undefined;
  }
  if (w.kind === "add") {
    const text = String(w.text ?? "").slice(0, 120).trim();
    return text ? { kind: "add", text } : undefined;
  }
  return undefined;
}

const WHERE_ALLOW = ["tab", "split", "right-sidebar", "left-sidebar"];

// model-emitted UI actions pass through the SAME allowlists as the rules —
// op whitelist, command ids from COMMAND_ALLOW, web targets by NAME only.
// A model can suggest an action; it can never mint one.
// placement doctrine (Chase, 2026-08-14): default = a TAB in the main pane.
// The model may only place things elsewhere when the user's own words asked
// for a placement — Haiku volunteering where:"split" put Gmail at the bottom
// of the screen unasked. Habitual homes for specific targets live in
// PLACEMENT_DEFAULTS (calendar lives in the right sidebar); grow this table
// as habits form.
const PLACE_RE = /\b(right|left|split|side|sidebar|pane|panel|bottom|top|beside|next to)\b/i;
const PLACEMENT_DEFAULTS: Record<string, ObsidianWhere> = {
  calendar: "right-sidebar",
};

function validateObsidian(
  o: RoutedJson["obsidian"],
  transcript = ""
): ObsidianAction | undefined {
  if (!o || typeof o !== "object") return undefined;
  let where = WHERE_ALLOW.includes(String(o.where))
    ? (o.where as ObsidianWhere)
    : undefined;
  // model-suggested placement only survives when the user said one
  if (where && transcript && !PLACE_RE.test(transcript)) where = undefined;
  if (!where && o.op === "web") where = PLACEMENT_DEFAULTS[String(o.target ?? "")];
  const query = typeof o.query === "string" ? o.query.slice(0, 80).trim() : "";
  switch (o.op) {
    case "daily-note":
      return { op: "daily-note", where };
    case "cockpit":
      return { op: "cockpit" };
    case "open-note":
      return query ? { op: "open-note", query, where } : undefined;
    case "search":
      return query ? { op: "search", query } : undefined;
    case "command": {
      const id = String(o.id ?? "");
      return COMMAND_ALLOW[id]
        ? { op: "command", id, label: COMMAND_ALLOW[id] }
        : undefined;
    }
    case "web": {
      const target = WEB_TARGETS[String(o.target ?? "")];
      return target ? { op: "web", ...target, where } : undefined;
    }
    case "repo": {
      const slug = String((o as { slug?: unknown }).slug ?? "");
      return /^[A-Za-z0-9_.-]{2,}\/[A-Za-z0-9_.-]{2,}$/.test(slug)
        ? { op: "repo", slug, where }
        : undefined;
    }
    default:
      return undefined;
  }
}

// shared sanity layer for model engines — skill must be real, panels must be
// real, tier-1 without a valid skill bounces back to the caller's fallback
function validateRouted(
  parsed: RoutedJson,
  engine: "haiku" | "local",
  transcript = ""
): RouteResult | null {
  // model-picked report target — resolved server-side to the newest file and
  // shipped down the deliverable channel (opens as a note in a main tab)
  if (parsed.obsidian?.op === "report") {
    const rel = resolveReport(String(parsed.obsidian.target ?? ""));
    if (rel) return { tier: 2, reply: "", engine, deliverable: rel, reveal: "open" };
  }
  const obsidian = validateObsidian(parsed.obsidian, transcript);
  const panels = Array.isArray(parsed.panels)
    ? (parsed.panels.filter((p) => (PANEL_IDS as readonly string[]).includes(String(p))) as PanelId[])
    : undefined;
  // a valid vault write wins — route() executes it and speaks the outcome
  const write = validateWrite(parsed.write);
  if (write) return { tier: 2, reply: "", engine, panels, write };
  // a valid UI action wins outright — tier 2, silent reply, orb executes
  if (obsidian) return { tier: 2, reply: "", engine, panels, obsidian };
  const tier = parsed.tier === 1 || parsed.tier === 2 ? parsed.tier : 3;
  const skill =
    tier === 1 && parsed.skill && ALLOWED_SKILLS.has(parsed.skill) ? parsed.skill : undefined;
  if (tier === 1 && !skill) return null;
  return { tier, skill, reply: String(parsed.reply ?? "Done."), engine, panels };
}

// fire-and-forget warmup — the first HTTPS call to api.anthropic.com pays
// ~7s of TLS/connection setup per server process; a 1-token ping at module
// load moves that cost off the user's first real ask. Mirrors warmLocal().
let haikuWarmed = false;
function warmHaiku() {
  const key = homeEnv("ANTHROPIC_API_KEY");
  // VOICE_NO_WARMUP: tests import this module — they must not ping the API
  if (haikuWarmed || !key || process.env.VOICE_NO_WARMUP) return;
  haikuWarmed = true;
  fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: HAIKU_MODEL,
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    }),
  }).catch(() => {
    haikuWarmed = false; // network blip — retry on a later call
  });
}
warmHaiku(); // module load = first voice API hit — warm while rules still answer

async function haikuRoute(
  transcript: string,
  state: VaultState,
  convo = ""
): Promise<RouteResult | null> {
  const key = homeEnv("ANTHROPIC_API_KEY");
  if (!key) return null;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: HAIKU_MODEL,
      max_tokens: 300,
      system: routerSystem(state, convo),
      messages: [{ role: "user", content: transcript }],
    }),
  });
  if (!res.ok) throw new Error(`haiku ${res.status}`);

  const json = (await res.json()) as { content?: { type: string; text?: string }[] };
  const text = json.content?.find((c) => c.type === "text")?.text ?? "";
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  return validateRouted(JSON.parse(m[0]) as RoutedJson, "haiku", transcript);
}

// --- local engine -----------------------------------------------------------
// qwen3.5:4b via Ollama — picked by bench (scripts/bench-router-model.mjs):
// 15/16 tier accuracy, 16/16 JSON + skill discipline, p50 ~600ms / p90 ~800ms
// warm on the 5090. Grammar-enforced JSON via Ollama's `format` schema, so
// parsing never fails — validateRouted only has to police the VALUES.

const OLLAMA_URL = () => homeEnv("OLLAMA_URL") || "http://127.0.0.1:11434";
const LOCAL_ROUTER_MODEL = () => homeEnv("VOICE_ROUTER_MODEL") || "qwen3.5:4b";
const LOCAL_TIMEOUT_MS = 6000; // covers a cold model load; warm calls ~600ms

const ROUTE_SCHEMA = {
  type: "object",
  properties: {
    tier: { type: "integer", enum: [1, 2, 3] },
    skill: { type: "string" },
    reply: { type: "string" },
    panels: { type: "array", items: { type: "string", enum: [...PANEL_IDS] } },
    obsidian: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: ["daily-note", "cockpit", "open-note", "search", "command", "web", "repo", "report"],
        },
        query: { type: "string" },
        id: { type: "string", enum: Object.keys(COMMAND_ALLOW) },
        target: {
          type: "string",
          enum: [...Object.keys(WEB_TARGETS), ...Object.keys(REPORT_TARGETS)],
        },
        slug: { type: "string" },
        where: { type: "string", enum: ["tab", "split", "right-sidebar", "left-sidebar"] },
      },
    },
    write: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["top3", "task", "add"] },
        index: { type: "integer", enum: [0, 1, 2] },
        undo: { type: "boolean" },
        target: { type: "string" },
        text: { type: "string" },
      },
    },
  },
  required: ["tier", "reply"],
};

// fire-and-forget warmup so the first real utterance doesn't pay the model
// load; keep_alive 24h keeps the 3.4GB resident after that
let localWarmed = false;
function warmLocal() {
  if (localWarmed) return;
  localWarmed = true;
  fetch(`${OLLAMA_URL()}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: LOCAL_ROUTER_MODEL(),
      stream: false,
      think: false,
      keep_alive: "24h",
      options: { num_predict: 1 },
      messages: [{ role: "user", content: "hi" }],
    }),
  }).catch(() => {
    localWarmed = false; // ollama down — retry the warmup on a later call
  });
}

async function localRoute(
  transcript: string,
  state: VaultState,
  convo = ""
): Promise<RouteResult | null> {
  warmLocal();
  const res = await fetch(`${OLLAMA_URL()}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(LOCAL_TIMEOUT_MS),
    body: JSON.stringify({
      model: LOCAL_ROUTER_MODEL(),
      stream: false,
      think: false, // qwen3.5 small ships thinking-off, but be explicit
      keep_alive: "24h",
      format: ROUTE_SCHEMA,
      options: { temperature: 0.2, num_predict: 200 },
      messages: [
        { role: "system", content: routerSystem(state, convo) },
        { role: "user", content: transcript },
      ],
    }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}`);
  const json = (await res.json()) as { message?: { content?: string } };
  const text = json.message?.content ?? "";
  if (!text) return null;
  return validateRouted(JSON.parse(text) as RoutedJson, "local", transcript);
}
