// Making room on the canvas for what a layer draws under boxes, without moving anything for
// real. Under each box that shows a row there's a cut: everything below it is drawn lower by
// the row's height, frames grow to keep what's in them, and a drop or a new box is mapped back
// before it's saved. Like inserting a row in a spreadsheet: whole bands move, so what was lined
// up stays lined up, and nothing that didn't overlap starts to.
import type { CanvasGraph } from "../../shared/project";

export interface Spread {
  /** Saved → drawn. */
  down(y: number): number;
  /** Drawn → saved (a point inside an inserted gap goes to the cut). */
  up(y: number): number;
  /** Nothing to make room for. */
  none: boolean;
}

export const NO_SPREAD: Spread = { down: (y) => y, up: (y) => y, none: true };

/** Cuts at these heights, each opening a gap of `by`; cuts within a few units merge. */
export function makeSpread(cuts: { y: number; by: number }[]): Spread {
  if (!cuts.length) return NO_SPREAD;
  const sorted = [...cuts].sort((a, b) => a.y - b.y);
  const merged: { y: number; by: number }[] = [];
  for (const c of sorted) {
    const last = merged[merged.length - 1];
    if (last && c.y - last.y < 4) last.by = Math.max(last.by, c.by);
    else merged.push({ ...c });
  }
  return {
    none: false,
    down(y) {
      let off = 0;
      for (const c of merged) if (c.y < y) off += c.by;
      return y + off;
    },
    up(y) {
      let off = 0;
      for (const c of merged) {
        const at = c.y + off;
        if (y <= at) break;
        if (y < at + c.by) return c.y;
        off += c.by;
      }
      return y - off;
    },
  };
}

/** The graph as drawn: boxes moved down past the cuts above them, frames stretched to match. */
export function spreadGraph(g: CanvasGraph, s: Spread): CanvasGraph {
  if (s.none) return g;
  return {
    nodes: g.nodes.map((n) => ({ ...n, y: s.down(n.y) })),
    edges: g.edges.map((e) =>
      e.shape?.bends?.length || e.shape?.split || e.shape?.join
        ? {
            ...e,
            shape: {
              ...e.shape,
              bends: e.shape.bends?.map((b) => ({ x: b.x, y: s.down(b.y) })),
              split: e.shape.split && { x: e.shape.split.x, y: s.down(e.shape.split.y) },
              join: e.shape.join && { x: e.shape.join.x, y: s.down(e.shape.join.y) },
            },
          }
        : e,
    ),
    groups: g.groups.map((gr) => {
      const y = s.down(gr.y);
      return { ...gr, y, h: s.down(gr.y + gr.h) - y };
    }),
  };
}
