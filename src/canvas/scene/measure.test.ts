import { describe, expect, it } from "vitest";
import type { CanvasNode } from "../types";
import { baseAlpha, clip, handles, nearestOnBorder, pad, rowOffset, signature } from "./measure";

const node = (over: Partial<CanvasNode> = {}): CanvasNode => ({
  id: "a",
  kind: "app",
  name: "Shop API",
  subtitle: "",
  x: 0,
  y: 0,
  w: 200,
  h: 80,
  external: false,
  status: "live",
  childCount: 0,
  technology: "Node",
  hidden: 0,
  tags: [],
  ...over,
});

const table = (h: number, n: number): CanvasNode =>
  node({
    kind: "table",
    h,
    columns: Array.from({ length: n }, (_, i) => ({
      name: `c${i}`,
      type: "text",
      mark: "" as const,
      nullable: false,
    })),
  });

describe("clip", () => {
  it.each([
    ["short", 10, "short"],
    ["exactly10!", 10, "exactly10!"],
    ["a longer name than that", 10, "a longer …"],
    ["abc", 1, "…"],
  ])("clip(%j, %i) = %j", (text, max, want) => {
    expect(clip(text, max)).toBe(want);
  });
});

describe("baseAlpha", () => {
  it.each([
    [{}, 1],
    [{ status: "future" as const }, 0.8],
    [{ status: "deprecated" as const }, 0.55],
    [{ status: "removed" as const }, 0.6],
    [{ guess: true as const }, 0.6],
    [{ status: "future" as const, guess: true as const }, 0.8 * 0.6],
  ])("%j fades to %d", (over, want) => {
    expect(baseAlpha(node(over))).toBeCloseTo(want);
  });
});

describe("signature", () => {
  it("is the same for the same box, wherever it is", () => {
    expect(signature(node())).toBe(signature(node({ x: 500, y: 900 })));
  });

  it("lists what a rebuild depends on, in order", () => {
    expect(signature(node({ tags: ["a", "b"], color: "#ff0000", icon: "redis" }))).toBe(
      "app|Shop API||false|live|0|200|80|Node|redis|0|a,b|#ff0000|",
    );
  });

  it.each([
    ["name", { name: "Other" }],
    ["size", { w: 240 }],
    ["technology", { technology: "Go" }],
    ["status", { status: "future" as const }],
    ["hidden", { hidden: 2 }],
    ["tags", { tags: ["x"] }],
  ])("changes with %s", (_what, over) => {
    expect(signature(node(over))).not.toBe(signature(node()));
  });

  it("includes a table's columns", () => {
    expect(signature(table(170, 2))).toBe(
      "table|Shop API||false|live|0|200|170|Node||0|||c0:text::false,c1:text::false",
    );
  });
});

describe("rowOffset", () => {
  it("is where a column's row sits from the side's middle", () => {
    const t = table(170, 3);
    expect([0, 1, 2].map((i) => rowOffset(t, `c${i}`))).toEqual([-16, 6, 28]);
  });

  it.each([
    ["no column named", table(170, 3), undefined],
    ["an unknown column", table(170, 3), "nope"],
    ["a table too short for its columns", table(80, 3), "c0"],
    ["a box that isn't a table", node({ h: 170 }), "c0"],
  ])("is null for %s", (_what, n, col) => {
    expect(rowOffset(n, col)).toBeNull();
  });

  it("is null for rows folded into '+N more'", () => {
    // 170 tall fits 4 rows: the 4th is the "+N more" line when there are more columns.
    const t = table(170, 6);
    expect(rowOffset(t, "c2")).toBe(28);
    expect(rowOffset(t, "c3")).toBeNull();
  });
});

describe("nearestOnBorder", () => {
  const r = { x: 10, y: 20, w: 100, h: 50 };
  it.each([
    [
      { x: 0, y: 40 },
      { x: 10, y: 40 },
    ],
    [
      { x: 200, y: 40 },
      { x: 110, y: 40 },
    ],
    [
      { x: 50, y: 0 },
      { x: 50, y: 20 },
    ],
    [
      { x: 50, y: 100 },
      { x: 50, y: 70 },
    ],
    [
      { x: 12, y: 40 },
      { x: 10, y: 40 },
    ],
    [
      { x: 60, y: 45 },
      { x: 60, y: 20 },
    ],
  ])("%j -> %j", (p, want) => {
    expect(nearestOnBorder(r, p)).toEqual(want);
  });
});

describe("handles and pad", () => {
  it("handles are the middle of each side, top first, clockwise", () => {
    expect(handles({ x: 10, y: 20, w: 100, h: 50 })).toEqual([
      { x: 60, y: 20 },
      { x: 110, y: 45 },
      { x: 60, y: 70 },
      { x: 10, y: 45 },
    ]);
  });

  it("pad grows a rect on every side", () => {
    expect(pad({ x: 10, y: 20, w: 100, h: 50 }, 16)).toEqual({ x: -6, y: 4, w: 132, h: 82 });
  });
});
