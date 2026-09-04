// ---------------------------------------------------------------------------
// Per-ask model override — "use opus" / "use fable" spoken inside a tier-3
// ask overrides the runner's default model for that ONE run.
// Exact-phrase guard: only the literal bigram "use <name>" counts, so STT
// mishears ("opus" alone, "user table", "useful") can never flip the model.
// The phrase is stripped before routing so the ask reads clean in the
// voice-ask prompt and in the Haiku router.
// Runner side re-validates against its own allowlist (defense in depth).
// ---------------------------------------------------------------------------

const MODEL_PHRASES: Record<string, { id: string; spoken: string }> = {
  opus: { id: "claude-opus-5", spoken: "Opus" },
  fable: { id: "claude-fable-5-1", spoken: "Fable" },
  sonnet: { id: "claude-sonnet-5", spoken: "Sonnet" },
  haiku: { id: "claude-haiku-4-5-20251001", spoken: "Haiku" },
};

const PHRASE_RE = /\buse\s+(opus|fable|sonnet|haiku)\b/i;

export interface ModelOverride {
  /** full model id passed to the runner as args.model */
  model: string;
  /** human name for the spoken ack ("running this one on Opus") */
  spoken: string;
  /** transcript with the override phrase removed, ready for routing */
  stripped: string;
}

export function extractModelOverride(transcript: string): ModelOverride | null {
  const m = transcript.match(PHRASE_RE);
  if (!m) return null;
  const pick = MODEL_PHRASES[m[1].toLowerCase()];
  if (!pick) return null;
  const stripped = transcript
    .replace(PHRASE_RE, " ")
    .replace(/\s+/g, " ")
    // dangling connectives/punctuation left where the phrase sat:
    // "Use opus, summarize X" / "summarize X, and" / "and summarize X"
    .replace(/^[\s,;]+/, "")
    .replace(/^(and|then|please)\b[\s,;]*/i, "")
    .replace(/[\s,;]+(and|then|please)?[\s,;]*$/i, "")
    .trim();
  return { model: pick.id, spoken: pick.spoken, stripped };
}
