import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { seedOps } from "./seed.ts";
import { applyOps, emptyState, mirror, type Actor } from "./doc.ts";
import { keyOps } from "./files.ts";
import { buildIndex } from "./project.ts";
import { viewSlice } from "./slice.ts";

const me: Actor = { id: "t", name: "T", kind: "agent" };

describe("exporting a view", () => {
  it("takes what it shows, what that's in and holds, and the lines between", () => {
    const doc = new Y.Doc();
    const state = emptyState();
    mirror(doc, state, () => {});
    applyOps(doc, state, seedOps(), me, "seed");
    applyOps(doc, state, keyOps(state), me, "keys");
    const idx = buildIndex({
      objects: state.objects.values(),
      connections: state.connections.values(),
      diagrams: state.diagrams.values(),
      placements: state.placements.values(),
      flows: state.flows.values(),
      boundaries: state.boundaries.values(),
    });
    const api = [...idx.diagrams.values()].find(
      (d) => d.scopeId && idx.objects.get(d.scopeId)?.key === "shop-api",
    )!;
    const deep = viewSlice(state, idx, api.id);
    const shallow = viewSlice(state, idx, api.id, { deep: false });
    expect(deep.diagrams.size).toBe(1);
    expect(shallow.objects.size).toBeLessThanOrEqual(deep.objects.size);
    for (const c of deep.connections.values())
      expect(deep.objects.has(c.fromId) && deep.objects.has(c.toId)).toBe(true);
    for (const o of deep.objects.values())
      if (o.parentId) expect(deep.objects.has(o.parentId)).toBe(true);
  });
});
