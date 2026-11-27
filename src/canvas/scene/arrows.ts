// Shaping arrows by hand: the style (curved, elbow, straight), dragging an arrow's end, bend
// or label, and saving the shape.
import {
  bendIndex,
  nearestSide,
  nearestT,
  type Point,
  SIDE_WORD,
  sideT,
} from "../../../shared/geometry";
import type { ArrowShape, ArrowStyle } from "../../../shared/model.ts";
import { AsyncRouter } from "../avoid";
import { drawStaticEdges } from "./edges";
import { requestRender } from "./frame";
import { endRect, shapeOf } from "./lookup";
import { drawOverlay } from "./overlay";
import { syncAvoid } from "./routing";
import type { SceneState } from "./state";
import { GUIDE_SNAP, SNAP } from "./theme";
import type { Drag, EdgeView } from "./types";

/** Curved, elbow or straight. Elbow and straight load the router the first time (curves until then). */
export function setArrowStyle(state: SceneState, style: ArrowStyle): void {
  if (style === state.arrowStyle) return;
  state.arrowStyle = style;
  // Routes arrive from a worker; each time, the arrows are drawn again through them.
  if (style !== "curved" && !state.avoid && typeof Worker !== "undefined")
    state.avoid = new AsyncRouter(() => {
      if (state.destroyed || !state.ready) return;
      drawStaticEdges(state);
      drawOverlay(state);
      requestRender(state);
    });
  restyleEdges(state);
}

function restyleEdges(state: SceneState): void {
  if (!state.ready) return;
  syncAvoid(state);
  drawStaticEdges(state);
  drawOverlay(state);
  requestRender(state);
}

/**
 * Bends that do nothing: one on top of the last, or on the straight line between its
 * neighbours. Dragging a line adds a bend each time, and an arrow straightened by hand kept
 * every one of them, a row of dots that each bent it again when nudged.
 */
function tidyBends(bends: Point[], start: Point, end: Point): Point[] {
  const out: Point[] = [];
  const pts = [start, ...bends, end];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1] ?? start;
    const b = pts[i]!;
    const c = pts[i + 1]!;
    if (Math.hypot(b.x - a.x, b.y - a.y) < 3) continue;
    const len = Math.hypot(c.x - a.x, c.y - a.y);
    // How far b is off the line a→c, and whether it lies between them.
    const off = len ? Math.abs((c.x - a.x) * (a.y - b.y) - (a.x - b.x) * (c.y - a.y)) / len : 0;
    const along = len ? ((b.x - a.x) * (c.x - a.x) + (b.y - a.y) * (c.y - a.y)) / (len * len) : 0;
    if (len && off < 3 && along > 0 && along < 1) continue;
    out.push(b);
  }
  return out;
}

/** Where an arrow forks off another isn't lost when it's reshaped. */
function forkOf(shape: ArrowShape, was: ArrowShape | undefined): Partial<ArrowShape> {
  const from = shape.forkAt !== undefined ? shape : was;
  return from?.forkOf && from.forkAt !== undefined
    ? { forkOf: from.forkOf, forkAt: from.forkAt }
    : {};
}

/** An arrow's shape reset: where it forks off another, and where what it carries was put, stay. */
function forkOrParts(
  parts: ArrowShape["parts"],
  was: ArrowShape | undefined,
): Partial<ArrowShape> | null {
  const kept = { ...(parts ? { parts } : {}), ...(was ? forkOf(was, was) : {}) };
  return Object.keys(kept).length ? kept : null;
}

/** Save an arrow's shape (the draft stays on screen until the model has it). */
export function commitShape(state: SceneState, edge: string, shape: ArrowShape | null): void {
  const ev = state.edges.get(edge);
  if (!ev) return;
  // Where what it carries was dragged to isn't its shape: reshaping or resetting it keeps that.
  const parts = shape?.parts ?? shapeOf(state, ev.edge)?.parts;
  if (shape?.bends?.length)
    shape = { ...shape, bends: tidyBends(shape.bends, ev.route.p0, ev.route.p1) };
  const rest = shape
    ? {
        fromSide: shape.fromSide,
        toSide: shape.toSide,
        fromAt: shape.fromSide ? shape.fromAt : undefined,
        toAt: shape.toSide ? shape.toAt : undefined,
        ...forkOf(shape, shapeOf(state, ev.edge)),
        bends: shape.bends?.length ? shape.bends : undefined,
        label: shape.label,
        parts,
      }
    : forkOrParts(parts, shapeOf(state, ev.edge));
  if (rest)
    for (const k of Object.keys(rest) as (keyof typeof rest)[])
      if (rest[k] === undefined) delete rest[k];
  const ok =
    state.cb.onArrowShape?.(
      ev.edge.from,
      ev.edge.to,
      rest && Object.keys(rest).length ? rest : null,
    ) ?? false;
  if (!ok) {
    state.shaping = null;
    syncAvoid(state);
    drawStaticEdges(state);
  }
}

/** A fork's start slides along the arrow it comes off. False when it isn't a fork. */
function slideFork(state: SceneState, ev: EdgeView, s: ArrowShape, world: Point): boolean {
  const parent = ev.edge.forkOf ? state.edges.get(ev.edge.forkOf) : undefined;
  if (!parent) return false;
  const t = Math.max(0.05, Math.min(0.95, nearestT(parent.route, world)));
  s.forkAt = Math.round(t * 100) / 100;
  return true;
}

/**
 * An end goes where it's dragged: a fork's start along the arrow it comes off, any other end to
 * the nearest side of its box and the spot along it. Whether that changed where it's routed
 * from; null when its box isn't here.
 */
function moveEnd(
  state: SceneState,
  ev: EdgeView,
  s: ArrowShape,
  part: "from" | "to",
  world: Point,
): boolean | null {
  if (part === "from" && slideFork(state, ev, s, world)) return true;
  const box = endRect(state, part === "from" ? ev.edge.from : ev.edge.to);
  if (!box) return null;
  const near = nearestSide(box, world);
  const side = SIDE_WORD[near];
  const k = part === "from" ? "fromSide" : "toSide";
  const kt = part === "from" ? "fromAt" : "toAt";
  const t = sideT(box, near, world);
  const changed = s[k] !== side || s[kt] !== t;
  s[k] = side;
  s[kt] = t;
  return changed;
}

export function dragArrow(
  state: SceneState,
  d: Extract<Drag, { kind: "arrow" }>,
  world: Point,
  free: boolean,
): void {
  const ev = state.edges.get(d.edge);
  if (!ev) return;
  if (!d.moved && Math.hypot(world.x - d.start.x, world.y - d.start.y) * state.camera.scale < 4)
    return;
  d.moved = true;
  const base = shapeOf(state, ev.edge) ?? { diagramId: "", from: ev.edge.from, to: ev.edge.to };
  const s: ArrowShape = { ...base, bends: base.bends ? [...base.bends] : undefined };
  let resync = false;
  if (d.part === "from" || d.part === "to") {
    const moved = moveEnd(state, ev, s, d.part, world);
    if (moved === null) return;
    resync = moved;
  } else if (d.part === "label") {
    s.label = Math.round(nearestT(ev.route, world) * 1000) / 1000;
  } else {
    const bends = s.bends ?? [];
    if (d.part === "line") {
      d.index = bendIndex(ev.route.p0, bends, ev.route.p1, world);
      bends.splice(d.index, 0, world);
      d.part = "bend";
      resync = true; // now drawn through its bends, not by the router
    }
    const q = free
      ? { ...world }
      : { x: Math.round(world.x / SNAP) * SNAP, y: Math.round(world.y / SNAP) * SNAP };
    // Line up with the point either side, so that stretch runs straight.
    if (!free) {
      const tol = GUIDE_SNAP / state.camera.scale + SNAP / 2;
      const prev = d.index === 0 ? ev.route.p0 : bends[d.index - 1]!;
      const next = d.index === bends.length - 1 ? ev.route.p1 : bends[d.index + 1]!;
      for (const n of [prev, next]) {
        if (Math.abs(world.x - n.x) < tol) q.x = n.x;
        if (Math.abs(world.y - n.y) < tol) q.y = n.y;
      }
    }
    bends[d.index] = { x: Math.round(q.x), y: Math.round(q.y) };
    s.bends = bends;
  }
  state.shaping = { edge: d.edge, shape: s };
  if (resync) syncAvoid(state);
  drawStaticEdges(state);
  drawOverlay(state);
  requestRender(state);
}
