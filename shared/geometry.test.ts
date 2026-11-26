import { describe, expect, it } from "vitest";
import {
  arrowHead,
  bendIndex,
  bentRoute,
  borderPoint,
  boundsOf,
  clipToBoxes,
  contains,
  intersects,
  labelSpots,
  lineRoute,
  nearestSide,
  nearestT,
  placeLabel,
  rectFromCorners,
  route,
  smoothThrough,
  routeBox,
  routeDistance,
  routePoint,
  traceRoute,
} from "./geometry";

const box = { x: 0, y: 0, w: 100, h: 50 };

describe("borderPoint", () => {
  it("leaves through the side facing the target", () => {
    expect(borderPoint(box, { x: 500, y: 25 })).toEqual({ x: 100, y: 25 });
    expect(borderPoint(box, { x: 50, y: -500 })).toEqual({ x: 50, y: 0 });
  });

  it("leaves through a corner on the diagonal", () => {
    const p = borderPoint(box, { x: 150, y: 75 });
    expect(p.x).toBeCloseTo(100);
    expect(p.y).toBeCloseTo(50);
  });

  it("stops at a target inside the box, and handles the center itself", () => {
    expect(borderPoint(box, { x: 60, y: 25 })).toEqual({ x: 60, y: 25 });
    expect(borderPoint(box, { x: 50, y: 25 })).toEqual({ x: 50, y: 25 });
  });
});

describe("rects", () => {
  it("bounds several rects, and none", () => {
    expect(boundsOf([box, { x: -10, y: 20, w: 5, h: 100 }])).toEqual({
      x: -10,
      y: 0,
      w: 110,
      h: 120,
    });
    expect(boundsOf([])).toBeNull();
  });

  it("tests overlap and containment, edges included", () => {
    expect(intersects(box, { x: 100, y: 50, w: 10, h: 10 })).toBe(true);
    expect(intersects(box, { x: 101, y: 0, w: 10, h: 10 })).toBe(false);
    expect(contains(box, { x: 100, y: 50 })).toBe(true);
    expect(contains(box, { x: 100.1, y: 10 })).toBe(false);
  });

  it("builds a marquee from corners in any order", () => {
    expect(rectFromCorners({ x: 10, y: 40 }, { x: 0, y: 5 })).toEqual({ x: 0, y: 5, w: 10, h: 35 });
  });
});

describe("arrowHead", () => {
  it("puts both corners behind the tip, mirrored across the line", () => {
    const [a, b] = arrowHead({ x: 100, y: 0 }, { x: 0, y: 0 }, 10);
    expect(a.x).toBeLessThan(100);
    expect(b.x).toBeCloseTo(a.x);
    expect(a.y).toBeCloseTo(-b.y);
  });
});

describe("route", () => {
  const a = { x: 0, y: 0, w: 100, h: 50 };

  it("leaves from the facing side: right for a box to the right, bottom for one below", () => {
    const r = route(a, { x: 300, y: 10, w: 100, h: 50 });
    expect(r.p0).toEqual({ x: 100, y: 25 });
    expect(r.p1).toEqual({ x: 300, y: 35 });
    const down = route(a, { x: 20, y: 300, w: 100, h: 50 });
    expect(down.p0).toEqual({ x: 50, y: 50 });
    expect(down.p1).toEqual({ x: 70, y: 300 });
  });

  it("goes through its ends, and is near a point on it but far from one off it", () => {
    const r = route(a, { x: 300, y: 200, w: 100, h: 50 });
    expect(routePoint(r, 0)).toEqual(r.p0);
    expect(routePoint(r, 1)).toEqual(r.p1);
    expect(routeDistance(r, routePoint(r, 0.37))).toBeLessThan(1);
    expect(routeDistance(r, { x: 0, y: 400 })).toBeGreaterThan(100);
  });
});

describe("ports", () => {
  it("spreads edges sharing a side, in the order of their other ends", async () => {
    const { ports } = await import("./geometry");
    const rects: Record<string, { x: number; y: number; w: number; h: number }> = {
      a: { x: 0, y: 100, w: 100, h: 60 },
      up: { x: 400, y: 0, w: 100, h: 60 },
      down: { x: 400, y: 260, w: 100, h: 60 },
    };
    const p = ports(
      [
        { id: "1", from: "a", to: "down" },
        { id: "2", from: "a", to: "up" },
      ],
      (id) => rects[id],
    );
    expect(p.get("2")!.a).toBeLessThan(0);
    expect(p.get("1")!.a).toBeGreaterThan(0);
    expect(p.get("1")!.b).toBe(0);
  });
});

describe("chooseSides", () => {
  // A box in the way: never out of the back of one end or into the far side of the other (that
  // hooked, trial 17); curveAround takes the line around the box instead.
  it("never leaves by a box's back or enters the far side, and keeps the facing sides when nothing is in the way", async () => {
    const { BoxGrid, chooseSides } = await import("./geometry");
    const rects: Record<string, { x: number; y: number; w: number; h: number }> = {
      a: { x: 0, y: 0, w: 100, h: 60 },
      b: { x: 400, y: 0, w: 100, h: 60 },
      wall: { x: 200, y: -20, w: 100, h: 100 },
      c: { x: 0, y: 400, w: 100, h: 60 },
    };
    const grid = new BoxGrid();
    for (const [id, r] of Object.entries(rects)) grid.add(id, r);
    const got = chooseSides(
      [
        { id: "blocked", from: "a", to: "b" },
        { id: "clear", from: "a", to: "c" },
      ],
      (id) => rects[id],
      grid,
    );
    expect(got.get("blocked")!.from).not.toBe("l");
    expect(got.get("blocked")!.to).not.toBe("r");
    expect(got.get("clear")).toEqual({ from: "b", to: "t" });
  });
});

describe("line routes (elbow and straight)", () => {
  const a = { x: 0, y: 0, w: 100, h: 50 };
  const b = { x: 300, y: 200, w: 100, h: 50 };

  it("cuts a centre-to-centre path at both boxes' borders", () => {
    const pts = clipToBoxes(
      [
        { x: 50, y: 25 },
        { x: 200, y: 25 },
        { x: 200, y: 225 },
        { x: 350, y: 225 },
      ],
      a,
      b,
    );
    expect(pts[0]).toEqual({ x: 100, y: 25 });
    expect(pts[pts.length - 1]).toEqual({ x: 300, y: 225 });
    expect(pts).toHaveLength(4);
  });

  it("drops bends that are still inside a box", () => {
    const pts = clipToBoxes(
      [
        { x: 50, y: 25 },
        { x: 80, y: 25 },
        { x: 80, y: 120 },
        { x: 350, y: 120 },
        { x: 350, y: 225 },
      ],
      a,
      b,
    );
    expect(pts[0]).toEqual({ x: 80, y: 50 });
  });

  it("finds points along it by length, and its distance and box", () => {
    const r = lineRoute([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
    ]);
    expect(routePoint(r, 0.5)).toEqual({ x: 100, y: 0 });
    expect(routePoint(r, 0.75)).toEqual({ x: 100, y: 50 });
    expect(routeDistance(r, { x: 50, y: 10 })).toBeCloseTo(10);
    expect(routeBox(r)).toEqual({ x: 0, y: 0, w: 100, h: 100 });
    expect(r.c2).toEqual({ x: 100, y: 0 });
  });

  it("rounds elbow corners, never past half a leg", () => {
    const calls: string[] = [];
    const sink = {
      moveTo: (x: number, y: number) => calls.push(`M${x},${y}`),
      lineTo: (x: number, y: number) => calls.push(`L${x},${y}`),
      bezierCurveTo: () => calls.push("C"),
      quadraticCurveTo: (cx: number, cy: number, x: number, y: number) =>
        calls.push(`Q${cx},${cy} ${x},${y}`),
    };
    traceRoute(
      sink,
      lineRoute(
        [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 100 },
        ],
        10,
      ),
    );
    expect(calls).toEqual(["M0,0", "L5,0", "Q10,0 10,5", "L10,100"]);
  });

  it("offers label spots on the longest stretch first", () => {
    const spots = labelSpots(
      lineRoute([
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 200 },
      ]),
    );
    expect(spots[0]).toEqual({ x: 20, y: 100 });
  });

  it("puts a wide label on a stretch it can lie along, before an upright one", () => {
    const r = lineRoute([
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { x: 200, y: 400 },
    ]);
    expect(labelSpots(r, 150)[0]).toEqual({ x: 100, y: 0 });
  });

  it("sets a label beside an upright line, not across it, and keeps it off other lines", () => {
    // Only an upright stretch: the label touches it from one side.
    const r = lineRoute([
      { x: 300, y: 0 },
      { x: 300, y: 400 },
    ]);
    const at = placeLabel(r, 160, 18, [], []);
    expect(Math.abs(at.x - 300)).toBe(90);
    // Another line runs across where the label would go on the right: it goes left instead.
    const other = lineRoute([
      { x: 310, y: 0 },
      { x: 310, y: 400 },
      { x: 600, y: 400 },
    ]);
    const crossing = lineRoute([
      { x: 320, y: 200 },
      { x: 600, y: 200 },
    ]);
    const at2 = placeLabel(r, 160, 18, [], [], [r, other, crossing]);
    expect(at2.x).toBeLessThan(300);
  });
});

describe("arrows shaped by hand", () => {
  const a = { x: 0, y: 0, w: 100, h: 50 };
  const b = { x: 400, y: 300, w: 100, h: 50 };

  it("nearestSide picks the side a point is beyond, or nearest inside", () => {
    expect(nearestSide(a, { x: 300, y: 25 })).toBe("r");
    expect(nearestSide(a, { x: 50, y: -40 })).toBe("t");
    expect(nearestSide(a, { x: 5, y: 25 })).toBe("l");
  });

  it("an elbow through a bend is all right angles and ends square on to pinned sides", () => {
    const r = bentRoute(a, b, [{ x: 250, y: 100 }], "elbow", { from: "r", to: "t" });
    const pts = r.pts!;
    for (let i = 1; i < pts.length; i++)
      expect(pts[i]!.x === pts[i - 1]!.x || pts[i]!.y === pts[i - 1]!.y).toBe(true);
    expect(pts[0]).toEqual({ x: 100, y: 25 });
    expect(pts[pts.length - 1]).toEqual({ x: 450, y: 300 });
    // Arrives at the top going down: the last leg is vertical.
    expect(pts[pts.length - 2]!.x).toBe(450);
    expect(pts).toContainEqual({ x: 250, y: 100 });
  });

  it("a straight bent arrow goes through its bends, cut at the box borders", () => {
    const r = bentRoute(a, b, [{ x: 450, y: 25 }], "straight");
    expect(r.pts).toEqual([
      { x: 100, y: 25 },
      { x: 450, y: 25 },
      { x: 450, y: 300 },
    ]);
  });

  it("nearestT measures along the line", () => {
    const r = lineRoute([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
    ]);
    expect(nearestT(r, { x: 50, y: 10 })).toBeCloseTo(0.25);
    expect(nearestT(r, { x: 130, y: 100 })).toBeCloseTo(1);
  });

  it("bendIndex puts a new bend on the nearest stretch", () => {
    const s = { x: 0, y: 0 };
    const e = { x: 300, y: 0 };
    expect(bendIndex(s, [{ x: 100, y: 100 }], e, { x: 40, y: 50 })).toBe(0);
    expect(bendIndex(s, [{ x: 100, y: 100 }], e, { x: 220, y: 50 })).toBe(1);
  });
});

describe("smoothThrough", () => {
  it("goes through every point and never doubles back at a sharp bend", () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 20, y: 10 },
      { x: 120, y: 20 },
    ];
    const out = smoothThrough(pts, 10);
    for (const p of pts)
      expect(out.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 1e-6)).toBe(true);
    // Stays near the points: no wide loop.
    for (const q of out) expect(q.x > -20 && q.x < 140 && q.y > -20 && q.y < 40).toBe(true);
  });
});
