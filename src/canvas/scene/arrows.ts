// Shaping arrows by hand: the style (curved, elbow, straight), dragging an arrow's end, bend
// or label, and saving the shape.
import { bendIndex, nearestSide, nearestT, type Point, SIDE_WORD } from "../../../shared/geometry";
import type { ArrowShape, ArrowStyle } from "../../../shared/model.ts";
import { AsyncRouter } from "../avoid";
import { drawStaticEdges } from "./edges";
import { requestRender } from "./frame";
import { endRect, shapeOf } from "./lookup";
import { drawOverlay } from "./overlay";
import { syncAvoid } from "./routing";
import type { SceneState } from "./state";
import { GUIDE_SNAP, SNAP } from "./theme";
import type { Drag } from "./types";

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

/** Save an arrow's shape (the draft stays on screen until the model has it). */
export function commitShape(state: SceneState, edge: string, shape: ArrowShape | null): void {
  const ev = state.edges.get(edge);
  if (!ev) return;
  // Where what it carries was dragged to isn't its shape: reshaping or resetting it keeps that.
  const parts = shape?.parts ?? shapeOf(state, ev.edge)?.parts;
  const rest = shape
    ? {
        fromSide: shape.fromSide,
        toSide: shape.toSide,
        bends: shape.bends?.length ? shape.bends : undefined,
        label: shape.label,
        parts,
      }
    : parts
      ? { parts }
      : null;
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
    const box = endRect(state, d.part === "from" ? ev.edge.from : ev.edge.to);
    if (!box) return;
    const side = SIDE_WORD[nearestSide(box, world)];
    const k = d.part === "from" ? "fromSide" : "toSide";
    resync = s[k] !== side;
    s[k] = side;
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
