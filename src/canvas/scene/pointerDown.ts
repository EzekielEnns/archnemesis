// A press on the canvas: what it picks up (a drag from a box, a handle, an arrow, a frame,
// the minimap, empty canvas) and the drag it starts.
import { screenToWorld } from "../camera";
import type { Point } from "../../../shared/geometry";
import { requestRender } from "./frame";
import {
  hitArrowPart,
  hitBoundary,
  hitContainer,
  hitEdge,
  hitHandle,
  hitNode,
  hitOffDiagram,
  hitResize,
  hitScope,
} from "./hit";
import { local } from "./lookup";
import { inMinimap } from "./minimap";
import { dragFrame } from "./nodeDrag";
import { drawOverlay } from "./overlay";
import { emitSelect, raise, select } from "./selection";
import type { SceneState } from "./state";
import type { NodeView } from "./types";
import { panToMinimap } from "./view";

/** Simple mode: a right-press on empty canvas starts a marquee; the menu waits for the release. */
function pressRightInSimple(state: SceneState, e: PointerEvent): void {
  state.rightDragged = false;
  const screen = local(state, e);
  const world = screenToWorld(state.camera, screen);
  if (!hitNode(state, world) && !hitEdge(state, world) && !inMinimap(state, screen)) {
    state.app.canvas.setPointerCapture(e.pointerId);
    state.drag = { kind: "marquee", start: screen, current: screen, right: true };
  }
}

/** The group tool, the minimap and the place tool take the press before anything under it. */
function pressOnTool(state: SceneState, e: PointerEvent, screen: Point, world: Point): boolean {
  if (e.button === 0 && state.groupDraw && !inMinimap(state, screen)) {
    state.drag = { kind: "marquee", start: screen, current: screen };
    return true;
  }
  if (e.button === 0 && inMinimap(state, screen)) {
    state.drag = { kind: "minimap" };
    panToMinimap(state, screen);
    return true;
  }
  if (e.button === 0 && state.tool === "place") {
    state.cb.onPlace?.(world);
    return true;
  }
  return false;
}

/** An end or a bend of the selected arrow: dragging it shapes the arrow. */
function pressOnArrowPart(state: SceneState, e: PointerEvent, world: Point): boolean {
  const part = e.button === 0 && state.tool === "select" ? hitArrowPart(state, world) : null;
  if (part && state.selectedEdge) {
    state.drag = {
      kind: "arrow",
      edge: state.selectedEdge,
      part: part.part,
      index: part.index,
      start: world,
      moved: false,
    };
    state.app.canvas.style.cursor = "grabbing";
    return true;
  }
  return false;
}

/** The corner of the one selected box: dragging it resizes. */
function pressOnResize(state: SceneState, e: PointerEvent, world: Point): boolean {
  const resizing = e.button === 0 ? hitResize(state, world) : null;
  if (resizing) {
    const n = state.views.get(resizing)!.node;
    state.drag = {
      kind: "resize",
      id: resizing,
      start: world,
      origin: { w: n.w, h: n.h },
      moved: false,
    };
    return true;
  }
  return false;
}

/** "⇄ N off diagram" sits where the bottom handle does: the words win. */
function pressOnOffDiagram(state: SceneState, e: PointerEvent, world: Point): boolean {
  const off = e.button === 0 && state.tool === "select" ? hitOffDiagram(state, world) : null;
  if (off) {
    select(state, { nodes: [off], edge: null }, true);
    state.cb.onOffDiagram?.(off);
    return true;
  }
  return false;
}

/** The band along the hovered box's border: dragging it draws a connection. */
function pressOnHandle(state: SceneState, e: PointerEvent, world: Point): boolean {
  const handleOf = e.button === 0 ? hitHandle(state, world) : null;
  if (handleOf) {
    state.knob = null;
    state.drag = { kind: "connect", from: handleOf, start: world, current: world, target: null };
    state.app.canvas.style.cursor = "crosshair";
    drawOverlay(state);
    requestRender(state);
    return true;
  }
  return false;
}

/** A file frame's title picks the module, as clicking its box would. */
function pressOnFile(state: SceneState, e: PointerEvent, screen: Point, world: Point): boolean {
  const file = e.button === 0 && !e.shiftKey && !state.space ? hitContainer(state, world) : null;
  if (file) {
    state.selected = new Set([file]);
    state.selectedEdge = null;
    state.selectedBoundary = null;
    state.selectedScope = false;
    emitSelect(state);
    drawOverlay(state);
    requestRender(state);
    // Dragging a frame by its title moves everything in it.
    if (dragFrame(state, file, world, screen)) return true;
    state.drag = { kind: "pan", last: screen, moved: false, keep: true };
    return true;
  }
  return false;
}

/** A boundary frame's title picks the boundary. */
function pressOnBoundary(state: SceneState, e: PointerEvent, screen: Point, world: Point): boolean {
  const frame = e.button === 0 && !e.shiftKey ? hitBoundary(state, world) : null;
  if (frame) {
    state.selected.clear();
    state.selectedEdge = null;
    state.selectedBoundary = frame;
    emitSelect(state);
    drawOverlay(state);
    requestRender(state);
    // Dragging from the title moves the frame with its boxes; a click just picks it.
    if (dragFrame(state, `boundary:${frame}`, world, screen)) return true;
    state.drag = { kind: "pan", last: screen, moved: false, keep: true };
    return true;
  }
  return false;
}

/** The diagram's own frame's title picks the diagram. */
function pressOnScope(state: SceneState, e: PointerEvent, screen: Point, world: Point): boolean {
  if (e.button === 0 && !e.shiftKey && hitScope(state, world)) {
    state.selected.clear();
    state.selectedEdge = null;
    state.selectedBoundary = null;
    state.selectedScope = true;
    emitSelect(state);
    drawOverlay(state);
    requestRender(state);
    const scope = state.groupList.find((g) => !g.boundary && !g.lane && !g.container);
    if (scope && dragFrame(state, scope.id, world, screen)) return true;
    state.drag = { kind: "pan", last: screen, moved: true };
    return true;
  }
  return false;
}

/** An arrow: picks it, and a drag from it shapes it. */
function pressOnEdge(state: SceneState, e: PointerEvent, screen: Point, world: Point): boolean {
  const edge = e.button === 0 && !e.shiftKey ? hitEdge(state, world) : null;
  if (edge) {
    state.selectedBoundary = null;
    state.selectedScope = false;
    state.selected.clear();
    state.selectedEdge = edge.edge.id;
    // Dragging it from here shapes it: its label moves the label, its line adds a bend.
    const l = edge.label && state.edgeLabels.visible ? edge.label.position : null;
    const onLabel =
      !!l &&
      Math.abs(world.x - l.x) <= edge.labelSize.w / 2 &&
      Math.abs(world.y - l.y) <= edge.labelSize.h / 2;
    state.drag =
      state.tool === "view"
        ? { kind: "pan", last: screen, moved: false, keep: true }
        : {
            kind: "arrow",
            edge: edge.edge.id,
            part: onLabel ? "label" : "line",
            index: -1,
            start: world,
            moved: false,
          };
    emitSelect(state);
    drawOverlay(state);
    requestRender(state);
    return true;
  }
  return false;
}

/** Nothing under the press but empty canvas (or a frame, or an arrow). */
function pressOnEmpty(state: SceneState, e: PointerEvent, screen: Point, world: Point): void {
  if (pressOnFile(state, e, screen, world)) return;
  if (pressOnBoundary(state, e, screen, world)) return;
  if (pressOnScope(state, e, screen, world)) return;
  if (pressOnEdge(state, e, screen, world)) return;
  // A drag on empty canvas pans; shift-drag selects (in simple mode, a right-drag selects too).
  const select = e.button === 0 && e.shiftKey;
  state.drag = select
    ? { kind: "marquee", start: screen, current: screen }
    : { kind: "pan", last: screen, moved: false };
  // A press on empty canvas lets go of what's picked there and then, not on the release (which
  // read as a lag). If it turns out to be a drag, that's a pan: what was picked comes back.
  if (
    state.drag.kind === "pan" &&
    e.button === 0 &&
    (state.selected.size || state.selectedEdge || state.selectedBoundary || state.selectedScope)
  ) {
    state.drag.was = {
      nodes: [...state.selected],
      edge: state.selectedEdge,
      boundary: state.selectedBoundary,
      diagram: state.selectedScope,
    };
    state.selected.clear();
    state.selectedEdge = null;
    state.selectedBoundary = null;
    state.selectedScope = false;
    emitSelect(state);
    drawOverlay(state);
    requestRender(state);
  }
  state.app.canvas.style.cursor = state.drag.kind === "pan" ? "grabbing" : "crosshair";
}

/** A box: picks it (shift adds), and a drag from it moves what's picked. */
function pressOnNode(
  state: SceneState,
  e: PointerEvent,
  hit: NodeView,
  screen: Point,
  world: Point,
): void {
  const id = hit.node.id;
  state.selectedEdge = null;
  state.selectedBoundary = null;
  state.selectedScope = false;
  if (e.shiftKey) {
    if (state.selected.has(id)) state.selected.delete(id);
    else state.selected.add(id);
  } else if (!state.selected.has(id)) {
    state.selected = new Set([id]);
  }
  // Viewing: the click picks it; a drag from it pans, nothing moves.
  if (state.tool === "view") {
    state.selected = new Set([id]);
    emitSelect(state);
    state.drag = { kind: "pan", last: screen, moved: false, keep: true };
    drawOverlay(state);
    requestRender(state);
    return;
  }
  emitSelect(state);
  raise(state, hit);
  const ids = [...state.selected];
  const origin = new Map<string, Point>();
  for (const sid of ids) {
    const n = state.views.get(sid)?.node;
    if (n) origin.set(sid, { x: n.x, y: n.y });
  }
  state.drag = { kind: "nodes", ids, start: world, startScreen: screen, origin, moved: false };
  drawOverlay(state);
  requestRender(state);
}

export function onPointerDown(state: SceneState, e: PointerEvent): void {
  if (state.simple && e.button === 2) {
    pressRightInSimple(state, e);
    return;
  }
  if (e.button !== 0 && e.button !== 1) return;
  state.app.canvas.setPointerCapture(e.pointerId);
  const screen = local(state, e);
  const world = screenToWorld(state.camera, screen);

  if (pressOnTool(state, e, screen, world)) return;
  if (pressOnArrowPart(state, e, world)) return;
  if (pressOnResize(state, e, world)) return;
  if (pressOnOffDiagram(state, e, world)) return;
  if (pressOnHandle(state, e, world)) return;

  const hit = e.button === 0 && !(state.simple && state.space) ? hitNode(state, world) : null;
  // The connect tool: a drag from a box draws the arrow (a click still picks where it starts).
  if (hit && state.connecting) {
    state.knob = null;
    state.drag = { kind: "connect", from: hit.node.id, start: world, current: world, target: null };
    state.app.canvas.style.cursor = "crosshair";
    return;
  }
  // The connect tool, from an arrow: a branch of it, to wherever it's dropped.
  const off = !hit && state.connecting && e.button === 0 ? hitEdge(state, world) : null;
  if (off && state.views.has(off.edge.from)) {
    state.knob = null;
    state.drag = {
      kind: "connect",
      from: off.edge.from,
      like: off.edge.id,
      start: world,
      current: world,
      target: null,
    };
    state.app.canvas.style.cursor = "crosshair";
    return;
  }
  if (!hit) pressOnEmpty(state, e, screen, world);
  else pressOnNode(state, e, hit, screen, world);
}
