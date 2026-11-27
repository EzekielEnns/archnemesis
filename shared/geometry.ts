// Plain 2D geometry for the canvas: no Pixi, so it's unit-tested on its own.

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function center(r: Rect): Point {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

export function contains(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}

/** The smallest rect holding every rect given; null for none. */
export function boundsOf(rects: Iterable<Rect>): Rect | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  if (minX === Infinity) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** The rect spanned by two corners, in any order (a marquee drag). */
export function rectFromCorners(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

/**
 * Where the line from the rect's center toward `target` leaves the rect: the point an
 * edge should start or end at so it meets the box's border, not its middle.
 */
export function borderPoint(r: Rect, target: Point): Point {
  const c = center(r);
  const dx = target.x - c.x;
  const dy = target.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const tx = dx === 0 ? Infinity : r.w / 2 / Math.abs(dx);
  const ty = dy === 0 ? Infinity : r.h / 2 / Math.abs(dy);
  const t = Math.min(tx, ty, 1);
  return { x: c.x + dx * t, y: c.y + dy * t };
}

/** The two back corners of an arrowhead whose tip is at `tip`, pointing away from `from`. */
export function arrowHead(tip: Point, from: Point, size: number): [Point, Point] {
  const angle = Math.atan2(tip.y - from.y, tip.x - from.x);
  const spread = Math.PI / 7;
  return [
    { x: tip.x - size * Math.cos(angle - spread), y: tip.y - size * Math.sin(angle - spread) },
    { x: tip.x - size * Math.cos(angle + spread), y: tip.y - size * Math.sin(angle + spread) },
  ];
}

/**
 * An edge's path. A curve (p0, c1, c2, p1): it leaves one box from the side facing the
 * other and arrives square. Or, with `pts`, a line through those points (elbow or
 * straight, from the router); then c1 and c2 are the points next to each end, so the
 * arrowhead still points along the last stretch. `round` rounds an elbow's corners.
 */
export interface Route {
  p0: Point;
  c1: Point;
  c2: Point;
  p1: Point;
  pts?: Point[];
  round?: number;
  /** Where it parts from the others out of its box, and where it meets the others into its box: a dot each. */
  dots?: { split?: Point; join?: Point };
}

/** A route along points (at least two). */
export function lineRoute(pts: Point[], round = 0): Route {
  const n = pts.length;
  return { p0: pts[0]!, c1: pts[1]!, c2: pts[n - 2]!, p1: pts[n - 1]!, pts, round };
}

/** What a route is drawn onto: Pixi's Graphics fits, and tests can record the calls. */
export interface PathSink {
  moveTo(x: number, y: number): unknown;
  lineTo(x: number, y: number): unknown;
  bezierCurveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): unknown;
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): unknown;
}

/** Draw a route as dashes (not stroked): `on` long, `off` apart, following its curve. */
export function traceDashed(g: PathSink, r: Route, on = 6, off = 5): void {
  const n = 64;
  const pts: Point[] = [];
  for (let i = 0; i <= n; i++) pts.push(routePoint(r, i / n));
  let drawing = true;
  let left = on;
  g.moveTo(pts[0]!.x, pts[0]!.y);
  for (let i = 1; i < pts.length; i++) {
    let a = pts[i - 1]!;
    const b = pts[i]!;
    let seg = Math.hypot(b.x - a.x, b.y - a.y);
    while (seg > 0) {
      const step = Math.min(seg, left);
      const t = step / seg;
      const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      if (drawing) g.lineTo(p.x, p.y);
      else g.moveTo(p.x, p.y);
      seg -= step;
      left -= step;
      a = p;
      if (left <= 0) {
        drawing = !drawing;
        left = drawing ? on : off;
      }
    }
  }
}

/** Draw a route's path (not stroked). Elbow corners are rounded, never past half a leg. */
export function traceRoute(g: PathSink, r: Route): void {
  g.moveTo(r.p0.x, r.p0.y);
  if (!r.pts) {
    g.bezierCurveTo(r.c1.x, r.c1.y, r.c2.x, r.c2.y, r.p1.x, r.p1.y);
    return;
  }
  const pts = r.pts;
  const rad = r.round ?? 0;
  for (let i = 1; i < pts.length; i++) {
    const cur = pts[i]!;
    const next = pts[i + 1];
    if (!rad || !next) {
      g.lineTo(cur.x, cur.y);
      continue;
    }
    const prev = pts[i - 1]!;
    const k = Math.min(
      rad,
      Math.hypot(cur.x - prev.x, cur.y - prev.y) / 2,
      Math.hypot(next.x - cur.x, next.y - cur.y) / 2,
    );
    const into = toward(cur, prev, k);
    const out = toward(cur, next, k);
    g.lineTo(into.x, into.y);
    g.quadraticCurveTo(cur.x, cur.y, out.x, out.y);
  }
}

/** The point `d` along the way from `a` toward `b`. */
function toward(a: Point, b: Point, d: number): Point {
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return { x: a.x + ((b.x - a.x) / len) * d, y: a.y + ((b.y - a.y) / len) * d };
}

/**
 * A router's path runs from box centre to box centre: cut it where it leaves the first
 * box and where it enters the last, so it meets their borders.
 */
export function clipToBoxes(pts: Point[], a: Rect, b: Rect): Point[] {
  if (pts.length < 2) return pts;
  const out = [...pts];
  // Leaving a: drop points still inside it, then cut the first leg at its border.
  while (out.length > 2 && contains(a, out[1]!)) out.shift();
  out[0] = exitPoint(a, out[0]!, out[1]!) ?? out[0]!;
  while (out.length > 2 && contains(b, out[out.length - 2]!)) out.pop();
  const n = out.length;
  out[n - 1] = exitPoint(b, out[n - 1]!, out[n - 2]!) ?? out[n - 1]!;
  return out;
}

/** Where the segment from `inside` toward `outside` crosses the rect's border. */
function exitPoint(r: Rect, inside: Point, outside: Point): Point | null {
  const dx = outside.x - inside.x;
  const dy = outside.y - inside.y;
  let t = Infinity;
  if (dx > 0) t = Math.min(t, (r.x + r.w - inside.x) / dx);
  if (dx < 0) t = Math.min(t, (r.x - inside.x) / dx);
  if (dy > 0) t = Math.min(t, (r.y + r.h - inside.y) / dy);
  if (dy < 0) t = Math.min(t, (r.y - inside.y) / dy);
  if (!Number.isFinite(t) || t < 0 || t > 1) return null;
  return { x: inside.x + dx * t, y: inside.y + dy * t };
}

export type Side = "l" | "r" | "t" | "b";

/** Which sides a curve leaves `a` and enters `b` from: sideways when the boxes are further apart horizontally than vertically. */
export function sides(a: Rect, b: Rect): { from: Side; to: Side } {
  const ca = center(a);
  const cb = center(b);
  const dx = cb.x - ca.x;
  const dy = cb.y - ca.y;
  const gapX = Math.abs(dx) - (a.w + b.w) / 2;
  const gapY = Math.abs(dy) - (a.h + b.h) / 2;
  if (gapX >= gapY) return dx >= 0 ? { from: "r", to: "l" } : { from: "l", to: "r" };
  return dy >= 0 ? { from: "b", to: "t" } : { from: "t", to: "b" };
}

const OUT: Record<Side, Point> = {
  l: { x: -1, y: 0 },
  r: { x: 1, y: 0 },
  t: { x: 0, y: -1 },
  b: { x: 0, y: 1 },
};

/** The point on a side, `offset` px from its middle (along x for top/bottom, y for left/right). */
export function anchor(r: Rect, side: Side, offset = 0): Point {
  const c = center(r);
  if (side === "l" || side === "r") return { x: side === "l" ? r.x : r.x + r.w, y: c.y + offset };
  return { x: c.x + offset, y: side === "t" ? r.y : r.y + r.h };
}

/** How far from the middle of a side an end pinned at `t` (0 to 1 along it) sits. */
export function pinOffset(r: Rect, side: Side, t: number | undefined): number | undefined {
  return t === undefined ? undefined : (t - 0.5) * (side === "l" || side === "r" ? r.h : r.w);
}

/** The same for both ends of an arrow, from its shape: only an end with a side has a spot on it. */
export function pinOffsets(
  a: Rect,
  b: Rect,
  pin: { from?: Side; to?: Side },
  shape: { fromAt?: number; toAt?: number } | undefined,
): { a?: number; b?: number } {
  const at: { a?: number; b?: number } = {};
  const oa = pin.from ? pinOffset(a, pin.from, shape?.fromAt) : undefined;
  const ob = pin.to ? pinOffset(b, pin.to, shape?.toAt) : undefined;
  // Only the ends that have a spot: spread over the shared-out offsets, the rest keep theirs.
  if (oa !== undefined) at.a = oa;
  if (ob !== undefined) at.b = ob;
  return at;
}

/** Where along a side a point is, 0 to 1: kept off the corners, in steps a hand can hit twice. */
export function sideT(r: Rect, side: Side, p: Point): number {
  const raw = side === "l" || side === "r" ? (p.y - r.y) / r.h : (p.x - r.x) / r.w;
  const t = Math.min(0.9, Math.max(0.1, raw));
  // The middle holds on: a little off it is the middle.
  return Math.abs(t - 0.5) < 0.06 ? 0.5 : Math.round(t * 20) / 20;
}

/** A curve from a facing side of `a` to one of `b`; offsets move the ends along their sides. */
export function route(a: Rect, b: Rect, offA = 0, offB = 0, via?: { from: Side; to: Side }): Route {
  const { from, to } = via ?? sides(a, b);
  const p0 = anchor(a, from, offA);
  const p1 = anchor(b, to, offB);
  const horizontal = from === "l" || from === "r";
  const k = Math.max(30, (horizontal ? Math.abs(p1.x - p0.x) : Math.abs(p1.y - p0.y)) * 0.45);
  const o0 = OUT[from];
  const o1 = OUT[to];
  return {
    p0,
    c1: { x: p0.x + o0.x * k, y: p0.y + o0.y * k },
    c2: { x: p1.x + o1.x * k, y: p1.y + o1.y * k },
    p1,
  };
}

export interface PortEdge {
  id: string;
  from: string;
  to: string;
}

/**
 * Where on its box each arrow of a fan starts, so they can leave as one line: the side facing
 * the middle of where they all go, at its middle. One whose start was put somewhere by hand
 * keeps it, and the rest start there with it. One bent by hand starts there too, then takes
 * its own bends.
 */
export function fanSides(
  edges: (PortEdge & {
    fan?: string;
    split?: string;
    shape?: { fromSide?: keyof typeof SIDE_OF_WORD; fromAt?: number; bends?: unknown[] };
  })[],
  rect: (id: string) => Rect | undefined,
): Map<string, { side: Side; at?: number }> {
  const by = new Map<string, typeof edges>();
  for (const e of edges) {
    if (!e.fan || e.split) continue;
    if (!rect(e.from) || !rect(e.to)) continue;
    by.set(e.fan, [...(by.get(e.fan) ?? []), e]);
  }
  const out = new Map<string, { side: Side; at?: number }>();
  for (const list of by.values()) {
    if (list.length < 2) continue;
    const held = list.find((e) => e.shape?.fromSide)?.shape;
    const to = list.map((e) => center(rect(e.to)!));
    const mid = {
      x: to.reduce((s, p) => s + p.x, 0) / to.length,
      y: to.reduce((s, p) => s + p.y, 0) / to.length,
    };
    const start = held?.fromSide
      ? { side: SIDE_OF_WORD[held.fromSide], at: held.fromAt }
      : { side: sides(rect(list[0]!.from)!, { x: mid.x, y: mid.y, w: 0, h: 0 }).from };
    for (const e of list) if (!e.shape?.fromSide) out.set(e.id, start);
  }
  return out;
}

/** A line through these points made of level and upright stretches: a corner goes in wherever two aren't in line. */
function squared(pts: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.hypot(p.x - last.x, p.y - last.y) < 0.5) continue;
    if (last && Math.abs(p.x - last.x) > 0.5 && Math.abs(p.y - last.y) > 0.5)
      out.push({ x: p.x, y: last.y });
    out.push(p);
  }
  return out;
}

/**
 * The part of an arrow that's its own, where its name goes: after its split point, or before
 * its join point. The whole arrow when it has neither.
 */
export function ownStretch(r: Route, shape: { split?: Point; join?: Point } | undefined): Route {
  const pts = r.pts;
  if (!pts) return r;
  const at = (p: Point | undefined) =>
    p ? pts.findIndex((q) => Math.hypot(q.x - p.x, q.y - p.y) < 1) : -1;
  const [i, j] = [at(r.dots?.split ?? shape?.split), at(r.dots?.join ?? shape?.join)];
  const own = pts.slice(i > 0 ? i : 0, j > 0 ? j + 1 : pts.length);
  return own.length > 1 && own.length < pts.length ? lineRoute(own) : r;
}

/** From a point into a box: to the middle of the side facing it, turning once so it arrives square. */
function intoBox(from: Point, to: Rect): Point[] {
  const side = sides({ x: from.x, y: from.y, w: 0, h: 0 }, to).to;
  const q = anchor(to, side);
  return [side === "t" || side === "b" ? { x: q.x, y: from.y } : { x: from.x, y: q.y }, q];
}

/** q is on the stretch from a to b, past a. */
function along(q: Point, a: Point, b: Point): boolean {
  const cross = (q.x - a.x) * (b.y - a.y) - (q.y - a.y) * (b.x - a.x);
  const dot = (q.x - a.x) * (b.x - a.x) + (q.y - a.y) * (b.y - a.y);
  const len = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
  return Math.abs(cross) < 1 && dot > 1 && dot <= len + 1;
}

/**
 * A line in to a point and a line out of it that starts back the way the first came: the two
 * with that overlap taken off, so the second leaves the first where they really part.
 */
function untangle(inn: Point[], out: Point[]): { inn: Point[]; out: Point[] } {
  for (let i = 0; i < 8 && inn.length > 1 && out.length > 1; i++) {
    const [p, before, next] = [inn[inn.length - 1]!, inn[inn.length - 2]!, out[1]!];
    if (along(next, p, before)) {
      // It turns off partway back: they part there.
      const whole = Math.hypot(next.x - before.x, next.y - before.y) < 1;
      inn = whole ? inn.slice(0, -1) : [...inn.slice(0, -1), next];
      out = out.slice(1);
    } else if (along(before, p, next)) {
      // It runs back past the corner: that corner goes, and the next stretch is checked.
      inn = inn.slice(0, -1);
      out = [before, ...out.slice(1)];
    } else break;
  }
  return { inn, out };
}

/**
 * An arrow through a split point: out of its box to the point (the stretch it shares with the
 * others that split there), then on to its own box. Each stretch is the router's path when there
 * is one, else a line that turns once; bends put in by hand shape the stretch after the point.
 */
export function splitRoute(
  a: Rect,
  p: Point,
  b: Rect,
  o: { trunk?: Point[] | null; branch?: Point[] | null; bends?: Point[]; round?: number } = {},
): Route {
  const far: Rect = { x: -1e9, y: -1e9, w: 0, h: 0 };
  const out = intoBox(p, a).reverse();
  const trunk = o.trunk ? [...clipToBoxes(o.trunk, a, far).slice(0, -1), p] : [...out, p];
  const bends = o.bends ?? [];
  const tail = bends[bends.length - 1] ?? p;
  const branch =
    o.branch && !bends.length
      ? [p, ...clipToBoxes(o.branch, far, b).slice(1)]
      : [p, ...bends, ...intoBox(tail, b)];
  // Never back along the line it came in on: it parts where the two really go different ways.
  const { inn, out: on } = untangle(squared(trunk), squared(branch));
  const pts = squared([...inn, ...on.slice(1)]);
  if (pts.length < 2) return lineRoute([anchor(a, "b"), anchor(b, "t")], o.round ?? 0);
  return { ...lineRoute(pts, o.round ?? 0), dots: { split: inn[inn.length - 1] } };
}

/** Which way a line heads off from the point x on it: towards its start (`back`) or its end. Undefined when x isn't on it. */
function headingAt(pts: Point[], x: Point, back: boolean): string | undefined {
  for (let i = 0; i < pts.length; i++) {
    const [p, next] = [pts[i]!, pts[i + 1]];
    const here = Math.hypot(p.x - x.x, p.y - x.y) < 1;
    if (!here && !(next && along(x, p, next) && Math.hypot(next.x - x.x, next.y - x.y) >= 1))
      continue;
    // On a corner: the corner before or after it. Partway along a stretch: that stretch's end.
    const to = back ? (here ? pts[i - 1] : p) : next;
    return to && `${Math.sign(Math.round(to.x - x.x))},${Math.sign(Math.round(to.y - x.y))}`;
  }
  return undefined;
}

/**
 * The dots worth drawing, as "x,y": the spots where arrows of one split group really part, or
 * arrows of one join group really meet (two of them come or go different ways there). An
 * arrow's own point with nothing parting or meeting at it gets none.
 */
export function sharedDots(
  arrows: { route?: Route; split?: string; join?: string }[],
): Set<string> {
  const out = new Set<string>();
  for (const kind of ["split", "join"] as const) {
    const groups = new Map<string, Route[]>();
    for (const a of arrows)
      if (a[kind] && a.route?.pts) groups.set(a[kind], [...(groups.get(a[kind]) ?? []), a.route]);
    for (const routes of groups.values())
      for (const r of routes) {
        const x = r.dots?.[kind];
        if (!x) continue;
        const ways = new Set(routes.map((o) => headingAt(o.pts!, x, kind === "join")));
        ways.delete(undefined);
        if (ways.size > 1) out.add(`${x.x},${x.y}`);
      }
  }
  return out;
}

/**
 * An arrow through both: out to its split point with the others from its box, across to its
 * join point, and into the other box with the others that join there.
 */
function throughRoute(
  a: Rect,
  b: Rect,
  s: { split: Point; join: Point; bends?: Point[] },
  o: { trunk?: Point[] | null; own?: Point[] | null; tail?: Point[] | null; round?: number },
): Route {
  const far: Rect = { x: -1e9, y: -1e9, w: 0, h: 0 };
  const head = o.trunk
    ? [...clipToBoxes(o.trunk, a, far).slice(0, -1), s.split]
    : [...intoBox(s.split, a).reverse(), s.split];
  const end = o.tail
    ? [s.join, ...clipToBoxes(o.tail, far, b).slice(1)]
    : [s.join, ...intoBox(s.join, b)];
  const middle = s.bends?.length ? s.bends : (o.own?.slice(1, -1) ?? []);
  const r = lineRoute(squared([...head, ...middle, ...end]), o.round ?? 0);
  return { ...r, dots: { split: s.split, join: s.join } };
}

/**
 * The line of an arrow that goes by a split point, a join point or both; undefined when it has
 * neither. `paths` are the router's: the shared stretch from its box, its own, the shared one in.
 */
export function meetRoute(
  a: Rect,
  b: Rect,
  s: { split?: Point; join?: Point; bends?: Point[] } | undefined,
  o: { trunk?: Point[] | null; own?: Point[] | null; tail?: Point[] | null; round?: number },
): Route | undefined {
  if (s?.split && s.join) return throughRoute(a, b, { ...s, split: s.split, join: s.join }, o);
  if (s?.split)
    return splitRoute(a, s.split, b, {
      trunk: o.trunk,
      branch: o.own,
      bends: s.bends,
      round: o.round,
    });
  if (s?.join)
    return joinRoute(a, s.join, b, { branch: o.own, tail: o.tail, bends: s.bends, round: o.round });
  return undefined;
}

/**
 * An arrow through a join point: from its box to the point, then into the other box along the
 * stretch it shares with the others that join there. A split, the other way round.
 */
export function joinRoute(
  a: Rect,
  p: Point,
  b: Rect,
  o: { branch?: Point[] | null; tail?: Point[] | null; bends?: Point[]; round?: number } = {},
): Route {
  const back = splitRoute(b, p, a, {
    trunk: o.tail && [...o.tail].reverse(),
    branch: o.branch && [...o.branch].reverse(),
    bends: o.bends && [...o.bends].reverse(),
  });
  return { ...lineRoute([...back.pts!].reverse(), o.round ?? 0), dots: { join: back.dots?.split } };
}

/** An arrow bent by hand that's in a fan still leaves from the fan's spot: its pin and offsets, with that start. */
export function fanStart<P extends { from?: Side }, A extends { a?: number }>(
  pin: P,
  at: A,
  fan: { side: Side } | undefined,
  a: number | undefined,
): { pin: P; at: A } {
  return fan ? { pin: { ...pin, from: fan.side }, at: { ...at, a: a ?? 0 } } : { pin, at };
}

/** How far two lines from the same point run as one, in px (0 when they part at once). */
export function sharedRun(a: Point[], b: Point[]): number {
  let run = 0;
  for (let i = 1; i < a.length && i < b.length; i++) {
    const [p, q, r] = [a[i - 1]!, a[i]!, b[i]!];
    if (Math.hypot(p.x - b[i - 1]!.x, p.y - b[i - 1]!.y) > 0.5) break;
    const la = Math.hypot(q.x - p.x, q.y - p.y);
    const lb = Math.hypot(r.x - p.x, r.y - p.y);
    // Not the same way out of this point: they've parted.
    if (!la || !lb || ((q.x - p.x) * (r.x - p.x) + (q.y - p.y) * (r.y - p.y)) / (la * lb) < 0.999)
      break;
    run += Math.min(la, lb);
    if (Math.abs(la - lb) > 0.5) break;
  }
  return run;
}

/** A line's length. */
export function lineLength(pts: Point[]): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++)
    total += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
  return total;
}

/**
 * Spread the ends of edges that share a box side along it, ordered by where the other
 * end is, so they don't pile onto one point or cross each other at the box.
 */
export function ports(
  edges: PortEdge[],
  rect: (id: string) => Rect | undefined,
  chosen?: Map<string, { from: Side; to: Side }>,
): Map<string, { a: number; b: number }> {
  const groups = new Map<string, { edge: string; end: "a" | "b"; key: number }[]>();
  const add = (node: string, side: Side, edge: string, end: "a" | "b", other: Rect) => {
    const c = center(other);
    const k = `${node}|${side}`;
    const item = { edge, end, key: side === "l" || side === "r" ? c.y : c.x };
    const g = groups.get(k);
    if (g) g.push(item);
    else groups.set(k, [item]);
  };
  for (const e of edges) {
    const a = rect(e.from);
    const b = rect(e.to);
    if (!a || !b) continue;
    const { from, to } = chosen?.get(e.id) ?? sides(a, b);
    add(e.from, from, e.id, "a", b);
    add(e.to, to, e.id, "b", a);
  }
  const out = new Map<string, { a: number; b: number }>();
  for (const [k, items] of groups) {
    const [node, side] = k.split("|") as [string, Side];
    const r = rect(node)!;
    const len = (side === "l" || side === "r" ? r.h : r.w) * 0.7;
    items.sort((x, y) => x.key - y.key);
    const n = items.length;
    const step = Math.min(18, len / Math.max(1, n - 1));
    items.forEach((it, i) => {
      const off = n === 1 ? 0 : (i - (n - 1) / 2) * step;
      const cur = out.get(it.edge) ?? { a: 0, b: 0 };
      cur[it.end] = off;
      out.set(it.edge, cur);
    });
  }
  return out;
}

export function routePoint(r: Route, t: number): Point {
  if (r.pts) return alongLine(r.pts, t);
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * r.p0.x + b * r.c1.x + c * r.c2.x + d * r.p1.x,
    y: a * r.p0.y + b * r.c1.y + c * r.c2.y + d * r.p1.y,
  };
}

/**
 * Where a label could sit on a line route, best first: the middle of each straight stretch
 * (longest first), then its thirds. Curves have one spot, their middle.
 */
export function labelSpots(r: Route, w = 0): Point[] {
  if (!r.pts) return [routePoint(r, 0.5)];
  const legs: { a: Point; b: Point; len: number }[] = [];
  for (let i = 1; i < r.pts.length; i++) {
    const a = r.pts[i - 1]!;
    const b = r.pts[i]!;
    legs.push({ a, b, len: Math.hypot(b.x - a.x, b.y - a.y) });
  }
  // Text runs across: a leg it can lie along (one that runs across, long enough) comes before
  // an upright one, whose middle would spread the label sideways over other lines.
  const along = (l: { a: Point; b: Point; len: number }) =>
    w > 0 && Math.abs(l.b.x - l.a.x) >= Math.abs(l.b.y - l.a.y) && l.len >= Math.min(w, 120);
  legs.sort((x, y) => Number(along(y)) - Number(along(x)) || y.len - x.len);
  const at = (l: { a: Point; b: Point }, t: number) => ({
    x: l.a.x + (l.b.x - l.a.x) * t,
    y: l.a.y + (l.b.y - l.a.y) * t,
  });
  return [...legs.map((l) => at(l, 0.5)), ...legs.flatMap((l) => [at(l, 1 / 3), at(l, 2 / 3)])];
}

/** How much two rects overlap, as an area (0 when they don't). */
function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Where a w×h label goes on a route: the first spot clear of `boxes` and of labels already
 * `taken` (it's added to them), trying the good spots first (labelSpots), then every few
 * pixels along the whole line. A short hop between two boxes has no clear spot of its own,
 * so the label slides to where the line runs in the open. With none clear anywhere, the
 * spot that covers least.
 */
export function placeLabel(
  r: Route,
  w: number,
  h: number,
  boxes: Rect[] | RectIndex,
  taken: Rect[],
  others: Route[] = [],
): Point {
  return placeLabelOn(r, w, h, boxes, taken, true, others).at;
}

interface Run {
  of: Route;
  a: Point;
  b: Point;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
const RUNS = new WeakMap<Route[], Run[]>();
/**
 * Every route's straight runs (a curve as four chords), with their bounds. Kept per list of
 * routes: a redraw places every label against the same list, so it's worked out once.
 */
function runsOf(routes: Route[]): Run[] {
  const had = RUNS.get(routes);
  if (had) return had;
  const runs: Run[] = [];
  for (const o of routes) {
    const pts = o.pts ?? [o.p0, routePoint(o, 0.25), routePoint(o, 0.5), routePoint(o, 0.75), o.p1];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
      runs.push({
        of: o,
        a,
        b,
        x0: Math.min(a.x, b.x),
        y0: Math.min(a.y, b.y),
        x1: Math.max(a.x, b.x),
        y1: Math.max(a.y, b.y),
      });
    }
  }
  RUNS.set(routes, runs);
  return runs;
}

/** placeLabel, saying how much box it still covers (0: none), so a caller can shorten it and try again. */
export function placeLabelOn(
  r: Route,
  w: number,
  h: number,
  boxes: Rect[] | RectIndex,
  taken: Rect[],
  keep = true,
  others: Route[] = [],
): { at: Point; covers: number } {
  const box = (p: Point): Rect => ({ x: p.x - w / 2 - 4, y: p.y - h / 2 - 2, w: w + 8, h: h + 4 });
  // Every spot tried lies on the route or just beside it, so only what's within reach of the
  // route can cost anything: boxes, labels and runs further off are dropped once, here, and not
  // weighed again for each of a few hundred spots.
  const hull = r.pts ?? [r.p0, r.c1, r.c2, r.p1];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const q of hull) {
    x0 = Math.min(x0, q.x);
    y0 = Math.min(y0, q.y);
    x1 = Math.max(x1, q.x);
    y1 = Math.max(y1, q.y);
  }
  x0 -= w + 20;
  x1 += w + 20;
  y0 -= 2 * h + 20;
  y1 += 2 * h + 20;
  const near = (b: Rect) => b.x <= x1 && b.x + b.w >= x0 && b.y <= y1 && b.y + b.h >= y0;
  const nearBoxes = (
    boxes instanceof RectIndex ? boxes.near({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }) : boxes
  ).filter(near);
  const nearTaken = taken.filter(near);
  // Other lines' straight runs: a label lying along one reads as that line's label.
  const runs = runsOf(others).filter(
    (s) => s.of !== r && s.x0 <= x1 && s.x1 >= x0 && s.y0 <= y1 && s.y1 >= y0,
  );
  const overRuns = (b: Rect) => {
    const right = b.x + b.w;
    const bottom = b.y + b.h;
    let n = 0;
    for (const s of runs) {
      // A run whose own bounds miss the label has no length inside it: skip the sum.
      if (s.x1 < b.x || s.x0 > right || s.y1 < b.y || s.y0 > bottom) continue;
      n += lengthInside(s.a, s.b, b);
    }
    return n;
  };
  // Covering a box's title is far worse than sitting on another label or line.
  const cost = (b: Rect) => {
    let onBoxes = 0;
    for (const x of nearBoxes) onBoxes += overlapArea(x, b);
    let onLabels = 0;
    for (const x of nearTaken) onLabels += overlapArea(x, b);
    return onBoxes * 8 + onLabels + overRuns(b) * h * 2;
  };
  const on = [...labelSpots(r, w)];
  for (let t = 0.1; t <= 0.9001; t += 0.025) on.push(routePoint(r, t));
  // On an upright stretch a label across the line spreads sideways over its neighbours and
  // reads as theirs: beside it, touching, is how it reads as this line's.
  const upright = (p: Point) => {
    if (!r.pts) return false;
    for (let i = 1; i < r.pts.length; i++) {
      const a = r.pts[i - 1]!;
      const b = r.pts[i]!;
      if (
        Math.abs(a.x - b.x) < 1 &&
        Math.abs(p.x - a.x) < 1 &&
        p.y >= Math.min(a.y, b.y) - 1 &&
        p.y <= Math.max(a.y, b.y) + 1
      )
        return Math.abs(b.y - a.y) > h * 2;
    }
    return false;
  };
  // Then just beside the line (above or below it, or to one side), which still reads as its
  // label; each step off the line costs a little, so on the line wins when it's clear.
  const off = [h / 2 + 6, -(h / 2 + 6), h + 12, -(h + 12)].flatMap((dy) =>
    on.map((p) => ({ x: p.x, y: p.y + dy, away: Math.abs(dy) })),
  );
  const side = [w / 2 + 10, -(w / 2 + 10)].flatMap((dx) =>
    on.map((p) => ({ x: p.x + dx, y: p.y, away: upright(p) ? 0 : Math.abs(dx) })),
  );
  const across = on.map((p) => ({ ...p, away: upright(p) && w > 40 ? w / 2 : 0 }));
  const cands = [
    ...across.filter((p) => !p.away),
    ...side.filter((p) => !p.away),
    ...across.filter((p) => p.away),
    ...off,
    ...side.filter((p) => p.away),
  ];
  let best: Point = cands[0]!;
  let least = Infinity;
  for (const p of cands) {
    const over = cost(box(p));
    if (over === 0 && p.away === 0) {
      best = { x: p.x, y: p.y };
      least = 0;
      break;
    }
    const c = over + p.away * w;
    if (c < least) [best, least] = [{ x: p.x, y: p.y }, c];
  }
  const bestBox = box(best);
  const covers = nearBoxes.reduce((n, x) => n + overlapArea(x, bestBox), 0);
  if (keep) taken.push(box(best));
  return { at: best, covers };
}

/** How much of the segment a→b lies inside the rect (clipped, Liang–Barsky). */
export function lengthInside(a: Point, b: Point, r: Rect): number {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  // Each side of the rect in turn, written out: this runs millions of times a redraw, and a
  // list of pairs to loop over would be allocated on every call.
  for (let side = 0; side < 4; side++) {
    const p = side === 0 ? -dx : side === 1 ? dx : side === 2 ? -dy : dy;
    const q =
      side === 0
        ? a.x - r.x
        : side === 1
          ? r.x + r.w - a.x
          : side === 2
            ? a.y - r.y
            : r.y + r.h - a.y;
    if (p === 0) {
      if (q < 0) return 0;
    } else {
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
    }
  }
  return t1 > t0 ? (t1 - t0) * Math.hypot(dx, dy) : 0;
}

/** The point a fraction `t` of the way along a line, by length. */
function alongLine(pts: Point[], t: number): Point {
  let total = 0;
  for (let i = 1; i < pts.length; i++)
    total += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
  let left = total * Math.max(0, Math.min(1, t));
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (left <= len) return len === 0 ? a : toward(a, b, left);
    left -= len;
  }
  return pts[pts.length - 1]!;
}

function segmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** How far a point is from the curve (sampled; plenty for clicking on it). */
export function routeDistance(r: Route, p: Point, samples = 24): number {
  let best = Infinity;
  if (r.pts) {
    for (let i = 1; i < r.pts.length; i++)
      best = Math.min(best, segmentDistance(p, r.pts[i - 1]!, r.pts[i]!));
    return best;
  }
  let prev = r.p0;
  for (let i = 1; i <= samples; i++) {
    const next = routePoint(r, i / samples);
    best = Math.min(best, segmentDistance(p, prev, next));
    prev = next;
  }
  return best;
}

/** Boxes bucketed on a coarse grid, for "what's under this point" without scanning them all. */
const cellKey = (x: number, y: number) => (x + 0x8000) * 0x10000 + (y + 0x8000);

/** The area a curve can reach: the box around its end and control points. */
export function routeBox(r: Route): Rect {
  if (r.pts) return boundsOf(r.pts.map((q) => ({ x: q.x, y: q.y, w: 0, h: 0 })))!;
  const x0 = Math.min(r.p0.x, r.c1.x, r.c2.x, r.p1.x);
  const y0 = Math.min(r.p0.y, r.c1.y, r.c2.y, r.p1.y);
  return {
    x: x0,
    y: y0,
    w: Math.max(r.p0.x, r.c1.x, r.c2.x, r.p1.x) - x0,
    h: Math.max(r.p0.y, r.c1.y, r.c2.y, r.p1.y) - y0,
  };
}

/**
 * Rects on a coarse grid, to ask which are near a place without looking at all of them.
 * Answers come in the order the rects were given, so code that takes "the first one that..."
 * picks the same one as it would from the whole list.
 */
export class RectIndex {
  private cells = new Map<number, number[]>();
  private rects: Rect[];
  private cell: number;
  constructor(rects: Rect[], cell = 512) {
    this.rects = rects;
    this.cell = cell;
    rects.forEach((r, i) => {
      const x1 = Math.floor((r.x + r.w) / cell);
      const y1 = Math.floor((r.y + r.h) / cell);
      for (let x = Math.floor(r.x / cell); x <= x1; x++)
        for (let y = Math.floor(r.y / cell); y <= y1; y++) {
          const k = cellKey(x, y);
          const list = this.cells.get(k);
          if (list) list.push(i);
          else this.cells.set(k, [i]);
        }
    });
  }

  /** Every rect that could touch `q` (and maybe a few that don't), in the order given. */
  near(q: Rect): Rect[] {
    const x1 = Math.floor((q.x + q.w) / this.cell);
    const y1 = Math.floor((q.y + q.h) / this.cell);
    const x0 = Math.floor(q.x / this.cell);
    const y0 = Math.floor(q.y / this.cell);
    // A query as big as the whole drawing: the list itself is the answer.
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > this.cells.size) return this.rects;
    const hit = new Set<number>();
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++)
        for (const i of this.cells.get(cellKey(x, y)) ?? []) hit.add(i);
    return [...hit].sort((a, b) => a - b).map((i) => this.rects[i]!);
  }
}

export class BoxGrid {
  // Keyed by a number (not "x,y"): this lookup runs ~half a million times per full routing.
  private cells = new Map<number, { id: string; r: Rect }[]>();
  private cell: number;
  private pad: number;
  constructor(cell = 256, pad = 10) {
    this.cell = cell;
    this.pad = pad;
  }

  add(id: string, r: Rect): void {
    const p = this.pad;
    const x0 = Math.floor((r.x - p) / this.cell);
    const x1 = Math.floor((r.x + r.w + p) / this.cell);
    const y0 = Math.floor((r.y - p) / this.cell);
    const y1 = Math.floor((r.y + r.h + p) / this.cell);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const k = cellKey(x, y);
        const list = this.cells.get(k);
        if (list) list.push({ id, r });
        else this.cells.set(k, [{ id, r }]);
      }
    }
  }

  /** Does this rect overlap any box (without padding)? */
  overlaps(q: Rect): boolean {
    const x0 = Math.floor(q.x / this.cell);
    const x1 = Math.floor((q.x + q.w) / this.cell);
    const y0 = Math.floor(q.y / this.cell);
    const y1 = Math.floor((q.y + q.h) / this.cell);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        for (const { r } of this.cells.get(cellKey(x, y)) ?? []) if (intersects(r, q)) return true;
      }
    }
    return false;
  }

  /** The box a point is inside (with padding), other than the ones to skip. */
  hit(p: Point, skipA: string, skipB: string): string | null {
    const list = this.cells.get(cellKey(Math.floor(p.x / this.cell), Math.floor(p.y / this.cell)));
    if (!list) return null;
    const pad = this.pad;
    for (const { id, r } of list) {
      if (id === skipA || id === skipB) continue;
      if (p.x > r.x - pad && p.x < r.x + r.w + pad && p.y > r.y - pad && p.y < r.y + r.h + pad)
        return id;
    }
    return null;
  }
}

const ALL_SIDES: Side[] = ["r", "l", "b", "t"];
const SAMPLES = 24;

interface RouteCost {
  /** Other boxes the curve runs through. */
  crossed: number;
  /** Samples inside its own end boxes (a curve doubling back through itself). */
  own: number;
  len: number;
}

function cost(r: Route, a: Rect, b: Rect, aId: string, bId: string, grid: BoxGrid): RouteCost {
  const crossed = new Set<string>();
  let own = 0;
  let len = 0;
  let prev = r.p0;
  for (let i = 1; i < SAMPLES; i++) {
    const t = i / SAMPLES;
    const p = routePoint(r, t);
    len += Math.hypot(p.x - prev.x, p.y - prev.y);
    prev = p;
    const hit = grid.hit(p, aId, bId);
    if (hit) crossed.add(hit);
    if ((t > 0.1 && contains(a, p)) || (t < 0.9 && contains(b, p))) own++;
  }
  len += Math.hypot(r.p1.x - prev.x, r.p1.y - prev.y);
  return { crossed: crossed.size, own, len };
}

/**
 * The sides each edge should leave and enter by: the facing sides, unless that curve runs
 * through another box and some other pair of sides doesn't.
 */
const NORMAL: Record<Side, Point> = {
  l: { x: -1, y: 0 },
  r: { x: 1, y: 0 },
  t: { x: 0, y: -1 },
  b: { x: 0, y: 1 },
};
/** Side `s` of `r` faces away from `other`, clearly (its outward direction points back). */
function backwards(r: Rect, s: Side, other: Rect): boolean {
  const c = center(r);
  const o = center(other);
  const v = { x: o.x - c.x, y: o.y - c.y };
  const len = Math.hypot(v.x, v.y) || 1;
  return (NORMAL[s].x * v.x + NORMAL[s].y * v.y) / len < -0.8;
}

export function chooseSides(
  edges: PortEdge[],
  rect: (id: string) => Rect | undefined,
  grid: BoxGrid,
): Map<string, { from: Side; to: Side }> {
  const out = new Map<string, { from: Side; to: Side }>();
  for (const e of edges) {
    const a = rect(e.from);
    const b = rect(e.to);
    if (!a || !b) continue;
    const facing = sides(a, b);
    const base = cost(route(a, b, 0, 0, facing), a, b, e.from, e.to, grid);
    if (base.crossed === 0) {
      out.set(e.id, facing);
      continue;
    }
    // A detour only if it crosses fewer boxes, doesn't loop through its own ends, and
    // isn't much longer: a wild loop around half the diagram reads worse than a crossing.
    const maxLen = base.len * 1.6 + 160;
    let best = facing;
    let bestScore = base.crossed * 1000 + base.len / 10;
    for (const from of ALL_SIDES) {
      for (const to of ALL_SIDES) {
        const via = { from, to };
        // Never out of the back of a box or into the far side of one: the arrow overshoots and
        // hooks back (a loop into the bottom of "Design folders" from above).
        if (backwards(a, from, b) || backwards(b, to, a)) continue;
        const c = cost(route(a, b, 0, 0, via), a, b, e.from, e.to, grid);
        if (c.crossed >= base.crossed || c.own > 1 || c.len > maxLen) continue;
        const score = c.crossed * 1000 + c.len / 10 + 6;
        if (score < bestScore) {
          bestScore = score;
          best = via;
        }
      }
    }
    out.set(e.id, best);
  }
  return out;
}

// --- arrows shaped by hand ------------------------------------------------------------------

/** The side of `r` nearest to `p`. */
export function nearestSide(r: Rect, p: Point): Side {
  const d: [Side, number][] = [
    ["l", Math.abs(p.x - r.x)],
    ["r", Math.abs(p.x - (r.x + r.w))],
    ["t", Math.abs(p.y - r.y)],
    ["b", Math.abs(p.y - (r.y + r.h))],
  ];
  // Outside the box, the side it's beyond wins over a nearer edge line it isn't beside.
  const c = center(r);
  const nx = (p.x - c.x) / (r.w / 2);
  const ny = (p.y - c.y) / (r.h / 2);
  if (Math.abs(nx) > 1 || Math.abs(ny) > 1)
    return Math.abs(nx) >= Math.abs(ny) ? (nx < 0 ? "l" : "r") : ny < 0 ? "t" : "b";
  return d.sort((a, b) => a[1] - b[1])[0]![0];
}

const horizontalSide = (s: Side) => s === "l" || s === "r";

/**
 * An arrow through hand-placed bend points. It leaves `a` by `via.from` (or wherever the
 * line to the first bend crosses its border) and arrives at `b` the same way. Elbow: right
 * angles, carrying on in the same direction before each turn; curved: big round corners;
 * straight: sharp corners.
 */
export function bentRoute(
  a: Rect,
  b: Rect,
  bends: Point[],
  style: "curved" | "elbow" | "straight",
  via: { from?: Side; to?: Side } = {},
  off: { a?: number; b?: number } = {},
): Route {
  const first = bends[0] ?? center(b);
  const last = bends[bends.length - 1] ?? center(a);
  const start = via.from
    ? anchor(a, via.from, off.a ?? 0)
    : (exitPoint(a, center(a), first) ?? center(a));
  const end = via.to ? anchor(b, via.to, off.b ?? 0) : (exitPoint(b, center(b), last) ?? center(b));
  const raw = [start, ...bends, end];
  // Which way the line runs as it leaves: out of the side it starts on.
  const startSide = via.from ?? sideOfBorder(a, start);
  const endSide = via.to ?? sideOfBorder(b, end);
  if (style === "straight") return lineRoute(dedupe(raw), 0);
  if (style === "curved") {
    // A smooth curve through the bends that leaves and arrives square on to the box (a
    // short straight start and end), sampled finely so it's drawn and hit-tested as a line.
    const o = OUT[startSide];
    const i = OUT[endSide];
    const lead = 18;
    const through = dedupe([
      start,
      { x: start.x + o.x * lead, y: start.y + o.y * lead },
      ...bends,
      { x: end.x + i.x * lead, y: end.y + i.y * lead },
      end,
    ]);
    return lineRoute(smoothThrough(through), 0);
  }
  let horizontal = horizontalSide(startSide);
  const out: Point[] = [start];
  for (let i = 1; i < raw.length; i++) {
    const p = out[out.length - 1]!;
    const q = raw[i]!;
    if (p.x !== q.x && p.y !== q.y) {
      // The last leg turns so it arrives square on to its side.
      const h = i === raw.length - 1 ? !horizontalSide(endSide) : horizontal;
      out.push(h ? { x: q.x, y: p.y } : { x: p.x, y: q.y });
      horizontal = !h;
    } else if (p.x !== q.x || p.y !== q.y) horizontal = p.y === q.y;
    out.push(q);
  }
  return lineRoute(dedupe(out), 10);
}

function sideOfBorder(r: Rect, p: Point): Side {
  return nearestSide({ x: r.x - 0.01, y: r.y - 0.01, w: r.w + 0.02, h: r.h + 0.02 }, p);
}

function dedupe(pts: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || Math.abs(q.x - p.x) > 0.01 || Math.abs(q.y - p.y) > 0.01) out.push(p);
  }
  if (out.length < 2) out.push({ ...out[0]! });
  return out;
}

/** How far along the route (0 at the start, 1 at the end) the point nearest `p` is. */
export function nearestT(r: Route, p: Point): number {
  const pts = r.pts ?? Array.from({ length: 49 }, (_, i) => routePoint(r, i / 48));
  let total = 0;
  let best = { d: Infinity, at: 0 };
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const u = len
      ? Math.max(
          0,
          Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (len * len)),
        )
      : 0;
    const d = Math.hypot(a.x + (b.x - a.x) * u - p.x, a.y + (b.y - a.y) * u - p.y);
    if (d < best.d) best = { d, at: total + len * u };
    total += len;
  }
  return total ? Math.max(0, Math.min(1, best.at / total)) : 0.5;
}

/** Where a new bend at `p` goes in the list: on the stretch of [start, ...bends, end] nearest it. */
export function bendIndex(start: Point, bends: Point[], end: Point, p: Point): number {
  const pts = [start, ...bends, end];
  let best = { d: Infinity, i: 0 };
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const len2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
    const u = len2
      ? Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / len2))
      : 0;
    const d = Math.hypot(a.x + (b.x - a.x) * u - p.x, a.y + (b.y - a.y) * u - p.y);
    if (d < best.d) best = { d, i: i - 1 };
  }
  return best.i;
}

export const SIDE_WORD: Record<Side, "left" | "right" | "top" | "bottom"> = {
  l: "left",
  r: "right",
  t: "top",
  b: "bottom",
};
export const SIDE_OF_WORD: Record<"left" | "right" | "top" | "bottom", Side> = {
  left: "l",
  right: "r",
  top: "t",
  bottom: "b",
};

/**
 * Points along a centripetal Catmull-Rom spline through `pts`: smooth, goes through every
 * point, and (unlike rounding each corner) never loops back on itself at a sharp bend.
 */
export function smoothThrough(pts: Point[], perLeg = 14): Point[] {
  if (pts.length < 3) return pts;
  const n = pts.length;
  const at = (k: number): Point => {
    if (k < 0) return { x: 2 * pts[0]!.x - pts[1]!.x, y: 2 * pts[0]!.y - pts[1]!.y };
    if (k >= n)
      return { x: 2 * pts[n - 1]!.x - pts[n - 2]!.x, y: 2 * pts[n - 1]!.y - pts[n - 2]!.y };
    return pts[k]!;
  };
  const out: Point[] = [pts[0]!];
  for (let k = 0; k < n - 1; k++) {
    const p0 = at(k - 1);
    const p1 = at(k);
    const p2 = at(k + 1);
    const p3 = at(k + 2);
    const t = (a: Point, b: Point) => Math.max(1e-3, Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y)));
    const t1 = t(p0, p1);
    const t2 = t1 + t(p1, p2);
    const t3 = t2 + t(p2, p3);
    for (let s = 1; s <= perLeg; s++) {
      const u = t1 + ((t2 - t1) * s) / perLeg;
      const lerp = (a: Point, b: Point, ta: number, tb: number): Point => ({
        x: ((tb - u) / (tb - ta)) * a.x + ((u - ta) / (tb - ta)) * b.x,
        y: ((tb - u) / (tb - ta)) * a.y + ((u - ta) / (tb - ta)) * b.y,
      });
      const a1 = lerp(p0, p1, 0, t1);
      const a2 = lerp(p1, p2, t1, t2);
      const a3 = lerp(p2, p3, t2, t3);
      const b1 = lerp(a1, a2, 0, t2);
      const b2 = lerp(a2, a3, t1, t3);
      out.push(lerp(b1, b2, t1, t2));
    }
  }
  return out;
}

/** Points along a route: its line, or the curve sampled. */
function routePts(r: Route, n = 32): Point[] {
  return r.pts ?? Array.from({ length: n + 1 }, (_, i) => routePoint(r, i / n));
}

const within = (inner: Rect, outer: Rect) =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.w <= outer.x + outer.w &&
  inner.y + inner.h <= outer.y + outer.h;

/**
 * A curve that runs through boxes other than its ends (and what holds them), bent around
 * them: for each box it crosses, a pass along whichever side of it covers least, kept smooth
 * (bentRoute, curved). The canvas and the render both draw curved arrows this way, so a
 * line never reads as going into a box it doesn't touch. A curve that crosses nothing is
 * returned as it is; one that can't be cleared keeps the bending that covers least.
 */
export function curveAround(
  r: Route,
  a: Rect,
  b: Rect,
  via: { from: Side; to: Side },
  boxes: Iterable<Rect> | RectIndex,
  off: { a?: number; b?: number } = {},
  margin = 18,
): Route {
  const pad = (x: Rect, m: number): Rect => ({
    x: x.x - m,
    y: x.y - m,
    w: x.w + 2 * m,
    h: x.h + 2 * m,
  });
  const reach = pad(routeBox(r), margin * 4);
  const blockers: Rect[] = [];
  for (const x of boxes instanceof RectIndex ? boxes.near(reach) : boxes)
    if (x !== a && x !== b && !within(a, x) && !within(b, x) && intersects(x, reach))
      blockers.push(x);
  if (!blockers.length) return r;
  // How much of the route is inside other boxes, and which it enters first.
  const inside = (rt: Route): { total: number; first: Rect | null } => {
    const pts = routePts(rt);
    let total = 0;
    let first: Rect | null = null;
    for (let i = 1; i < pts.length; i++)
      for (const x of blockers) {
        const l = lengthInside(pts[i - 1]!, pts[i]!, x);
        if (l > 0.5) ((total += l), (first ??= x));
      }
    return { total, first };
  };
  const length = (rt: Route) => {
    const pts = routePts(rt);
    let n = 0;
    for (let i = 1; i < pts.length; i++)
      n += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
    return n;
  };
  let best = { route: r, ...inside(r) };
  if (!best.first) return r;
  const score = (x: { total: number; route: Route }) => x.total * 20 + length(x.route);
  const dir = { x: r.p1.x - r.p0.x, y: r.p1.y - r.p0.y };
  const along = (p: Point) => (p.x - r.p0.x) * dir.x + (p.y - r.p0.y) * dir.y;
  let bends: Point[] = [];
  for (let step = 0; step < 4 && best.first; step++) {
    const x = pad(best.first, margin);
    const across = Math.abs(dir.x) >= Math.abs(dir.y);
    // Past it above or below (a line running across), or left or right (one running down).
    const ways: Point[][] = across
      ? [
          [
            { x: x.x, y: x.y },
            { x: x.x + x.w, y: x.y },
          ],
          [
            { x: x.x, y: x.y + x.h },
            { x: x.x + x.w, y: x.y + x.h },
          ],
        ]
      : [
          [
            { x: x.x, y: x.y },
            { x: x.x, y: x.y + x.h },
          ],
          [
            { x: x.x + x.w, y: x.y },
            { x: x.x + x.w, y: x.y + x.h },
          ],
        ];
    let next: { route: Route; total: number; first: Rect | null; bends: Point[] } | null = null;
    // A bend past either end makes the arrow overshoot and hook back into its box (a loop under "Design folders", from passing below the box beside it): only bends between.
    const end = along(r.p1);
    for (const way0 of ways) {
      const way = way0.filter((p) => along(p) > 0 && along(p) < end);
      if (!way.length) continue;
      const tried = [...bends, ...way].sort((p, q) => along(p) - along(q));
      // Out of the side it leaves by and into the side it enters by: a first bend behind the
      // start (or a last one behind the end) turns the arrow back on itself in a hook.
      const s0 = anchor(a, via.from, off.a ?? 0);
      const s1 = anchor(b, via.to, off.b ?? 0);
      const f = tried[0]!;
      const l = tried[tried.length - 1]!;
      if (NORMAL[via.from].x * (f.x - s0.x) + NORMAL[via.from].y * (f.y - s0.y) < 0) continue;
      if (NORMAL[via.to].x * (l.x - s1.x) + NORMAL[via.to].y * (l.y - s1.y) < 0) continue;
      const route = bentRoute(a, b, tried, "curved", via, off);
      const got = { route, ...inside(route), bends: tried };
      if (!next || score(got) < score(next)) next = got;
    }
    if (!next || score(next) >= score(best)) break;
    best = next;
    bends = next.bends;
  }
  return best.route;
}
