// Small lookups the other modules share: a box or frame by id, where a line ends, an arrow's
// shape while it's being reshaped, and the pointer's position on the canvas.
import type { Point, Rect } from "../../../shared/geometry";
import type { ArrowShape } from "../../../shared/model.ts";
import type { CanvasEdge, CanvasGroup } from "../types";
import type { SceneState } from "./state";
import type { EdgeView } from "./types";

/** The middle of the part of the canvas you can see, in screen px. */
export function viewMid(state: SceneState): Point {
  return { x: (state.size.w + state.insetLeft) / 2, y: state.size.h / 2 };
}

/** A box on the diagram, or a module drawn as a frame around its insides. */
export function pickable(state: SceneState, id: string): boolean {
  return state.views.has(id) || !!frameOf(state, id);
}

export function frameOf(state: SceneState, id: string): CanvasGroup | undefined {
  return state.groupList.find((g) => g.container && g.id === id);
}

/** Where a line ends: a box, or a frame. */
export function endRect(state: SceneState, id: string): Rect | undefined {
  return state.views.get(id)?.node ?? state.frameEnds.get(id);
}

/**
 * What lights up with an arrow that splits or joins. The first arrow of a group (the one the
 * others were drawn off, or onto) shows the whole of it; any other is picked by itself.
 */
export function splitFamily(state: SceneState, ev: EdgeView): EdgeView[] {
  const split = ev.edge.splitLead ? ev.edge.split : undefined;
  const join = ev.edge.joinLead ? ev.edge.join : undefined;
  if (!split && !join) return [];
  return [...state.edges.values()].filter(
    (o) => o !== ev && ((split && o.edge.split === split) || (join && o.edge.join === join)),
  );
}

/** The arrows through one split or join point, by its group. */
export function meetGroup(state: SceneState, key: string): EdgeView[] {
  return [...state.edges.values()].filter((o) => o.edge.split === key || o.edge.join === key);
}

export function shapeOf(
  state: Pick<SceneState, "shaping"> & Partial<Pick<SceneState, "splitMove">>,
  e: CanvasEdge,
): ArrowShape | undefined {
  const s = state.shaping?.edge === e.id ? state.shaping.shape : e.shape;
  const m = state.splitMove;
  if (!m || !s) return s;
  if (e.split === m.key) return { ...s, split: m.at };
  return e.join === m.key ? { ...s, join: m.at } : s;
}

export function local(state: SceneState, e: MouseEvent): Point {
  const r = state.app.canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
