// Curved arrows go around the boxes between their ends (trial 14: one ran through Dev probes).
import { describe, expect, it } from "vitest";
import { curveAround, lengthInside, route, routePoint, type Rect, type Route } from "./geometry.ts";

const inside = (r: Route, x: Rect) => {
  const pts = r.pts ?? Array.from({ length: 65 }, (_, i) => routePoint(r, i / 64));
  let n = 0;
  for (let i = 1; i < pts.length; i++) n += lengthInside(pts[i - 1]!, pts[i]!, x);
  return n;
};

describe("curveAround", () => {
  const a: Rect = { x: 0, y: 0, w: 120, h: 60 };
  const b: Rect = { x: 600, y: 0, w: 120, h: 60 };
  const via = { from: "r", to: "l" } as const;

  it("bends a curve around a box in its way, and keeps its ends", () => {
    const wall: Rect = { x: 300, y: -10, w: 120, h: 80 };
    const r = route(a, b, 0, 0, via);
    expect(inside(r, wall)).toBeGreaterThan(50);
    const around = curveAround(r, a, b, via, [a, b, wall]);
    expect(inside(around, wall)).toBe(0);
    const pts = around.pts!;
    expect(pts[0]).toEqual(r.p0);
    expect(pts[pts.length - 1]).toEqual(r.p1);
  });

  it("goes around two boxes in a row", () => {
    const one: Rect = { x: 220, y: 0, w: 80, h: 60 };
    const two: Rect = { x: 420, y: -20, w: 80, h: 60 };
    const around = curveAround(route(a, b, 0, 0, via), a, b, via, [one, two]);
    expect(inside(around, one) + inside(around, two)).toBe(0);
  });

  it("leaves a clear curve alone, and the frames that hold its ends", () => {
    const r = route(a, b, 0, 0, via);
    const frame: Rect = { x: -40, y: -40, w: 800, h: 160 };
    expect(curveAround(r, a, b, via, [frame, { x: 300, y: 300, w: 80, h: 60 }])).toBe(r);
  });
});
