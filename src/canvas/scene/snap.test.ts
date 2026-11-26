import { describe, expect, it } from "vitest";
import { gridSnap, neighbourSnap, resizedSize } from "./snap";

describe("gridSnap: the move that puts the grabbed box's corner on the 8px grid", () => {
  it.each([
    [{ x: 13, y: 21 }, 5, 5, { dx: 3, dy: 3 }],
    [{ x: 0, y: 0 }, 3, 3, { dx: 0, dy: 0 }],
    [{ x: 0, y: 0 }, 4, 4, { dx: 8, dy: 8 }],
    [{ x: 0, y: 0 }, -5, 12, { dx: -8, dy: 16 }],
  ])("from %j moving by (%i, %i)", (lead, dx, dy, want) => {
    expect(gridSnap(lead, dx, dy)).toEqual(want);
  });
});

describe("resizedSize: a box's size while its corner is dragged", () => {
  it.each([
    [
      { w: 200, h: 80 },
      { x: 20, y: -30 },
      { w: 224, h: 56 },
    ],
    [
      { w: 200, h: 80 },
      { x: -200, y: 100 },
      { w: 120, h: 184 },
    ],
  ])("%j by %j gives %j (on the grid, not under 120 x 56)", (origin, world, want) => {
    expect(resizedSize(origin, { x: 0, y: 0 }, world)).toEqual(want);
  });
});

describe("neighbourSnap: lining up with the boxes around", () => {
  const box = (id: string, x: number, y: number) => ({ node: { id, x, y, w: 100, h: 50 } });
  const order = [box("a", 104, 200), box("b", 100, 0)];
  const moving = { x: 104, y: 200, w: 100, h: 50 };

  it("snaps a left edge 4px off another's, and says which lines to draw", () => {
    expect(neighbourSnap(moving, new Set(["a"]), order, 1)).toEqual({
      dx: -4,
      dy: 0,
      guides: [
        { axis: "x", at: 100, from: 0, to: 250 },
        { axis: "x", at: 150, from: 0, to: 250 },
        { axis: "x", at: 200, from: 0, to: 250 },
      ],
    });
  });

  it("reaches less far on screen as the zoom grows (6 screen px)", () => {
    expect(neighbourSnap(moving, new Set(["a"]), order, 2)).toEqual({ dx: 0, dy: 0, guides: [] });
  });

  it("doesn't snap to a box that is itself dragged", () => {
    expect(neighbourSnap(moving, new Set(["a", "b"]), order, 1)).toEqual({
      dx: 0,
      dy: 0,
      guides: [],
    });
  });

  it("ignores boxes out of reach", () => {
    const far = [box("a", 104, 200), box("far", 100, 5000)];
    expect(neighbourSnap(moving, new Set(["a"]), far, 1)).toEqual({ dx: 0, dy: 0, guides: [] });
  });

  it("doesn't snap when 16px off", () => {
    const off = { x: 120, y: 200, w: 100, h: 50 };
    expect(neighbourSnap(off, new Set(["a"]), [box("a", 120, 200), box("b", 100, 0)], 1)).toEqual({
      dx: 0,
      dy: 0,
      guides: [],
    });
  });
});
