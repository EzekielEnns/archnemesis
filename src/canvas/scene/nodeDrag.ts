// Dragging boxes (or a frame with everything in it): the grid, alignment with neighbours, what
// they'd be dropped into, and the live positions.
import { boundsOf, type Point } from "../../../shared/geometry";
import type { CanvasGroup } from "../types";
import { drawGroups } from "./groups";
import { dropTargetAt } from "./hit";
import { beginLiveEdges, redrawLive } from "./live";
import { gridSnap, neighbourSnap } from "./snap";
import type { SceneState } from "./state";
import { DRAG_THRESHOLD } from "./theme";
import type { Drag } from "./types";
import { tellWatchers } from "./watch";

type NodesDrag = Extract<Drag, { kind: "nodes" }>;

/** A frame being dragged remembers how far it has been carried (dx, dy), to move only the rest. */
type CarriedGroup = CanvasGroup & { dx?: number; dy?: number };

/**
 * Start dragging a frame (a file's, a boundary's, the opened box's): the boxes inside it move
 * together and the frame, drawn around them, follows. False when it holds no box, or the tool
 * isn't select (the view tool only pans).
 */
export function dragFrame(state: SceneState, id: string, world: Point, screen: Point): boolean {
  if (state.tool !== "select") return false;
  const g = state.groupList.find((x) => x.id === id);
  if (!g) return false;
  const ids = state.order
    .filter(
      (v) =>
        v.node.x >= g.x &&
        v.node.y >= g.y &&
        v.node.x + v.node.w <= g.x + g.w &&
        v.node.y + v.node.h <= g.y + g.h,
    )
    .map((v) => v.node.id);
  if (!ids.length) return false;
  const origin = new Map<string, Point>();
  for (const i of ids) {
    const n = state.views.get(i)!.node;
    origin.set(i, { x: n.x, y: n.y });
  }
  state.drag = {
    kind: "nodes",
    ids,
    start: world,
    startScreen: screen,
    origin,
    moved: false,
    frame: id,
  };
  return true;
}

/** Simple mode: the frame the dragged boxes started in (leaving it takes them out). */
function frameStartedIn(state: SceneState, d: NodesDrag): CanvasGroup | null {
  const lead = d.origin.get(d.ids[0]!);
  const v = state.views.get(d.ids[0]!);
  return state.simple && !d.frame && lead && v
    ? (state.groupList
        .filter(
          (g) =>
            (g.container || g.inset) &&
            lead.x >= g.x &&
            lead.y >= g.y &&
            lead.x + v.node.w <= g.x + g.w &&
            lead.y + v.node.h <= g.y + g.h,
        )
        .sort((a, b) => (b.depth ?? 0) - (a.depth ?? 0) || a.w * a.h - b.w * b.h)[0] ?? null)
    : null;
}

/** The press has moved far enough to be a drag: what's dragged goes to the live layer. */
function beginDrag(state: SceneState, d: NodesDrag, screen: Point): boolean {
  if (Math.hypot(screen.x - d.startScreen.x, screen.y - d.startScreen.y) < DRAG_THRESHOLD)
    return false;
  d.moved = true;
  state.dropFrom = frameStartedIn(state, d);
  // A dragged frame takes its own lines (and those of the frames in it) along.
  const g = d.frame ? state.groupList.find((x) => x.id === d.frame) : undefined;
  const frames = g
    ? [...state.frameEnds]
        .filter(
          ([, r]) => r.x >= g.x && r.y >= g.y && r.x + r.w <= g.x + g.w && r.y + r.h <= g.y + g.h,
        )
        .map(([id]) => id)
    : [];
  beginLiveEdges(state, [...d.ids, ...frames]);
  state.app.canvas.style.cursor = "grabbing";
  return true;
}

/** How far the boxes move: on the grid, then lined up with neighbours (hold ⌥ for neither). */
function snappedMove(
  state: SceneState,
  d: NodesDrag,
  world: Point,
  free: boolean,
): { dx: number; dy: number } {
  let dx = world.x - d.start.x;
  let dy = world.y - d.start.y;
  // Snap the grabbed box to the grid (hold ⌥ to place freely); the rest move with it.
  const lead = d.origin.get(d.ids[d.ids.length - 1] ?? "");
  if (lead && !free) {
    ({ dx, dy } = gridSnap(lead, dx, dy));
  }
  // Then line up with nearby boxes (edges, centres, equal gaps), which beats the grid.
  state.guides = [];
  if (!free) {
    const moving = boundsOf(
      d.ids.flatMap((id) => {
        const v = state.views.get(id);
        const o = d.origin.get(id);
        return v && o ? [{ x: o.x + dx, y: o.y + dy, w: v.node.w, h: v.node.h }] : [];
      }),
    );
    if (moving) {
      const snap = neighbourSnap(moving, new Set(d.ids), state.order, state.camera.scale);
      dx += snap.dx;
      dy += snap.dy;
      state.guides = snap.guides;
    }
  }
  return { dx, dy };
}

/** Simple mode: what they'd go into, by where the pointer is (a frame dragged whole: nothing). */
function showDropHint(state: SceneState, d: NodesDrag, world: Point, e: PointerEvent): void {
  state.dropInto = dropTargetAt(state, world, new Set(d.ids));
  const into = state.dropInto
    ? (state.views.get(state.dropInto)?.node.name ??
      state.groupList.find((x) => x.id === state.dropInto)?.name)
    : null;
  const from = state.dropFrom;
  const out =
    !state.dropInto &&
    from &&
    !(
      world.x >= from.x &&
      world.x <= from.x + from.w &&
      world.y >= from.y &&
      world.y <= from.y + from.h
    );
  const what = d.ids.length === 1 ? "" : ` ${d.ids.length}`;
  const text =
    into && state.dropInto !== from?.id
      ? `Put${what} inside ${into}`
      : out
        ? `Take${what} out of ${from!.name}`
        : null;
  state.cb.onDropHint?.(text ? { text, x: e.clientX, y: e.clientY } : null);
}

/** The frame comes along with the boxes it holds, and every frame inside it. */
function carryFrame(state: SceneState, d: NodesDrag): void {
  const g = state.groupList.find((x) => x.id === d.frame);
  const lead = d.origin.get(d.ids[0]!);
  const now = state.views.get(d.ids[0]!)?.node;
  if (g && lead && now) {
    const sx = now.x - lead.x - ((g as CarriedGroup).dx ?? 0);
    const sy = now.y - lead.y - ((g as CarriedGroup).dy ?? 0);
    // Itself and every frame inside it (files, boundaries, lanes), whatever kind it is.
    const inside = state.groupList.filter(
      (x) =>
        x === g || (x.x >= g.x && x.y >= g.y && x.x + x.w <= g.x + g.w && x.y + x.h <= g.y + g.h),
    );
    for (const x of inside) {
      x.x += sx;
      x.y += sy;
    }
    (g as CarriedGroup).dx = now.x - lead.x;
    (g as CarriedGroup).dy = now.y - lead.y;
    drawGroups(state, state.groupList);
  }
}

/** The pointer moved with boxes held: move them (snapped), and redraw what follows. */
export function dragNodes(
  state: SceneState,
  d: NodesDrag,
  screen: Point,
  world: Point,
  e: PointerEvent,
): void {
  if (!d.moved && !beginDrag(state, d, screen)) return;
  const { dx, dy } = snappedMove(state, d, world, e.altKey);
  for (const id of d.ids) {
    const v = state.views.get(id);
    const o = d.origin.get(id);
    if (!v || !o) continue;
    v.node = { ...v.node, x: o.x + dx, y: o.y + dy };
    v.root.position.set(v.node.x, v.node.y);
  }
  const live = d.ids.flatMap((id) => {
    const n = state.views.get(id)?.node;
    return n ? [{ id, x: n.x, y: n.y, w: n.w, h: n.h }] : [];
  });
  if (state.simple && !d.frame) showDropHint(state, d, world, e);
  if (d.frame) carryFrame(state, d);
  state.cb.onDragging?.(live);
  state.moving = new Map(live.map((m) => [m.id, { x: m.x, y: m.y }]));
  tellWatchers(state);
  redrawLive(state);
}
