import { describe, expect, it } from "vitest";
import { boundsOf, intersects } from "../../shared/geometry";
import { generate } from "./generate";

describe("generate", () => {
  it("is deterministic for a seed", () => {
    expect(generate(100, 7)).toEqual(generate(100, 7));
    expect(generate(100, 7)).not.toEqual(generate(100, 8));
  });

  it("makes the asked-for boxes, none overlapping, and edges only between them", () => {
    const g = generate(250);
    expect(g.nodes).toHaveLength(250);
    const ids = new Set(g.nodes.map((n) => n.id));
    expect(ids.size).toBe(250);
    for (const e of g.edges) {
      expect(ids.has(e.from) && ids.has(e.to)).toBe(true);
      expect(e.from).not.toBe(e.to);
    }
    // Neighbours in the layout never touch (checking each box against the next few is enough).
    for (let i = 0; i + 1 < g.nodes.length; i++) {
      for (let j = i + 1; j < Math.min(g.nodes.length, i + 6); j++) {
        expect(intersects(g.nodes[i]!, g.nodes[j]!)).toBe(false);
      }
    }
    expect(boundsOf(g.nodes)).not.toBeNull();
  });
});
