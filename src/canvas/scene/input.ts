// Wiring the browser's events to the canvas: pointer, wheel, keys, resizing.
import { panBy, screenToWorld, zoomAt } from "../camera";
import type { Rect } from "../../../shared/geometry";
import type { ArrowShape } from "../../../shared/model.ts";
import { commitShape } from "./arrows";
import { drawStaticEdges } from "./edges";
import { requestRender } from "./frame";
import { hitArrowPart, hitEdge, hitNode } from "./hit";
import { local, shapeOf } from "./lookup";
import { drawMinimap, inMinimap } from "./minimap";
import { drawOverlay } from "./overlay";
import { onPointerDown } from "./pointerDown";
import { onPointerMove } from "./pointerMove";
import { onPointerUp } from "./pointerUp";
import { edgeLabelClient } from "./queries";
import { recomputeRoutes, syncAvoid } from "./routing";
import { select, setHovered } from "./selection";
import type { SceneState } from "./state";
import { SNAP } from "./theme";
import { fit, setCamera, zoomBy } from "./view";

/** Scroll or zoom from something laid over the canvas (a note), as if it were the canvas. */
export function forwardWheel(state: SceneState, e: WheelEvent): void {
  onWheel(state, e);
}

export function bindInput(state: SceneState, host: HTMLElement): void {
  const canvas = state.app.canvas;
  const on = <K extends keyof HTMLElementEventMap>(
    el: HTMLElement | Window,
    type: K,
    fn: (e: HTMLElementEventMap[K]) => void,
    opts?: AddEventListenerOptions,
  ) => {
    el.addEventListener(type, fn as EventListener, opts);
    state.cleanup.push(() => el.removeEventListener(type, fn as EventListener, opts));
  };

  on(canvas, "pointerdown", (e) => onPointerDown(state, e));
  on(canvas, "pointermove", (e) => onPointerMove(state, e));
  on(canvas, "pointerup", (e) => onPointerUp(state, e));
  on(canvas, "pointercancel", (e) => onPointerUp(state, e));
  on(canvas, "pointerleave", () => {
    state.cb.onPointer?.(null);
    if (state.drag) return;
    state.hoveredEdge = null;
    state.knob = null;
    setHovered(state, null);
    drawOverlay(state);
    requestRender(state);
  });
  on(canvas, "dblclick", (e) => {
    const p = screenToWorld(state.camera, local(state, e));
    // On the selected arrow: a bend goes, an end lets go of its side.
    const part = hitArrowPart(state, p);
    const sel = state.selectedEdge ? state.edges.get(state.selectedEdge) : undefined;
    if (part && sel) {
      const s: ArrowShape = {
        ...(shapeOf(state, sel.edge) ?? { diagramId: "", from: sel.edge.from, to: sel.edge.to }),
      };
      if (part.part === "bend") s.bends = (s.bends ?? []).filter((_, i) => i !== part.index);
      else delete s[part.part === "from" ? "fromSide" : "toSide"];
      state.shaping = { edge: sel.edge.id, shape: s };
      syncAvoid(state);
      drawStaticEdges(state);
      drawOverlay(state);
      requestRender(state);
      commitShape(state, sel.edge.id, s);
      return;
    }
    const hit = hitNode(state, p);
    if (!hit) {
      const edge = hitEdge(state, p);
      const at = edge && edgeLabelClient(state, edge.edge.id);
      if (edge && at) state.cb.onEditEdge?.(edge.edge.id, at.x, at.y);
      return;
    }
    // The name line renames; anywhere else on the box opens it. A folded box isn't one
    // object (renaming it would rename its first member): it only opens.
    if (!hit.node.folded && p.y - hit.node.y < 34 && p.x - hit.node.x > 24)
      state.cb.onRename?.(hit.node.id);
    else state.cb.onOpen?.(hit.node.id);
  });
  on(canvas, "contextmenu", (e) => {
    e.preventDefault();
    const world = screenToWorld(state.camera, local(state, e));
    const hit = hitNode(state, world);
    const edge = hit ? null : hitEdge(state, world);
    // Simple mode, on empty canvas: a right-drag selects, so the menu waits for the release
    // (macOS sends this on press), and none comes after a drag (Windows sends it on release).
    if (state.simple && !hit && !edge) {
      if (state.rightDragged) {
        state.rightDragged = false;
        return;
      }
      if (state.drag?.kind === "marquee" && state.drag.right) {
        state.pendingContext = { clientX: e.clientX, clientY: e.clientY, world };
        return;
      }
    }
    if (hit && !state.selected.has(hit.node.id))
      select(state, { nodes: [hit.node.id], edge: null }, true);
    if (edge) select(state, { nodes: [], edge: edge.edge.id }, true);
    state.cb.onContext?.({
      kind: hit ? "node" : edge ? "edge" : "canvas",
      id: hit?.node.id ?? edge?.edge.id ?? null,
      clientX: e.clientX,
      clientY: e.clientY,
      world,
    });
  });
  on(canvas, "wheel", (e) => onWheel(state, e), { passive: false });
  on(window, "keydown", (e) => onKey(state, e));
  on(window, "keydown", (e) => {
    const t = e.target as HTMLElement | null;
    if (
      e.key === " " &&
      !(t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(t.tagName)))
    ) {
      state.space = true;
      if (state.simple) e.preventDefault();
    }
  });
  on(window, "keyup", (e) => {
    if (e.key === " ") state.space = false;
  });

  const ro = new ResizeObserver(() => {
    const { width, height } = host.getBoundingClientRect();
    state.size = { w: Math.max(1, width), h: Math.max(1, height) };
    state.app.renderer.resize(state.size.w, state.size.h);
    if (state.grid) {
      state.grid.width = state.size.w;
      state.grid.height = state.size.h;
    }
    drawMinimap(state);
    setCamera(state, state.camera);
  });
  ro.observe(host);
  state.cleanup.push(() => ro.disconnect());
}

/** Trackpad: two fingers pan, a pinch zooms (it arrives as a ctrl-wheel). Mouse: ⌘-wheel zooms. */
function onWheel(state: SceneState, e: WheelEvent): void {
  e.preventDefault();
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? state.size.h : 1;
  const dx = e.deltaX * unit;
  const dy = e.deltaY * unit;
  if (inMinimap(state, local(state, e))) {
    // Over the minimap, any scroll zooms the view about its middle.
    zoomBy(state, Math.exp(-dy * 0.004));
    return;
  }
  if (e.ctrlKey || e.metaKey) {
    const speed = e.ctrlKey ? 0.01 : 0.002;
    setCamera(state, zoomAt(state.camera, local(state, e), Math.exp(-dy * speed)));
  } else {
    setCamera(state, panBy(state.camera, -dx, -dy));
  }
}

function onKey(state: SceneState, e: KeyboardEvent): void {
  const target = e.target as HTMLElement | null;
  if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)))
    return;
  const arrows: Record<string, [number, number]> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  };
  const dir = arrows[e.key];
  if (dir && state.selected.size && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    const step = e.shiftKey ? SNAP * 5 : SNAP;
    const nudged: Rect[] = [];
    const moves = [...state.selected].flatMap((id) => {
      const v = state.views.get(id);
      if (!v) return [];
      const was: Rect = v.node;
      v.node = { ...v.node, x: v.node.x + dir[0] * step, y: v.node.y + dir[1] * step };
      v.root.position.set(v.node.x, v.node.y);
      nudged.push(was, v.node);
      return [{ id, x: v.node.x, y: v.node.y }];
    });
    recomputeRoutes(state, { ids: new Set(moves.map((m) => m.id)), areas: nudged });
    drawStaticEdges(state);
    drawMinimap(state);
    drawOverlay(state);
    requestRender(state);
    state.cb.onMove?.(moves);
    return;
  }
  if (e.key === "F2" && state.selected.size === 1) {
    e.preventDefault();
    state.cb.onRename?.([...state.selected][0]!);
    return;
  }
  if (e.key === "f" && !e.metaKey && !e.ctrlKey) fit(state);
  else if (e.key === "Escape" && (state.selected.size || state.selectedEdge)) {
    select(state, { nodes: [], edge: null }, true);
  } else if (e.key === "a" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    select(state, { nodes: state.order.map((v) => v.node.id), edge: null }, true);
  }
}
