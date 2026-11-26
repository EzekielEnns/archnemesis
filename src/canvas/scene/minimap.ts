// The minimap in the bottom-left corner: its layout, its boxes, the view rectangle, and
// whether a point is on it.
import { visibleWorld } from "../camera";
import { boundsOf, type Point } from "../../../shared/geometry";
import type { CanvasNode } from "../types";
import { requestRender } from "./frame";
import type { SceneState } from "./state";
import { MINI_BOTTOM, MINI_H, MINI_MARGIN, MINI_W, THEME } from "./theme";

export function toggleMinimap(state: SceneState, on = !state.miniOn): void {
  state.miniOn = on;
  drawMinimap(state);
  requestRender(state);
}

/** Lay the minimap out for the current boxes and draw all of it. */
export function drawMinimap(state: SceneState): void {
  const show = state.miniOn && state.order.length > 0;
  state.minimap.visible = show;
  state.mini = null;
  if (!show) return;
  const b = boundsOf(state.order.map((v) => v.node))!;
  const pad = 8;
  const s = Math.min((MINI_W - pad * 2) / Math.max(1, b.w), (MINI_H - pad * 2) / Math.max(1, b.h));
  const x = state.insetLeft + MINI_MARGIN;
  const y = state.size.h - MINI_BOTTOM - MINI_H;
  state.mini = {
    s,
    x,
    y,
    ox: x + pad + (MINI_W - pad * 2 - b.w * s) / 2 - b.x * s,
    oy: y + pad + (MINI_H - pad * 2 - b.h * s) / 2 - b.y * s,
  };
  state.miniBg
    .clear()
    .roundRect(x, y, MINI_W, MINI_H, 8)
    .fill({ color: THEME.miniBg, alpha: 0.92 })
    .stroke({ color: THEME.cardStroke, width: 1 });
  drawMiniNodes(state);
  drawMiniView(state);
}

export function drawMiniNodes(state: SceneState): void {
  const m = state.mini;
  const g = state.miniNodes;
  g.clear();
  if (!m) return;
  const lit: CanvasNode[] = [];
  for (const v of state.order) {
    const n = v.node;
    if (state.selected.has(n.id) || state.focus?.nodes.has(n.id)) lit.push(n);
    else
      g.rect(
        m.ox + n.x * m.s,
        m.oy + n.y * m.s,
        Math.max(1.5, n.w * m.s),
        Math.max(1.5, n.h * m.s),
      );
  }
  g.fill({ color: THEME.miniNode, alpha: state.focus ? 0.5 : 1 });
  for (const n of lit)
    g.rect(m.ox + n.x * m.s, m.oy + n.y * m.s, Math.max(2, n.w * m.s), Math.max(2, n.h * m.s));
  if (lit.length) g.fill(THEME.select);
}

export function drawMiniView(state: SceneState): void {
  const m = state.mini;
  const g = state.miniView;
  g.clear();
  if (!m) return;
  const v = visibleWorld(state.camera, state.size.w, state.size.h);
  const x0 = Math.max(m.x, m.ox + v.x * m.s);
  const y0 = Math.max(m.y, m.oy + v.y * m.s);
  const x1 = Math.min(m.x + MINI_W, m.ox + (v.x + v.w) * m.s);
  const y1 = Math.min(m.y + MINI_H, m.oy + (v.y + v.h) * m.s);
  if (x1 > x0 && y1 > y0)
    g.rect(x0, y0, x1 - x0, y1 - y0).stroke({ color: THEME.miniView, width: 1 });
}

export function inMinimap(state: SceneState, p: Point): boolean {
  const m = state.mini;
  return (
    !!m &&
    state.minimap.visible &&
    p.x >= m.x &&
    p.x <= m.x + MINI_W &&
    p.y >= m.y &&
    p.y <= m.y + MINI_H
  );
}
