// The canvas's look and its numbers: colours, sizes, zoom thresholds and limits. Nothing
// here does anything.
import type { NodeKind } from "../types";

export const THEME = {
  bg: 0x0f1115,
  dot: 0x2a2f39,
  card: 0x1a1e26,
  cardExternal: 0x15181e,
  cardStroke: 0x2c323d,
  cardStrokeExternal: 0x3b4150,
  title: 0xe6e9ef,
  subtitle: 0x8b93a3,
  subtitleBright: 0xaab3c3,
  future: 0xd8a657,
  deprecated: 0xc07070,
  badge: 0x6f7889,
  edge: 0x5f6a7e,
  edgeFuture: 0x8a7a45,
  edgeDeprecated: 0x7a4b4b,
  /** Deleted on a fork, still on main: boxes and lines in a diff. */
  removed: 0xf87171,
  edgeLive: 0xb3bdd2,
  edgeFocus: 0xd4dcec,
  edgePath: 0xf2c14e,
  /** A line whose ends are in different regions: the region boundary's colour. */
  edgeRegion: 0xb39ddb,
  labelBg: 0x14171d,
  label: 0xaab3c3,
  group: 0x13161c,
  groupStroke: 0x343b48,
  groupTitle: 0xc7cdd8,
  select: 0x4f8cff,
  guide: 0xf472b6,
  hover: 0x6f7889,
  handle: 0x4f8cff,
  hidden: 0xd8a657,
  miniBg: 0x12151b,
  miniNode: 0x3a4252,
  miniView: 0x8b93a3,
};

/** A boundary's colour by kind: muted, so frames sit behind the boxes. */
export const BOUNDARY_COLOR: Record<string, number> = {
  cloud: 0x7f8ea3,
  project: 0x6f9bd1,
  host: 0x8fb3e0,
  network: 0x5fb39a,
  subnet: 0x8cc08a,
  region: 0xb39ddb,
  edge: 0xd9a35f,
  trust: 0xd97f7f,
  process: 0x8fd1b8,
  group: 0x9aa3b2,
};

/** A boundary's kind, said quietly after its name (not shouted in caps). */
export const BOUNDARY_LABEL: Record<string, string> = {
  cloud: "cloud",
  project: "project",
  host: "host",
  network: "network",
  subnet: "subnet",
  region: "region",
  edge: "edge",
  trust: "trust zone",
  process: "process",
  group: "",
};

export const KIND_COLOR: Record<NodeKind, number> = {
  actor: 0xa78bfa,
  system: 0x60a5fa,
  app: 0x34d399,
  store: 0xfbbf24,
  component: 0xf472b6,
  module: 0xf0a060,
  function: 0x7dcfcf,
  library: 0xc792ea,
  table: 0xf2c46d,
};

/** a with t of b mixed in. */
export function mixColor(a: number, b: number, t: number): number {
  const ch = (sh: number) => Math.round(((a >> sh) & 255) * (1 - t) + ((b >> sh) & 255) * t) << sh;
  return ch(16) | ch(8) | ch(0);
}

export const FONT = "archnm-ui";

/** The logo tile at a box's left. */
export const TILE = 34;

export const KIND_WORD: Record<NodeKind, string> = {
  actor: "Actor",
  system: "System",
  app: "App",
  store: "Service",
  component: "Component",
  module: "Module",
  function: "Function",
  library: "Library",
  table: "Table",
};

export const RADIUS = 10;

export const GRID = 24;

export const SNAP = 8;

/** How close (screen px) a dragged box gets to another's line before it snaps to it. */
export const GUIDE_SNAP = 6;

export const TITLE_MIN_SCALE = 0.35; // below this a title is a blur, so it isn't drawn

export const SUBTITLE_MIN_SCALE = 0.6;

export const EDGE_LABEL_MIN_SCALE = 0.55;

/** How short a label gets to keep off a box (the whole text shows on hover). */
export const SHORT_LABEL = 14;

export const DRAG_THRESHOLD = 3; // screen px before a press becomes a drag

export const EDGE_HIT = 6; // screen px

export const HANDLE_R = 5; // screen px

export const MIN_W = 120;

export const MIN_H = 56;

export const RESIZE_HIT = 9; // screen px

export const ARROW_HANDLE_HIT = 8; // screen px

export const EDGE_BAND_IN = 9; // screen px inside a box's border that start a connection

export const EDGE_BAND_OUT = 10; // and outside it

export const MINI_W = 200;

export const MINI_H = 130;

export const MINI_MARGIN = 12;

/** The minimap sits above the zoom controls in the bottom-left corner. */
export const MINI_BOTTOM = 60;

/** Above this many boxes, arrows take the facing sides without checking what they cross. */
export const ROUTE_AROUND_LIMIT = 3000;

/** Above this many boxes, elbow and straight arrows fall back to curves (routing gets slow). */
export const AVOID_LIMIT = 2000;

/** Below this many arrows, a drag redraws all of them each frame, so ones routed around the moving box follow it. */
export const AVOID_LIVE_ALL = 600;

/** The marks on a table's columns, in the panel's colours. */
export const COLUMN_MARK = {
  pk: { word: "PK", fg: 0xf2c46d, bg: 0x3a2f17 },
  fk: { word: "FK", fg: 0x8fb8ff, bg: 0x1c2a44 },
  uq: { word: "UQ", fg: 0xaab3c3, bg: 0x262b34 },
  pii: { word: "PII", fg: 0xf29b9b, bg: 0x3a1c1c },
} as const;
