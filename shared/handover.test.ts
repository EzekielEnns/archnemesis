import { describe, expect, it } from "vitest";
import { makeConnection, makeDiagram, makeObject } from "./model.ts";
import { buildIndex } from "./project.ts";
import { review, reviewText } from "./handover.ts";

const idx = (
  objects: ReturnType<typeof makeObject>[],
  connections: ReturnType<typeof makeConnection>[] = [],
  diagrams = [
    makeDiagram({
      name: "Landscape",
      key: "landscape",
      scopeId: null,
      rules: { include: [{ kind: "system" }], exclude: [] },
    }),
  ],
) => buildIndex({ objects, connections, diagrams, placements: [], flows: [], boundaries: [] });

describe("review", () => {
  it("says an empty design is not ready", () => {
    expect(review(idx([])).must[0]?.problem).toMatch(/nothing modelled/);
  });
  it("wants a way in and lines between things", () => {
    const sys = makeObject({ id: "s", kind: "system", name: "S", description: "x" });
    const a = makeObject({ id: "a", kind: "app", name: "A", parentId: "s", description: "x" });
    const db = makeObject({ id: "db", kind: "store", name: "DB", parentId: "s" });
    const r = review(idx([sys, a, db], [], []));
    expect(r.must.map((m) => m.problem).join("\n")).toMatch(
      /no top-level view[\s\S]*app connected to nothing[\s\S]*store connected to nothing/,
    );
    const ok = review(idx([sys, a, db], [makeConnection({ fromId: "a", toId: "db" })]));
    expect(ok.must).toEqual([]);
    expect(reviewText(ok, "d")).toContain("Ready to hand over");
  });
  it("folds many alike into one item", () => {
    const sys = makeObject({ id: "s", kind: "system", name: "S" });
    const apps = Array.from({ length: 6 }, (_, i) =>
      makeObject({ id: `a${i}`, kind: "app", name: `A${i}`, parentId: "s" }),
    );
    expect(
      review(idx([sys, ...apps])).must.filter((m) => /connected to nothing/.test(m.problem)),
    ).toHaveLength(1);
  });
});
