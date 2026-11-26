// Questions the app asks the canvas: which box or arrow is here, where an arrow's label sits,
// where a box is on the page. They change nothing.
import { screenToWorld } from "../camera";
import { type Point, routePoint } from "../../../shared/geometry";
import { hitEdge, hitNode } from "./hit";
import { viewMid } from "./lookup";
import type { SceneState } from "./state";

/** The box at a diagram point, if any. */
export function nodeAt(state: SceneState, world: Point): string | null {
  return hitNode(state, world)?.node.id ?? null;
}

/** Where a page point (a drop, say) lands in the diagram. */
export function clientToWorld(state: SceneState, clientX: number, clientY: number): Point {
  const r = state.app.canvas.getBoundingClientRect();
  return screenToWorld(state.camera, { x: clientX - r.left, y: clientY - r.top });
}

export function viewCenter(state: SceneState): Point {
  return screenToWorld(state.camera, viewMid(state));
}

/** Where an arrow's label sits on the diagram (its middle, when it has no label), and its size. */
export function edgeLabelAt(
  state: SceneState,
  id: string,
): { x: number; y: number; w: number; h: number } | null {
  const ev = state.edges.get(id);
  if (!ev) return null;
  const mid = ev.label
    ? { x: ev.label.position.x, y: ev.label.position.y }
    : routePoint(ev.route, 0.5);
  const w = ev.label ? ev.labelSize.w : 16;
  const h = ev.label ? ev.labelSize.h : 16;
  return { x: mid.x - w / 2, y: mid.y - h / 2, w, h };
}

/** The arrow at a diagram point, if any: its connections. */
export function edgeAt(
  state: SceneState,
  world: Point,
): { id: string; connectionIds: string[] } | null {
  const ev = hitEdge(state, world);
  return ev ? { id: ev.edge.id, connectionIds: ev.edge.connectionIds } : null;
}

/** The middle of the arrow a connection is drawn on here (where its label sits), live. */
export function connectionAnchor(state: SceneState, connectionId: string): Point | null {
  for (const ev of state.edges.values()) {
    if (!ev.edge.connectionIds.includes(connectionId)) continue;
    return ev.label
      ? { x: ev.label.position.x, y: ev.label.position.y }
      : routePoint(ev.route, 0.5);
  }
  return null;
}

/** Where an arrow's label sits on the page. */
export function edgeLabelClient(state: SceneState, id: string): Point | null {
  const ev = state.edges.get(id);
  if (!ev) return null;
  const mid = ev.label
    ? { x: ev.label.position.x, y: ev.label.position.y }
    : routePoint(ev.route, 0.5);
  const r = state.app.canvas.getBoundingClientRect();
  return {
    x: r.left + state.camera.x + mid.x * state.camera.scale,
    y: r.top + state.camera.y + mid.y * state.camera.scale,
  };
}

export function isEmpty(state: SceneState): boolean {
  return state.order.length === 0;
}

/** A frame's rectangle on the page (a boundary is "boundary:<id>"). */
export function clientRectOfGroup(
  state: SceneState,
  id: string,
): { x: number; y: number; w: number; h: number } | null {
  const g = state.groupList.find((x) => x.id === id);
  if (!g) return null;
  const r = state.app.canvas.getBoundingClientRect();
  const s = state.camera.scale;
  return {
    x: r.left + state.camera.x + g.x * s,
    y: r.top + state.camera.y + g.y * s,
    w: g.w * s,
    h: g.h * s,
  };
}

/** A box's rect in page coordinates, for editing its name in place. */
export function clientRectOf(
  state: SceneState,
  id: string,
): { x: number; y: number; w: number; h: number; scale: number } | null {
  const n = state.views.get(id)?.node;
  if (!n) return null;
  const r = state.app.canvas.getBoundingClientRect();
  const s = state.camera.scale;
  return {
    x: r.left + state.camera.x + n.x * s,
    y: r.top + state.camera.y + n.y * s,
    w: n.w * s,
    h: n.h * s,
    scale: s,
  };
}
