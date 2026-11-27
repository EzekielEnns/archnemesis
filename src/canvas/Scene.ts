// The diagram canvas: PixiJS on WebGL, driven by its own code rather than React, so a
// drag or a zoom never re-renders a component.
//
// It draws on demand (nothing changes, nothing is drawn), hides boxes outside the view,
// drops labels when they'd be too small to read, and keeps a dragged box's edges on their
// own layer so a drag redraws a handful of curves, not all of them. Pointer handling is
// its own: one hit test per event against plain rects and curves, not Pixi's events.
//
// It knows nothing about the model: it's handed a CanvasGraph (shared/project.ts) and
// reports what the user did through callbacks; the app turns those into model edits.
import type { Camera } from "./camera";
import type { Point } from "../../shared/geometry";
import type { ArrowStyle } from "../../shared/model.ts";
import { setArrowStyle } from "./scene/arrows";
import { exportPng } from "./scene/exportPng";
import { renderFrame, requestRender } from "./scene/frame";
import { forwardWheel } from "./scene/input";
import { destroy, init } from "./scene/lifecycle";
import { toggleMinimap } from "./scene/minimap";
import { replaceView } from "./scene/nodes";
import { drawOverlay } from "./scene/overlay";
import { setPeers } from "./scene/peers";
import {
  clientRectOf,
  clientRectOfGroup,
  clientToWorld,
  connectionAnchor,
  edgeAt,
  edgeLabelAt,
  edgeLabelClient,
  isEmpty,
  nodeAt,
  viewCenter,
} from "./scene/queries";
import { select } from "./scene/selection";
import { spotlight } from "./scene/spotlight";
import { SceneState } from "./scene/state";
import { sync } from "./scene/sync";
import type { Peer, SceneCallbacks, SceneView, Selection, Spotlight, Tool } from "./scene/types";
import {
  centerAt,
  centerOn,
  centerSelection,
  fit,
  frameBoxes,
  glide,
  reveal,
  setInsetLeft,
  setView,
  zoomBy,
  zoomTo,
} from "./scene/view";
import { watch } from "./scene/watch";
import type { CanvasGraph } from "./types";
export type {
  SceneStats,
  Selection,
  ContextTarget,
  Spotlight,
  SceneCallbacks,
  SceneView,
  Tool,
  Peer,
} from "./scene/types";
export { KIND_COLOR } from "./scene/theme";

export class Scene {
  private state: SceneState;

  constructor(callbacks: SceneCallbacks = {}) {
    this.state = new SceneState(callbacks);
    const state = this.state;
    state.frame = (now) => renderFrame(state, now);
    state.replaceView = (v, n, sig) => replaceView(state, v, n, sig);
    state.fetchIcon = callbacks.loadIcon ?? noIcon;
  }

  /** Resolves false if the scene was destroyed while Pixi was starting. */
  init(host: HTMLElement): Promise<boolean> {
    return init(this.state, host);
  }

  destroy(): void {
    destroy(this.state);
  }

  fit(): void {
    fit(this.state);
  }

  /** Curved, elbow or straight. Elbow and straight load the router the first time (curves until then). */
  setArrowStyle(style: ArrowStyle): void {
    setArrowStyle(this.state, style);
  }

  /** The drawer covers this much of the canvas's left edge. The canvas itself never resizes. */
  setInsetLeft(px: number): void {
    setInsetLeft(this.state, px);
  }

  zoomBy(factor: number): void {
    zoomBy(this.state, factor);
  }

  getCamera(): Camera {
    return this.state.camera;
  }

  setView(c: Camera): void {
    setView(this.state, c);
  }

  /**
   * Pan (not zoom) just enough that these boxes are in view and clear of the panels
   * (insets in screen px), if they aren't already.
   */
  reveal(ids: string[], insets = { left: 0, right: 0, top: 0, bottom: 0 }): void {
    reveal(this.state, ids, insets);
  }

  /** Pan (not zoom) so a box is in the middle of the view; `smooth` glides there. */
  centerOn(id: string, smooth = false): void {
    centerOn(this.state, id, smooth);
  }

  /** Glide to boxes so they all fit (a guided tour's step), zooming no closer than 100%. */
  frameBoxes(ids: string[]): void {
    frameBoxes(this.state, ids);
  }

  /** Ease the camera to `to` over ~half a second (a jump when the person prefers less motion). */
  glide(to: Camera, ms = 550): void {
    glide(this.state, to, ms);
  }

  /** Follow the camera and live drags (for notes drawn over the canvas). Returns an unwatch. */
  watch(fn: (v: SceneView) => void): () => void {
    return watch(this.state, fn);
  }

  /** The box at a diagram point, if any. */
  nodeAt(world: Point): string | null {
    return nodeAt(this.state, world);
  }

  /** Scroll or zoom from something laid over the canvas (a note), as if it were the canvas. */
  forwardWheel(e: WheelEvent): void {
    forwardWheel(this.state, e);
  }

  /** Bring a diagram point to the middle of the view. */
  centerAt(p: Point, smooth = false): void {
    centerAt(this.state, p, smooth);
  }

  /** Where a page point (a drop, say) lands in the diagram. */
  clientToWorld(clientX: number, clientY: number): Point {
    return clientToWorld(this.state, clientX, clientY);
  }

  viewCenter(): Point {
    return viewCenter(this.state);
  }

  /** Dots on every arrow, not only on what's selected or lit (a per-person choice). */
  setAnimate(on: boolean): void {
    this.state.animateAll = on;
    if (!this.state.ready) return;
    requestRender(this.state);
  }

  /** Light up a flow step (or a tag): overrides the selection's focus until cleared. */
  spotlight(spec: Spotlight | null): void {
    spotlight(this.state, spec);
  }

  setSimple(on: boolean): void {
    this.state.simple = on;
  }

  setGroupDraw(on: boolean): void {
    this.state.groupDraw = on;
    this.state.app.canvas.style.cursor = on ? "crosshair" : "";
  }

  /** The connect tool: a drag from a box draws a connection. */
  setConnecting(on: boolean): void {
    this.state.connecting = on;
  }

  setTool(t: Tool): void {
    this.state.tool = t;
    this.state.knob = null;
    this.state.app.canvas.style.cursor = t === "place" ? "crosshair" : "";
    drawOverlay(this.state);
    requestRender(this.state);
  }

  /** Zoom about the middle of the view to an exact scale. */
  zoomTo(scale: number): void {
    zoomTo(this.state, scale);
  }

  /** Pan so the selection (or, with nothing selected, the whole diagram) is in the middle, keeping the zoom. */
  center(): void {
    centerSelection(this.state);
  }

  toggleMinimap(on = !this.state.miniOn): void {
    toggleMinimap(this.state, on);
  }

  /** Where an arrow's label sits on the diagram (its middle, when it has no label), and its size. */
  edgeLabelAt(id: string): { x: number; y: number; w: number; h: number } | null {
    return edgeLabelAt(this.state, id);
  }

  /** The arrow at a diagram point, if any: its connections. */
  edgeAt(world: Point): { id: string; connectionIds: string[] } | null {
    return edgeAt(this.state, world);
  }

  /** The middle of the arrow a connection is drawn on here (where its label sits), live. */
  connectionAnchor(connectionId: string): Point | null {
    return connectionAnchor(this.state, connectionId);
  }

  /** Where an arrow's label sits on the page. */
  edgeLabelClient(id: string): Point | null {
    return edgeLabelClient(this.state, id);
  }

  isEmpty(): boolean {
    return isEmpty(this.state);
  }

  select(sel: Selection, notify = false): void {
    select(this.state, sel, notify);
  }

  /** Bring the canvas in line with a new projection: only what changed is rebuilt. */
  sync(graph: CanvasGraph): void {
    sync(this.state, graph);
  }

  /** The whole diagram as a PNG, at 2x, on the canvas background. */
  exportPng(): Promise<Blob | null> {
    return exportPng(this.state);
  }

  /** Show who else is here. Cheap: one Graphics and a label per person. */
  setPeers(peers: Peer[]): void {
    setPeers(this.state, peers);
  }

  /** A frame's rectangle on the page (a boundary is "boundary:<id>"). */
  clientRectOfGroup(id: string): { x: number; y: number; w: number; h: number } | null {
    return clientRectOfGroup(this.state, id);
  }

  /** A box's rect in page coordinates, for editing its name in place. */
  clientRectOf(id: string): { x: number; y: number; w: number; h: number; scale: number } | null {
    return clientRectOf(this.state, id);
  }
}

/** Without a loader from the caller there are no technology logos: the canvas makes no requests itself. */
const noIcon = (): Promise<string | null> => Promise.resolve(null);
