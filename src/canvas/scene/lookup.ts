// Small lookups the other modules share: a box or frame by id, where a line ends, an arrow's
// shape while it's being reshaped, and the pointer's position on the canvas.
import type { Point, Rect } from "../../../shared/geometry";
import type { ArrowShape } from "../../../shared/model.ts";
import type { CanvasEdge, CanvasGroup } from "../types";
import type { SceneState } from "./state";

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

export function shapeOf(state: Pick<SceneState, "shaping">, e: CanvasEdge): ArrowShape | undefined {
  return state.shaping?.edge === e.id ? state.shaping.shape : e.shape;
}

export function local(state: SceneState, e: MouseEvent): Point {
  const r = state.app.canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
