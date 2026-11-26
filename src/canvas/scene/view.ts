// The camera: where it is, moving it (zoom, fit, centre, reveal, glide) and what has to be
// redrawn when it moves.
import { type Camera, fitBounds, zoomAt } from "../camera";
import { boundsOf, center, type Point } from "../../../shared/geometry";
import { drawStaticEdges } from "./edges";
import { applyLabelVisibility, cull, requestRender } from "./frame";
import { frameOf, viewMid } from "./lookup";
import { drawMinimap, drawMiniView } from "./minimap";
import { drawOverlay } from "./overlay";
import { drawPeers } from "./peers";
import type { SceneState } from "./state";
import { tellWatchers } from "./watch";

export function fit(state: SceneState): void {
  const bounds = boundsOf(state.order.map((v) => v.node));
  if (!bounds) return;
  const c = fitBounds(bounds, state.size.w - state.insetLeft, state.size.h, 72);
  setCamera(state, { ...c, x: c.x + state.insetLeft });
}

/** The drawer covers this much of the canvas's left edge. The canvas itself never resizes. */
export function setInsetLeft(state: SceneState, px: number): void {
  if (px === state.insetLeft) return;
  state.insetLeft = px;
  drawMinimap(state);
  requestRender(state);
}

export function zoomBy(state: SceneState, factor: number): void {
  setCamera(state, zoomAt(state.camera, viewMid(state), factor));
}

export function setView(state: SceneState, c: Camera): void {
  setCamera(state, c);
}

/**
 * Pan (not zoom) just enough that these boxes are in view and clear of the panels
 * (insets in screen px), if they aren't already.
 */
export function reveal(
  state: SceneState,
  ids: string[],
  insets = { left: 0, right: 0, top: 0, bottom: 0 },
): void {
  const b = boundsOf(ids.flatMap((id) => state.views.get(id)?.node ?? []));
  if (!b) return;
  const s = state.camera.scale;
  const free = {
    x0: insets.left,
    y0: insets.top,
    x1: state.size.w - insets.right,
    y1: state.size.h - insets.bottom,
  };
  const x0 = state.camera.x + b.x * s;
  const y0 = state.camera.y + b.y * s;
  const x1 = x0 + b.w * s;
  const y1 = y0 + b.h * s;
  if (x0 >= free.x0 && x1 <= free.x1 && y0 >= free.y0 && y1 <= free.y1) return;
  const cx = (free.x0 + free.x1) / 2 - (b.x + b.w / 2) * s;
  const cy = (free.y0 + free.y1) / 2 - (b.y + b.h / 2) * s;
  setCamera(state, { ...state.camera, x: cx, y: cy });
}

/** Pan (not zoom) so a box is in the middle of the view; `smooth` glides there. */
export function centerOn(state: SceneState, id: string, smooth = false): void {
  const n = state.views.get(id)?.node ?? frameOf(state, id);
  if (!n) return;
  const c = center(n);
  const mid = viewMid(state);
  const to = {
    ...state.camera,
    x: mid.x - c.x * state.camera.scale,
    y: mid.y - c.y * state.camera.scale,
  };
  if (smooth) glide(state, to);
  else setCamera(state, to);
}

/** Glide to boxes so they all fit (a guided tour's step), zooming no closer than 100%. */
export function frameBoxes(state: SceneState, ids: string[]): void {
  const bounds = boundsOf(
    ids.map((id) => state.views.get(id)?.node).filter((n): n is NonNullable<typeof n> => !!n),
  );
  if (!bounds) return;
  const c = fitBounds(bounds, state.size.w - state.insetLeft, state.size.h, 140);
  const scale = Math.min(c.scale, 1);
  const mid = viewMid(state);
  const bc = center(bounds);
  glide(state, { ...state.camera, scale, x: mid.x - bc.x * scale, y: mid.y - bc.y * scale });
}

/** Ease the camera to `to` over ~half a second (a jump when the person prefers less motion). */
export function glide(state: SceneState, to: Camera, ms = 550): void {
  cancelAnimationFrame(state.glideFrame);
  if (typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches)
    return setCamera(state, to);
  const from = { ...state.camera };
  const t0 = performance.now();
  const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
  const tick = (now: number) => {
    const t = Math.min(1, (now - t0) / ms);
    const k = ease(t);
    setCamera(state, {
      x: from.x + (to.x - from.x) * k,
      y: from.y + (to.y - from.y) * k,
      scale: from.scale + (to.scale - from.scale) * k,
    });
    if (t < 1) state.glideFrame = requestAnimationFrame(tick);
  };
  state.glideFrame = requestAnimationFrame(tick);
}

/** Bring a diagram point to the middle of the view. */
export function centerAt(state: SceneState, p: Point, smooth = false): void {
  const mid = viewMid(state);
  const to = {
    ...state.camera,
    x: mid.x - p.x * state.camera.scale,
    y: mid.y - p.y * state.camera.scale,
  };
  if (smooth) glide(state, to);
  else setCamera(state, to);
}

/** Zoom about the middle of the view to an exact scale. */
export function zoomTo(state: SceneState, scale: number): void {
  zoomBy(state, scale / state.camera.scale);
}

/** Pan so the selection (or, with nothing selected, the whole diagram) is in the middle, keeping the zoom. */
export function centerSelection(state: SceneState): void {
  const ids = state.selected.size ? [...state.selected] : state.order.map((v) => v.node.id);
  const b = boundsOf(ids.flatMap((id) => state.views.get(id)?.node ?? []));
  if (!b) return;
  const s = state.camera.scale;
  const mid = viewMid(state);
  setCamera(state, {
    ...state.camera,
    x: mid.x - (b.x + b.w / 2) * s,
    y: mid.y - (b.y + b.h / 2) * s,
  });
}

export function setCamera(state: SceneState, c: Camera): void {
  state.camera = c;
  state.world.position.set(c.x, c.y);
  state.world.scale.set(c.scale);
  if (state.grid) {
    state.grid.tilePosition.set(c.x, c.y);
    state.grid.tileScale.set(c.scale);
    // Fade the dots out before they crowd into a grey wash.
    state.grid.alpha = Math.min(1, Math.max(0, (c.scale - 0.2) / 0.3));
  }
  // Below 66% zoom edges would drop under a pixel; redraw them thicker per zoom step.
  const bucket = c.scale >= 0.66 ? 0 : Math.round(Math.log2(1 / c.scale) * 4);
  if (bucket !== state.edgeWidthBucket && state.edges.size) {
    state.edgeWidthBucket = bucket;
    // Only the width changes with the zoom: the routes and labels are where they were.
    drawStaticEdges(state, true);
  }
  cull(state);
  applyLabelVisibility(state, false);
  drawMiniView(state);
  drawOverlay(state);
  drawPeers(state);
  requestRender(state);
  state.cb.onZoom?.(c.scale);
  tellWatchers(state);
}

/** Centre the view on the minimap point under the cursor. */
export function panToMinimap(state: SceneState, p: Point): void {
  const m = state.mini;
  if (!m) return;
  const wx = (p.x - m.ox) / m.s;
  const wy = (p.y - m.oy) / m.s;
  const mid = viewMid(state);
  setCamera(state, {
    ...state.camera,
    x: mid.x - wx * state.camera.scale,
    y: mid.y - wy * state.camera.scale,
  });
}
