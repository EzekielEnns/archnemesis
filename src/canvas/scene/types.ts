// The shapes the canvas passes around: what it reports (SceneCallbacks, Selection…) and what it keeps
// for each box, arrow and drag. Scene.ts re-exports the public ones.
import { BitmapText, Container } from "pixi.js";
import type { Camera } from "../camera";
import type { Point, Rect, Route } from "../../../shared/geometry";
import type { ArrowShape } from "../../../shared/model.ts";
import type { CanvasEdge, CanvasNode } from "../types";

export interface SceneStats {
  nodes: number;
  edges: number;
  visible: number;
  selected: number;
  scale: number;
  /** Frames drawn in the last second: the display rate while something moves, 0 at rest. */
  fps: number;
  /** CPU time of the last frame, in ms. */
  frameMs: number;
}

export interface Selection {
  nodes: string[];
  edge: string | null;
  /** A boundary, picked by its frame's title. */
  boundary?: string | null;
  /** The diagram itself, picked by its own frame's title (its story, in the inspector). */
  diagram?: boolean;
}

export interface ContextTarget {
  kind: "node" | "edge" | "canvas";
  id: string | null;
  clientX: number;
  clientY: number;
  world: Point;
}

/** A story step lit up on the canvas: boxes, and pairs that should have an arrow between them. */
export interface Spotlight {
  nodes: string[];
  pairs: [string, string][];
  /** Numbered badges for a flow's steps: on the arrow, or on the box for a step inside one. */
  steps?: { from: string; to: string; n: number }[];
  /** A path: its route lit in one colour (amber), no numbers. */
  tone?: "path";
  /** What's new on a fork: these boxes get a ✦ (the rest of nodes are where it plugs in). */
  marked?: string[];
}

/** The SVG text of a technology's logo (null when there is none), in its brand colour. */
export type IconLoader = (technology: string, color?: "brand") => Promise<string | null>;

export interface SceneCallbacks {
  /**
   * How to fetch a technology's logo as SVG text (null: none). Left out, the canvas asks the
   * app's own /api/icon route.
   */
  loadIcon?: IconLoader;
  /** byCode: the app selected it (select(…, true)), not a click. */
  /** back: what was picked before a press on empty canvas, put back because the press was a pan. */
  onSelect?: (sel: Selection, byCode?: boolean, back?: boolean) => void;
  /** Boxes were dragged; their new top-left corners. */
  /**
   * into (simple mode): what they were dropped into: a frame or a box under the pointer, null
   * for empty canvas; undefined when that isn't asked (not simple mode).
   */
  onMove?: (moves: { id: string; x: number; y: number }[], into?: string | null) => void;
  /** Simple mode, while boxes are dragged: what letting go would do, said by the pointer. */
  onDropHint?: (hint: { text: string; x: number; y: number } | null) => void;
  /** The group tool: a frame drawn around these boxes. */
  onGroupDraw?: (ids: string[]) => void;
  /** A connection was dragged from one box's handle onto another box. */
  /** With `like`, it was drawn off that arrow: a fork, off the arrow to `of`, `at` of the way along. */
  /** `split`: drawn off the arrow `like` at this point, where the two part (if `like` has no split point yet). */
  onConnect?: (
    from: string,
    to: string,
    like?: string,
    split?: Point,
    /** Dropped on this arrow, here: the new one joins it at that point on the way into its box. */
    join?: { onto: string; at: Point },
  ) => void;
  /** A split or join point was dragged: these arrows now meet at `at`. False if it can't be saved. */
  onSplitMove?: (
    arrows: { from: string; to: string }[],
    kind: "split" | "join",
    at: Point,
  ) => boolean;
  /**
   * A connection was dragged from a box's handle into empty space: make a new box there,
   * connected to it. `frame` is the file (module) frame it was dropped in, if any.
   */
  onConnectNew?: (from: string, at: Point, frame: string | null) => void;
  /** A box was double-clicked. */
  onOpen?: (id: string) => void;
  /** "⇄ N off diagram" on a box was clicked. */
  onOffDiagram?: (id: string) => void;
  /** A box's name was double-clicked (or F2): edit it in place. */
  onRename?: (id: string) => void;
  /** A box was resized by its corner. */
  onResize?: (id: string, w: number, h: number) => void;
  /** An arrow was double-clicked; where its label is on the page. */
  /** line: which name was double-clicked, on a label that lists several. */
  onEditEdge?: (id: string, clientX: number, clientY: number, line?: number) => void;
  /** An arrow reshaped by hand (null: back to automatic). False if it can't be saved. */
  onArrowShape?: (
    from: string,
    to: string,
    shape: Omit<ArrowShape, "diagramId" | "from" | "to"> | null,
  ) => boolean;
  /** Right-click on a box, an arrow or empty canvas. */
  onContext?: (target: ContextTarget) => void;
  onStats?: (s: SceneStats) => void;
  /** The zoom changed (1 = 100%). */
  onZoom?: (scale: number) => void;
  /** The place tool was clicked on the canvas, at this world point. */
  onPlace?: (world: Point) => void;
  /** Where the pointer is in the world (null when it leaves), for others to see. */
  onPointer?: (world: Point | null) => void;
  /** Boxes being dragged, at their live positions, every move; null when the drag ends. */
  onDragging?: (moves: { id: string; x: number; y: number; w: number; h: number }[] | null) => void;
}

/** What things on top of the canvas (notes, links) need to follow it: the camera, and boxes mid-drag. */
export interface SceneView {
  camera: Camera;
  /** Boxes being dragged here, at their live positions; empty when nothing is. */
  moving: Map<string, { x: number; y: number }>;
}

/** select: the usual. place: a click drops something there. */
/** view: look around: a drag always pans, a click picks a box (to read it) without moving it. */
export type Tool = "select" | "place" | "view";

/** Someone else here: their pointer, what they've selected, what they're dragging. */
export interface Peer {
  key: number;
  name: string;
  color: string;
  cursor: Point | null;
  selected: string[];
  moving: { id: string; x: number; y: number; w: number; h: number }[];
}

/** What changed since the arrows were last routed. */
export interface Dirty {
  /** Boxes that moved or resized. */
  ids: Set<string>;
  /** Where those boxes were and now are (and any added or removed). */
  areas: Rect[];
  /** Arrows that must be routed regardless. */
  edges?: Set<string>;
}

export interface NodeView {
  node: CanvasNode;
  sig: string;
  root: Container;
  title: BitmapText;
  subtitle: BitmapText;
  /** Where "⇄ N off diagram" is on the box (relative to it): a click there shows them. */
  offDiagram?: Rect;
}

export interface EdgeView {
  edge: CanvasEdge;
  route: Route;
  label: Container | null;
  /** The label's size, for clicking on it. */
  labelSize: { w: number; h: number };
  /** Shortened to keep off a box; the whole text shows on hover. */
  short?: boolean;
  /** The route's bounds, for skipping far edges on hover; boxOf is the route it's for. */
  box?: { x0: number; y0: number; x1: number; y1: number };
  boxOf?: Route;
}

export type Drag =
  /** keep: it began on a frame's title, which picked the frame; letting go keeps it picked. */
  | { kind: "pan"; last: Point; moved: boolean; keep?: boolean; was?: Selection }
  | {
      kind: "nodes";
      ids: string[];
      start: Point;
      startScreen: Point;
      origin: Map<string, Point>;
      moved: boolean;
      frame?: string;
    }
  | { kind: "marquee"; start: Point; current: Point; right?: boolean }
  | {
      kind: "connect";
      from: string;
      start: Point;
      current: Point;
      target: string | null;
      /** Drawn off this arrow: a branch of it, to another box. */
      like?: string;
      /** Over this arrow, not a box: dropped here it joins it, into the box that one goes to. */
      onto?: string | null;
    }
  | { kind: "resize"; id: string; start: Point; origin: { w: number; h: number }; moved: boolean }
  | { kind: "minimap" }
  /** Shaping the selected arrow: an end (pins its side), a bend, its label, or its line (adds a bend). */
  | {
      kind: "arrow";
      edge: string;
      part: "from" | "to" | "bend" | "label" | "line" | "split";
      index: number;
      start: Point;
      moved: boolean;
    };
