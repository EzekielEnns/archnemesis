// The performance meter (⌘K → Show performance meter) and what a bug report carries about the
// page: the canvas's frame rate and frame time, React's re-renders, main-thread stalls, memory,
// and the page's recent errors. A small react-scan of our own, with no dependency.
import type { ProfilerOnRenderCallback } from "react";
import { useEffect, useState } from "react";
import type { SceneStats } from "../canvas/Scene";

// --- what's measured, kept at module level so a report can read it without the meter on -------

let scene: SceneStats | null = null;
/** The canvas's numbers, as it reports them (every 250 ms while drawing). */
export function notePerf(s: SceneStats): void {
  scene = s;
}

const commits: { at: number; ms: number }[] = [];
/** React's Profiler callback: one entry per commit of the app. */
export const countCommit: ProfilerOnRenderCallback = (_id, _phase, actual) => {
  const at = performance.now();
  commits.push({ at, ms: actual });
  while (commits.length && commits[0]!.at < at - 5000) commits.shift();
};

const stalls: { at: number; ms: number }[] = [];
const errors: { at: string; text: string }[] = [];
let installed = false;

/** Start listening for main-thread stalls and page errors (once). */
export function installPerf(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) stalls.push({ at: e.startTime, ms: e.duration });
      const now = performance.now();
      while (stalls.length && stalls[0]!.at < now - 30_000) stalls.shift();
    }).observe({ type: "longtask", buffered: true });
  } catch {
    /* not every browser reports long tasks */
  }
  const keep = (text: string) => {
    errors.push({ at: new Date().toISOString(), text: text.slice(0, 300) });
    if (errors.length > 15) errors.shift();
  };
  window.addEventListener("error", (e) =>
    keep(`${e.message} (${e.filename?.split("/").pop() ?? ""}:${e.lineno ?? ""})`),
  );
  window.addEventListener("unhandledrejection", (e) =>
    keep(`unhandled: ${String((e.reason as Error)?.message ?? e.reason)}`),
  );
  const was = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    keep(
      args
        .map((a) =>
          a instanceof Error ? a.message : typeof a === "string" ? a : JSON.stringify(a),
        )
        .join(" "),
    );
    was(...args);
  };
}

export interface PerfSnapshot {
  fps: number | null;
  frameMs: number | null;
  boxes: number | null;
  visible: number | null;
  lines: number | null;
  /** React commits in the last second, and the slowest of the last 5 s. */
  renders: number;
  slowestRenderMs: number;
  /** Main-thread stalls over 50 ms in the last 10 s, and the longest. */
  stalls: number;
  longestStallMs: number;
  heapMb: number | null;
}

export function perfSnapshot(): PerfSnapshot {
  const now = performance.now();
  const recent = stalls.filter((x) => x.at >= now - 10_000);
  const heap = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
    ?.usedJSHeapSize;
  return {
    fps: scene?.fps ?? null,
    frameMs: scene ? Math.round(scene.frameMs * 10) / 10 : null,
    boxes: scene?.nodes ?? null,
    visible: scene?.visible ?? null,
    lines: scene?.edges ?? null,
    renders: commits.filter((c) => c.at >= now - 1000).length,
    slowestRenderMs: Math.round(Math.max(0, ...commits.map((c) => c.ms)) * 10) / 10,
    stalls: recent.length,
    longestStallMs: Math.round(Math.max(0, ...recent.map((x) => x.ms))),
    heapMb: heap ? Math.round(heap / 1e6) : null,
  };
}

export function recentErrors(): { at: string; text: string }[] {
  return [...errors];
}

// --- the meter ------------------------------------------------------------------------------

const KEY = "archnm.perfMeter";
export function perfMeterOn(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}
export function setPerfMeterOn(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY, "1");
    else localStorage.removeItem(KEY);
  } catch {
    /* a private window: on for this page only */
  }
}

/** Colour a number by how it feels: fine, noticeable, bad. */
const tone = (v: number, warn: number, bad: number, higherIsBetter = false) =>
  higherIsBetter
    ? v <= bad
      ? "bad"
      : v <= warn
        ? "warn"
        : "ok"
    : v >= bad
      ? "bad"
      : v >= warn
        ? "warn"
        : "ok";

export function PerfMeter({ onClose }: { onClose: () => void }) {
  const [s, setS] = useState(perfSnapshot);
  useEffect(() => {
    const t = setInterval(() => setS(perfSnapshot()), 500);
    return () => clearInterval(t);
  }, []);
  // The canvas only draws when something changes, so few frames with cheap ones is just quiet,
  // not slow: the frame time and stalls say when it's struggling.
  const idle = s.fps !== null && s.fps < 2;
  const quiet = s.fps !== null && s.fps < 30 && (s.frameMs ?? 0) < 16;
  return (
    <div className="perf-meter" role="status" aria-label="Performance">
      {/* Two rows, as tall as the zoom controls beside it. */}
      <span
        className={idle || quiet ? "muted" : tone(s.fps ?? 60, 45, 25, true)}
        title="The canvas draws only when something changes"
      >
        {idle ? "idle" : `${s.fps ?? "–"} fps`}
      </span>
      <span className={tone(s.frameMs ?? 0, 8, 16)}>{s.frameMs ?? "–"} ms/frame</span>
      <span className={tone(s.renders, 10, 30)}>{s.renders} renders/s</span>
      <span
        className={tone(s.slowestRenderMs, 16, 50)}
        title="Slowest React render in the last 5 s"
      >
        ≤{s.slowestRenderMs} ms
      </span>
      <button className="perf-close" onClick={onClose} title="Hide (⌘K → Hide performance meter)">
        ×
      </button>
      <span
        className={tone(s.stalls, 1, 4)}
        title="Main-thread stalls over 50 ms in the last 10 s, and the longest"
      >
        {s.stalls} stalls · {s.longestStallMs} ms
      </span>
      <span className="muted">
        {s.visible ?? "–"}/{s.boxes ?? "–"} boxes
      </span>
      <span className="muted">{s.lines ?? "–"} lines</span>
      <span className="muted">{s.heapMb !== null ? `${s.heapMb} MB` : ""}</span>
      <span />
    </div>
  );
}
