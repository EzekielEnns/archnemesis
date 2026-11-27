// Focus: light up a flow step or a selection and dim what isn't connected to it.
import type { CanvasGroup } from "../types";
import { drawStaticEdges } from "./edges";
import { requestRender } from "./frame";
import { drawGroups } from "./groups";
import { baseAlpha } from "./measure";
import { drawMiniNodes } from "./minimap";
import { drawOverlay } from "./overlay";
import { splitFamily } from "./lookup";
import type { SceneState } from "./state";
import type { Spotlight } from "./types";

/** Light up a flow step (or a tag): overrides the selection's focus until cleared. */
export function spotlight(state: SceneState, spec: Spotlight | null): void {
  state.spot = spec && (spec.nodes.length || spec.pairs.length) ? spec : null;
  if (!state.ready) return;

  refocus(state);
  drawOverlay(state);
  requestRender(state);
}

/** The selected frame, when it's a box opened here or a group unfolded here. */
function openedPicked(state: SceneState): CanvasGroup | null {
  const b = state.selectedBoundary;
  if (!b || !(b.startsWith("open:") || b.startsWith("fold:"))) return null;
  return state.groupList.find((g) => g.id === `boundary:${b}`) ?? null;
}

interface Focus {
  nodes: Set<string>;
  edges: Set<string>;
}

/** A spotlit step: its boxes, and the arrows between each pair. */
function focusOnSpot(state: SceneState, spot: Spotlight): Focus {
  const f: Focus = { nodes: new Set(spot.nodes), edges: new Set() };
  for (const [a, b] of spot.pairs) {
    f.nodes.add(a).add(b);
    for (const id of [`${a}>${b}`, `${b}>${a}`]) if (state.edges.has(id)) f.edges.add(id);
  }
  return f;
}

/** The selected boxes, their neighbours and the arrows between. */
function focusOnSelection(state: SceneState): Focus {
  const f: Focus = { nodes: new Set(state.selected), edges: new Set() };
  // A picked file frame stands for the functions inside it; a picked opened box (or
  // unfolded group), for everything drawn inside its panel.
  const picked = new Set(state.selected);
  const box = openedPicked(state);
  for (const grp of state.groupList) {
    if (!(grp.container && state.selected.has(grp.id)) && grp !== box) continue;
    for (const v of state.order)
      if (
        v.node.x >= grp.x &&
        v.node.y >= grp.y &&
        v.node.x + v.node.w <= grp.x + grp.w &&
        v.node.y + v.node.h <= grp.y + grp.h
      ) {
        picked.add(v.node.id);
        f.nodes.add(v.node.id);
      }
  }
  for (const id of picked) {
    for (const ev of state.edgesByNode.get(id) ?? []) {
      f.edges.add(ev.edge.id);
      f.nodes.add(ev.edge.from);
      f.nodes.add(ev.edge.to);
    }
  }
  return f;
}

/** Dim everything the selection isn't connected to. */
export function refocus(state: SceneState): void {
  let f: Focus | null = null;
  if (state.spot) {
    f = focusOnSpot(state, state.spot);
  } else if (state.selectedEdge) {
    const ev = state.edges.get(state.selectedEdge);
    // An arrow and the others through its split point are one arrow: all of it stays lit, with every box it reaches.
    const all = ev ? [ev, ...splitFamily(state, ev)] : [];
    if (ev)
      f = {
        nodes: new Set(all.flatMap((x) => [x.edge.from, x.edge.to])),
        edges: new Set(all.map((x) => x.edge.id)),
      };
  } else if (state.selected.size || openedPicked(state)) {
    f = focusOnSelection(state);
  }
  state.focus = f;
  // A picked file frame is drawn picked; one no longer picked, not.
  const framesPicked =
    state.groupList
      .filter((g) => g.container && state.selected.has(g.id))
      .map((g) => g.id)
      .join() +
    "|" +
    (state.selectedBoundary ?? "");
  if (framesPicked !== state.framesPicked) {
    state.framesPicked = framesPicked;
    drawGroups(state, state.groupList);
  }
  for (const v of state.order)
    v.root.alpha = baseAlpha(v.node) * (f && !f.nodes.has(v.node.id) ? 0.3 : 1);
  drawStaticEdges(state);
  drawMiniNodes(state);
}
