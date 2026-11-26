// Drawing on demand: ask for a frame, draw it, report stats; hide what's off screen and drop
// labels that would be too small to read.
import { visibleWorld } from "../camera";
import { intersects, type Rect } from "../../../shared/geometry";
import { drawFlowDots } from "./flow";
import type { SceneState } from "./state";
import { EDGE_LABEL_MIN_SCALE, SUBTITLE_MIN_SCALE, TITLE_MIN_SCALE } from "./theme";
import type { SceneStats } from "./types";

export function cull(state: SceneState): void {
  const seen = visibleWorld(state.camera, state.size.w, state.size.h);
  const margin = 40 / state.camera.scale;
  const area: Rect = {
    x: seen.x - margin,
    y: seen.y - margin,
    w: seen.w + margin * 2,
    h: seen.h + margin * 2,
  };
  let visible = 0;
  for (const v of state.order) {
    const on = intersects(v.node, area);
    v.root.visible = on;
    if (on) visible++;
  }
  state.visibleCount = visible;
}

export function applyLabelVisibility(state: SceneState, force: boolean): void {
  const s = state.camera.scale;
  const next = {
    title: s >= TITLE_MIN_SCALE,
    subtitle: s >= SUBTITLE_MIN_SCALE,
    edge: s >= EDGE_LABEL_MIN_SCALE,
  };
  if (
    !force &&
    next.title === state.labels.title &&
    next.subtitle === state.labels.subtitle &&
    next.edge === state.labels.edge
  )
    return;
  state.labels = next;
  for (const v of state.order) {
    v.title.visible = next.title;
    v.subtitle.visible = next.subtitle;
  }
  state.edgeLabels.visible = next.edge;
}

export function requestRender(state: SceneState): void {
  if (state.frameQueued || !state.ready || state.destroyed) return;
  state.frameQueued = true;
  requestAnimationFrame(state.frame);
}

export function renderFrame(state: SceneState, now: number): void {
  state.frameQueued = false;
  if (state.destroyed) return;
  if (drawFlowDots(state, now)) requestRender(state);
  const t0 = performance.now();
  state.app.render();
  state.lastFrameMs = performance.now() - t0;
  state.frames.push(now);
  while (state.frames.length && (state.frames[0] as number) < now - 1000) state.frames.shift();
  emitStats(state, now);
}

function emitStats(state: SceneState, now: number): void {
  if (!state.cb.onStats) return;
  if (now - state.lastStatsAt >= 250) {
    state.lastStatsAt = now;
    state.cb.onStats(stats(state, now));
  }
  // One more report after things go quiet, so the meter settles instead of freezing.
  if (state.statsTimer) clearTimeout(state.statsTimer);
  state.statsTimer = setTimeout(() => state.cb.onStats?.(stats(state, performance.now())), 1100);
}

function stats(state: SceneState, now: number): SceneStats {
  return {
    nodes: state.order.length,
    edges: state.edges.size,
    visible: state.visibleCount,
    selected: state.selected.size,
    scale: state.camera.scale,
    fps: state.frames.filter((t) => t >= now - 1000).length,
    frameMs: state.lastFrameMs,
  };
}
