// What is drawn over the boxes at the same size on screen at any zoom: selection outlines,
// handles, guides, the connection being dragged, hover; and the marquee.
import type { Graphics } from "pixi.js";
import {
  arrowHead,
  center,
  type Point,
  rectFromCorners,
  type Route,
  route,
  SIDE_OF_WORD,
  traceRoute,
  nearestT,
  routePoint,
} from "../../../shared/geometry";
import { drawSteps } from "./flow";
import { endRect, splitFamily, shapeOf } from "./lookup";
import { handles } from "./measure";
import type { SceneState } from "./state";
import { HANDLE_R, RADIUS, THEME } from "./theme";
import type { Drag, EdgeView } from "./types";
import type { CanvasNode } from "../types";

/** The picked boundary's and the picked diagram frame's outlines. */
function drawPickedFrames(state: SceneState, g: Graphics, px: number): void {
  const frame = state.selectedBoundary
    ? state.groupList.find((x) => x.id === `boundary:${state.selectedBoundary}`)
    : undefined;
  if (frame)
    g.rect(frame.x, frame.y, frame.w, frame.h).stroke({ color: THEME.select, width: 2 * px });
  const scope = state.selectedScope
    ? state.groupList.find((x) => !x.boundary && !x.lane && !x.container)
    : undefined;
  if (scope)
    g.roundRect(scope.x, scope.y, scope.w, scope.h, 14).stroke({
      color: THEME.select,
      width: 2 * px,
    });
}

/** Alignment guides shown while a drag snaps to other boxes. */
function drawGuides(state: SceneState, g: Graphics, px: number): void {
  for (const gd of state.guides) {
    if (gd.axis === "x") g.moveTo(gd.at, gd.from - 12 * px).lineTo(gd.at, gd.to + 12 * px);
    else g.moveTo(gd.from - 12 * px, gd.at).lineTo(gd.to + 12 * px, gd.at);
  }
  if (state.guides.length) g.stroke({ color: THEME.guide, width: 1 * px, alpha: 0.9 });
}

/** A route traced on the highlight layer, ready to be stroked. */
function curve(eh: Graphics, r: Route): Graphics {
  traceRoute(eh, r);
  return eh;
}

/** While an arrow's end is dragged: the side of its box it will be pinned to, lit. */
function drawPinnedSide(state: SceneState, g: Graphics, ev: EdgeView, px: number): void {
  const d = state.drag?.kind === "arrow" ? state.drag : null;
  if (d && (d.part === "from" || d.part === "to") && d.moved) {
    const box = endRect(state, d.part === "from" ? ev.edge.from : ev.edge.to);
    const side = shapeOf(state, ev.edge)?.[d.part === "from" ? "fromSide" : "toSide"];
    if (box && side) {
      const s = SIDE_OF_WORD[side];
      const [x0, y0, x1, y1] =
        s === "t"
          ? [box.x, box.y, box.x + box.w, box.y]
          : s === "b"
            ? [box.x, box.y + box.h, box.x + box.w, box.y + box.h]
            : s === "l"
              ? [box.x, box.y, box.x, box.y + box.h]
              : [box.x + box.w, box.y, box.x + box.w, box.y + box.h];
      g.moveTo(x0, y0)
        .lineTo(x1, y1)
        .stroke({ color: THEME.select, width: 4 * px, alpha: 0.6 });
    }
  }
}

/** The selected arrow, lit, with its handles: an end, a bend. */
function drawSelectedArrow(state: SceneState, g: Graphics, eh: Graphics, px: number): void {
  if (!state.selectedEdge) return;
  const ev = state.edges.get(state.selectedEdge);
  if (ev) {
    // The others through its split point are lit with it: one arrow that splits.
    for (const o of splitFamily(state, ev))
      curve(eh, o.route).stroke({ color: THEME.select, width: 3 * px });
    curve(eh, ev.route).stroke({ color: THEME.select, width: 3 * px });
    // Handles: drag an end to pin the side it uses, a bend to move it, the line to add one.
    drawPinnedSide(state, g, ev, px);
    for (const p of [ev.route.p0, ev.route.p1]) g.circle(p.x, p.y, 4.5 * px);
    g.fill(0xffffff).stroke({ color: THEME.select, width: 1.5 * px });
    const shape = shapeOf(state, ev.edge);
    for (const p of shape?.bends ?? []) g.circle(p.x, p.y, 4 * px);
    // The split point: drag it and every arrow through it follows.
    for (const meet of [ev.route.dots?.split, ev.route.dots?.join])
      if (meet) g.circle(meet.x, meet.y, 6 * px);
    g.fill(THEME.select);
  }
}

/** A flow step between boxes with no arrow between them on this diagram: draw where it would go. */
function drawSpotPairs(state: SceneState, eh: Graphics, px: number): void {
  for (const [a, b] of state.spot?.pairs ?? []) {
    if (state.edges.has(`${a}>${b}`) || state.edges.has(`${b}>${a}`)) continue;
    const na = state.views.get(a)?.node;
    const nb = state.views.get(b)?.node;
    if (!na || !nb) continue;
    const r = route(na, nb);
    curve(eh, r).stroke({ color: THEME.select, width: 2.5 * px, alpha: 0.9 });
    const [h1, h2] = arrowHead(r.p1, r.c2, 10);
    eh.poly([r.p1.x, r.p1.y, h1.x, h1.y, h2.x, h2.y]).fill(THEME.select);
  }
}

/** Arrow highlights go on their own layer under the labels, so the labels stay readable. */
function drawEdgeHighlights(state: SceneState, g: Graphics, px: number): void {
  const eh = state.edgeHighlight;
  eh.clear();
  if (state.hoveredEdge && state.hoveredEdge !== state.selectedEdge && !state.drag) {
    const hov = state.edges.get(state.hoveredEdge);
    for (const o of hov ? [hov, ...splitFamily(state, hov)] : [])
      curve(eh, o.route).stroke({ color: THEME.select, width: 2.5 * px, alpha: 0.55 });
  }
  drawSelectedArrow(state, g, eh, px);
  drawSpotPairs(state, eh, px);
}

/** The selected boxes' outlines, and the corner to resize the one selected box by. */
function drawSelectedBoxes(state: SceneState, g: Graphics, px: number): void {
  for (const id of state.selected) {
    const n = state.views.get(id)?.node;
    if (n) g.roundRect(n.x - 3 * px, n.y - 3 * px, n.w + 6 * px, n.h + 6 * px, RADIUS + 3 * px);
  }
  if (state.selected.size) g.stroke({ color: THEME.select, width: 2 * px });
  const one =
    state.selected.size === 1 ? state.views.get([...state.selected][0]!)?.node : undefined;
  if (one && state.drag?.kind !== "nodes" && state.tool !== "view") {
    const k = 7 * px;
    g.rect(one.x + one.w - k / 2 + 3 * px, one.y + one.h - k / 2 + 3 * px, k, k).fill(THEME.select);
  }
}

/** Simple mode: the box or frame a drag would drop into. */
function drawDropTarget(state: SceneState, g: Graphics, px: number): void {
  if (state.dropInto && state.drag?.kind === "nodes") {
    const t =
      state.views.get(state.dropInto)?.node ?? state.groupList.find((x) => x.id === state.dropInto);
    if (t) {
      const m = 4 * px;
      g.roundRect(t.x - m, t.y - m, t.w + m * 2, t.h + m * 2, RADIUS + 3)
        .fill({ color: THEME.handle, alpha: 0.06 })
        .stroke({ color: THEME.handle, width: 2 * px, alpha: 0.9 });
    }
  }
}

/** The connection being dragged: its target lit, and the line to it (or to the pointer). */
function drawConnectPreview(
  state: SceneState,
  g: Graphics,
  d: Extract<Drag, { kind: "connect" }>,
  px: number,
): void {
  const from = state.views.get(d.from)?.node;
  const target = d.target ? state.views.get(d.target)?.node : undefined;
  if (target)
    g.roundRect(target.x, target.y, target.w, target.h, RADIUS).stroke({
      color: THEME.select,
      width: 2 * px,
    });
  const onto = d.onto ? state.edges.get(d.onto) : undefined;
  if (onto && from) {
    // Over an arrow: it lights, with the spot this would join it at.
    const p = routePoint(
      onto.route,
      Math.max(0.05, Math.min(0.95, nearestT(onto.route, d.current))),
    );
    traceRoute(g, onto.route);
    g.stroke({ color: THEME.select, width: 3 * px, alpha: 0.7 });
    const r = route(from, { x: p.x, y: p.y, w: 0, h: 0 });
    g.moveTo(r.p0.x, r.p0.y).bezierCurveTo(r.c1.x, r.c1.y, r.c2.x, r.c2.y, r.p1.x, r.p1.y);
    g.stroke({ color: THEME.select, width: 2 * px });
    g.circle(p.x, p.y, 5 * px).fill({ color: THEME.select });
    return;
  }
  if (d.like) {
    // A branch: from where on the arrow it was picked up.
    const end = target ? center(target) : d.current;
    g.moveTo(d.start.x, d.start.y).lineTo(end.x, end.y);
    g.stroke({ color: THEME.select, width: 2 * px });
    g.circle(d.start.x, d.start.y, 4 * px).fill({ color: THEME.select });
  } else if (from) {
    const end = target ? center(target) : d.current;
    const r = target ? route(from, target) : route(from, { x: end.x, y: end.y, w: 0, h: 0 });
    g.moveTo(r.p0.x, r.p0.y).bezierCurveTo(r.c1.x, r.c1.y, r.c2.x, r.c2.y, r.p1.x, r.p1.y);
    g.stroke({ color: THEME.select, width: 2 * px });
  }
}

/** On the edge of the hovered box: a dot with an arrow pointing out of that side. */
function drawKnob(g: Graphics, hover: CanvasNode, k: Point, px: number): void {
  // On the edge: this is where a drag starts a connection.
  g.roundRect(hover.x, hover.y, hover.w, hover.h, RADIUS).stroke({
    color: THEME.handle,
    width: 1.5 * px,
    alpha: 0.7,
  });
  // A dot with an arrow pointing out of that side: drag from here to draw a connection
  // (onto a box, or into space for a new one). Not a +: nothing is added by clicking it.
  const r = (HANDLE_R + 2) * px;
  const dx = k.x <= hover.x + 0.5 ? -1 : k.x >= hover.x + hover.w - 0.5 ? 1 : 0;
  const dy = dx ? 0 : k.y <= hover.y + 0.5 ? -1 : 1;
  g.circle(k.x, k.y, r).fill(THEME.handle);
  const a = r * 0.5;
  // The shaft, then the head, along (dx, dy).
  g.moveTo(k.x - dx * a, k.y - dy * a).lineTo(k.x + dx * a, k.y + dy * a);
  g.moveTo(k.x + dx * a - (dx * a + dy * a) * 0.6, k.y + dy * a - (dy * a - dx * a) * 0.6);
  g.lineTo(k.x + dx * a, k.y + dy * a);
  g.lineTo(k.x + dx * a - (dx * a - dy * a) * 0.6, k.y + dy * a - (dy * a + dx * a) * 0.6);
  g.stroke({ color: 0xffffff, width: 1.5 * px });
}

/** The hovered box: its outline, and what says its edge can be dragged from. */
function drawHover(state: SceneState, g: Graphics, hover: CanvasNode, px: number): void {
  if (!state.selected.has(hover.id)) {
    g.roundRect(hover.x, hover.y, hover.w, hover.h, RADIUS).stroke({
      color: THEME.hover,
      width: 1.5 * px,
    });
  }
  if (state.knob) {
    drawKnob(g, hover, state.knob, px);
  } else if (state.tool !== "view") {
    // Hints that the edge is grabbable.
    for (const h of handles(hover)) g.circle(h.x, h.y, (HANDLE_R - 1.5) * px);
    g.fill(THEME.bg).stroke({ color: THEME.handle, width: 1.2 * px, alpha: 0.8 });
  }
}

/** Outlines and handles stay the same size on screen at any zoom, so they're redrawn on zoom. */
export function drawOverlay(state: SceneState): void {
  const g = state.overlay;
  g.clear();
  const px = 1 / state.camera.scale;
  drawSteps(state, px);

  drawPickedFrames(state, g, px);
  drawGuides(state, g, px);
  drawEdgeHighlights(state, g, px);
  drawSelectedBoxes(state, g, px);
  drawDropTarget(state, g, px);

  const d = state.drag;
  const hover = state.hovered ? state.views.get(state.hovered)?.node : undefined;
  if (d?.kind === "connect") drawConnectPreview(state, g, d, px);
  else if (hover && !d) drawHover(state, g, hover, px);
}

export function drawMarquee(state: SceneState): void {
  const g = state.screenOverlay;
  g.clear();
  if (state.drag?.kind !== "marquee") return;
  const r = rectFromCorners(state.drag.start, state.drag.current);
  g.rect(r.x, r.y, r.w, r.h)
    .fill({ color: THEME.select, alpha: 0.08 })
    .stroke({ color: THEME.select, width: 1 });
}
