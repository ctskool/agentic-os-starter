process.env.VOICE_ROUTER = "haiku";
const { route } = await import("../lib/router.ts");
for (const t of ["Hey Jarvis, open my daily note please.", "go back", "pull up my calendar", "intel brief", "Hey Jarvis, pull up the terminal.", "open a terminal", "could you maybe show me that calendar thing again"]) {
  const t0 = performance.now();
  const r = await route(t);
  console.log(`${(performance.now()-t0).toFixed(0).padStart(5)}ms  [${r.engine}]  "${t}" -> tier ${r.tier}${r.obsidian ? " obsidian:"+r.obsidian.op : ""}${r.skill ? " skill:"+r.skill : ""}`);
}
