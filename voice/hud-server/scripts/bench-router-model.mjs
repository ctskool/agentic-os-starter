#!/usr/bin/env node
// Bench a local Ollama model on the voice-router task: tier classification +
// skill pick + spoken reply as strict JSON. Measures warm latency + accuracy.
//
//   node scripts/bench-router-model.mjs <model> [<model> ...]
//
// Uses the REAL router system prompt shape (snapshot frozen below so runs are
// comparable) and grammar-enforced JSON via Ollama structured outputs.

const OLLAMA = "http://127.0.0.1:11434";

const PANEL_IDS = ["vitals", "pipeline", "diagnostics", "priorities", "schedule", "objective", "documents"];
const SKILLS = [
  "metrics-pull", "morning-report", "inbox-brief", "github-trending",
  "ai-trend-scan", "vault-cleanup", "yt-week-review", "plan-today",
  "plan-tomorrow", "weekly-review", "voice-ask",
];

// frozen snapshot — mirrors stateSummary() output shape
const SNAPSHOT = `youtube.subscribers = 13913 (ok, week delta 312)
youtube.views_28d = 482001 (ok, week delta 21044)
instagram.followers = 8420 (ok, week delta 195)
tiktok.followers = 128400 (ok, week delta 802)
stripe.mrr = 4200 (mock)
claude_code.tokens_5h = 391022 (ok)
runner: alive, busy=false, pending=0
latest video: "I Let Claude Run My Business for a Week" views=18211
top3: [ ] record voice-over for MCP video; [x] post carousel; [ ] reply to sponsor email
schedule: 09:00 deep work; 13:00 edit session; 20:00 stream
focus: ship the MCP explainer`;

const SYSTEM = `You are the intent router for a voice-controlled personal dashboard. Classify the user's utterance and reply in strict JSON only:
{"tier": 1|2|3, "skill": "<skill-name or omit>", "reply": "<short spoken response, max 2 sentences, plain text>", "panels": ["<dashboard panels the reply references, from: ${PANEL_IDS.join(", ")}>"]}

Tier 1: user wants to run one of these skills: ${SKILLS.join(", ")}. Set "skill". Reply = brief ack.
Tier 2: user asks about dashboard state. Answer ONLY from the snapshot below. Reply = the answer, conversational, numbers rounded. If they ask for the daily briefing / "what's going on today", compose a tight rundown: open directives, next schedule item, focus, latest video, MRR.
Tier 3: anything needing real reasoning or outside data. It will be dispatched to a background Claude session automatically. Reply = a brief "working on it" style ack.

Greetings and chitchat ("hey", "what's up", "how are you", "thanks", "can you hear me") are tier 2 — reply conversationally in one or two short sentences, optionally flavored with the snapshot. NEVER send chitchat to tier 3; a background session for a greeting wastes half a minute.

Dashboard snapshot:
${SNAPSHOT}`;

const SCHEMA = {
  type: "object",
  properties: {
    tier: { type: "integer", enum: [1, 2, 3] },
    skill: { type: "string" },
    reply: { type: "string" },
    panels: { type: "array", items: { type: "string", enum: PANEL_IDS } },
  },
  required: ["tier", "reply"],
};

// [utterance, expected tier, expected skill (null = none), note]
const CASES = [
  ["what's my MRR", 2, null, "metric question"],
  ["run the trend scan", 1, "ai-trend-scan", "skill dispatch"],
  ["hey what's up", 2, null, "chitchat"],
  ["pull the metrics", 1, "metrics-pull", "skill dispatch"],
  ["research the best AI video tools for me", 3, null, "open-ended ask"],
  ["how many subscribers do I have", 2, null, "metric question"],
  ["can you hear me", 2, null, "mic check"],
  ["give me the rundown", 2, null, "briefing"],
  ["draft a cold email to a potential sponsor", 3, null, "open-ended ask"],
  ["what's next on my schedule", 2, null, "schedule question"],
  ["check what's trending on github", 1, "github-trending", "skill dispatch"],
  ["how's the latest video doing", 2, null, "video question"],
  ["thanks man", 2, null, "chitchat ack"],
  ["plan my day", 1, "plan-today", "skill dispatch"],
  ["what should I focus on this afternoon", 2, null, "focus question (snapshot has it)"],
  ["summarize my week and tell me what to double down on", 3, null, "reasoning ask"],
];

async function chat(model, utterance) {
  const t0 = performance.now();
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      think: false, // disable reasoning on thinking models; ignored otherwise
      format: SCHEMA,
      options: { temperature: 0.2, num_predict: 200 },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: utterance },
      ],
    }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const j = await res.json();
  const ms = performance.now() - t0;
  let parsed = null;
  try {
    parsed = JSON.parse(j.message?.content ?? "");
  } catch {
    /* counts as failure */
  }
  return { ms, parsed, raw: j.message?.content ?? "" };
}

async function benchModel(model) {
  console.log(`\n=== ${model} ===`);
  // warm the model (load weights, KV) — not counted
  try {
    await chat(model, "hello");
  } catch (e) {
    console.log(`  LOAD FAILED: ${String(e).slice(0, 200)}`);
    return null;
  }

  let tierOk = 0, skillOk = 0, jsonOk = 0;
  const times = [];
  for (const [utt, wantTier, wantSkill] of CASES) {
    const { ms, parsed } = await chat(model, utt);
    times.push(ms);
    const gotTier = parsed?.tier ?? null;
    const gotSkill = parsed?.skill ?? null;
    const tierPass = gotTier === wantTier;
    // skill judged only on tier-1 cases; null-want means "must not dispatch"
    const skillPass = wantSkill ? gotSkill === wantSkill : !(gotTier === 1 && gotSkill);
    if (parsed) jsonOk++;
    if (tierPass) tierOk++;
    if (skillPass) skillOk++;
    const flag = tierPass && skillPass ? "ok " : "MISS";
    console.log(
      `  ${flag} ${Math.round(ms).toString().padStart(5)}ms  "${utt}" -> tier ${gotTier}${gotSkill ? `/${gotSkill}` : ""} (want ${wantTier}${wantSkill ? `/${wantSkill}` : ""})${flag === "MISS" && parsed ? ` reply="${String(parsed.reply).slice(0, 60)}"` : ""}`
    );
  }
  times.sort((a, b) => a - b);
  const p50 = times[Math.floor(times.length / 2)];
  const p90 = times[Math.floor(times.length * 0.9)];
  const summary = {
    model,
    json: `${jsonOk}/${CASES.length}`,
    tier: `${tierOk}/${CASES.length}`,
    skill: `${skillOk}/${CASES.length}`,
    p50: Math.round(p50),
    p90: Math.round(p90),
  };
  console.log(`  -> json ${summary.json} | tier ${summary.tier} | skill-discipline ${summary.skill} | p50 ${summary.p50}ms | p90 ${summary.p90}ms`);
  return summary;
}

const models = process.argv.slice(2);
if (models.length === 0) {
  console.error("usage: node scripts/bench-router-model.mjs <model> [...]");
  process.exit(1);
}
const results = [];
for (const m of models) {
  const r = await benchModel(m);
  if (r) results.push(r);
}
console.log("\n=== SUMMARY ===");
for (const r of results) {
  console.log(`${r.model.padEnd(28)} json ${r.json}  tier ${r.tier}  skill ${r.skill}  p50 ${r.p50}ms  p90 ${r.p90}ms`);
}
