import { describe, expect, it } from "vitest";
import { fanSides, forkRoute, lineRoute, sharedRun } from "./geometry.ts";

const box = (x: number, y: number) => ({ x, y, w: 100, h: 40 });

describe("fan-out arrows", () => {
  const rects = new Map([
    ["bus", box(0, 0)],
    ["a", box(-200, 300)],
    ["b", box(0, 300)],
    ["c", box(200, 300)],
  ]);
  const rect = (id: string) => rects.get(id);
  const fan = (to: string, more = {}) => ({
    id: `bus>${to}`,
    from: "bus",
    to,
    fan: "bus|publishes",
    ...more,
  });

  it("all leave the side facing the middle of where they go", () => {
    const got = fanSides([fan("a"), fan("b"), fan("c")], rect);
    expect([...got.values()].map((f) => f.side)).toEqual(["b", "b", "b"]);
  });

  it("one pinned by hand keeps its start and the rest start there with it", () => {
    const got = fanSides(
      [fan("a"), fan("b", { shape: { fromSide: "left", fromAt: 0.3 } }), fan("c")],
      rect,
    );
    expect([...got.keys()]).toEqual(["bus>a", "bus>c"]);
    expect(got.get("bus>a")).toEqual({ side: "l", at: 0.3 });
    expect(fanSides([fan("a"), { id: "x", from: "bus", to: "b" }], rect).size).toBe(0);
    // Bent by hand, it's still part of the fan.
    expect(fanSides([fan("a", { shape: { bends: [{ x: 1, y: 1 }] } }), fan("c")], rect).size).toBe(
      2,
    );
  });

  it("measures how far two lines run as one", () => {
    const down = [
      { x: 0, y: 0 },
      { x: 0, y: 100 },
    ];
    expect(sharedRun([...down, { x: -200, y: 100 }], [...down, { x: 200, y: 100 }])).toBe(100);
    expect(
      sharedRun(
        [...down, { x: 50, y: 100 }],
        [
          { x: 0, y: 0 },
          { x: 0, y: 60 },
          { x: 90, y: 60 },
        ],
      ),
    ).toBe(60);
    expect(
      sharedRun(down, [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ]),
    ).toBe(0);
  });

  it("a fork leaves from a spot on its arrow and turns once into its box", () => {
    const parent = lineRoute([
      { x: 0, y: 0 },
      { x: 0, y: 200 },
    ]);
    const r = forkRoute(parent, 0.5, { x: 200, y: 180, w: 100, h: 40 });
    expect(r.pts![0]).toEqual({ x: 0, y: 100 });
    expect(r.pts![r.pts!.length - 1]).toEqual({ x: 200, y: 200 });
  });
});
