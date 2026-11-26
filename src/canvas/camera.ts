// The view onto the world: screen = world * scale + (x, y). Immutable; every change
// returns a new camera, so the scene can tell when it moved.
import type { Point, Rect } from "../../shared/geometry";

export interface Camera {
  x: number;
  y: number;
  scale: number;
}

export const MIN_SCALE = 0.05;
export const MAX_SCALE = 4;

function clampScale(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

export function screenToWorld(c: Camera, p: Point): Point {
  return { x: (p.x - c.x) / c.scale, y: (p.y - c.y) / c.scale };
}

export function worldToScreen(c: Camera, p: Point): Point {
  return { x: p.x * c.scale + c.x, y: p.y * c.scale + c.y };
}

export function panBy(c: Camera, dx: number, dy: number): Camera {
  return { ...c, x: c.x + dx, y: c.y + dy };
}

/** Zoom by `factor` keeping the world point under the screen point `at` where it is. */
export function zoomAt(c: Camera, at: Point, factor: number): Camera {
  const scale = clampScale(c.scale * factor);
  const k = scale / c.scale;
  return { scale, x: at.x - (at.x - c.x) * k, y: at.y - (at.y - c.y) * k };
}

/** The camera that shows all of `bounds` centered in a w×h view, `padding` px at the edges. */
export function fitBounds(bounds: Rect, w: number, h: number, padding = 48): Camera {
  const availW = Math.max(1, w - padding * 2);
  const availH = Math.max(1, h - padding * 2);
  const scale = clampScale(
    Math.min(availW / Math.max(1, bounds.w), availH / Math.max(1, bounds.h), 1),
  );
  return {
    scale,
    x: w / 2 - (bounds.x + bounds.w / 2) * scale,
    y: h / 2 - (bounds.y + bounds.h / 2) * scale,
  };
}

/** The part of the world a w×h view shows. */
export function visibleWorld(c: Camera, w: number, h: number): Rect {
  const tl = screenToWorld(c, { x: 0, y: 0 });
  return { x: tl.x, y: tl.y, w: w / c.scale, h: h / c.scale };
}
