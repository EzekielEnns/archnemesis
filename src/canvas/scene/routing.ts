// Which sides every arrow uses and where along them, and handing boxes and arrows to the
// router for elbow and straight lines.
import {
  BoxGrid,
  chooseSides,
  intersects,
  fanSides,
  pinOffset,
  ports,
  type Rect,
  route,
  routeBox,
  sides,
} from "../../../shared/geometry";
import { routerEdges } from "../../../shared/router.ts";
import { endRect, shapeOf } from "./lookup";
import { pad } from "./measure";
import type { SceneState } from "./state";
import { AVOID_LIMIT, ROUTE_AROUND_LIMIT } from "./theme";
import type { Dirty } from "./types";

/** Is the router drawing arrows right now (style, loaded, and the diagram not too big)? */
export function routed(state: SceneState): boolean {
  return (
    state.arrowStyle !== "curved" &&
    state.avoid !== null &&
    !state.avoid.failed &&
    state.order.length <= AVOID_LIMIT
  );
}

/** Tell the router where every box and arrow is now; it re-routes what that touches. */
export function syncAvoid(state: SceneState): void {
  if (!routed(state)) return;
  const boxes = new Map<string, Rect>();
  for (const v of state.order)
    boxes.set(v.node.id, { x: v.node.x, y: v.node.y, w: v.node.w, h: v.node.h });
  const list = [...state.edges.values()].map((ev) => ({
    ...ev.edge,
    shape: shapeOf(state, ev.edge),
  }));
  const ends = new Map([...boxes, ...state.frameEnds]);
  const style = state.arrowStyle === "straight" ? "straight" : "elbow";
  try {
    state.avoid!.sync(boxes, routerEdges(list, ends, boxes), style);
  } catch (e) {
    // Never let the router break drawing: drop it, and arrows go back to curves.
    console.warn("archnm: arrow router failed; arrows are curved for now", e);
    state.avoid?.destroy();
    state.avoid = null;
  }
}

/**
 * Which sides every arrow uses (around boxes in the way) and where along them.
 * With `dirty`, only the arrows that could have changed are re-routed: ones touching a
 * moved box, ones whose curve reaches where a box was or now is, and any listed.
 */
export function recomputeRoutes(state: SceneState, dirty?: Dirty): void {
  const all = [...state.edges.values()].map((ev) => ev.edge);
  const rect = (id: string) => endRect(state, id);
  if (state.order.length > ROUTE_AROUND_LIMIT) {
    state.sideMap.clear();
  } else {
    const grid = new BoxGrid();
    for (const v of state.order) grid.add(v.node.id, v.node);
    if (!dirty) {
      state.sideMap = chooseSides(all, rect, grid);
    } else {
      const areas = dirty.areas.map((a) => pad(a, 16));
      const redo = all.filter((e) => {
        if (
          dirty.ids.has(e.from) ||
          dirty.ids.has(e.to) ||
          dirty.edges?.has(e.id) ||
          !state.sideMap.has(e.id)
        )
          return true;
        if (!areas.length) return false;
        const a = rect(e.from);
        const b = rect(e.to);
        if (!a || !b) return false;
        // Its current curve, and the direct one it would take if nothing were in the way
        // (a detour can come back once a box moves off the direct line).
        const now = routeBox(route(a, b, 0, 0, state.sideMap.get(e.id)));
        const direct = routeBox(route(a, b, 0, 0, sides(a, b)));
        return areas.some((r) => intersects(now, r) || intersects(direct, r));
      });
      for (const e of all) if (!state.sideMap.has(e.id)) redo.push(e);
      for (const [id, sides] of chooseSides(redo, rect, grid)) state.sideMap.set(id, sides);
      const live = new Set(all.map((e) => e.id));
      for (const id of state.sideMap.keys()) if (!live.has(id)) state.sideMap.delete(id);
    }
  }
  // A fan leaves its box from one spot on one side.
  const fans = fanSides(
    all.map((e) => ({ ...e, shape: shapeOf(state, e) })),
    (id) => (state.views.has(id) ? rect(id) : undefined),
  );
  state.fanMap = new Map([...fans].map(([id, f]) => [id, f.side]));
  for (const [id, { side }] of fans) {
    const e = state.edges.get(id)!.edge;
    const [a, b] = [rect(e.from), rect(e.to)];
    const now = state.sideMap.get(id) ?? (a && b ? sides(a, b) : undefined);
    if (now) state.sideMap.set(id, { from: side, to: now.to });
  }
  state.portMap = ports(all, rect, state.sideMap);
  for (const [id, f] of fans) {
    const a = rect(state.edges.get(id)!.edge.from);
    state.portMap.set(id, {
      a: (a && pinOffset(a, f.side, f.at ?? 0.5)) || 0,
      b: state.portMap.get(id)?.b ?? 0,
    });
  }
  syncAvoid(state);
}
