// ---------------------------------------------------------------------------
// normalizeForSpeech(text) — last-mile rewrite before ANY TTS engine.
// Kokoro reads "$4,200" as "dollar 4 200" and "$200M" as "dollar 2 M";
// spelling money out in words fixes every source at once (router replies,
// mined headlines, run summaries). Pure module — no env, no fs.
// ---------------------------------------------------------------------------

const ONES = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight",
  "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
  "sixteen", "seventeen", "eighteen", "nineteen",
];
const TENS = [
  "", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy",
  "eighty", "ninety",
];

function numWords(n: number): string {
  if (n < 0) return `minus ${numWords(-n)}`;
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? ` ${ONES[n % 10]}` : "");
  if (n < 1_000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${numWords(n % 100)}` : ""}`;
  if (n < 1_000_000) return `${numWords(Math.floor(n / 1_000))} thousand${n % 1_000 ? ` ${numWords(n % 1_000)}` : ""}`;
  if (n < 1_000_000_000) return `${numWords(Math.floor(n / 1_000_000))} million${n % 1_000_000 ? ` ${numWords(n % 1_000_000)}` : ""}`;
  return `${numWords(Math.floor(n / 1_000_000_000))} billion${n % 1_000_000_000 ? ` ${numWords(n % 1_000_000_000)}` : ""}`;
}

// "1.5" → "one point five" (decimals read digit-by-digit after the point)
function decimalWords(s: string): string {
  const [int, frac] = s.split(".");
  const head = numWords(parseInt(int, 10));
  if (!frac) return head;
  return `${head} point ${[...frac].map((d) => ONES[parseInt(d, 10)]).join(" ")}`;
}

const SUFFIX: Record<string, string> = {
  k: "thousand",
  m: "million",
  b: "billion",
  t: "trillion",
};

// Spoken numbers get ROUNDED to clean magnitudes — "four thousand two hundred
// dollars" reads choppy; "four thousand dollars" flows. Precision lives on
// screen; the voice speaks in wave-tops (Chase's call, 2026-06-12).
function spokenRound(n: number): string {
  if (n < 1_000) return numWords(n);
  if (n < 1_000_000) return `${Math.round(n / 1_000)} thousand`; // 4,200 → "4 thousand"
  return `${Math.round(n / 100_000) / 10} million`; // 1,437,000 → "1.4 million"
}

export function normalizeForSpeech(text: string): string {
  let t = text;

  // clock times FIRST — Kokoro reads "1:00" as "one zero zero". "1:00 PM" →
  // "1 PM", "13:00" → "1 PM", "9:05" → "9 oh 5", "1:30" → "1 30". Runs before
  // the number passes so the raw digits never reach them.
  t = t.replace(/\b(\d{1,2}):([0-5]\d)\b(?:\s*(a\.?m\.?|p\.?m\.?))?/gi, (raw, h: string, m: string, ap?: string) => {
    let hour = parseInt(h, 10);
    if (hour > 23) return raw; // not a clock time
    let suffix = ap ? ap.replace(/\./g, "").toLowerCase() : "";
    if (!suffix && hour >= 13) { hour -= 12; suffix = "pm"; }
    if (!suffix && hour === 0) { hour = 12; suffix = "am"; }
    const spokenAp = suffix ? (suffix === "am" ? " AM" : " PM") : "";
    if (m === "00") return `${hour}${spokenAp}`;
    const mins = m.startsWith("0") ? `oh ${m[1]}` : m;
    return `${hour} ${mins}${spokenAp}`;
  });

  // $200M / $1.5B / $10k → "two hundred million dollars"
  t = t.replace(/\$\s?(\d+(?:\.\d+)?)\s?(k|K|[mM]illion|[bB]illion|[tT]rillion|M|B|T)\b/g, (_, num: string, suf: string) => {
    const scale = SUFFIX[suf[0].toLowerCase()];
    return `${decimalWords(num)} ${scale} dollars`;
  });

  // $4,200 / $4200.50 / $1 → "four thousand dollars" (rounded, cents dropped)
  t = t.replace(/\$\s?(\d{1,3}(?:,\d{3})*|\d+)(?:\.\d+)?/g, (_, num: string) => {
    const n = parseInt(num.replace(/,/g, ""), 10);
    return `${spokenRound(n)} ${n === 1 ? "dollar" : "dollars"}`;
  });

  // bare 200M / 1.5B (counts, not money) → "two hundred million"
  t = t.replace(/\b(\d+(?:\.\d+)?)([MBT])\b/g, (_, num: string, suf: string) => {
    return `${decimalWords(num)} ${SUFFIX[suf.toLowerCase()]}`;
  });

  // remaining thousands separators trip the phonemizer: "14,166" → "14166".
  // Lookarounds so multi-comma numbers ("1,437,000") strip in one pass.
  t = t.replace(/(?<=\d),(?=\d{3}\b)/g, "");

  // bare big counts round to magnitudes too: "14606 views" → "fifteen
  // thousand views". Decimals are consumed whole ("1437.5" never leaves a
  // dangling ".5" after rounding). Years (19xx/20xx) stay literal.
  t = t.replace(/\b(\d{4,})(?:\.\d+)?\b/g, (raw, num: string) => {
    const n = parseInt(num, 10);
    if (n >= 1900 && n <= 2099 && !raw.includes(".")) return raw; // year, not a count
    return spokenRound(n);
  });

  return t;
}

// ---------------------------------------------------------------------------
// scrubRunSummary(s) — runner summaries are line 1 of a claude -p reply and
// sometimes leak build jargon the user should never HEAR ("(headless)",
// "SAVED inbox/...", markdown). The runner prompt's spoken-summary contract
// is the real fix; this is the safety net for replies that ignore it.
// ---------------------------------------------------------------------------
// failure summaries are runner internals ("[runner: hard timeout 10m —
// killed]", "spawn error: ENOENT") — translate the known shapes to something
// a person would say before they reach the speakers
export function humanizeFailure(s: string): string {
  if (/hard timeout/i.test(s)) return "it ran past the time limit, so I stopped it.";
  if (/spawn error/i.test(s)) return "I couldn't start the session for it.";
  if (/bad intent json|unknown or invalid intent/i.test(s)) return "the request didn't parse on my end.";
  // unknown shape: scrub bracketed runner internals, keep whatever's human
  return scrubRunSummary(s.replace(/\[runner:[^\]]*\]/gi, "").trim());
}

export function scrubRunSummary(s: string): string {
  let t = s;
  // trailing "SAVED <path>" protocol line
  t = t.replace(/\bSAVED\s+\S+\s*$/i, "");
  // parentheticals carrying process jargon: "(headless)", "(autonomous run)"
  t = t.replace(/\s*\([^)]*\b(headless|autonomous|exit code|run[ _-]?id|deliverable)\b[^)]*\)/gi, "");
  // bare jargon words that survive outside parens
  t = t.replace(/\b(headless(ly)?|autonomous(ly)?)\b/gi, "");
  // markdown chrome reads as noise
  t = t.replace(/[`*#_]+/g, "");
  // file paths spoken aloud are gibberish ("2026 dash 06 dash 12 dash…")
  t = t.replace(/\b[\w.-]+(?:[\\/][\w.-]+)+\.(?:md|json|html|csv)\b/g, "the report");
  return t.replace(/\s{2,}/g, " ").replace(/\s+([.,!?;:])/g, "$1").trim();
}
