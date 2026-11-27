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

/** The arrow a fork comes off in the end: up through the forks to the one that starts at the box. */
function forkRoot(state: SceneState, ev: EdgeView): string {
  let at = ev;
  for (let i = 0; at.edge.forkOf && i < 32; i++) {
    const up = state.edges.get(at.edge.forkOf);
    if (!up) break;
    at = up;
  }
  return at.edge.id;
}

/** The rest of an arrow that splits: the arrow a fork comes off, and every other fork of it. One arrow to the eye. */
export function forkFamily(state: SceneState, ev: EdgeView): EdgeView[] {
  const root = forkRoot(state, ev);
  return (state.edgesByNode.get(ev.edge.from) ?? []).filter(
    (o) => o !== ev && (o.edge.forkOf || ev.edge.forkOf) && forkRoot(state, o) === root,
  );
}

export function shapeOf(state: Pick<SceneState, "shaping">, e: CanvasEdge): ArrowShape | undefined {
  return state.shaping?.edge === e.id ? state.shaping.shape : e.shape;
}

export function local(state: SceneState, e: MouseEvent): Point {
  const r = state.app.canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
