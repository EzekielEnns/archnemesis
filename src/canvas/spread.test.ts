// Room for a layer's rows: drawn positions move down past each cut, and map back exactly.
import { describe, expect, it } from "vitest";
import { makeSpread } from "./spread";

describe("spread", () => {
  const s = makeSpread([
    { y: 100, by: 28 },
    { y: 102, by: 20 }, // merges with the one above (28 wins)
    { y: 300, by: 28 },
  ]);
  it("moves what's below each cut down, leaves what's above", () => {
    expect(s.down(50)).toBe(50);
    expect(s.down(100)).toBe(100);
    expect(s.down(120)).toBe(148);
    expect(s.down(400)).toBe(456);
  });
  it("maps back: drawn → saved, a point in a gap goes to its cut", () => {
    for (const y of [0, 50, 120, 299, 301, 400]) expect(s.up(s.down(y))).toBe(y);
    expect(s.up(110)).toBe(100);
  });
  it("no cuts: nothing moves", () => {
    const n = makeSpread([]);
    expect(n.none).toBe(true);
    expect(n.down(42)).toBe(42);
  });
});
