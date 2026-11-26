// Small pure helpers: a box's fade, where a column's row sits, whether a box changed (its
// signature), how text is shortened, and the points on a box's edge.
import type { Point, Rect } from "../../../shared/geometry";
import { TABLE_HEAD, TABLE_ROW, tableShowsColumns } from "../../../shared/project.ts";
import type { CanvasNode } from "../types";

export const pad = (r: Rect, by: number): Rect => ({
  x: r.x - by,
  y: r.y - by,
  w: r.w + by * 2,
  h: r.h + by * 2,
});

/** The point on a box's border closest to p. */
export function nearestOnBorder(r: Rect, p: Point): Point {
  const x = Math.max(r.x, Math.min(r.x + r.w, p.x));
  const y = Math.max(r.y, Math.min(r.y + r.h, p.y));
  const d = [x - r.x, r.x + r.w - x, y - r.y, r.y + r.h - y];
  const m = Math.min(...d);
  if (m === d[0]) return { x: r.x, y };
  if (m === d[1]) return { x: r.x + r.w, y };
  if (m === d[2]) return { x, y: r.y };
  return { x, y: r.y + r.h };
}

/** The middle of each side: hints that a box's edge can be dragged from. */
export function handles(n: Rect): Point[] {
  return [
    { x: n.x + n.w / 2, y: n.y },
    { x: n.x + n.w, y: n.y + n.h / 2 },
    { x: n.x + n.w / 2, y: n.y + n.h },
    { x: n.x, y: n.y + n.h / 2 },
  ];
}

export function baseAlpha(n: CanvasNode): number {
  // Future and deprecated also say so in their tags, so the fade can be lighter. A guess is
  // fainter still, as a guessed call's line is.
  return (
    (n.status === "future"
      ? 0.8
      : n.status === "deprecated"
        ? 0.55
        : n.status === "removed"
          ? 0.6
          : 1) * (n.guess ? 0.6 : 1)
  );
}

/** Where a column's row is on an open table's side, from the side's middle (null: not shown). */
export function rowOffset(n: CanvasNode, column?: string): number | null {
  if (!column || n.kind !== "table" || !n.columns?.length || !tableShowsColumns(n.h)) return null;
  const i = n.columns.findIndex((c) => c.name === column);
  const fits = Math.max(1, Math.floor((n.h - TABLE_HEAD - 6) / TABLE_ROW));
  if (i < 0 || (n.columns.length > fits && i >= fits - 1)) return null;
  return TABLE_HEAD + i * TABLE_ROW + TABLE_ROW / 2 - n.h / 2;
}

export function signature(n: CanvasNode): string {
  const cols = n.columns?.map((c) => `${c.name}:${c.type}:${c.mark}:${c.nullable}`).join(",") ?? "";
  return [
    n.kind,
    n.name,
    n.subtitle,
    n.external,
    n.status,
    n.childCount,
    n.w,
    n.h,
    n.technology,
    n.icon ?? "",
    n.hidden,
    n.tags.join(","),
    n.color ?? "",
    cols,
  ].join("|");
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
