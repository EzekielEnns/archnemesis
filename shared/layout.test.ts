import { describe, expect, it } from "vitest";
import { layout, roomForLines } from "./layout.ts";

const nodes = ["a", "b", "c"].map((id) => ({ id, w: 184, h: 72 }));
const edges = [
  { from: "a", to: "b" },
  { from: "b", to: "c" },
];

describe("layout", () => {
  it("puts callers before callees, left to right or top to bottom, from the origin", async () => {
    const right = await layout(nodes, edges, "right", { x: 400, y: 200 });
    expect(right.get("a")!.x).toBeLessThan(right.get("b")!.x);
    expect(right.get("b")!.x).toBeLessThan(right.get("c")!.x);
    expect(Math.min(...[...right.values()].map((p) => p.x))).toBe(400);
    const down = await layout(nodes, edges, "down");
    expect(down.get("a")!.y).toBeLessThan(down.get("b")!.y);
    for (const p of down.values()) expect((p.x % 8) + (p.y % 8)).toBe(0);
  });
});

describe("room for lines", () => {
  const box = { w: 200, h: 80 };
  const rowsOf = (n: number, per: number) => {
    const pos = new Map<string, { x: number; y: number }>();
    for (let r = 0; r < n; r++)
      for (let c = 0; c < per; c++) pos.set(`r${r}c${c}`, { x: c * 260, y: r * 176 });
    return pos;
  };
  it("widens a gap by the lines turning in it and the labels on them", () => {
    const pos = rowsOf(2, 6);
    const size = new Map([...pos.keys()].map((k) => [k, box]));
    const edges = Array.from({ length: 10 }, (_, i) => ({
      from: `r0c${i % 6}`,
      to: `r1c${(i + 1) % 6}`,
      label: "reads",
    }));
    roomForLines(pos, size, edges, "down");
    // 40 + 10 lines × 14 + two label rows.
    expect(pos.get("r1c0")!.y - (pos.get("r0c0")!.y + 80)).toBe(40 + 140 + 52);
    expect(pos.get("r0c3")!.y).toBe(0);
  });
  it("leaves a quiet gap alone, and a line straight through a row takes no height there", () => {
    const pos = rowsOf(3, 2);
    const size = new Map([...pos.keys()].map((k) => [k, box]));
    roomForLines(pos, size, [{ from: "r0c0", to: "r2c1" }], "down");
    expect(pos.get("r1c0")!.y).toBe(176);
    expect(pos.get("r2c0")!.y).toBe(352);
  });
});
