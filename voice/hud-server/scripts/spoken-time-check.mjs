const { normalizeForSpeech } = await import("../lib/spokenText.ts");
for (const s of [
  "You have a call at 1:00.",
  "Call at 1:00 PM, then standup at 9:05 a.m.",
  "Schedule: 13:00 deep work; 14:30 edit session",
  "The video hit 14,166 views and $4,200 MRR at 00:30",
  "ratio was 3:45",
]) console.log(`${s}\n  -> ${normalizeForSpeech(s)}`);
