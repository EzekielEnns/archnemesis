// Hit testing: what is under a point. One test per pointer event against plain rects and
// curves (boxes, arrows, connection handles, the resize corner, frame title strips).
import { contains, type Point, routeDistance, routePoint } from "../../../shared/geometry";
import { shapeOf } from "./lookup";
import type { SceneState } from "./state";
import { ARROW_HANDLE_HIT, EDGE_BAND_IN, EDGE_BAND_OUT, EDGE_HIT, RESIZE_HIT } from "./theme";
import type { EdgeView, NodeView } from "./types";

/** The frame or box (not one being dragged) whose area holds the point: innermost first. */
export function dropTargetAt(
  state: Pick<SceneState, "order" | "groupList">,
  p: Point,
  dragged: Set<string>,
): string | null {
  const box = state.order.find(
    (v) =>
      !dragged.has(v.node.id) &&
      !["actor", "table", "library"].includes(v.node.kind) &&
      contains(v.node, p),
  );
  if (box) return box.node.id;
  // A box opened here holds what's in its panel (the smallest panel: the innermost).
  const frames = state.groupList
    .filter(
      (g) =>
        (g.container || g.inset) &&
        !dragged.has(g.id) &&
        p.x >= g.x &&
        p.x <= g.x + g.w &&
        p.y >= g.y &&
        p.y <= g.y + g.h,
    )
    .sort((a, b) => (b.depth ?? 0) - (a.depth ?? 0) || a.w * a.h - b.w * b.h);
  return frames[0]?.id ?? null;
}

/** The part of the selected arrow under the pointer: an end or a bend. */
export function hitArrowPart(
  state: Pick<SceneState, "selectedEdge" | "edges" | "camera" | "shaping"> &
    Partial<Pick<SceneState, "splitMove">>,
  p: Point,
): { part: "from" | "to" | "bend" | "split"; index: number } | null {
  const ev = state.selectedEdge ? state.edges.get(state.selectedEdge) : undefined;
  if (!ev) return null;
  const r = ARROW_HANDLE_HIT / state.camera.scale;
  const shape = shapeOf(state, ev.edge);
  // index 0: its split point; 1: its join point.
  for (const [i, sp] of [ev.route.dots?.split, ev.route.dots?.join].entries())
    if (sp && Math.hypot(p.x - sp.x, p.y - sp.y) <= r * 1.3) return { part: "split", index: i };
  const bends = shape?.bends ?? [];
  for (let i = 0; i < bends.length; i++)
    if (Math.hypot(p.x - bends[i]!.x, p.y - bends[i]!.y) <= r) return { part: "bend", index: i };
  if (Math.hypot(p.x - ev.route.p1.x, p.y - ev.route.p1.y) <= r) return { part: "to", index: -1 };
  if (Math.hypot(p.x - ev.route.p0.x, p.y - ev.route.p0.y) <= r) return { part: "from", index: -1 };
  return null;
}

/** The box whose "⇄ N off diagram" is under this point, if any. */
export function hitOffDiagram(state: Pick<SceneState, "order">, p: Point): string | null {
  for (const v of state.order) {
    const r = v.offDiagram;
    if (r && contains({ x: v.node.x + r.x, y: v.node.y + r.y, w: r.w, h: r.h }, p))
      return v.node.id;
  }
  return null;
}

/** The title strip of the diagram's own frame (the object it looks inside). */
export function hitScope(state: Pick<SceneState, "groupList" | "camera">, p: Point): boolean {
  const f = state.groupList.find((g) => !g.boundary && !g.lane && !g.container);
  const strip = Math.max(36, 18 / state.camera.scale);
  return !!f && p.x >= f.x && p.x <= f.x + Math.min(f.w, 360) && p.y >= f.y && p.y <= f.y + strip;
}

/** A file or package frame whose title strip is under the pointer: the innermost one. */
export function hitContainer(
  state: Pick<SceneState, "groupList" | "camera">,
  p: Point,
): string | null {
  const strip = Math.max(24, 14 / state.camera.scale);
  const frames = state.groupList
    .filter((g) => g.container)
    .sort((a, b) => (b.depth ?? 0) - (a.depth ?? 0));
  return (
    frames.find((g) => p.x >= g.x && p.x <= g.x + g.w && p.y >= g.y && p.y <= g.y + strip)?.id ??
    null
  );
}

/** A boundary whose frame's title strip is under the pointer: the innermost one. */
export function hitBoundary(
  state: Pick<SceneState, "groupList" | "camera">,
  p: Point,
): string | null {
  const frames = state.groupList
    .filter((g) => g.boundary)
    .sort((a, b) => (b.depth ?? 0) - (a.depth ?? 0));
  const strip = Math.max(30, 18 / state.camera.scale);
  const f = frames.find((g) => p.x >= g.x && p.x <= g.x + g.w && p.y >= g.y && p.y <= g.y + strip);
  return f ? f.id.slice("boundary:".length) : null;
}

export function hitNode(state: Pick<SceneState, "order">, p: Point): NodeView | null {
  for (let i = state.order.length - 1; i >= 0; i--) {
    const v = state.order[i] as NodeView;
    if (v.root.visible && contains(v.node, p)) return v;
  }
  return null;
}

export function hitEdge(
  state: Pick<SceneState, "edgeLabels" | "edges" | "camera">,
  p: Point,
): EdgeView | null {
  if (state.edgeLabels.visible) {
    for (const ev of state.edges.values()) {
      if (!ev.label) continue;
      const { x, y } = ev.label.position;
      if (Math.abs(p.x - x) <= ev.labelSize.w / 2 && Math.abs(p.y - y) <= ev.labelSize.h / 2)
        return ev;
    }
  }
  const limit = EDGE_HIT / state.camera.scale;
  let best: EdgeView | null = null;
  let bestD = limit;
  for (const ev of state.edges.values()) {
    // A cheap box test first: most edges are nowhere near the pointer.
    if (ev.boxOf !== ev.route) {
      let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity;
      for (let i = 0; i <= 12; i++) {
        const q = routePoint(ev.route, i / 12);
        x0 = Math.min(x0, q.x);
        y0 = Math.min(y0, q.y);
        x1 = Math.max(x1, q.x);
        y1 = Math.max(y1, q.y);
      }
      ev.box = { x0, y0, x1, y1 };
      ev.boxOf = ev.route;
    }
    const b = ev.box!;
    // Curves bulge a little past their samples: pad generously.
    const pad = bestD + 24;
    if (p.x < b.x0 - pad || p.x > b.x1 + pad || p.y < b.y0 - pad || p.y > b.y1 + pad) continue;
    const d = routeDistance(ev.route, p);
    if (d < bestD) {
      bestD = d;
      best = ev;
    }
  }
  return best;
}

/**
 * A connection can be dragged from anywhere along a box's edge: a band just inside and
 * just outside its border. The middle of the box moves it.
 */
export function hitHandle(
  state: Pick<SceneState, "hovered" | "tool" | "views" | "camera">,
  p: Point,
): string | null {
  if (!state.hovered || state.tool === "view") return null;
  const n = state.views.get(state.hovered)?.node;
  if (!n) return null;
  const out = EDGE_BAND_OUT / state.camera.scale;
  const inn = Math.min(EDGE_BAND_IN / state.camera.scale, n.h / 4);
  const outer =
    p.x >= n.x - out && p.x <= n.x + n.w + out && p.y >= n.y - out && p.y <= n.y + n.h + out;
  const inner =
    p.x > n.x + inn && p.x < n.x + n.w - inn && p.y > n.y + inn && p.y < n.y + n.h - inn;
  return outer && !inner ? n.id : null;
}

/** The resize corner of the one selected box, if the point is on it. */
export function hitResize(
  state: Pick<SceneState, "selected" | "tool" | "views" | "camera">,
  p: Point,
): string | null {
  if (state.selected.size !== 1 || state.tool === "view") return null;
  const n = state.views.get([...state.selected][0]!)?.node;
  if (!n) return null;
  const r = RESIZE_HIT / state.camera.scale;
  return Math.abs(p.x - (n.x + n.w)) <= r && Math.abs(p.y - (n.y + n.h)) <= r ? n.id : null;
}
