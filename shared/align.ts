// Alignment: where boxes sit is most of what makes a diagram readable. Two tools, both plain
// geometry (no canvas, no model) so they're tested on their own and the server can use them:
// - snapToNeighbours: while dragging, line the box up with others' edges, centres and gaps.
// - straighten: the smallest moves that put connected boxes on shared rows and columns.

import type { ArrowShape } from "./model.ts";

export interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A guide line to draw while snapping: vertical at x (from y0 to y1) or horizontal at y. */
export type Guide =
  | { axis: "x"; at: number; from: number; to: number }
  | { axis: "y"; at: number; from: number; to: number };

interface Snap {
  delta: number;
  guides: Guide[];
}

/**
 * Where the dragged boxes (their bounds, `moving`) would snap: to another box's left, centre
 * or right (top, middle, bottom), or to the same gap as the neighbours next to them. Within
 * `threshold`; otherwise no snap on that axis.
 */
export function snapToNeighbours(
  moving: Box,
  others: Box[],
  threshold: number,
): { dx: number; dy: number; guides: Guide[] } {
  const x = snapAxis(moving, others, threshold, "x");
  const y = snapAxis(moving, others, threshold, "y");
  return {
    dx: x?.delta ?? 0,
    dy: y?.delta ?? 0,
    guides: [...(x?.guides ?? []), ...(y?.guides ?? [])],
  };
}

function snapAxis(m: Box, others: Box[], threshold: number, axis: "x" | "y"): Snap | null {
  const pos = (b: Box) => (axis === "x" ? b.x : b.y);
  const size = (b: Box) => (axis === "x" ? b.w : b.h);
  const cross = (b: Box) => (axis === "x" ? b.y : b.x);
  const crossSize = (b: Box) => (axis === "x" ? b.h : b.w);
  const lines = (b: Box) => [pos(b), pos(b) + size(b) / 2, pos(b) + size(b)];

  let best: Snap | null = null;
  let bestAbs = threshold + 1e-9;
  const consider = (delta: number, guides: () => Guide[]) => {
    const abs = Math.abs(delta);
    if (abs < bestAbs - 1e-9) {
      bestAbs = abs;
      best = { delta, guides: guides() };
    } else if (best && Math.abs(abs - bestAbs) < 1e-9 && Math.abs(delta - best.delta) < 1e-9) {
      best.guides.push(...guides());
    }
  };

  // Edges and centres.
  const mine = lines(m);
  for (const o of others) {
    const theirs = lines(o);
    for (let i = 0; i < 3; i++) {
      // Only like with like (left/left, centre/centre, right/right) and edge to opposite
      // edge: a centre lined up with an edge reads as a mistake.
      for (let j = 0; j < 3; j++) {
        if ((i === 1) !== (j === 1)) continue;
        const delta = theirs[j]! - mine[i]!;
        consider(delta, () => {
          const at = theirs[j]!;
          const a = Math.min(cross(m), cross(o));
          const b = Math.max(cross(m) + crossSize(m), cross(o) + crossSize(o));
          return [
            axis === "x" ? { axis: "x", at, from: a, to: b } : { axis: "y", at, from: a, to: b },
          ];
        });
      }
    }
  }

  // Equal gaps: boxes sharing this row (overlapping on the other axis), on either side.
  const band = others
    .filter((o) => cross(o) < cross(m) + crossSize(m) && cross(o) + crossSize(o) > cross(m))
    .sort((a, b) => pos(a) - pos(b));
  const before = band.filter((o) => pos(o) + size(o) <= pos(m) + threshold);
  const after = band.filter((o) => pos(o) >= pos(m) + size(m) - threshold);
  const gapGuide = (a: Box, b: Box): Guide => {
    const at = cross(m) + crossSize(m) / 2;
    return axis === "x"
      ? { axis: "y", at, from: pos(a) + size(a), to: pos(b) }
      : { axis: "x", at, from: pos(a) + size(a), to: pos(b) };
  };
  const l1 = before[before.length - 1];
  const l2 = before[before.length - 2];
  const r1 = after[0];
  const r2 = after[1];
  if (l1 && l2) {
    const gap = pos(l1) - (pos(l2) + size(l2));
    consider(pos(l1) + size(l1) + gap - pos(m), () => [
      gapGuide(l2, l1),
      gapGuide(l1, {
        ...m,
        x: axis === "x" ? pos(l1) + size(l1) + gap : m.x,
        y: axis === "y" ? pos(l1) + size(l1) + gap : m.y,
      }),
    ]);
  }
  if (r1 && r2) {
    const gap = pos(r2) - (pos(r1) + size(r1));
    const target = pos(r1) - gap - size(m);
    consider(target - pos(m), () => [
      gapGuide({ ...m, x: axis === "x" ? target : m.x, y: axis === "y" ? target : m.y }, r1),
      gapGuide(r1, r2),
    ]);
  }
  if (l1 && r1) {
    // Centred between the two neighbours.
    const free = pos(r1) - (pos(l1) + size(l1)) - size(m);
    if (free > 0) {
      const target = pos(l1) + size(l1) + free / 2;
      consider(target - pos(m), () => {
        const placed = { ...m, x: axis === "x" ? target : m.x, y: axis === "y" ? target : m.y };
        return [gapGuide(l1, placed), gapGuide(placed, r1)];
      });
    }
  }
  return best;
}

/**
 * Straighten: the smallest moves that put connected boxes on shared rows and columns.
 * Boxes joined by an arrow whose centres are already close on one axis (within `near`, or
 * half the smaller box) are grouped, and each group moves to its members' median line. A
 * group that would land a box on top of another is left where it is. Snapped to `grid`.
 */
export function straighten(
  boxes: Box[],
  edges: { from: string; to: string }[],
  opts: { near?: number; grid?: number; only?: Set<string> } = {},
): Map<string, { x: number; y: number }> {
  const grid = opts.grid ?? 8;
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const movable = (id: string) => !opts.only || opts.only.has(id);
  const next = new Map(boxes.map((b) => [b.id, { x: b.x, y: b.y }]));
  const degree = new Map(boxes.map((b) => [b.id, 0]));
  for (const e of edges) {
    if (degree.has(e.from)) degree.set(e.from, degree.get(e.from)! + 1);
    if (degree.has(e.to)) degree.set(e.to, degree.get(e.to)! + 1);
  }

  for (const axis of ["y", "x"] as const) {
    const centre = (b: Box) =>
      axis === "y" ? next.get(b.id)!.y + b.h / 2 : next.get(b.id)!.x + b.w / 2;
    const parent = new Map<string, string>();
    const find = (id: string): string => {
      let p = parent.get(id) ?? id;
      while (p !== (parent.get(p) ?? p)) p = parent.get(p) ?? p;
      parent.set(id, p);
      return p;
    };
    for (const e of edges) {
      const a = byId.get(e.from);
      const b = byId.get(e.to);
      if (!a || !b || a === b || !movable(a.id) || !movable(b.id)) continue;
      const near = opts.near ?? Math.min(axis === "y" ? a.h : a.w, axis === "y" ? b.h : b.w) / 2;
      // Already side by side on this axis (so they'd share a row), and close to it.
      const apart = Math.abs(centre(a) - centre(b));
      const otherGap =
        axis === "y"
          ? Math.abs(a.x + a.w / 2 - (b.x + b.w / 2))
          : Math.abs(a.y + a.h / 2 - (b.y + b.h / 2));
      if (apart > 0 && apart <= near && otherGap > apart) parent.set(find(a.id), find(b.id));
    }
    const groups = new Map<string, Box[]>();
    for (const b of boxes) {
      const root = find(b.id);
      const g = groups.get(root);
      if (g) g.push(b);
      else groups.set(root, [b]);
    }
    for (const members of groups.values()) {
      if (members.length < 2) continue;
      // The line is the best-connected box's centre (it stays put: the hub the others line
      // up on), or the median one's when they're equally connected.
      const byCentre = [...members].sort((p, q) => centre(p) - centre(q));
      const median = byCentre[Math.floor((byCentre.length - 1) / 2)]!;
      const anchor = members.reduce(
        (best, b) => (degree.get(b.id)! > degree.get(best.id)! ? b : best),
        median,
      );
      const line = centre(anchor);
      const trial = new Map(next);
      for (const b of members) {
        if (b === anchor) continue;
        const cur = trial.get(b.id)!;
        const v = line - (axis === "y" ? b.h : b.w) / 2;
        // On the grid when the line allows it (same-size boxes), else exactly on the line.
        const snapped = Math.round(v / grid) * grid;
        const at = Math.abs(snapped - v) < 0.5 ? snapped : Math.round(v);
        trial.set(b.id, axis === "y" ? { x: cur.x, y: at } : { x: at, y: cur.y });
      }
      if (!overlapsAny(members, boxes, trial))
        for (const b of members) next.set(b.id, trial.get(b.id)!);
    }
  }
  const moved = new Map<string, { x: number; y: number }>();
  for (const b of boxes) {
    const p = next.get(b.id)!;
    if (p.x !== b.x || p.y !== b.y) moved.set(b.id, p);
  }
  return moved;
}

function overlapsAny(
  members: Box[],
  all: Box[],
  at: Map<string, { x: number; y: number }>,
): boolean {
  const rect = (b: Box) => ({ ...b, ...at.get(b.id)! });
  for (const m of members) {
    const a = rect(m);
    for (const o of all) {
      if (o.id === m.id) continue;
      const b = rect(o);
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) return true;
    }
  }
  return false;
}

/**
 * Boxes moved (laid out, straightened): hand-placed bends go with their arrow, moved by
 * how far its two ends moved on average, so a shaped arrow keeps its shape. Only shapes
 * that change come back.
 */
export function shiftBends(
  shapes: Iterable<ArrowShape>,
  before: Map<string, { x: number; y: number }>,
  after: Map<string, { x: number; y: number }>,
): ArrowShape[] {
  const out: ArrowShape[] = [];
  const delta = (id: string) => {
    const a = before.get(id);
    const b = after.get(id) ?? a;
    return a && b ? { x: b.x - a.x, y: b.y - a.y } : { x: 0, y: 0 };
  };
  for (const s of shapes) {
    if (!s.bends?.length) continue;
    const f = delta(s.from);
    const t = delta(s.to);
    const dx = Math.round((f.x + t.x) / 2);
    const dy = Math.round((f.y + t.y) / 2);
    if (!dx && !dy) continue;
    out.push({ ...s, bends: s.bends.map((p) => ({ x: p.x + dx, y: p.y + dy })) });
  }
  return out;
}
