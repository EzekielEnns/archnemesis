// Bringing the canvas in line with a new projection of the diagram: only what changed is
// rebuilt, and only the arrows near it are routed again.
import { lineEnds } from "../../../shared/project.ts";
import type { CanvasGraph } from "../types";
import { makeEdgeLabel, routeOf } from "./edges";
import { applyLabelVisibility, cull, requestRender } from "./frame";
import { drawGroups } from "./groups";
import { endRect, pickable } from "./lookup";
import { signature } from "./measure";
import { drawMinimap } from "./minimap";
import { makeView } from "./nodes";
import { drawOverlay } from "./overlay";
import { recomputeRoutes, syncAvoid } from "./routing";
import { emitSelect } from "./selection";
import { refocus } from "./spotlight";
import type { SceneState } from "./state";
import type { Dirty, EdgeView } from "./types";

/** Add, update and remove the boxes to match the graph, noting what moved, appeared or went. */
function syncNodes(state: SceneState, graph: CanvasGraph, dirty: Dirty): void {
  const keep = new Set<string>();
  for (const n of graph.nodes) {
    keep.add(n.id);
    const sig = signature(n);
    const v = state.views.get(n.id);
    if (!v) dirty.areas.push(n);
    else if (v.node.x !== n.x || v.node.y !== n.y || v.node.w !== n.w || v.node.h !== n.h) {
      dirty.ids.add(n.id);
      dirty.areas.push(v.node, n);
    }
    if (!v) {
      const view = makeView(state, n, sig);
      state.views.set(n.id, view);
      state.order.push(view);
      state.nodeLayer.addChild(view.root);
    } else if (v.sig !== sig) {
      state.replaceView(v, n, sig);
    } else {
      v.node = n;
      v.root.position.set(n.x, n.y);
    }
  }
  for (const v of [...state.order]) {
    if (keep.has(v.node.id)) continue;
    dirty.areas.push(v.node);
    state.views.delete(v.node.id);
    state.order.splice(state.order.indexOf(v), 1);
    v.root.destroy({ children: true });
  }
}

/** Build every arrow again from the graph. Returns what each one connected before. */
function rebuildEdges(state: SceneState, graph: CanvasGraph): Map<string, string> {
  const before = new Map([...state.edges].map(([id, ev]) => [id, `${ev.edge.from}>${ev.edge.to}`]));
  for (const ev of state.edges.values()) ev.label?.destroy({ children: true });
  state.edges.clear();
  state.edgesByNode.clear();
  state.liveEdges.clear();
  state.edgesLive.clear();
  // Frames hold line ends too (the same objects drawGroups keeps, so a dragged frame's lines follow it).
  state.frameEnds = new Map([...lineEnds(graph)].filter(([id]) => !state.views.has(id)));
  for (const e of graph.edges) {
    if (!endRect(state, e.from) || !endRect(state, e.to)) continue;
    const label = e.label ? makeEdgeLabel(state, e.label) : null;
    const ev: EdgeView = {
      edge: e,
      route: routeOf(state, e),
      label,
      labelSize: label ? { w: label.width, h: label.height } : { w: 0, h: 0 },
    };
    state.edges.set(e.id, ev);
    for (const id of [e.from, e.to]) {
      const list = state.edgesByNode.get(id);
      if (list) list.push(ev);
      else state.edgesByNode.set(id, [ev]);
    }
  }
  return before;
}

/** Drop what's picked or hovered that's no longer here; say so if the selection changed. */
function settleSelection(state: SceneState): void {
  const selBefore = state.selected.size + (state.selectedEdge ? 1 : 0);
  for (const id of [...state.selected]) if (!pickable(state, id)) state.selected.delete(id);
  if (state.selectedEdge && !state.edges.has(state.selectedEdge)) state.selectedEdge = null;
  if (state.hovered && !state.views.has(state.hovered)) state.hovered = null;
  if (state.hoveredEdge && !state.edges.has(state.hoveredEdge)) state.hoveredEdge = null;
  if (selBefore !== state.selected.size + (state.selectedEdge ? 1 : 0)) emitSelect(state);
  else refocus(state);
}

/** Bring the canvas in line with a new projection: only what changed is rebuilt. */
export function sync(state: SceneState, graph: CanvasGraph): void {
  if (!state.ready) return;
  // What moved, appeared or went: only arrows near those need routing again.
  const dirty: Dirty = { ids: new Set(), areas: [], edges: new Set() };
  let structural = state.edges.size === 0;
  syncNodes(state, graph, dirty);

  const before = rebuildEdges(state, graph);
  for (const id of state.edges.keys()) if (!before.has(id)) dirty.edges!.add(id);
  // A shape change (here or from someone else) re-routes; the draft it came from is done.
  if (!state.drag || state.drag.kind !== "arrow") state.shaping = null;
  const shapeSig = JSON.stringify(graph.edges.filter((e) => e.shape).map((e) => e.shape));
  if (shapeSig !== state.shapeSig) {
    state.shapeSig = shapeSig;
    if (!structural && !dirty.ids.size && !dirty.areas.length && !dirty.edges!.size)
      syncAvoid(state);
  }
  if (before.size !== state.edges.size) structural = true;
  // Ports spread arrows along a side, so any change in who connects re-spreads them all;
  // but an echo of what's already on screen changes nothing.
  if (structural || dirty.ids.size || dirty.areas.length || dirty.edges!.size)
    recomputeRoutes(state, structural && !before.size ? undefined : dirty);
  drawGroups(state, graph.groups);

  settleSelection(state);

  cull(state);
  applyLabelVisibility(state, true);
  drawMinimap(state);
  drawOverlay(state);
  requestRender(state);
}
