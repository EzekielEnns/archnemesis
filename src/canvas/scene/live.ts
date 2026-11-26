// While boxes are dragged or resized: their arrows move to their own layer, and the ports
// along the sides are worked out again for them.
import { BoxGrid, chooseSides, ports } from "../../../shared/geometry";
import { drawEdges, drawStaticEdges } from "./edges";
import { requestRender } from "./frame";
import { endRect } from "./lookup";
import { drawOverlay } from "./overlay";
import { routed, syncAvoid } from "./routing";
import type { SceneState } from "./state";
import { AVOID_LIVE_ALL, ROUTE_AROUND_LIMIT } from "./theme";

/**
 * Move the dragged boxes' edges, and their neighbours' (whose ports shift as the box
 * moves), to their own layer for the drag.
 */
export function beginLiveEdges(state: SceneState, ids: string[]): void {
  state.liveEdges.clear();
  state.liveNodes = new Set(ids);
  for (const id of ids)
    for (const ev of state.edgesByNode.get(id) ?? [])
      state.liveNodes.add(ev.edge.from).add(ev.edge.to);
  for (const id of state.liveNodes)
    for (const ev of state.edgesByNode.get(id) ?? []) state.liveEdges.add(ev);
  drawStaticEdges(state);
}

/** New ports for the live edges; an end on a box outside the live set keeps its old one. */
function refreshLivePorts(state: SceneState): void {
  const list = [...state.liveEdges].map((ev) => ev.edge);
  const rect = (id: string) => endRect(state, id);
  if (state.order.length <= ROUTE_AROUND_LIMIT) {
    const grid = new BoxGrid();
    for (const v of state.order) grid.add(v.node.id, v.node);
    for (const [id, via] of chooseSides(list, rect, grid)) state.sideMap.set(id, via);
  } else {
    for (const e of list) state.sideMap.delete(e.id);
  }
  syncAvoid(state);
  const fresh = ports(list, rect, state.sideMap);
  for (const ev of state.liveEdges) {
    const old = state.portMap.get(ev.edge.id) ?? { a: 0, b: 0 };
    const now = fresh.get(ev.edge.id) ?? { a: 0, b: 0 };
    state.portMap.set(ev.edge.id, {
      a: state.liveNodes.has(ev.edge.from) ? now.a : old.a,
      b: state.liveNodes.has(ev.edge.to) ? now.b : old.b,
    });
  }
}

/** Redraw what a live drag changes: the ports, the arrows on the live layer, the overlay. */
export function redrawLive(state: SceneState): void {
  refreshLivePorts(state);
  if (routed(state) && state.edges.size <= AVOID_LIVE_ALL) drawStaticEdges(state);
  drawEdges(state, state.edgesLive, state.liveEdges, true);
  drawOverlay(state);
  requestRender(state);
}
