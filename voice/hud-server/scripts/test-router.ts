// Rules-engine sweep — dispatch-vs-reference, question hijack, in-flight
// guard, rundown anchoring. Pure rulesRoute/inFlightGuard against synthetic
// state: no network, no Haiku spend, nothing written to the real queue.
// Run: npx -y tsx scripts/test-router.ts
import type { RouteResult } from "../lib/router";
import type { VaultState } from "../lib/vault";

process.env.VOICE_NO_WARMUP = "1"; // must be set BEFORE the module loads
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { rulesRoute, inFlightGuard } = require("../lib/router") as typeof import("../lib/router");

function state(over: Partial<VaultState> = {}): VaultState {
  return {
    generated_at: new Date().toISOString(),
    vault_root: "",
    metrics: [],
    runner: {
      ts: "",
      pid: 0,
      version: "",
      busy: false,
      active: 0,
      max_concurrent: 3,
      pending: 0,
      heartbeat_age_s: 1,
      alive: true,
    },
    latestVideo: null,
    daily: null,
    outliers: null,
    trendingRepos: [],
    runs: [],
    queue: [],
    morning: null,
    etas: {},
    ...over,
  };
}

const trendingRunning = state({
  runs: [
    {
      id: "r1",
      skill: "github-trending",
      label: null,
      link: null,
      status: "running",
      summary: "",
      ts_completed: null,
      ts_started: new Date().toISOString(),
      duration_s: null,
      deliverable_path: null,
    },
  ],
});

interface Case {
  name: string;
  transcript: string;
  state?: VaultState;
  expect: (r: RouteResult) => boolean;
  want: string;
}

const dispatched = (skill: string) => (r: RouteResult) => r.tier === 1 && r.skill === skill;
const fallsThrough = (r: RouteResult) => r.fallthrough === true;

const CASES: Case[] = [
  // --- clear-cut dispatch still instant (bare alias, ≤5 words, not a question)
  { name: "bare alias", transcript: "trend scan", expect: dispatched("ai-trend-scan"), want: "tier 1 ai-trend-scan" },
  { name: "short command", transcript: "run the github trending", expect: dispatched("github-trending"), want: "tier 1 github-trending" },
  { name: "short audit", transcript: "run the inbox audit", expect: dispatched("inbox-brief"), want: "tier 1 inbox-brief" },
  { name: "polite alias", transcript: "the inbox brief please", expect: dispatched("inbox-brief"), want: "tier 1 inbox-brief" },

  // --- the live miss (2026-06-12 1:21 PM): analytical question naming a skill
  {
    name: "question naming skill must NOT dispatch",
    transcript:
      "Based on these new GitHub trending repos for today, do you have any you think we should create a video about? Maybe like three of them?",
    expect: fallsThrough,
    want: "fallthrough to model engines",
  },
  // interrogative "do" used to count as a command verb — keep it dead
  {
    name: "interrogative do + alias",
    transcript: "do you think the github trending stuff matters this week?",
    expect: fallsThrough,
    want: "fallthrough",
  },
  // long command phrasing now defers to the model engines (1-2s, still dispatches)
  {
    name: "long command sentence defers",
    transcript: "can you run the inbox audit for me when you get a chance",
    expect: fallsThrough,
    want: "fallthrough",
  },
  // skill reference inside a bigger ask — never a re-dispatch
  {
    name: "reference not order",
    transcript: "once you're done with that inbox brief tell me about fable 5",
    expect: fallsThrough,
    want: "fallthrough",
  },
  {
    name: "question about report content",
    transcript: "what's going on with the github trending report today",
    expect: fallsThrough,
    want: "fallthrough",
  },

  // --- rundown stays anchored
  { name: "rundown trigger", transcript: "give me the rundown", expect: (r) => r.tier === 2 && /follow|board|morning|afternoon|evening|midnight/i.test(r.reply), want: "tier 2 briefing" },
  { name: "brief me", transcript: "hey jarvis brief me", expect: (r) => r.tier === 2, want: "tier 2 briefing" },

  // --- instant tier-2 lanes untouched
  { name: "mic check", transcript: "can you hear me", expect: (r) => r.tier === 2 && r.reply === "Loud and clear.", want: "Loud and clear." },
  { name: "subs metric", transcript: "how many subscribers do I have", expect: (r) => r.tier === 2, want: "tier 2 vitals answer" },
  { name: "queue", transcript: "what's in the queue", expect: (r) => r.tier === 2, want: "tier 2 queue answer" },

  // --- in-flight guard on the surviving dispatch path
  {
    name: "in-flight bare re-ask",
    transcript: "run the github trending",
    state: trendingRunning,
    expect: (r) => r.tier === 2 && /already running/.test(r.reply),
    want: "tier 2 already-running",
  },
  {
    name: "explicit re-run passes",
    transcript: "run github trending again",
    state: trendingRunning,
    expect: dispatched("github-trending"),
    want: "tier 1 github-trending",
  },
];

let failed = 0;
for (const c of CASES) {
  const s = c.state ?? state();
  const r = inFlightGuard(rulesRoute(c.transcript, s), c.transcript, s);
  const ok = c.expect(r);
  if (!ok) failed++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${c.name}\n      got: tier ${r.tier}${r.skill ? ` skill=${r.skill}` : ""}${r.fallthrough ? " (fallthrough)" : ""} — "${r.reply.slice(0, 80)}"${ok ? "" : `\n      want: ${c.want}`}`
  );
}
console.log(failed === 0 ? `\nAll ${CASES.length} cases pass.` : `\n${failed}/${CASES.length} FAILED`);
process.exit(failed ? 1 : 0);
