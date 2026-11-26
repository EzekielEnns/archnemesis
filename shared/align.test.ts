import { describe, expect, it } from "vitest";
import { shiftBends, snapToNeighbours, straighten, type Box } from "./align.ts";

const box = (id: string, x: number, y: number, w = 184, h = 72): Box => ({ id, x, y, w, h });

describe("snapToNeighbours", () => {
  it("lines up centres and says where", () => {
    const s = snapToNeighbours(box("m", 300, 105), [box("a", 0, 100)], 8);
    expect(s.dy).toBe(-5);
    expect(s.guides.some((g) => g.axis === "y" && g.at === 136)).toBe(true);
  });

  it("does nothing beyond the threshold", () => {
    const s = snapToNeighbours(box("m", 300, 130), [box("a", 0, 100)], 8);
    expect(s.dy).toBe(0);
  });

  it("matches the gap between the two neighbours before it", () => {
    // a at 0, b at 284 (gap 100); m dragged to 566 snaps to 568 (gap 100 again).
    const s = snapToNeighbours(box("m", 566, 0), [box("a", 0, 0), box("b", 284, 0)], 8);
    expect(s.dx).toBe(2);
  });
});

describe("straighten", () => {
  it("puts connected boxes that are nearly in a row on one row", () => {
    const moved = straighten(
      [box("a", 0, 0), box("b", 300, 20), box("c", 600, 8)],
      [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
      ],
    );
    const ys = ["a", "b", "c"].map((id) => moved.get(id)?.y ?? { a: 0, b: 20, c: 8 }[id]);
    expect(new Set(ys).size).toBe(1);
    // b is the hub (two arrows): it stays, the others come to it.
    expect(ys[0]).toBe(20);
    expect(moved.has("b")).toBe(false);
  });

  it("leaves boxes that aren't connected, or are far off a line", () => {
    expect(straighten([box("a", 0, 0), box("b", 300, 20)], []).size).toBe(0);
    expect(straighten([box("a", 0, 0), box("b", 300, 300)], [{ from: "a", to: "b" }]).size).toBe(0);
  });

  it("lines up a column too", () => {
    const moved = straighten([box("a", 0, 0), box("b", 30, 200)], [{ from: "a", to: "b" }]);
    expect(moved.get("a")?.x ?? 0).toBe(moved.get("b")?.x ?? 30);
  });

  it("won't put a box on top of another", () => {
    // c sits where b would land.
    const moved = straighten(
      [box("a", 0, 0), box("b", 300, 40), box("c", 300, -60)],
      [{ from: "a", to: "b" }],
    );
    expect(moved.size).toBe(0);
  });

  it("only moves the boxes asked for", () => {
    const moved = straighten([box("a", 0, 0), box("b", 300, 20)], [{ from: "a", to: "b" }], {
      only: new Set(["a"]),
    });
    expect(moved.size).toBe(0);
  });
});

describe("shiftBends", () => {
  it("moves a shaped arrow's bends by how far its ends moved, on average", () => {
    const shape = { diagramId: "d", from: "a", to: "b", bends: [{ x: 10, y: 10 }] };
    const before = new Map([
      ["a", { x: 0, y: 0 }],
      ["b", { x: 100, y: 0 }],
    ]);
    const after = new Map([
      ["a", { x: 40, y: 0 }],
      ["b", { x: 100, y: 20 }],
    ]);
    expect(shiftBends([shape], before, after)).toEqual([{ ...shape, bends: [{ x: 30, y: 20 }] }]);
    expect(shiftBends([shape], before, before)).toEqual([]);
    expect(
      shiftBends([{ diagramId: "d", from: "a", to: "b", fromSide: "top" }], before, after),
    ).toEqual([]);
  });
});
