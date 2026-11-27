// Letting go: what each kind of drag does when it ends (select, move, resize, connect, shape).
import { screenToWorld } from "../camera";
import { intersects, nearestT, type Rect, rectFromCorners } from "../../../shared/geometry";
import type { CanvasGroup } from "../types";
import { commitShape } from "./arrows";
import { drawStaticEdges } from "./edges";
import { requestRender } from "./frame";
import { hitBoundary, hitScope } from "./hit";
import { local } from "./lookup";
import { drawMinimap } from "./minimap";
import { drawMarquee, drawOverlay } from "./overlay";
import { recomputeRoutes } from "./routing";
import { emitSelect } from "./selection";
import type { SceneState } from "./state";
import type { Drag } from "./types";
import { tellWatchers } from "./watch";

/** A click on empty canvas (not a drag, not on a frame's title) lets go of what's picked. */
function finishPan(state: SceneState, d: Extract<Drag, { kind: "pan" }>, e: PointerEvent): void {
  if (
    !d.moved &&
    !d.keep &&
    (state.selected.size || state.selectedEdge || state.selectedBoundary || state.selectedScope) &&
    !hitBoundary(state, screenToWorld(state.camera, local(state, e))) &&
    !hitScope(state, screenToWorld(state.camera, local(state, e)))
  ) {
    state.selected.clear(); // a click on empty canvas
    state.selectedEdge = null;
    state.selectedBoundary = null;
    state.selectedScope = false;
    emitSelect(state);
  }
}

/** A marquee ends: a right-click shows the menu; a drag selects (or draws a group around) what it covers. */
function finishMarquee(state: SceneState, d: Extract<Drag, { kind: "marquee" }>): void {
  if (d.right && Math.hypot(d.current.x - d.start.x, d.current.y - d.start.y) < 4) {
    // A right-click, not a drag: the menu (held back when the browser sent it on press).
    drawMarquee(state);
    const pending = state.pendingContext;
    state.pendingContext = null;
    if (pending) state.cb.onContext?.({ kind: "canvas", id: null, ...pending });
    return;
  }
  if (d.right) {
    state.rightDragged = true;
    state.pendingContext = null;
  }
  const area = rectFromCorners(
    screenToWorld(state.camera, d.start),
    screenToWorld(state.camera, d.current),
  );
  // A group takes what's wholly inside the frame drawn; a selection, what it touches.
  const inArea = (v: { node: { x: number; y: number; w: number; h: number } }) =>
    v.node.x >= area.x &&
    v.node.y >= area.y &&
    v.node.x + v.node.w <= area.x + area.w &&
    v.node.y + v.node.h <= area.y + area.h;
  state.selected = new Set(
    state.order
      .filter((v) => (state.groupDraw ? inArea(v) : intersects(v.node, area)))
      .map((v) => v.node.id),
  );
  state.selectedEdge = null;
  state.selectedBoundary = null;
  state.selectedScope = false;
  drawMarquee(state);
  emitSelect(state);
  if (state.groupDraw) state.cb.onGroupDraw?.([...state.selected]);
}

/** Drawn off an arrow: which arrow it forks from (by where that one goes), and how far along. */
function forkSpot(
  state: SceneState,
  d: Extract<Drag, { kind: "connect" }>,
): { of: string; at: number } | undefined {
  const ev = d.like ? state.edges.get(d.like) : undefined;
  if (!ev) return undefined;
  const t = Math.max(0.05, Math.min(0.95, nearestT(ev.route, d.start)));
  return { of: ev.edge.to, at: Math.round(t * 100) / 100 };
}

/** A connection dropped on a box connects them; on nothing, it makes a new box there. */
function finishConnect(state: SceneState, d: Extract<Drag, { kind: "connect" }>): void {
  const far = Math.hypot(d.current.x - d.start.x, d.current.y - d.start.y) * state.camera.scale;
  // The connect tool, and a click not a drag: the box is picked (where the connection starts, or ends).
  if (state.connecting && far < 4) {
    state.selected = new Set(d.like ? [] : [d.from]);
    state.selectedEdge = d.like ?? null;
    state.selectedBoundary = null;
    state.selectedScope = false;
    emitSelect(state);
    return;
  }
  if (d.target) state.cb.onConnect?.(d.from, d.target, d.like, forkSpot(state, d));
  else if (d.like) return;
  else if (Math.hypot(d.current.x - d.start.x, d.current.y - d.start.y) * state.camera.scale > 24) {
    // Dropped on nothing: a new box, there, connected. Inside a file frame, it's in that file.
    const frame = state.groupList
      .filter(
        (g) =>
          g.container &&
          d.current.x >= g.x &&
          d.current.x <= g.x + g.w &&
          d.current.y >= g.y &&
          d.current.y <= g.y + g.h,
      )
      .sort((a, b) => (b.depth ?? 0) - (a.depth ?? 0))[0];
    state.cb.onConnectNew?.(d.from, d.current, frame?.id ?? null);
  }
}

/** A resize ends: the arrows are routed for the new size, and the app told. */
function finishResize(state: SceneState, d: Extract<Drag, { kind: "resize" }>): void {
  state.liveEdges.clear();
  state.liveNodes.clear();
  state.edgesLive.clear();
  const now = state.views.get(d.id)?.node;
  recomputeRoutes(
    state,
    now
      ? { ids: new Set([d.id]), areas: [{ ...now, w: d.origin.w, h: d.origin.h }, now] }
      : undefined,
  );
  drawStaticEdges(state);
  drawMinimap(state);
  const n = state.views.get(d.id)?.node;
  if (n) state.cb.onResize?.(d.id, n.w, n.h);
}

/** A move ends: the arrows are routed for the new places, and the app told where they landed. */
function finishNodes(state: SceneState, d: Extract<Drag, { kind: "nodes" }>): void {
  state.guides = [];
  state.liveEdges.clear();
  state.liveNodes.clear();
  state.edgesLive.clear();
  const areas: Rect[] = [];
  for (const id of d.ids) {
    const n = state.views.get(id)?.node;
    const o = d.origin.get(id);
    if (n) areas.push(n);
    if (n && o) areas.push({ ...n, x: o.x, y: o.y });
  }
  recomputeRoutes(state, { ids: new Set(d.ids), areas });
  drawStaticEdges(state);
  drawMinimap(state);
  const moves = d.ids.flatMap((id) => {
    const n = state.views.get(id)?.node;
    return n ? [{ id, x: n.x, y: n.y }] : [];
  });
  const into = state.simple && !d.frame ? state.dropInto : undefined;
  state.dropInto = null;
  state.dropFrom = null;
  state.cb.onDropHint?.(null);
  if (d.frame) {
    const g = state.groupList.find((x) => x.id === d.frame) as
      (CanvasGroup & { dx?: number; dy?: number }) | undefined;
    if (g) {
      delete g.dx;
      delete g.dy;
    }
  }
  if (moves.length) state.cb.onMove?.(moves, into);
}

export function onPointerUp(state: SceneState, e: PointerEvent): void {
  const d = state.drag;
  state.drag = null;
  if (d?.kind === "nodes" && d.moved) {
    state.cb.onDragging?.(null);
    // Held until the drop comes back as the model: dropped now, pinned notes would jump back.
    setTimeout(() => {
      state.moving = new Map();
      tellWatchers(state);
    }, 120);
  }
  if (state.app.canvas.hasPointerCapture(e.pointerId))
    state.app.canvas.releasePointerCapture(e.pointerId);
  state.app.canvas.style.cursor = state.tool === "place" || state.groupDraw ? "crosshair" : "";
  if (!d) return;
  if (d.kind === "pan") finishPan(state, d, e);
  else if (d.kind === "marquee") finishMarquee(state, d);
  else if (d.kind === "arrow") {
    if (d.moved && state.shaping?.edge === d.edge) commitShape(state, d.edge, state.shaping.shape);
  } else if (d.kind === "connect") finishConnect(state, d);
  else if (d.kind === "resize") {
    if (d.moved) finishResize(state, d);
  } else if (d.kind === "nodes") {
    if (d.moved) finishNodes(state, d);
  }
  drawOverlay(state);
  requestRender(state);
}
