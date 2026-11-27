// Arrows routed around boxes by libavoid (Adaptagrams, LGPL-2.1, loaded unmodified as
// WebAssembly): elbow (right angles) and straight (bends only to get around a box).
// One router per diagram, kept between frames: a drag moves a few shapes and libavoid
// re-routes only what that touches, in well under a millisecond. Shared: the canvas loads
// libavoid in the browser (src/canvas/avoid.ts), the server in Node (server/render.ts).
import type { Avoid } from "libavoid-js";
import {
  anchor,
  fanSides,
  pinOffset,
  SIDE_OF_WORD,
  sides,
  type Point,
  type Rect,
  type Side,
} from "./geometry.ts";
import type { ArrowStyle } from "./model.ts";

/**
 * A box's pins: one in its middle, reachable from any side (the path is cut at the border),
 * and one in the middle of each side, for an arrow pinned to that side by hand.
 */
const PIN = 1;
const ALL_SIDES = 15;
// libavoid's ConnDirFlags: up 1, down 2, left 4, right 8.
const SIDE_PIN: Record<Side, { id: number; x: number; y: number; dir: number }> = {
  t: { id: 2, x: 0.5, y: 0, dir: 1 },
  b: { id: 3, x: 0.5, y: 1, dir: 2 },
  l: { id: 4, x: 0, y: 0.5, dir: 4 },
  r: { id: 5, x: 1, y: 0.5, dir: 8 },
};
const pinOf = (side?: Side) => (side ? SIDE_PIN[side].id : PIN);

interface Shape {
  ref: any;
  rect: Rect;
}

interface Conn {
  ref: any;
  from: string;
  to: string;
  pins: string;
}

const pinsOf = (e: RouterEdge) =>
  `${e.fromAt ? `${e.fromAt.x},${e.fromAt.y}` : pinOf(e.fromSide)}>${e.toAt ? `${e.toAt.x},${e.toAt.y}` : pinOf(e.toSide)}`;

export interface RouterEdge {
  id: string;
  from: string;
  to: string;
  fromSide?: Side;
  toSide?: Side;
  /** An end on a frame (a box drawn around its insides): a point on its border, left by that side. The frame isn't an obstacle. */
  fromAt?: FramePoint;
  toAt?: FramePoint;
}

export interface FramePoint {
  x: number;
  y: number;
  side: Side;
}

/**
 * The arrows to route, from a diagram's edges: an end on a frame (in `ends`, not in `boxes`)
 * becomes a point on its border; arrows bent by hand are drawn through their bends instead.
 */
export function routerEdges(
  edges: {
    id: string;
    from: string;
    to: string;
    fan?: string;
    shape?: {
      bends?: Point[];
      split?: Point;
      join?: Point;
      fromSide?: keyof typeof SIDE_OF_WORD;
      toSide?: keyof typeof SIDE_OF_WORD;
      fromAt?: number;
      toAt?: number;
    };
  }[],
  ends: Map<string, Rect>,
  boxes: Map<string, Rect>,
): RouterEdge[] {
  // The stretch from a box to a split point is routed once, for all the arrows that share it.
  const trunks = new Set<string>();
  // Its side of the box is the one any of them was pinned to.
  // (The stretch from a join point into its box, the same.)
  const trunkSide: Pins = new Map();
  for (const e of edges) {
    const sh = e.shape;
    if (sh?.split && sh.fromSide)
      trunkSide.set(trunkId(e.from, sh.split), { side: SIDE_OF_WORD[sh.fromSide], at: sh.fromAt });
    if (sh?.join && sh.toSide)
      trunkSide.set(tailId(e.to, sh.join), { side: SIDE_OF_WORD[sh.toSide], at: sh.toAt });
  }
  // A fan's arrows all start at one spot, so they run as one line until they part.
  const fans = fanSides(edges, (id) => (boxes.has(id) ? ends.get(id) : undefined));
  return edges.flatMap((e) => {
    const met = meetEdges(e, boxes, trunks, trunkSide);
    if (met) return met;
    // Bent by hand: drawn through its bends, not routed.
    if (e.shape?.bends?.length) return [];
    const a = ends.get(e.from);
    const b = ends.get(e.to);
    if (!a || !b) return [];
    const out: RouterEdge = {
      id: e.id,
      from: e.from,
      to: e.to,
      fromSide: e.shape?.fromSide && SIDE_OF_WORD[e.shape.fromSide],
      toSide: e.shape?.toSide && SIDE_OF_WORD[e.shape.toSide],
    };
    const fan = fans.get(e.id);
    if (fan) {
      out.fromSide = fan.side;
      out.fromAt = pinPoint(a, fan.side, fan.at ?? 0.5);
    }
    if (!boxes.has(e.from)) out.fromAt = framePoint(a, b, out.fromSide);
    else if (out.fromSide && e.shape?.fromAt !== undefined)
      out.fromAt = pinPoint(a, out.fromSide, e.shape.fromAt);
    if (!boxes.has(e.to)) out.toAt = framePoint(b, a, out.toSide);
    else if (out.toSide && e.shape?.toAt !== undefined)
      out.toAt = pinPoint(b, out.toSide, e.shape.toAt);
    return [out];
  });
}

/** Where a shared stretch was pinned to its box by hand, by the stretch's name. */
type Pins = Map<string, { side: Side; at?: number }>;
type Pinned = {
  bends?: Point[];
  fromSide?: keyof typeof SIDE_OF_WORD;
  toSide?: keyof typeof SIDE_OF_WORD;
  fromAt?: number;
  toAt?: number;
};

/** An end's side and, when it was put on a spot along it, that spot. */
function pinned(
  box: Rect | undefined,
  side: Side | undefined,
  at: number | undefined,
): { side?: Side; at?: FramePoint } {
  return { side, at: box && side && at !== undefined ? pinPoint(box, side, at) : undefined };
}

/** The router's name for the stretch from a box to one of its split points. */
export const trunkId = (from: string, p: Point) => `@split:${from}|${p.x},${p.y}`;

/**
 * An arrow through a split point is two routed stretches: box to point (once for every arrow
 * that shares the point), and point to its own box (not when it's bent by hand).
 */
function splitEdges(
  e: {
    id: string;
    from: string;
    to: string;
    shape?: Pinned;
  },
  p: Point,
  boxes: Map<string, Rect>,
  trunks: Set<string>,
  trunkSide: Pins,
): RouterEdge[] {
  if (!boxes.has(e.from) || !boxes.has(e.to)) return [];
  const at: FramePoint = { ...p, side: "r" };
  const out: RouterEdge[] = [];
  const trunk = trunkId(e.from, p);
  if (!trunks.has(trunk)) {
    trunks.add(trunk);
    const pin = trunkSide.get(trunk);
    const from = pinned(boxes.get(e.from), pin?.side, pin?.at);
    out.push({
      id: trunk,
      from: e.from,
      to: "@split",
      fromSide: from.side,
      fromAt: from.at,
      toAt: at,
    });
  }
  if (!e.shape?.bends?.length) {
    const to = pinned(
      boxes.get(e.to),
      e.shape?.toSide && SIDE_OF_WORD[e.shape.toSide],
      e.shape?.toAt,
    );
    out.push({ id: e.id, from: "@split", to: e.to, toSide: to.side, toAt: to.at, fromAt: at });
  }
  return out;
}

/** The stretches to route for an arrow that goes by a split point, a join point or both; undefined for any other. */
function meetEdges(
  e: Parameters<typeof splitEdges>[0] & { shape?: { split?: Point; join?: Point } },
  boxes: Map<string, Rect>,
  seen: Set<string>,
  trunkSide: Pins,
): RouterEdge[] | undefined {
  const { split, join } = e.shape ?? {};
  if (split && join) return bothEdges(e, split, join, boxes, seen, trunkSide);
  if (split) return splitEdges(e, split, boxes, seen, trunkSide);
  return join ? joinEdges(e, join, boxes, seen, trunkSide) : undefined;
}

/** Through a split point and a join point: the two shared stretches, and its own between the points. */
function bothEdges(
  e: Parameters<typeof splitEdges>[0],
  sp: Point,
  jp: Point,
  boxes: Map<string, Rect>,
  seen: Set<string>,
  trunkSide: Pins,
): RouterEdge[] {
  // (A bend stands in for "bent by hand": only the shared stretch is asked for.)
  const shared = [
    ...splitEdges({ ...e, shape: { ...e.shape, bends: [sp] } }, sp, boxes, seen, trunkSide),
    ...joinEdges({ ...e, shape: { ...e.shape, bends: [jp] } }, jp, boxes, seen, trunkSide),
  ];
  if (!boxes.has(e.from) || !boxes.has(e.to) || e.shape?.bends?.length) return shared;
  const own = { id: e.id, from: "@split", to: "@join" };
  return [...shared, { ...own, fromAt: { ...sp, side: "r" }, toAt: { ...jp, side: "r" } }];
}

/** The router's name for the stretch from a join point into its box. */
export const tailId = (to: string, p: Point) => `@join:${to}|${p.x},${p.y}`;

/** An arrow through a join point: its box to the point, and (once for all that share it) the point into the box. */
function joinEdges(
  e: {
    id: string;
    from: string;
    to: string;
    shape?: Pinned;
  },
  p: Point,
  boxes: Map<string, Rect>,
  tails: Set<string>,
  tailSide: Pins,
): RouterEdge[] {
  if (!boxes.has(e.from) || !boxes.has(e.to)) return [];
  const at: FramePoint = { ...p, side: "r" };
  const out: RouterEdge[] = [];
  const tail = tailId(e.to, p);
  if (!tails.has(tail)) {
    tails.add(tail);
    const pin = tailSide.get(tail);
    const to = pinned(boxes.get(e.to), pin?.side, pin?.at);
    out.push({ id: tail, from: "@join", to: e.to, toSide: to.side, toAt: to.at, fromAt: at });
  }
  if (!e.shape?.bends?.length) {
    const from = pinned(
      boxes.get(e.from),
      e.shape?.fromSide && SIDE_OF_WORD[e.shape.fromSide],
      e.shape?.fromAt,
    );
    out.push({
      id: e.id,
      from: e.from,
      to: "@join",
      fromSide: from.side,
      fromAt: from.at,
      toAt: at,
    });
  }
  return out;
}

/** An end put on a spot by hand: that point, a step off the box's border (the box is in the way of a point on it). */
function pinPoint(box: Rect, side: Side, t: number): FramePoint {
  const p = anchor(box, side, pinOffset(box, side, t));
  const out = { l: [-2, 0], r: [2, 0], t: [0, -2], b: [0, 2] }[side] as [number, number];
  return { x: p.x + out[0], y: p.y + out[1], side };
}

/** Where a line meets a frame: the middle of its side facing the other end (or the side pinned by hand). */
export function framePoint(frame: Rect, other: Rect, pinned?: Side): FramePoint {
  const side = pinned ?? sides(other, frame).to;
  return { ...anchor(frame, side), side };
}

export class EdgeRouter {
  private A: Avoid;
  private router: any;
  private shapes = new Map<string, Shape>();
  private conns = new Map<string, Conn>();
  private style: Exclude<ArrowStyle, "curved"> = "elbow";
  private paths = new Map<string, Point[]>();

  constructor(A: Avoid) {
    this.A = A;
    this.router = new A.Router(
      A.RouterFlag.OrthogonalRouting.value | A.RouterFlag.PolyLineRouting.value,
    );
    const P = A.RoutingParameter;
    // Keep 12px clear of boxes, 12px between parallel arrows; a bend costs about as much as 50px of length.
    this.router.setRoutingParameter(P.shapeBufferDistance, 12);
    this.router.setRoutingParameter(P.idealNudgingDistance, 12);
    this.router.setRoutingParameter(P.segmentPenalty, 50);
    const O = A.RoutingOption;
    this.router.setRoutingOption(O.nudgeOrthogonalSegmentsConnectedToShapes, true);
    // Arrows from the very same point are a fan: they stay one line until they part.
    this.router.setRoutingOption(O.nudgeSharedPathsWithCommonEndPoint, false);
  }

  /**
   * Bring the router up to date with the diagram and re-route. Only what changed is told to
   * libavoid; it re-routes only the arrows that touches.
   */
  sync(boxes: Map<string, Rect>, edges: RouterEdge[], style: Exclude<ArrowStyle, "curved">): void {
    const A = this.A;
    const restyle = style !== this.style;
    this.style = style;
    const type = style === "elbow" ? A.ConnType.ConnType_Orthogonal : A.ConnType.ConnType_PolyLine;

    // Arrows that are gone, or whose ends changed, go first (before their boxes can).
    const want = new Map(edges.map((e) => [e.id, e]));
    for (const [id, c] of this.conns) {
      const e = want.get(id);
      if (
        !e ||
        e.from !== c.from ||
        e.to !== c.to ||
        c.pins !== pinsOf(e) ||
        (!e.fromAt && !boxes.has(e.from)) ||
        (!e.toAt && !boxes.has(e.to))
      ) {
        this.router.deleteConnector(c.ref);
        this.conns.delete(id);
        this.paths.delete(id);
      }
    }
    for (const [id, s] of this.shapes) {
      if (!boxes.has(id)) {
        this.router.deleteShape(s.ref);
        this.shapes.delete(id);
      }
    }
    for (const [id, r] of boxes) {
      const s = this.shapes.get(id);
      if (!s) {
        const ref = new A.ShapeRef(this.router, this.rectangle(r));
        new A.ShapeConnectionPin(ref, PIN, 0.5, 0.5, true, 0, ALL_SIDES);
        for (const p of Object.values(SIDE_PIN))
          new A.ShapeConnectionPin(ref, p.id, p.x, p.y, true, 0, p.dir);
        this.shapes.set(id, { ref, rect: { ...r } });
      } else if (s.rect.x !== r.x || s.rect.y !== r.y || s.rect.w !== r.w || s.rect.h !== r.h) {
        // The third argument is libavoid's first_move (false: a move, not a placement).
        this.router.moveShape_poly(s.ref, this.rectangle(r), false);
        s.rect = { ...r };
      }
    }
    for (const e of edges) {
      const c = this.conns.get(e.id);
      if (c) {
        if (restyle) c.ref.setRoutingType(type);
        continue;
      }
      const a = e.fromAt
        ? this.point(e.fromAt)
        : this.shapes.get(e.from) && new A.ConnEnd(this.shapes.get(e.from)!.ref, pinOf(e.fromSide));
      const b = e.toAt
        ? this.point(e.toAt)
        : this.shapes.get(e.to) && new A.ConnEnd(this.shapes.get(e.to)!.ref, pinOf(e.toSide));
      if (!a || !b || e.from === e.to) continue;
      const ref = new A.ConnRef(this.router, a, b);
      ref.setRoutingType(type);
      this.conns.set(e.id, { ref, from: e.from, to: e.to, pins: pinsOf(e) });
    }
    this.router.processTransaction();
    for (const [id, c] of this.conns) {
      const line = c.ref.displayRoute();
      const pts: Point[] = [];
      for (let i = 0; i < line.size(); i++) {
        const p = line.at(i);
        pts.push({ x: p.x, y: p.y });
      }
      if (pts.length >= 2) this.paths.set(id, pts);
      else this.paths.delete(id);
    }
  }

  /** An arrow's path, box centre to box centre; null if it has none (yet). */
  path(id: string): Point[] | null {
    return this.paths.get(id) ?? null;
  }

  destroy(): void {
    try {
      this.router.delete();
    } catch {
      // Already gone with the page.
    }
    this.shapes.clear();
    this.conns.clear();
    this.paths.clear();
  }

  /** A free end on a frame's border (the binding takes no direction: the side picked it). */
  private point(p: FramePoint): any {
    return new this.A.ConnEnd(new this.A.Point(p.x, p.y));
  }

  private rectangle(r: Rect): any {
    const A = this.A;
    return new A.Rectangle(new A.Point(r.x, r.y), new A.Point(r.x + r.w, r.y + r.h));
  }
}
