// Snapping a dragged box: to the grid, then to the lines of its neighbours.
import { type Guide, snapToNeighbours } from "../../../shared/align.ts";
import type { Point, Rect } from "../../../shared/geometry";
import { GUIDE_SNAP, MIN_H, MIN_W, SNAP } from "./theme";

/** Snap the grabbed box to the grid (the move that puts its corner on it); the rest move with it. */
export function gridSnap(lead: Point, dx: number, dy: number): { dx: number; dy: number } {
  return {
    dx: Math.round((lead.x + dx) / SNAP) * SNAP - lead.x,
    dy: Math.round((lead.y + dy) / SNAP) * SNAP - lead.y,
  };
}

/**
 * Line up with nearby boxes (edges, centres, equal gaps), which beats the grid. `moving` is the
 * bounds of what's dragged; only boxes within reach, and not themselves dragged, are looked at.
 */
export function neighbourSnap(
  moving: Rect,
  dragged: Set<string>,
  order: { node: Rect & { id: string } }[],
  scale: number,
): { dx: number; dy: number; guides: Guide[] } {
  const reach = 1200;
  const others = order
    .filter(
      (v) =>
        !dragged.has(v.node.id) &&
        Math.abs(v.node.x - moving.x) < reach &&
        Math.abs(v.node.y - moving.y) < reach,
    )
    .map((v) => ({ id: v.node.id, x: v.node.x, y: v.node.y, w: v.node.w, h: v.node.h }));
  return snapToNeighbours({ id: "", ...moving }, others, GUIDE_SNAP / scale);
}

/** A box's size while its corner is dragged: on the grid, and never smaller than the minimum. */
export function resizedSize(
  origin: { w: number; h: number },
  start: Point,
  world: Point,
): { w: number; h: number } {
  return {
    w: Math.max(MIN_W, Math.round((origin.w + world.x - start.x) / SNAP) * SNAP),
    h: Math.max(MIN_H, Math.round((origin.h + world.y - start.y) / SNAP) * SNAP),
  };
}
