// Selecting: the picked boxes, arrow, frame or diagram, what's reported when it changes, the
// hovered box, and bringing a grabbed box to the top.
import { requestRender } from "./frame";
import { pickable } from "./lookup";
import { drawOverlay } from "./overlay";
import { refocus } from "./spotlight";
import type { SceneState } from "./state";
import type { NodeView, Selection } from "./types";

export function select(state: SceneState, sel: Selection, notify = false): void {
  state.selected = new Set(sel.nodes.filter((id) => pickable(state, id)));
  state.selectedEdge = sel.edge && state.edges.has(sel.edge) ? sel.edge : null;
  state.selectedBoundary =
    sel.boundary && state.groupList.some((g) => g.id === `boundary:${sel.boundary}`)
      ? sel.boundary
      : null;
  state.selectedScope = !!sel.diagram;
  if (notify) emitSelect(state, true);
  else refocus(state);
  drawOverlay(state);
  requestRender(state);
}

export function emitSelect(state: SceneState, byCode = false, back = false): void {
  refocus(state);
  state.cb.onSelect?.(
    {
      nodes: [...state.selected],
      edge: state.selectedEdge,
      boundary: state.selectedBoundary,
      diagram: state.selectedScope,
    },
    byCode,
    back,
  );
}

export function setHovered(state: SceneState, id: string | null): void {
  if (id === state.hovered) return;
  state.hovered = id;
  drawOverlay(state);
  requestRender(state);
}

/** Bring a box to the top, so the one you grab is the one drawn over its neighbours. */
export function raise(state: SceneState, v: NodeView): void {
  const i = state.order.indexOf(v);
  if (i === -1 || i === state.order.length - 1) return;
  state.order.splice(i, 1);
  state.order.push(v);
  state.nodeLayer.addChild(v.root);
}
