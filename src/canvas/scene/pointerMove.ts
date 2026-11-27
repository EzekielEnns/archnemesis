// The pointer moving: hover while nothing is held, and each kind of drag while one is.
import { panBy, screenToWorld } from "../camera";
import type { Point } from "../../../shared/geometry";
import { dragArrow } from "./arrows";
import { requestRender } from "./frame";
import { hitArrowPart, hitBoundary, hitEdge, hitHandle, hitNode, hitResize, hitScope } from "./hit";
import { beginLiveEdges, redrawLive } from "./live";
import { local } from "./lookup";
import { nearestOnBorder, signature } from "./measure";
import { inMinimap } from "./minimap";
import { dragNodes } from "./nodeDrag";
import { drawMarquee, drawOverlay } from "./overlay";
import { emitSelect, setHovered } from "./selection";
import { resizedSize } from "./snap";
import type { SceneState } from "./state";
import { BOUNDARY_LABEL } from "./theme";
import type { Drag, EdgeView, NodeView } from "./types";
import { panToMinimap, setCamera } from "./view";

/** Over the minimap, the resize corner or a handle of the selected arrow: say so by the cursor. */
function cursorOverControl(state: SceneState, screen: Point, world: Point): boolean {
  if (inMinimap(state, screen)) {
    state.app.canvas.style.cursor = "pointer";
    return true;
  }
  if (hitResize(state, world)) {
    state.app.canvas.style.cursor = "nwse-resize";
    return true;
  }
  if (state.tool === "select" && hitArrowPart(state, world)) {
    state.app.canvas.style.cursor = "move";
    return true;
  }
  return false;
}

/** The arrow under the pointer is lit; a merged arrow ("3 connections") lists what it stands for. */
function hoverEdge(state: SceneState, edge: EdgeView | null): void {
  const edgeId = edge?.edge.id ?? null;
  if (edgeId !== state.hoveredEdge) {
    state.hoveredEdge = edgeId;
    // A merged arrow ("3 connections") lists what it stands for.
    const merged = edge?.edge.merged;
    state.app.canvas.title = merged?.length
      ? merged.join("\n")
      : edge?.short
        ? edge.edge.label
        : "";
    drawOverlay(state);
    requestRender(state);
  }
}

/** Over a frame's title: say which kind of frame it is (they look alike otherwise). */
function frameTitleHint(state: SceneState, world: Point): void {
  const b = hitBoundary(state, world);
  const grp = b ? state.groupList.find((g) => g.id === `boundary:${b}`) : null;
  const scope =
    !b && hitScope(state, world)
      ? state.groupList.find((g) => !g.boundary && !g.lane && !g.container)
      : null;
  state.app.canvas.title = grp
    ? `${grp.name}: where these run (a ${BOUNDARY_LABEL[grp.boundary!] ?? grp.boundary}, dashed). Not what they're part of.`
    : scope
      ? `${scope.name}: what's inside this box (solid frame). Click to select it.`
      : "";
}

/** The cursor over what's under the pointer. */
function hoverCursor(
  state: SceneState,
  world: Point,
  under: { hit: NodeView | null; handle: string | null; edge: EdgeView | null },
): void {
  const { hit, handle, edge } = under;
  state.app.canvas.style.cursor =
    state.tool === "place"
      ? "crosshair"
      : handle
        ? "crosshair"
        : hit || edge
          ? "grab"
          : state.tool === "select" && (hitBoundary(state, world) || hitScope(state, world))
            ? "pointer"
            : "";
}

/** Nothing held: light up what's under the pointer, and say what a press would do. */
function hoverMove(state: SceneState, screen: Point, world: Point): void {
  if (cursorOverControl(state, screen, world)) return;
  const hit = hitNode(state, world);
  const handle = hitHandle(state, world);
  const edge = hit || handle ? null : hitEdge(state, world);
  hoverEdge(state, edge);
  setHovered(state, hit?.node.id ?? (handle ? state.hovered : null));
  const box = handle && state.tool === "select" ? state.views.get(handle)?.node : undefined;
  const knob = box ? nearestOnBorder(box, world) : null;
  if (knob || state.knob) {
    state.knob = knob;
    drawOverlay(state);
    requestRender(state);
  }
  if (!hit && !handle && !edge) frameTitleHint(state, world);
  hoverCursor(state, world, { hit, handle, edge });
}

/** A drag on empty canvas: the camera follows the pointer. */
function dragPan(state: SceneState, d: Extract<Drag, { kind: "pan" }>, screen: Point): void {
  d.moved ||= Math.hypot(screen.x - d.last.x, screen.y - d.last.y) > 0;
  if (d.moved && d.was) {
    // Not a click after all: panning keeps what was picked.
    state.selected = new Set(d.was.nodes);
    state.selectedEdge = d.was.edge;
    state.selectedBoundary = d.was.boundary ?? null;
    state.selectedScope = !!d.was.diagram;
    d.was = undefined;
    emitSelect(state, true, true);
    drawOverlay(state);
  }
  const next = panBy(state.camera, screen.x - d.last.x, screen.y - d.last.y);
  d.last = screen;
  setCamera(state, next);
}

/** A box's corner dragged: its size follows, on the grid. */
function dragResize(state: SceneState, d: Extract<Drag, { kind: "resize" }>, world: Point): void {
  const v = state.views.get(d.id);
  if (!v) return;
  if (!d.moved) {
    d.moved = true;
    beginLiveEdges(state, [d.id]);
  }
  const { w, h } = resizedSize(d.origin, d.start, world);
  if (w === v.node.w && h === v.node.h) return;
  const n = { ...v.node, w, h };
  state.replaceView(v, n, signature(n));
  redrawLive(state);
}

/** A connection dragged from a box: the box under the pointer is its target. */
function dragConnect(state: SceneState, d: Extract<Drag, { kind: "connect" }>, world: Point): void {
  d.current = world;
  const hit = hitNode(state, world);
  d.target = hit && hit.node.id !== d.from ? hit.node.id : null;
  // A branch goes somewhere its arrow doesn't already.
  if (d.like && d.target === state.edges.get(d.like)?.edge.to) d.target = null;
  // Over an arrow, not a box: dropped here it joins that arrow, into the box it goes to.
  const over = d.target || d.like ? null : hitEdge(state, world);
  d.onto =
    over && over.edge.from !== d.from && over.edge.to !== d.from && state.views.has(over.edge.to)
      ? over.edge.id
      : null;
  drawOverlay(state);
  requestRender(state);
}

export function onPointerMove(state: SceneState, e: PointerEvent): void {
  const screen = local(state, e);
  const world = screenToWorld(state.camera, screen);
  state.cb.onPointer?.(world);
  const d = state.drag;
  if (!d) hoverMove(state, screen, world);
  else if (d.kind === "arrow") dragArrow(state, d, world, e.altKey);
  else if (d.kind === "pan") dragPan(state, d, screen);
  else if (d.kind === "minimap") panToMinimap(state, screen);
  else if (d.kind === "resize") dragResize(state, d, world);
  else if (d.kind === "marquee") {
    d.current = screen;
    drawMarquee(state);
    requestRender(state);
  } else if (d.kind === "connect") dragConnect(state, d, world);
  else dragNodes(state, d, screen, world, e);
}
