// What the canvas keeps while it runs, in one place: the Pixi layers, the views of boxes and
// arrows, the camera, the selection, and the state of a drag. Scene owns one of these and
// hands it to the modules next to it, which are plain functions over it; nothing else keeps
// state of its own.
import {
  Application,
  type BitmapText,
  Container,
  Graphics,
  type GraphicsContext,
  type Texture,
  type TilingSprite,
} from "pixi.js";
import type { Camera } from "../camera";
import type { Guide } from "../../../shared/align.ts";
import type { Point, Rect, Side } from "../../../shared/geometry";
import type { ArrowShape, ArrowStyle } from "../../../shared/model.ts";
import type { AsyncRouter } from "../avoid";
import type { CanvasGroup, CanvasNode, NodeKind } from "../types";
import type {
  Drag,
  EdgeView,
  IconLoader,
  NodeView,
  Peer,
  SceneCallbacks,
  SceneView,
  Spotlight,
  Tool,
} from "./types";

export class SceneState {
  readonly cb: SceneCallbacks;

  // --- Pixi: the application and its layers, back to front -------------------------------
  app = new Application();
  world = new Container();
  grid: TilingSprite | null = null;
  groupLayer = new Container();
  edgesStatic = new Graphics();
  edgesLive = new Graphics();
  edgeHighlight = new Graphics(); // hovered, selected and spotlit arrows: under the labels
  edgeLabels = new Container();
  nodeLayer = new Container();
  overlay = new Graphics(); // selection, hover, handles, connect preview: world space
  flowDots = new Graphics(); // a flow step's traffic: dots running along its arrows
  stepLayer = new Container(); // a flow's step numbers
  screenOverlay = new Graphics(); // the marquee: screen space
  peerLayer = new Container(); // other people: cursors, selections, drags
  peerGfx = new Graphics();
  peerLabels = new Map<number, BitmapText>();
  cardContexts = new Map<string, GraphicsContext>();
  minimap = new Container();
  miniBg = new Graphics();
  miniNodes = new Graphics();
  miniView = new Graphics();

  // --- the boxes and arrows ---------------------------------------------------------------
  views = new Map<string, NodeView>();
  order: NodeView[] = []; // draw order: later is on top
  edges = new Map<string, EdgeView>();
  edgesByNode = new Map<string, EdgeView[]>();
  liveEdges = new Set<EdgeView>();
  /** Nodes whose edges are all live while dragging, so their ports can be recomputed. */
  liveNodes = new Set<string>();
  groupList: CanvasGroup[] = [];
  /** Frames lines end on (a box drawn around its insides, the view's scope), by id. */
  frameEnds = new Map<string, Rect>();
  sideMap = new Map<string, { from: Side; to: Side }>();
  portMap = new Map<string, { a: number; b: number }>();
  /** Technology logos in their brand colour (and that colour, for the tile behind). */
  icons = new Map<string, { tex: Texture; color: number } | null | "loading">();
  /** Kind icons, by kind: drawn white and tinted per use. */
  kindIcons = new Map<NodeKind, Texture | "loading">();

  // --- the camera and the view ------------------------------------------------------------
  camera: Camera = { x: 0, y: 0, scale: 1 };
  size = { w: 1, h: 1 };
  /** Screen px on the left covered by the drawer: fitting and centring use what's left. */
  insetLeft = 0;
  visibleCount = 0;
  labels = { title: true, subtitle: true, edge: true };
  edgeWidthBucket = 0;
  glideFrame = 0;
  miniOn = true;
  mini: { s: number; ox: number; oy: number; x: number; y: number } | null = null;

  // --- what is selected, lit or hovered ---------------------------------------------------
  selected = new Set<string>();
  selectedEdge: string | null = null;
  selectedBoundary: string | null = null;
  selectedScope = false;
  framesPicked = "";
  hovered: string | null = null;
  hoveredEdge: string | null = null;
  /** Where on the hovered box's edge a connection would start from. */
  knob: Point | null = null;
  /** What the selection is about: the selected boxes, their neighbours and the arrows between. */
  focus: { nodes: Set<string>; edges: Set<string> } | null = null;
  spot: Spotlight | null = null;
  /** Quiet traffic on every arrow too, not only on what's selected or lit. */
  animateAll = false;
  peers: Peer[] = [];

  // --- the pointer: tool, modes and the drag in progress ----------------------------------
  tool: Tool = "select";
  /** Simple mode: a drag on empty canvas selects (space-drag pans), a frame's title drags all
   * it holds, and a box dragged onto another box or frame goes inside it. */
  simple = false;
  space = false;
  /** The group tool: a drag anywhere (on boxes too) draws a frame around what it covers. */
  groupDraw = false;
  drag: Drag | null = null;
  /** While boxes are dragged in simple mode: the box or frame they'd go into. */
  dropInto: string | null = null;
  /** The frame the dragged boxes started in (simple mode): leaving it takes them out. */
  dropFrom: CanvasGroup | null = null;
  /** Simple mode: a right-drag on empty canvas selects; a right-click there still opens the menu. */
  rightDragged = false;
  pendingContext: { clientX: number; clientY: number; world: Point } | null = null;
  /** Alignment guides shown while a drag snaps to other boxes. */
  guides: Guide[] = [];
  moving = new Map<string, { x: number; y: number }>();

  // --- arrows: style, router, and a shape being edited ------------------------------------
  /** How arrows are drawn; elbow and straight use the router once it has loaded. */
  arrowStyle: ArrowStyle = "curved";
  avoid: AsyncRouter | null = null;
  /** An arrow being shaped: drawn this way until the change comes back from the model. */
  shaping: { edge: string; shape: ArrowShape } | null = null;
  shapeSig = "";

  // --- frames, timers and lifetime --------------------------------------------------------
  frameQueued = false;
  frames: number[] = [];
  lastFrameMs = 0;
  lastStatsAt = 0;
  statsTimer: ReturnType<typeof setTimeout> | null = null;
  watchSoon = 0;
  watchers = new Set<(v: SceneView) => void>();
  cleanup: (() => void)[] = [];
  ready = false;
  destroyed = false;

  // --- set by Scene when it is made, so modules don't have to import each other in a circle ---
  /** The frame callback handed to requestAnimationFrame. */
  frame: (now: number) => void = () => {};
  /** Rebuild one box's display objects (an icon has loaded). */
  replaceView: (v: NodeView, n: CanvasNode, sig: string) => NodeView = (v) => v;
  /** Fetch a technology's logo. */
  fetchIcon: IconLoader = () => Promise.resolve(null);

  constructor(callbacks: SceneCallbacks) {
    this.cb = callbacks;
  }
}
