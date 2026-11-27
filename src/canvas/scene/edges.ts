// Drawing arrows: each arrow's route, its label placed clear of boxes and other labels, the
// strokes and arrowheads grouped by look.
import { BitmapText, Container, Graphics } from "pixi.js";
import {
  arrowHead,
  pinOffsets,
  bentRoute,
  clipToBoxes,
  curveAround,
  RectIndex,
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
  fanStart,
  forkRoute,
  lineLength,
  sharedRun,
  startAt,
} from "../../../shared/geometry";
import type { ArrowShape } from "../../../shared/model.ts";
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
  t.text = labelText(ev.edge, short ? SHORT_LABEL : 32);
  const w = t.width + 12;
  const h = labelHeight(t.text);
  bg.clear()
    .roundRect(-w / 2, -h / 2, w, h, 6)
    .fill({ color: THEME.labelBg, alpha: 0.92 });
  t.position.set(-t.width / 2, -t.height / 2 - 1);
  ev.short = short;
  ev.labelSize = { w, h };
}

/**
 * What an arrow's label says. One that stands for two or three connections lists their names,
 * one a line (a queue's topics, a store's reads and writes), as the rendered picture does: "2
 * connections" said nothing. More than that, or none of them named, and it's the count.
 */
function labelText(e: CanvasEdge, max: number): string {
  const names = e.labels ?? [];
  if (names.length >= 2 && names.length <= 3 && e.label.endsWith(" connections"))
    return names.map((n) => clip(n.trim(), max)).join("\n");
  // All of them under one name: the name, and how many.
  if (names.length === 1 && e.label.endsWith(" connections"))
    return `${clip(names[0]!.trim(), max - 4)} ×${e.connectionIds.length}`;
  return clip(e.label, max);
}
const labelHeight = (text: string) => 18 + 14 * (text.split("\n").length - 1);

export function makeEdgeLabel(state: SceneState, e: CanvasEdge): Container {
  const c = new Container();
  const t = new BitmapText({
    text: labelText(e, 32),
    style: { fontFamily: FONT, fontSize: 11, align: "center", lineHeight: 14 },
  });
  t.tint = THEME.label;
  const w = t.width + 12;
  const h = labelHeight(t.text);
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

/** No box: a fork starts on a line, not in one. */
const NOWHERE: Rect = { x: -1e9, y: -1e9, w: 0, h: 0 };

/** A fork's line: from its spot on the arrow it comes off, not from the box. Undefined when it isn't one. */
function forkedRoute(
  state: SceneState,
  e: CanvasEdge,
  s: ArrowShape | undefined,
  b: Rect,
  index?: RectIndex,
): Route | undefined {
  const parent = e.forkOf ? state.edges.get(e.forkOf)?.edge : undefined;
  if (!parent || s?.forkAt === undefined || !endRect(state, parent.to)) return undefined;
  const up = routeOf(state, parent, index);
  const round = state.arrowStyle === "straight" ? 0 : 10;
  // Routed around boxes from its spot; with bends of its own, or unrouted, one turn into its box.
  const pts = !s.bends?.length && routed(state) ? state.avoid!.path(e.id) : null;
  return pts
    ? lineRoute(clipToBoxes(startAt(pts, routePoint(up, s.forkAt)), NOWHERE, b), round)
    : forkRoute(up, s.forkAt, b, s.bends, round);
}

/** Past this many boxes a redraw asks an index for the boxes near each arrow, not the whole list. */
const INDEX_FROM = 64;

export function routeOf(state: SceneState, e: CanvasEdge, index?: RectIndex): Route {
  const a = endRect(state, e.from)!;
  const b = endRect(state, e.to)!;
  const s = shapeOf(state, e);
  const fork = forkedRoute(state, e, s, b, index);
  if (fork) return fork;
  const pin = {
    from: s?.fromSide && SIDE_OF_WORD[s.fromSide],
    to: s?.toSide && SIDE_OF_WORD[s.toSide],
  };
  // An end put on a spot along its side by hand sits there, whatever else shares the side.
  const at = pinOffsets(a, b, pin, s);
  if (s?.bends?.length) {
    // Bent by hand, in a fan: it still leaves from the fan's spot, then takes its bends.
    const fan = state.fanMap.get(e.id);
    const st = fanStart(pin, at, fan && { side: fan }, state.portMap.get(e.id)?.a);
    return bentRoute(a, b, s.bends, state.arrowStyle, st.pin, st.at);
  }
  if (routed(state)) {
    const pts = state.avoid!.path(e.id);
    if (pts) return lineRoute(clipToBoxes(pts, a, b), state.arrowStyle === "elbow" ? 10 : 0);
  }
  const chosen = state.sideMap.get(e.id) ?? sides(a, b);
  const via = { from: pin.from ?? chosen.from, to: pin.to ?? chosen.to };
  const spread = portOffsets(state, e, a, b, via, chosen);
  const off = { ...spread, ...at };
  const r = route(a, b, off.a, off.b, via);
  // Curved arrows go around boxes they'd cross (as the render draws them); elbow and
  // straight ones fall back to this curve only while the router is busy or off.
  return state.arrowStyle === "curved"
    ? curveAround(r, a, b, via, index ?? state.order.map((v) => v.node), off)
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

/** For the arrow that leads a fan: how far along it (0 to 1) the middle of the shared line is; 0 when there's none to speak of. */
function fanTrunk(state: SceneState, ev: EdgeView): number {
  const pts = ev.route.pts;
  if (!ev.edge.fanLead || !pts) return 0;
  let run = Infinity;
  for (const o of state.edgesByNode.get(ev.edge.from) ?? [])
    if (o !== ev && o.edge.fan === ev.edge.fan && o.route.pts)
      run = Math.min(run, sharedRun(pts, o.route.pts));
  const total = lineLength(pts);
  return run >= 36 && run < Infinity && total ? run / 2 / total : 0;
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
  spots: { boxes: Rect[] | RectIndex; taken: Rect[]; others: Route[] },
): void {
  const { boxes, taken, others } = spots;
  let mid: Point;
  const placed = shapeOf(state, ev.edge)?.label;
  const trunk = placed === undefined ? fanTrunk(state, ev) : 0;
  if (placed !== undefined || trunk) {
    // A fan's name sits on the part they all share, before they part.
    mid = routePoint(ev.route, placed ?? trunk);
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
    for (const { route: r, edge } of list) {
      const [a, b] = arrowHead(r.p1, r.c2, 9);
      g.poly([r.p1.x, r.p1.y, a.x, a.y, b.x, b.y]);
      // A fork: a dot where it comes off its arrow.
      if (edge.forkOf) g.circle(r.p0.x, r.p0.y, 3.5);
      if (!edge.both) continue;
      // Both ways: a head at the start too.
      const [c, d] = arrowHead(r.p0, r.c1, 9);
      g.poly([r.p0.x, r.p0.y, c.x, c.y, d.x, d.y]);
    }
    g.fill({ color, alpha });
  }
}

export function drawEdges(
  state: SceneState,
  g: Graphics,
  edges: Iterable<EdgeView>,
  live: boolean,
  /** Only the strokes again (their width follows the zoom): routes and labels stay as they are. */
  strokesOnly = false,
): void {
  g.clear();
  const base = edgeWidth(state);
  const groups = new Map<string, LineGroup>();
  // Each label takes the best spot on its line that's clear of boxes and of labels
  // already placed (placeLabel), on curves and routed arrows alike.
  const taken: Rect[] = [];
  const all: Rect[] = strokesOnly ? [] : state.order.map((v) => v.node);
  const index = all.length > INDEX_FROM ? new RectIndex(all) : undefined;
  const boxes = index ?? all;
  // Every route first, so a label keeps off the other lines' straight runs.
  const list = [...edges];
  if (!strokesOnly) {
    for (const ev of list) ev.route = routeOf(state, ev.edge, index);
    tellWatchersSoon(state);
  } else {
    // An arrow that hasn't been drawn yet has no route to stroke again.
    for (const ev of list) ev.route ??= routeOf(state, ev.edge);
  }
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
    if (ev.label && !strokesOnly)
      placeEdgeLabel(state, ev, ev.label, { dim, focused, live }, { boxes, taken, others });
  }
  strokeGroups(g, groups);
}

/** 1.5 world units, but never thinner than about a pixel on screen. */
function edgeWidth(state: SceneState): number {
  return Math.max(1.5, 1 / state.camera.scale);
}

export function drawStaticEdges(state: SceneState, strokesOnly = false): void {
  const all = [...state.edges.values()];
  drawEdges(
    state,
    state.edgesStatic,
    state.liveEdges.size ? all.filter((e) => !state.liveEdges.has(e)) : all,
    false,
    strokesOnly,
  );
}
