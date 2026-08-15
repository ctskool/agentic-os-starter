import { route, type ObsidianAction, type Reveal } from "./router";
import { writeIntent } from "./skills";
import { extractModelOverride } from "./modelOverride";
import { conversationContext, rememberExchange } from "./voiceMemory";

// ---------------------------------------------------------------------------
// Shared transcript → intent dispatch. Two front doors call this:
//   POST /api/voice       — PTT audio clip (STT happens in the route)
//   POST /api/voice/text  — wake-word transcript (voice-server already STT'd)
// Same routing, same model-override extraction, same queue writes, same
// conversation memory — only the transport differs.
// ---------------------------------------------------------------------------

export interface VoicePayload {
  transcript: string;
  tier: number;
  skill: string | null;
  queued: string | null;
  reply: string;
  engine: string;
  panels: string[];
  deliverable: string | null;
  reveal: "open" | null;
  reveals: Reveal[];
  /** UI action for the Obsidian orb; browser HUD ignores it */
  obsidian: ObsidianAction | null;
}

export async function dispatchTranscript(
  transcript: string,
  source: string
): Promise<VoicePayload> {
  // "use opus" / "use fable" spoken in the ask → one-run model override;
  // strip the phrase so routing and the voice-ask prompt see the clean ask
  const override = extractModelOverride(transcript);
  const ask = override ? override.stripped : transcript;

  // running conversation memory — lets follow-ups ("make it shorter",
  // "what about the second one") resolve against the last few exchanges
  const convo = conversationContext();

  const result = await route(ask, convo);

  let queued: string | null = null;
  let reply = result.reply;
  if (result.tier === 1 && result.skill) {
    queued = writeIntent(result.skill, source);
  } else if (result.tier === 3 && ask.split(/\s+/).length >= 3) {
    // open-ended ask → headless claude -p via the runner (voice-ask skill);
    // completion is announced like any other run. Word guard keeps noise
    // and half-caught fragments from spawning real sessions.
    queued = writeIntent("voice-ask", source, {
      prompt: ask,
      ...(override ? { model: override.model } : {}),
      ...(convo ? { context: convo } : {}),
    });
    if (override && queued) {
      reply = `On it — running this one on ${override.spoken}. I'll speak up when it lands.`;
    }
  }

  const spokenReply = queued || result.tier !== 3 ? reply : "I didn't catch enough to act on.";

  rememberExchange({
    you: transcript,
    jarvis: spokenReply,
    tier: result.tier,
    skill: result.skill ?? (queued && result.tier === 3 ? "voice-ask" : undefined),
  });

  return {
    transcript,
    tier: result.tier,
    skill: result.skill ?? (result.tier === 3 && queued ? "voice-ask" : null),
    queued,
    reply: spokenReply,
    engine: result.engine,
    panels: result.panels ?? [],
    deliverable: result.deliverable ?? null,
    reveal: result.reveal ?? null,
    reveals: result.reveals ?? [],
    obsidian: result.obsidian ?? null,
  };
}
