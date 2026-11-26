// Deleting a box lets go of it everywhere that names it, instead of failing (s-chan round 8).
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { seedOps } from "./seed.ts";
import { applyOps, emptyState, mirror, type Actor } from "./doc.ts";
import { keyOps } from "./files.ts";
import { makeDiagram } from "./model.ts";

const me: Actor = { id: "t", name: "T", kind: "agent" };

describe("deleting a box a rule names", () => {
  it("takes it out of ids lists and drops selectors about it", () => {
    const doc = new Y.Doc();
    const state = emptyState();
    mirror(doc, state, () => {});
    applyOps(doc, state, seedOps(), me, "seed");
    applyOps(doc, state, keyOps(state), me, "keys");
    const [a, b] = [...state.objects.values()].filter((o) => o.kind === "app");
    const d = makeDiagram({
      name: "Picked",
      rules: {
        include: [{ ids: [a!.id, b!.id] }, { children: b!.id }],
        exclude: [{ ids: [b!.id] }],
      },
    });
    applyOps(doc, state, [{ op: "diagram.put", diagram: d }], me, "view");
    applyOps(doc, state, [{ op: "object.delete", id: b!.id }], me, "delete");
    expect(state.diagrams.get(d.id)?.rules).toEqual({ include: [{ ids: [a!.id] }], exclude: [] });
  });
});
