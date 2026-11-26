// Drawing arrows: each arrow's route, its label placed clear of boxes and other labels, the
// strokes and arrowheads grouped by look.
import { BitmapText, Container, Graphics } from "pixi.js";
import {
  arrowHead,
  bentRoute,
  clipToBoxes,
  curveAround,
  lineRoute,
  placeLabel,
  placeLabelOn,
  type Point,
  type Rect,
  type Route,
  route,
  routePoint,
  SIDE_OF_WORD,
  type Side,
  sides,
  traceDashed,
  traceRoute,
} from "../../../shared/geometry";
import type { CanvasEdge, CanvasNode } from "../types";
import { endRect, shapeOf } from "./lookup";
import { clip, rowOffset } from "./measure";
import { routed } from "./routing";
import type { SceneState } from "./state";
import { FONT, SHORT_LABEL, THEME } from "./theme";
import type { EdgeView } from "./types";
import { tellWatchersSoon } from "./watch";

/** Redraw an edge's label whole or shortened (to keep off a box). */
function setEdgeLabel(ev: EdgeView, short: boolean): void {
  const c = ev.label;
  if (!c) return;
  const [bg, t] = c.children as [Graphics, BitmapText];
  t.text = clip(ev.edge.label, short ? SHORT_LABEL : 32);
  const w = t.width + 12;
  const h = 18;
  bg.clear()
    .roundRect(-w / 2, -h / 2, w, h, 6)
    .fill({ color: THEME.labelBg, alpha: 0.92 });
  t.position.set(-t.width / 2, -t.height / 2 - 1);
  ev.short = short;
  ev.labelSize = { w, h };
}

export function makeEdgeLabel(state: SceneState, text: string): Container {
  const c = new Container();
  const t = new BitmapText({ text: clip(text, 32), style: { fontFamily: FONT, fontSize: 11 } });
  t.tint = THEME.label;
  const w = t.width + 12;
  const h = 18;
  const bg = new Graphics()
    .roundRect(-w / 2, -h / 2, w, h, 6)
    .fill({ color: THEME.labelBg, alpha: 0.92 });
  t.position.set(-t.width / 2, -t.height / 2 - 1);
  c.addChild(bg, t);
  state.edgeLabels.addChild(c);
  return c;
}

/**
 * How far along its sides an arrow leaves and arrives: spread among its neighbours on the side
 * it was spread for; a key on an open table leaves from (or arrives at) its column's row.
 */
function portOffsets(
  state: SceneState,
  e: CanvasEdge,
  a: Rect,
  b: Rect,
  via: { from: Side; to: Side },
  chosen: { from: Side; to: Side },
): { a: number; b: number } {
  const p = state.portMap.get(e.id);
  // Spread along a side only on the side it was spread for; a key on an open table leaves
  // from (or arrives at) its column's row.
  const rowA =
    (via.from === "l" || via.from === "r") && state.views.has(e.from)
      ? rowOffset(a as CanvasNode, e.fromColumn)
      : null;
  const rowB =
    (via.to === "l" || via.to === "r") && state.views.has(e.to)
      ? rowOffset(b as CanvasNode, e.toColumn)
      : null;
  return {
    a: rowA ?? (via.from === chosen.from ? (p?.a ?? 0) : 0),
    b: rowB ?? (via.to === chosen.to ? (p?.b ?? 0) : 0),
  };
}

export function routeOf(state: SceneState, e: CanvasEdge): Route {
  const a = endRect(state, e.from)!;
  const b = endRect(state, e.to)!;
  const s = shapeOf(state, e);
  const pin = {
    from: s?.fromSide && SIDE_OF_WORD[s.fromSide],
    to: s?.toSide && SIDE_OF_WORD[s.toSide],
  };
  if (s?.bends?.length) return bentRoute(a, b, s.bends, state.arrowStyle, pin);
  if (routed(state)) {
    const pts = state.avoid!.path(e.id);
    if (pts) return lineRoute(clipToBoxes(pts, a, b), state.arrowStyle === "elbow" ? 10 : 0);
  }
  const chosen = state.sideMap.get(e.id) ?? sides(a, b);
  const via = { from: pin.from ?? chosen.from, to: pin.to ?? chosen.to };
  const off = portOffsets(state, e, a, b, via, chosen);
  const r = route(a, b, off.a, off.b, via);
  // Curved arrows go around boxes they'd cross (as the render draws them); elbow and
  // straight ones fall back to this curve only while the router is busy or off.
  return state.arrowStyle === "curved"
    ? curveAround(
        r,
        a,
        b,
        via,
        state.order.map((v) => v.node),
        off,
      )
    : r;
}

/** An arrow's colour: by its status, then by whether the selection (or a lit step) is about it. */
function lineColor(state: SceneState, ev: EdgeView, live: boolean, focused: boolean): number {
  const status = ev.edge.status;
  return live
    ? THEME.edgeLive
    : status === "future"
      ? THEME.edgeFuture
      : status === "deprecated"
        ? THEME.edgeDeprecated
        : status === "removed"
          ? THEME.removed
          : focused
            ? state.spot
              ? state.spot.tone === "path"
                ? THEME.edgePath
                : THEME.select
              : THEME.edgeFocus
            : ev.edge.crosses
              ? THEME.edgeRegion
              : THEME.edge;
}

/**
 * Put an arrow's label where its shape says, or else on the best spot on its line that's
 * clear of boxes and of labels already placed (placeLabel), on curves and routed arrows alike.
 */
function placeEdgeLabel(
  state: SceneState,
  ev: EdgeView,
  label: Container,
  look: { dim: boolean; focused: boolean; live: boolean },
  spots: { boxes: Rect[]; taken: Rect[]; others: Route[] },
): void {
  const { boxes, taken, others } = spots;
  let mid: Point;
  const placed = shapeOf(state, ev.edge)?.label;
  if (placed !== undefined) {
    mid = routePoint(ev.route, placed);
    const { w, h } = ev.labelSize;
    taken.push({ x: mid.x - w / 2 - 4, y: mid.y - h / 2 - 2, w: w + 8, h: h + 4 });
  } else {
    // Where it would still cover a box (a title, a footer), a shorter label usually fits.
    if (ev.short) setEdgeLabel(ev, false);
    const trial = placeLabelOn(
      ev.route,
      ev.labelSize.w,
      ev.labelSize.h,
      boxes,
      taken,
      false,
      others,
    );
    if (trial.covers > 0 && ev.edge.label.length > SHORT_LABEL) {
      setEdgeLabel(ev, true);
      mid = placeLabel(ev.route, ev.labelSize.w, ev.labelSize.h, boxes, taken, others);
    } else {
      // Nothing changed since the trial, so placing it again would give the same spot.
      mid = trial.at;
      const { w, h } = ev.labelSize;
      taken.push({ x: mid.x - w / 2 - 4, y: mid.y - h / 2 - 2, w: w + 8, h: h + 4 });
    }
  }
  label.position.set(mid.x, mid.y);
  label.alpha = look.dim ? 0.18 : ev.edge.quiet && !look.focused && !look.live ? 0.25 : 1;
}

interface LineGroup {
  color: number;
  alpha: number;
  width: number;
  hop: boolean;
  list: EdgeView[];
}

/** Stroke each group of arrows that look alike in one go, then their arrowheads. */
function strokeGroups(g: Graphics, groups: Map<string, LineGroup>): void {
  for (const { color, alpha, width, hop, list } of groups.values()) {
    // A hop between processes is dashed: the call leaves the process here.
    for (const { route: r } of list) (hop ? traceDashed : traceRoute)(g, r);
    g.stroke({ width, color, alpha });
    for (const { route: r } of list) {
      const [a, b] = arrowHead(r.p1, r.c2, 9);
      g.poly([r.p1.x, r.p1.y, a.x, a.y, b.x, b.y]);
    }
    g.fill({ color, alpha });
  }
}

export function drawEdges(
  state: SceneState,
  g: Graphics,
  edges: Iterable<EdgeView>,
  live: boolean,
): void {
  g.clear();
  const base = edgeWidth(state);
  const groups = new Map<string, LineGroup>();
  // Each label takes the best spot on its line that's clear of boxes and of labels
  // already placed (placeLabel), on curves and routed arrows alike.
  const taken: Rect[] = [];
  const boxes: Rect[] = state.order.map((v) => v.node);
  // Every route first, so a label keeps off the other lines' straight runs.
  const list = [...edges];
  for (const ev of list) ev.route = routeOf(state, ev.edge);
  tellWatchersSoon(state);
  const others = list.map((ev) => ev.route);
  for (const ev of list) {
    const focused = state.focus?.edges.has(ev.edge.id) ?? false;
    const dim = !live && state.focus !== null && !focused;
    const status = ev.edge.status;
    const color = lineColor(state, ev, live, focused);
    // A library's lines wait in the background until something on them is picked.
    const alpha = dim ? 0.13 : ev.edge.quiet && !focused && !live ? 0.16 : 0.95;
    const width = focused || live ? base * 1.4 : base;
    // Dashed: a hop between processes, or a line deleted on the fork.
    const hop = !!ev.edge.hop || status === "removed";
    const key = `${color}|${alpha}|${width}|${hop}`;
    const grp = groups.get(key);
    if (grp) grp.list.push(ev);
    else groups.set(key, { color, alpha, width, hop, list: [ev] });
    if (ev.label)
      placeEdgeLabel(state, ev, ev.label, { dim, focused, live }, { boxes, taken, others });
  }
  strokeGroups(g, groups);
}

/** 1.5 world units, but never thinner than about a pixel on screen. */
function edgeWidth(state: SceneState): number {
  return Math.max(1.5, 1 / state.camera.scale);
}

export function drawStaticEdges(state: SceneState): void {
  const all = [...state.edges.values()];
  drawEdges(
    state,
    state.edgesStatic,
    state.liveEdges.size ? all.filter((e) => !state.liveEdges.has(e)) : all,
    false,
  );
}
