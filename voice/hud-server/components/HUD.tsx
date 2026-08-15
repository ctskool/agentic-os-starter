"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { VaultState, Metric } from "@/lib/vault";
import { voice } from "@/lib/voiceClient";
import { scrubRunSummary, humanizeFailure } from "@/lib/spokenText";
import { BG_MODES, type BgMode, type CoreMode } from "./GraphCore";
import ReportOverlay from "./ReportOverlay";

const GraphCore = dynamic(() => import("./GraphCore"), { ssr: false });

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function fmt(n: number): string {
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (Math.abs(n) >= 10_000) return Math.round(n / 1000) + "K";
  if (Math.abs(n) >= 1_000) return (n / 1000).toFixed(1) + "K";
  return String(Math.round(n));
}

function fmtFull(n: number): string {
  return n.toLocaleString("en-US");
}

function useVaultState(intervalMs = 5000) {
  const [state, setState] = useState<VaultState | null>(null);
  const [error, setError] = useState(false);

  const pull = useCallback(async () => {
    try {
      const res = await fetch("/api/state", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      setState(await res.json());
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    pull();
    const id = setInterval(pull, intervalMs);
    return () => clearInterval(id);
  }, [pull, intervalMs]);

  return { state, error, refresh: pull };
}

function useClock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function findMetric(metrics: Metric[], source: string, metric: string): Metric | null {
  return metrics.find((m) => m.source === source && m.metric === metric) ?? null;
}

// relative age of an ISO timestamp; stale = older than two missed 6h pulls
function fmtAge(ts: string | null): { label: string; stale: boolean } {
  if (!ts) return { label: "—", stale: true };
  const ms = Date.now() - Date.parse(ts);
  if (Number.isNaN(ms)) return { label: "—", stale: true };
  const stale = ms > 13 * 3600 * 1000;
  const m = Math.floor(ms / 60000);
  if (m < 1) return { label: "now", stale };
  if (m < 60) return { label: `${m}m`, stale };
  const h = Math.floor(m / 60);
  if (h < 48) return { label: `${h}h`, stale };
  return { label: `${Math.floor(h / 24)}d`, stale };
}

function fmtDur(s: number): string {
  if (s < 100) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

// task callouts speak stopwatch ("0:42") — fmtDur is for completed-run feed lines
function fmtClock(s: number): string {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function noteAgeDays(date: string): number {
  const ms = Date.now() - Date.parse(`${date}T12:00:00`);
  return Math.max(0, Math.round(ms / 86_400_000));
}

// animated count-up
function CountUp({ value, full = false }: { value: number; full?: boolean }) {
  const [display, setDisplay] = useState(0);
  const fromRef = useRef(0);
  useEffect(() => {
    const from = fromRef.current;
    if (from === value) {
      setDisplay(value);
      return;
    }
    const start = performance.now();
    const dur = 1400;
    let raf = 0;
    const step = (t: number) => {
      const p = Math.min((t - start) / dur, 1);
      const eased = 1 - Math.pow(1 - p, 4);
      setDisplay(from + (value - from) * eased);
      if (p < 1) raf = requestAnimationFrame(step);
      else fromRef.current = value;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{full ? fmtFull(Math.round(display)) : fmt(display)}</>;
}

// inline sparkline from metric history — real data, no fake bars
function Sparkline({ points }: { points: number[] }) {
  if (points.length < 2) return <div className="spark spark-flat" />;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const W = 100;
  const H = 16;
  const path = points
    .map((v, i) => {
      const x = (i / (points.length - 1)) * W;
      const y = H - 2 - ((v - min) / range) * (H - 4);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const last = points[points.length - 1];
  const lastY = H - 2 - ((last - min) / range) * (H - 4);
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <path d={path} fill="none" stroke="currentColor" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
      <circle cx={W} cy={lastY} r="1.8" fill="currentColor" />
    </svg>
  );
}

// section heading — typographic, no box
function SectionTitle({ title, tick, href }: { title: string; tick?: string; href?: string }) {
  return (
    <div className="sec-title">
      {href ? (
        <a className="sec-link" href={href} target="_blank" rel="noreferrer">
          {title} ↗
        </a>
      ) : (
        <span>{title}</span>
      )}
      {tick && <span className="tick">{tick}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// feed lines (voice transcript + run events — shown in the AudioIO mini feed)
// ---------------------------------------------------------------------------

interface FeedLine {
  ts: string;
  cls: string;
  text: string;
}

function nowHHMMSS(): string {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((x) => String(x).padStart(2, "0"))
    .join(":");
}

// spoken line for a finished run — short, no markdown, summary clamped.
// Summaries pass through scrubRunSummary so prompt-contract violations
// ("(headless)", SAVED-path tails) never reach the speakers.
function runAnnouncement(skill: string, status: string, summary: string, label?: string | null): string {
  const name = label ? `${label} ask` : skill.replace(/-/g, " ");
  if (status !== "ok") {
    const why = summary ? humanizeFailure(summary) : "";
    return `${name} hit a snag${why ? ` — ${why.slice(0, 120)}` : "."}`;
  }
  const clean = scrubRunSummary(summary);
  // voice-ask runs put the spoken answer in line 1 of output (= summary) —
  // speak it directly instead of "voice ask complete"
  if (skill === "voice-ask" && clean) {
    return clean.slice(0, 220);
  }
  // "plan today is done. Done." — a summary that only says done adds nothing
  const redundant = /^(done|complete|completed|finished|all done|ok)[.!]?$/i.test(clean);
  return `${name} is done.${clean && !redundant ? ` ${clean.slice(0, 160)}` : ""}`;
}

// ---------------------------------------------------------------------------
// panels (memoized — only re-render when their slice of state changes)
// ---------------------------------------------------------------------------

const SOCIAL_DEFS: { source: string; metric: string; label: string }[] = [
  { source: "youtube", metric: "subscribers", label: "YT Subscribers" },
  { source: "instagram", metric: "followers", label: "Instagram" },
];

function VitalLabel({ m, label }: { m: Metric; label: string }) {
  const age = fmtAge(m.timestamp);
  return (
    <span className="label">
      <i className={`status-dot ${m.status !== "ok" ? m.status : ""}`} />
      {label}
      {m.status === "mock" && <span className="sim-tag">SIM</span>}
      <span className={`age ${age.stale ? "stale" : ""}`}>{age.label}</span>
    </span>
  );
}

const Vitals = memo(function Vitals({ state, hot }: { state: VaultState; hot?: boolean }) {
  const metrics = state.metrics;
  const tokens = findMetric(metrics, "claude_code", "tokens_5h");
  const vidMetric = findMetric(metrics, "youtube", "latest_video_views");
  const v = state.latestVideo;

  // auto-calibrating cap: 100% = the biggest 5h window ever recorded —
  // no plan constant to maintain, tightens itself as heavy days land
  const tokenPeak = tokens
    ? Math.max(...tokens.history.map((h) => h.value), tokens.value)
    : null;

  const vidDays = v ? Math.max((Date.now() - Date.parse(v.published_at)) / 86_400_000, 0.25) : null;
  const vidPerDay = v && vidDays ? v.views / vidDays : null;

  return (
    <section className={`block boot-stagger ${hot ? "voice-hot" : ""}`} style={{ animationDelay: "0.1s" }}>
      <SectionTitle title="System Vitals" tick="AUDIENCE.LINK" />
      {SOCIAL_DEFS.map((def) => {
        const m = findMetric(metrics, def.source, def.metric);
        if (!m) return null;
        const dw = m.deltaWeek;
        const deltaCls = !dw ? "zero" : dw < 0 ? "neg" : "";
        const age = fmtAge(m.timestamp);
        return (
          <div className={`vital ${age.stale ? "is-stale" : ""}`} key={`${def.source}:${def.metric}`}>
            <VitalLabel m={m} label={def.label} />
            <span className="value">
              <CountUp value={m.value} />
            </span>
            <span className={`delta ${deltaCls}`}>
              {dw === null ? "—" : dw === 0 ? "steady /wk" : `${dw > 0 ? "▲" : "▼"} ${fmt(Math.abs(dw))} /wk`}
            </span>
            <div className="spark-row">
              <Sparkline points={m.history.map((h) => h.value)} />
            </div>
          </div>
        );
      })}

      {v && vidMetric && (
        <div className={`vital ${fmtAge(vidMetric.timestamp).stale ? "is-stale" : ""}`}>
          <VitalLabel m={vidMetric} label="Latest Video" />
          <span className="value">
            <CountUp value={v.views} />
          </span>
          <span className="delta">{vidPerDay !== null ? `≈${fmt(vidPerDay)} /day` : "—"}</span>
          <div className="spark-row">
            <Sparkline points={vidMetric.history.map((h) => h.value)} />
          </div>
        </div>
      )}

      {tokens && tokenPeak !== null && tokenPeak > 0 && (
        <div className={`vital ${fmtAge(tokens.timestamp).stale ? "is-stale" : ""}`}>
          <VitalLabel m={tokens} label="Claude 5h Window" />
          <span className="value">
            <CountUp value={(tokens.value / tokenPeak) * 100} full />
            <span className="unit-pct">%</span>
          </span>
          <span className="delta">
            {fmt(tokens.value)} of {fmt(tokenPeak)} peak
          </span>
          <div className="spark-row">
            <Sparkline points={tokens.history.map((h) => h.value)} />
          </div>
        </div>
      )}
    </section>
  );
});

// command deck — buttons drop REAL intents into system/queue/. Full roster:
// every skill the runner contract (lib/skills.ts ↔ runner.js) supports.
const DECK_SKILLS: { skill: string; label: string }[] = [
  { skill: "metrics-pull", label: "Metrics Pull" },
  { skill: "morning-report", label: "AM Report" },
  { skill: "inbox-brief", label: "Inbox Brief" },
  { skill: "github-trending", label: "GH Trending" },
  { skill: "ai-trend-scan", label: "Trend Scan" },
  { skill: "yt-week-review", label: "YT Week" },
  { skill: "plan-today", label: "Plan Today" },
  { skill: "plan-tomorrow", label: "Plan Tmrw" },
  { skill: "weekly-review", label: "Wk Review" },
  { skill: "vault-cleanup", label: "Vault Clean" },
];

function CommandDeck({
  state,
  hot,
  onQueued,
}: {
  state: VaultState | null;
  hot?: boolean;
  onQueued: (skill: string, ok: boolean) => void;
}) {
  const [cooldown, setCooldown] = useState<Record<string, boolean>>({});

  const fire = async (skill: string) => {
    if (cooldown[skill]) return;
    setCooldown((c) => ({ ...c, [skill]: true }));
    try {
      const res = await fetch("/api/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skill }),
      });
      onQueued(skill, res.ok);
    } catch {
      onQueued(skill, false);
    }
    setTimeout(() => setCooldown((c) => ({ ...c, [skill]: false })), 15000);
  };

  const r = state?.runner;
  return (
    <section className={`block boot-stagger ${hot ? "voice-hot" : ""}`} style={{ animationDelay: "0.26s" }}>
      <SectionTitle
        title="Command Deck"
        tick={r ? `${r.busy ? "ENGAGED" : "IDLE"} · ${r.active}/${r.max_concurrent} ACTIVE · ${r.pending} QUEUED` : "RUNNER OFFLINE"}
      />
      {state && state.queue.length > 0 && (
        <div className="queue-list">
          {state.queue.slice(0, 3).map((q) => (
            <span key={q.id}>▸ {q.label ?? q.skill}</span>
          ))}
          {state.queue.length > 3 && <span className="dim">+{state.queue.length - 3} more</span>}
        </div>
      )}
      <div className="deck">
        {DECK_SKILLS.map((d) => (
          <button
            key={d.skill}
            className={`deck-btn ${cooldown[d.skill] ? "fired" : ""}`}
            onClick={() => fire(d.skill)}
            disabled={cooldown[d.skill]}
          >
            <span className="deck-dot" />
            <span className="deck-label">{cooldown[d.skill] ? "QUEUED" : d.label}</span>
            <span className="deck-arrow">→</span>
          </button>
        ))}
      </div>
      <div className="deck-hint">intents write to system/queue — runner executes</div>
    </section>
  );
}

const AudioIO = memo(function AudioIO({ mode }: { mode: CoreMode }) {
  const live = mode === "speaking" || mode === "listening";
  return (
    <section className="block boot-stagger" style={{ animationDelay: "0.42s" }}>
      <SectionTitle title="Audio I/O" tick={live ? "TTS.LIVE" : "TTS.STANDBY"} />
      <div className={`wave ${live ? "live" : "idle"} ${mode === "listening" ? "cobalt" : ""}`}>
        {Array.from({ length: 36 }, (_, i) => (
          <i key={i} style={{ "--i": i } as React.CSSProperties} />
        ))}
      </div>
      <div className="audio-meta">
        <span>voice link · {live ? mode : "standby"}</span>
        <span>hold SPACE to talk · ESC to stop</span>
      </div>
    </section>
  );
});

const Priorities = memo(function Priorities({
  state,
  hot,
  onToggle,
}: {
  state: VaultState;
  hot?: boolean;
  onToggle: (index: number, done: boolean) => void;
}) {
  const d = state.daily;
  const ageDays = d && !d.isToday ? noteAgeDays(d.date) : 0;
  const veryStale = ageDays > 2;
  return (
    <section
      className={`block boot-stagger ${!d || d.isToday ? "" : "note-stale"} ${hot ? "voice-hot" : ""}`}
      style={{ animationDelay: "0.18s" }}
    >
      <SectionTitle title="Directives" tick="TOP.3" />
      {d ? (
        <>
          {!d.isToday && (
            <div className={`stale-banner ${veryStale ? "err" : ""}`}>
              ⚠ note is {ageDays}d old — run /today
            </div>
          )}
          {d.top3.map((p, i) => (
            <div
              className={`prio ${p.done ? "done" : ""} ${d.isToday ? "clickable" : ""}`}
              key={i}
              role={d.isToday ? "button" : undefined}
              title={d.isToday ? (p.done ? "mark open" : "mark done") : undefined}
              onClick={d.isToday ? () => onToggle(i, !p.done) : undefined}
            >
              <span className="box">{p.done ? "■" : "□"}</span>
              <span>{p.text}</span>
            </div>
          ))}
          <div className="prio-date">{d.isToday ? "today" : `carried · ${d.date}`}</div>
        </>
      ) : (
        <div className="prio dim">no daily note found</div>
      )}
    </section>
  );
});

// recent deliverables — every run that produced a document, newest first.
// The reveal chip is one-shot; this is the persistent trail.
const Documents = memo(function Documents({
  state,
  hot,
  onOpen,
}: {
  state: VaultState;
  hot?: boolean;
  onOpen: (path: string) => void;
}) {
  const docs: { path: string; skill: string; ts: string | null }[] = [];
  for (const r of state.runs) {
    if (r.status !== "ok" || !r.deliverable_path) continue;
    if (docs.some((d) => d.path === r.deliverable_path)) continue;
    docs.push({ path: r.deliverable_path, skill: r.label ?? r.skill, ts: r.ts_completed });
    if (docs.length >= 5) break;
  }
  if (docs.length === 0) return null;
  return (
    <section className={`block boot-stagger ${hot ? "voice-hot" : ""}`} style={{ animationDelay: "0.26s" }}>
      <SectionTitle title="Documents" tick="INBOX.TRAIL" />
      {docs.map((doc) => (
        <div className="doc-row" key={doc.path} role="button" onClick={() => onOpen(doc.path)}>
          <span className="doc-skill">{doc.skill.replace(/-/g, " ")}</span>
          <span className="doc-age">{fmtAge(doc.ts).label}</span>
        </div>
      ))}
    </section>
  );
});

// AI Wire — today's morning-report headlines, click → full report overlay
const Wire = memo(function Wire({
  state,
  onOpen,
}: {
  state: VaultState;
  onOpen: (path: string) => void;
}) {
  const m = state.morning;
  if (!m || m.heads.length === 0) return null;
  return (
    <section className="block boot-stagger" style={{ animationDelay: "0.5s" }}>
      <SectionTitle title="AI Wire" tick="MORNING.INTEL" />
      {/* top 3 only — the panel sits at the viewport's edge and more cuts off */}
      {m.heads.slice(0, 3).map((h, i) => (
        <div className="wire-row" key={i} role="button" onClick={() => onOpen(m.rel)}>
          <span className="wire-bullet">▸</span>
          <span>{h}</span>
        </div>
      ))}
    </section>
  );
});

function parseHHMM(t: string): number {
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : -1;
}

const Schedule = memo(function Schedule({ state, hot }: { state: VaultState; hot?: boolean }) {
  const d = state.daily;
  const now = useClock();
  if (!d || d.schedule.length === 0) return null;
  const nowMin = now && d.isToday ? now.getHours() * 60 + now.getMinutes() : -1;
  const items = d.schedule.map((s) => ({ ...s, min: parseHHMM(s.time) }));
  // current block = latest item that has started
  let currentIdx = -1;
  if (nowMin >= 0) {
    for (let i = 0; i < items.length; i++) {
      if (items[i].min >= 0 && items[i].min <= nowMin) currentIdx = i;
    }
  }
  const ageDays = d.isToday ? 0 : noteAgeDays(d.date);
  return (
    <section
      className={`block boot-stagger ${d.isToday ? "" : "note-stale"} ${hot ? "voice-hot" : ""}`}
      style={{ animationDelay: "0.34s" }}
    >
      <SectionTitle
        title="Schedule"
        tick={d.isToday ? "TODAY" : `${ageDays}D OLD`}
        href="https://calendar.google.com/calendar/u/0/r/day"
      />
      <div className="sched">
        {items.map((s, i) => (
          <div
            key={`${s.time}-${i}`}
            className={`sched-row ${i === currentIdx ? "now" : ""} ${
              currentIdx >= 0 && i < currentIdx ? "past" : ""
            }`}
          >
            <span className="t">{s.time}</span>
            <span className="i">{s.item}</span>
            {i === currentIdx && <span className="now-tag">NOW</span>}
          </div>
        ))}
      </div>
      {d.focus && <div className="focus-line">focus · {d.focus}</div>}
    </section>
  );
});

// State-picked directive: a fresh upload (<48h) takes the board as a live
// velocity battle; otherwise the long campaign — road to the NEXT subscriber
// milestone, with the projected arrival date from the real weekly delta.
const MILESTONES = [100_000, 250_000, 500_000, 1_000_000, 2_000_000];
const nextMilestone = (subs: number) =>
  MILESTONES.find((m) => m > subs) ?? Math.ceil(subs / 1_000_000 + 1) * 1_000_000;
const LIVE_DEPLOY_H = 48;

const Objective = memo(function Objective({ state, hot }: { state: VaultState; hot?: boolean }) {
  const subs = findMetric(state.metrics, "youtube", "subscribers");
  const v = state.latestVideo;

  const ageH = v?.published_at ? (Date.now() - Date.parse(v.published_at)) / 3_600_000 : null;
  const liveDeploy = v !== null && ageH !== null && ageH >= 0 && ageH <= LIVE_DEPLOY_H;

  const deployLine = v && (
    <div className="video-title">
      latest deploy ·{" "}
      <a href={v.url} target="_blank" rel="noreferrer">
        <b>{v.title}</b>
      </a>{" "}
      — {fmtFull(v.views)} views
    </div>
  );

  if (liveDeploy && v) {
    const days = Math.max(ageH! / 24, 0.25);
    const perDay = Math.round(v.views / days);
    const windowPct = Math.min((ageH! / LIVE_DEPLOY_H) * 100, 100);
    return (
      <section className={`objective boot-stagger ${hot ? "voice-hot" : ""}`} style={{ animationDelay: "0.58s" }}>
        <div className="obj-label">Primary Directive · Live Deploy</div>
        <div className="big">
          <CountUp value={v.views} full />
          <span className="unit">VIEWS</span>
        </div>
        <div className="progress">
          <i style={{ width: `${windowPct}%` }} />
        </div>
        <div className="sub">
          <span>
            velocity <b>{fmtFull(perDay)}/day</b>
          </span>
          <span>
            live <b>{Math.round(ageH!)}h</b>
          </span>
          <span>
            spotlight <b>{Math.max(LIVE_DEPLOY_H - Math.round(ageH!), 0)}h left</b>
          </span>
        </div>
        {deployLine}
      </section>
    );
  }

  const target = subs ? nextMilestone(subs.value) : MILESTONES[0];
  const pct = subs ? Math.min((subs.value / target) * 100, 100) : 0;
  // honest clock: at the current weekly pace, when does the next plaque land?
  const eta =
    subs && subs.deltaWeek && subs.deltaWeek > 0
      ? new Date(
          Date.now() + ((target - subs.value) / subs.deltaWeek) * 7 * 86_400_000
        ).toLocaleDateString("en-US", { month: "short", year: "numeric" })
      : null;
  return (
    <section className={`objective boot-stagger ${hot ? "voice-hot" : ""}`} style={{ animationDelay: "0.58s" }}>
      <div className="obj-label">Primary Directive · Road to {fmt(target)}</div>
      <div className="big">
        {subs ? <CountUp value={subs.value} full /> : "—"}
        <span className="unit">SUBS</span>
      </div>
      <div className="progress">
        <i style={{ width: `${pct}%` }} />
      </div>
      <div className="sub">
        <span>
          target <b>{fmtFull(target)}</b>
        </span>
        <span>
          this week <b>{subs?.deltaWeek ? `+${fmtFull(subs.deltaWeek)}` : "—"}</b>
        </span>
        <span>
          {eta ? (
            <>
              at this pace <b>{eta}</b>
            </>
          ) : (
            <b>{pct.toFixed(1)}%</b>
          )}
        </span>
      </div>
      {deployLine}
    </section>
  );
});

function TopBar({
  state,
  online,
  mode,
}: {
  state: VaultState | null;
  online: boolean;
  mode: CoreMode;
}) {
  const now = useClock();
  const r = state?.runner;
  return (
    <header className="topbar hud-top boot-stagger" style={{ animationDelay: "0.05s" }}>
      <div className="wordmark">
        <span className="name">V.A.U.L.T.</span>
        <span className="expansion">Voice-Activated Unified Logic Terminal</span>
      </div>
      <div className="status-line">
        <span className={`mode-chip mode-${mode}`}>
          <i className="status-dot" /> core · {mode}
        </span>
        <span className={`chip ${online ? "on" : "dead"}`}>
          {online ? "link · online" : "link · LOST"}
        </span>
        <span className={`chip ${r?.alive ? "on" : "dead"}`}>
          runner · {r?.alive ? "alive" : "down"}
        </span>
      </div>
      <div className="clock-wrap">
        <div className="clock" suppressHydrationWarning>
          {now
            ? `${String(now.getHours()).padStart(2, "0")}:${String(
                now.getMinutes()
              ).padStart(2, "0")}`
            : "--:--"}
          <span className="sec" suppressHydrationWarning>
            {now ? `:${String(now.getSeconds()).padStart(2, "0")}` : ""}
          </span>
        </div>
        <div className="clock-date" suppressHydrationWarning>
          {now
            ? `${["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][now.getDay()]} · ${
                ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"][
                  now.getMonth()
                ]
              } ${now.getDate()}`
            : ""}
        </div>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// root
// ---------------------------------------------------------------------------

const MODE_KEYS: Record<string, CoreMode> = {
  "1": "idle",
  "2": "working",
  "3": "listening",
  "4": "speaking",
  "5": "error",
};

export default function HUD() {
  const { state, error, refresh } = useVaultState(5000);
  const [feed, setFeed] = useState<FeedLine[]>([]);
  const [modeOverride, setModeOverride] = useState<CoreMode | null>(null);
  const [bgMode, setBgMode] = useState<BgMode>("grid");
  const [voiceSpeaking, setVoiceSpeaking] = useState(false);
  const [ptt, setPtt] = useState(false);
  const [wakeListening, setWakeListening] = useState(false);
  const [hotPanels, setHotPanels] = useState<string[]>([]);
  // report reveal: callouts = cards branching off the core (max 4 anchor
  // slots around the orb — same hairline language). kind "doc" opens the
  // overlay, kind "link" opens the source in a new tab, kind "task" is a
  // live run (elapsed / ~eta progress) that morphs into its doc card on
  // completion — target stays `run:<id>` until the morph swaps it.
  const [callouts, setCallouts] = useState<
    {
      id: number;
      kind: "doc" | "link" | "task";
      target: string;
      label: string;
      slot: number;
      startedAt?: number;
      etaS?: number | null;
      phase?: "working" | "done" | "failed";
    }[]
  >([]);
  const calloutSeq = useRef(0);
  const addCallout = useCallback(
    (target: string, label: string, kind: "doc" | "link" = "doc") => {
      setCallouts((cur) => {
        if (cur.some((c) => c.target === target)) return cur; // already on screen
        const used = new Set(cur.map((c) => c.slot));
        const free = [0, 1, 2, 3].find((s) => !used.has(s));
        const entry = { id: ++calloutSeq.current, kind, target, label };
        // all four slots taken → oldest card yields its slot, but never a
        // live task (its run is still going — evicting it hides real work)
        if (free === undefined) {
          const victim = cur.find((c) => !(c.kind === "task" && c.phase === "working")) ?? cur[0];
          return [...cur.filter((c) => c !== victim), { ...entry, slot: victim.slot }];
        }
        return [...cur, { ...entry, slot: free }];
      });
    },
    []
  );
  const [report, setReport] = useState<{ path: string; content: string } | null>(null);
  const reportOpenRef = useRef(false);
  reportOpenRef.current = report !== null;
  const seenRunsRef = useRef<Set<string>>(new Set());
  const spokenRunsRef = useRef<Set<string>>(new Set());

  const pushLine = useCallback((cls: string, text: string) => {
    setFeed((f) => [...f.slice(-30), { ts: nowHHMMSS(), cls, text }]);
  }, []);

  const openReport = useCallback(
    async (path: string) => {
      try {
        const res = await fetch(`/api/report?path=${encodeURIComponent(path)}`);
        if (!res.ok) throw new Error(String(res.status));
        const j = (await res.json()) as { path: string; content: string };
        setReport(j);
      } catch {
        pushLine("err", `couldn't open ${path}`);
      }
    },
    [pushLine]
  );

  // bottom-left TRANSCRIPT button — the voice conversation so far, rendered
  // in the same overlay as reports (memory.jsonl survives reloads, so this
  // shows exchanges from before the page opened too)
  const openTranscript = useCallback(async () => {
    try {
      const res = await fetch("/api/transcript", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      setReport((await res.json()) as { path: string; content: string });
    } catch {
      pushLine("err", "couldn't load transcript");
    }
  }, [pushLine]);

  const toggleDirective = useCallback(
    async (index: number, done: boolean) => {
      try {
        const res = await fetch("/api/daily", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ index, done }),
        });
        if (!res.ok) throw new Error(String(res.status));
        await refresh();
      } catch {
        pushLine("err", "directive update failed");
      }
    },
    [refresh, pushLine]
  );

  // ?demo=callouts — seed the doc callouts on demand (filming + layout checks)
  useEffect(() => {
    if (!window.location.search.includes("demo=callouts")) return;
    const seeds: [string, string][] = [
      ["inbox/reports/morning/demo-morning.md", "morning report"],
      ["inbox/voice/demo-voice-ask.md", "voice ask"],
      ["inbox/reports/trend-scan/demo-scan.md", "trend scan"],
      ["inbox/reports/inbox-briefs/demo-inbox.md", "inbox brief"],
    ];
    const timers = seeds.map(([p, l], i) => setTimeout(() => addCallout(p, l), 800 + i * 1400));
    return () => timers.forEach(clearTimeout);
  }, [addCallout]);

  // ?demo=taskwork — full task-callout lifecycle without queueing real runs:
  // two tasks spawn (one with eta, one indeterminate). First fills toward its
  // 10s median, runs OVERDUE at 10s (bar degrades to sweep), completes at 16s
  // and morphs into its doc card; the second fails at 22s
  useEffect(() => {
    if (!window.location.search.includes("demo=taskwork")) return;
    const seed = (label: string, etaS: number | null, slot: number) => ({
      id: ++calloutSeq.current,
      kind: "task" as const,
      target: `run:demo-${slot}`,
      label,
      startedAt: Date.now(),
      etaS,
      phase: "working" as const,
      slot,
    });
    const timers = [
      setTimeout(() => setCallouts((c) => [...c, seed("ai trend scan", 10, 0)]), 800),
      setTimeout(() => setCallouts((c) => [...c, seed("inbox brief", null, 1)]), 2600),
      setTimeout(
        () =>
          setCallouts((cur) =>
            cur.map((c) =>
              c.target === "run:demo-0"
                ? {
                    ...c,
                    kind: "doc" as const,
                    target: "inbox/reports/trend-scan/demo-scan.md",
                    phase: undefined,
                  }
                : c
            )
          ),
        16000
      ),
      setTimeout(
        () =>
          setCallouts((cur) =>
            cur.map((c) =>
              c.target === "run:demo-1" ? { ...c, phase: "failed" as const } : c
            )
          ),
        22000
      ),
    ];
    return () => timers.forEach(clearTimeout);
  }, []);

  // voice link — P1: Jarvis speaks, no mic
  useEffect(() => {
    voice.init();
    voice.onLog(pushLine);
    voice.onPanels(setHotPanels);
    voice.onDeliverable((path, label) => addCallout(path, label));
    voice.onReveal((r) => addCallout(r.target, r.label, r.kind)); // sequenced to speech
    voice.onOpenDoc((path) => void openReport(path)); // "bring up the html" → overlay now
    voice.onListening(setWakeListening); // P4: hands-free wake window
    return voice.onSpeaking(setVoiceSpeaking);
  }, [pushLine, openReport, addCallout]);

  // P3 choreography — highlights arrive with the reply and live for the
  // duration of speech; the grace window covers the response→playback gap
  // (and ends the glow if TTS never starts)
  useEffect(() => {
    if (voiceSpeaking || hotPanels.length === 0) return;
    const id = setTimeout(() => setHotPanels([]), 2000);
    return () => clearTimeout(id);
  }, [voiceSpeaking, hotPanels]);

  // P2 — push-to-talk: hold Space to record, release to send
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat) return;
      e.preventDefault();
      void voice.startCapture().then((ok) => {
        if (ok) setPtt(true);
      });
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      e.preventDefault();
      setPtt(false);
      void voice.finishCapture();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  // demo mode keys: 1 idle / 2 working / 3 listening / 4 speaking / 5 error, 0|Esc auto
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key in MODE_KEYS) {
        setModeOverride(MODE_KEYS[e.key]);
        pushLine("sys", `core mode override → ${MODE_KEYS[e.key].toUpperCase()}`);
      } else if (e.key === "Escape") {
        // overlay open → Esc closes it and does nothing else
        if (reportOpenRef.current) {
          setReport(null);
          return;
        }
        if (voice.stop()) pushLine("sys", "voice — stopped");
        setModeOverride(null);
      } else if (e.key === "0") {
        setModeOverride(null);
        pushLine("sys", "core mode → AUTO");
      } else if (e.key === "b" || e.key === "B") {
        setBgMode((cur) => {
          const next = BG_MODES[(BG_MODES.indexOf(cur) + 1) % BG_MODES.length];
          pushLine("sys", `background → ${next.toUpperCase()}`);
          return next;
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pushLine]);

  // real runs flow into the feed
  useEffect(() => {
    if (!state) return;
    const fresh = state.runs.filter((r) => !seenRunsRef.current.has(r.id));
    if (fresh.length === 0) return;
    [...fresh].reverse().forEach((r) => {
      seenRunsRef.current.add(r.id);
      const cls = r.status === "ok" ? "ok" : r.status === "running" ? "sys" : "err";
      const dur = r.duration_s !== null ? ` · ${fmtDur(r.duration_s)}` : "";
      const text = `run/${r.label ?? r.skill} — ${r.summary || r.status}${dur}`;
      const ts = r.ts_completed
        ? new Date(r.ts_completed).toTimeString().slice(0, 8)
        : nowHHMMSS();
      setFeed((f) => [...f.slice(-30), { ts, cls, text }]);
    });
  }, [state]);

  // task callouts — active runs branch off the core like doc reveals: skill
  // name + elapsed / ~eta bar while the runner works. On completion the card
  // morphs IN PLACE into the deliverable card (same slot, no jump) — this
  // effect must stay ABOVE the speak-completions effect so the morph happens
  // before addCallout's target dedupe sees the deliverable path.
  useEffect(() => {
    if (!state) return;
    setCallouts((cur) => {
      let next = cur;
      for (const r of state.runs) {
        const existing = next.find((c) => c.kind === "task" && c.target === `run:${r.id}`);
        if (r.status === "running" && !existing) {
          const used = new Set(next.map((c) => c.slot));
          const free = [0, 1, 2, 3].find((s) => !used.has(s));
          const entry = {
            id: ++calloutSeq.current,
            kind: "task" as const,
            target: `run:${r.id}`,
            label: r.label ?? r.skill.replace(/-/g, " "),
            startedAt: r.ts_started ? Date.parse(r.ts_started) : Date.now(),
            etaS: state.etas[r.skill] ?? null,
            phase: "working" as const,
            slot: 0,
          };
          if (free === undefined) {
            // same eviction rule as addCallout: oldest non-working card yields
            const victim =
              next.find((c) => !(c.kind === "task" && c.phase === "working")) ?? next[0];
            next = [...next.filter((c) => c !== victim), { ...entry, slot: victim.slot }];
          } else {
            next = [...next, { ...entry, slot: free }];
          }
        } else if (existing && existing.phase === "working" && r.status !== "running") {
          next =
            r.status === "ok" && r.deliverable_path
              ? next.map((c) =>
                  c === existing
                    ? {
                        ...c,
                        kind: (r.link ? "link" : "doc") as "link" | "doc",
                        target: r.link ?? r.deliverable_path!,
                        phase: undefined,
                      }
                    : c
                )
              : next.map((c) =>
                  c === existing
                    ? { ...c, phase: r.status === "ok" ? ("done" as const) : ("failed" as const) }
                    : c
                );
        }
      }
      return next;
    });
  }, [state]);

  // ok-but-no-deliverable tasks flash COMPLETE, then clear themselves
  useEffect(() => {
    if (!callouts.some((c) => c.phase === "done")) return;
    const id = setTimeout(
      () => setCallouts((cur) => cur.filter((c) => c.phase !== "done")),
      6000
    );
    return () => clearTimeout(id);
  }, [callouts]);

  // 1s re-render while a task works — elapsed + bar width derive from Date.now()
  const taskWorking = callouts.some((c) => c.kind === "task" && c.phase === "working");
  const [, setTaskTick] = useState(0);
  useEffect(() => {
    if (!taskWorking) return;
    const id = setInterval(() => setTaskTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [taskWorking]);

  // speak completions — separate from the feed diff: a run can first appear
  // as "running" (id lands in seenRunsRef), so completion is tracked by id
  // here, only once it reaches a terminal status. First snapshot seeds
  // silently — no replaying history out loud on page load.
  const runsPrimedRef = useRef(false);
  useEffect(() => {
    if (!state) return;
    const done = state.runs.filter(
      (r) => (r.status === "ok" || r.status === "error") && !spokenRunsRef.current.has(r.id)
    );
    if (!runsPrimedRef.current) {
      runsPrimedRef.current = true;
      done.forEach((r) => spokenRunsRef.current.add(r.id));
      return;
    }
    done.forEach((r) => {
      spokenRunsRef.current.add(r.id);
      voice.speak(runAnnouncement(r.skill, r.status, r.summary ?? "", r.label));
      // finished run left a document → offer it via the reveal chip. When
      // the run's REAL output lives at a URL (Gmail draft, video), the
      // callout sends you THERE — the md stays in the Documents trail.
      if (r.status === "ok" && r.deliverable_path) {
        addCallout(
          r.link ?? r.deliverable_path,
          r.label ?? r.skill.replace(/-/g, " "),
          r.link ? "link" : "doc"
        );
      }
    });
  }, [state]);

  const onQueued = useCallback(
    (skill: string, ok: boolean) => {
      pushLine(ok ? "sys" : "err", ok ? `intent queued → ${skill}` : `queue write FAILED → ${skill}`);
    },
    [pushLine]
  );

  // auto mode: fetch error → error; PTT held or wake window open → listening;
  // voice playing → speaking (orb mouths it, even mid-work); runner busy →
  // working; else idle
  const autoMode: CoreMode = error
    ? "error"
    : ptt || wakeListening
      ? "listening"
      : voiceSpeaking
        ? "speaking"
        : state?.runner?.busy
          ? "working"
          : "idle";
  const mode = modeOverride ?? autoMode;

  return (
    <main className="stage">
      <GraphCore mode={mode} bgMode={bgMode} getLevel={voice.getLevel} />

      <div className="scrim scrim-l" aria-hidden="true" />
      <div className="scrim scrim-r" aria-hidden="true" />
      <div className="scrim scrim-b" aria-hidden="true" />
      <div className="scrim scrim-t" aria-hidden="true" />

      <div className="hud">
        <TopBar state={state} online={!error} mode={mode} />

        <div className="hud-left">
          {state && <Vitals state={state} hot={hotPanels.includes("vitals")} />}
          {state && (
            <Priorities
              state={state}
              hot={hotPanels.includes("priorities")}
              onToggle={toggleDirective}
            />
          )}
          {state && (
            <Documents state={state} hot={hotPanels.includes("documents")} onOpen={openReport} />
          )}
        </div>

        <div className="hud-center">
          {callouts.map((c) => {
            const isTask = c.kind === "task";
            const elapsed =
              isTask && c.startedAt ? Math.max(0, Math.floor((Date.now() - c.startedAt) / 1000)) : 0;
            // ETA is silent: bar fills toward the median (capped at 95 — never
            // claim done before the run lands), and once elapsed passes it the
            // bar degrades to the indeterminate sweep instead of parking at a
            // number it promised. Text never states the estimate.
            const overdue = c.etaS != null && elapsed >= c.etaS;
            const pct = isTask && c.etaS && !overdue ? Math.min(95, (elapsed / c.etaS) * 100) : null;
            return (
              <div key={c.id} className={`callout slot-${c.slot}`}>
                <i className="br br-a" aria-hidden="true" />
                <i className="br br-b" aria-hidden="true" />
                <div
                  className={`callout-box${isTask ? ` task ${c.phase ?? ""}` : ""}`}
                  {...(!isTask && {
                    role: "button",
                    tabIndex: 0,
                    onClick: () =>
                      c.kind === "link"
                        ? window.open(c.target, "_blank", "noopener")
                        : void openReport(c.target),
                  })}
                >
                  <span className="callout-dot" />
                  <span className="callout-text">
                    <span className="callout-label">{c.label}</span>
                    {isTask ? (
                      <span className="task-meta">
                        <span className={`task-bar${pct === null && c.phase === "working" ? " indet" : ""}`}>
                          <i
                            style={
                              c.phase !== "working"
                                ? { width: "100%" }
                                : pct !== null
                                  ? { width: `${pct}%` }
                                  : undefined
                            }
                          />
                        </span>
                        <span className="task-time">
                          {c.phase === "working"
                            ? `${fmtClock(elapsed)} · working`
                            : c.phase === "failed"
                              ? `failed · ${fmtClock(elapsed)}`
                              : `complete · ${fmtClock(elapsed)}`}
                        </span>
                      </span>
                    ) : (
                      <span className="callout-file">
                        {c.kind === "link"
                          ? c.target.replace(/^https?:\/\/(www\.)?/, "").split("/")[0] + " ↗"
                          : c.target.split("/").pop()}
                      </span>
                    )}
                  </span>
                  <button
                    className="callout-x"
                    aria-label="dismiss"
                    onClick={(e) => {
                      e.stopPropagation();
                      setCallouts((cur) => cur.filter((x) => x.id !== c.id));
                    }}
                  >
                    ×
                  </button>
                </div>
              </div>
            );
          })}
          {callouts.length > 1 && (
            <button className="callout-clear" onClick={() => setCallouts([])}>
              clear all ×{callouts.length}
            </button>
          )}
        </div>

        <div className="hud-right">
          <CommandDeck
            state={state}
            hot={hotPanels.includes("pipeline") || hotPanels.includes("diagnostics")}
            onQueued={onQueued}
          />
          {state && <Schedule state={state} hot={hotPanels.includes("schedule")} />}
          <AudioIO mode={mode} />
          {state && <Wire state={state} onOpen={openReport} />}
        </div>

        <div className="hud-bottom">
          {state && <Objective state={state} hot={hotPanels.includes("objective")} />}
        </div>

        <button className="transcript-btn" onClick={() => void openTranscript()}>
          Transcript
        </button>
      </div>

      {report && (
        <ReportOverlay
          report={report}
          onClose={() => setReport(null)}
          action={
            report.path === "system/voice/transcript"
              ? {
                  label: "reset transcript ×",
                  onClick: () => {
                    void fetch("/api/transcript", { method: "DELETE" }).then(() => {
                      setReport(null);
                      pushLine("sys", "voice transcript cleared");
                    });
                  },
                }
              : undefined
          }
        />
      )}

      <div className="grain" aria-hidden="true" />
    </main>
  );
}
