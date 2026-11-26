// Connecting a new design to a repo: the repo's files replace its blank starter view.
import { expect, it } from "vitest";
import * as Y from "yjs";
import { applyOps, emptyState, fill, mirror, readState, type Actor } from "./doc.ts";
import { readFiles, toOps, writeFiles } from "./files.ts";
import { makeDiagram, makeObject } from "./model.ts";

const me: Actor = { id: "t", name: "T", kind: "agent" };

it("files with a landscape view load over two blank, unkeyed landscapes", () => {
  // What the repo holds: one box on a view keyed landscape.
  const src = emptyState();
  const d0 = new Y.Doc();
  mirror(d0, src, () => {});
  const box = makeObject({ id: "api", key: "api", kind: "system", name: "API" });
  applyOps(
    d0,
    src,
    [
      { op: "object.put", object: box },
      {
        op: "diagram.put",
        diagram: makeDiagram({
          name: "Landscape",
          key: "landscape",
          rules: { include: [{ ids: ["api"] }], exclude: [] },
        }),
      },
    ],
    me,
    "src",
  );
  const { model } = readFiles(writeFiles(src));

  // The new design: two blank "landscape" views made at once on two copies and merged by
  // sync (which doesn't run the checks), as happened on a real connect.
  const a = new Y.Doc();
  const b = new Y.Doc();
  for (const x of [a, b]) {
    const st = emptyState();
    mirror(x, st, () => {});
    applyOps(
      x,
      st,
      [{ op: "diagram.put", diagram: makeDiagram({ name: "Landscape", key: "landscape" }) }],
      me,
      "blank",
    );
  }
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(a));
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(b));
  const state = emptyState();
  mirror(doc, state, () => {});
  fill(state, readState(doc));
  expect(state.diagrams.size).toBe(2);
  expect(() => applyOps(doc, state, toOps(state, model), me, "files")).not.toThrow();
  expect([...state.diagrams.values()].map((d) => d.key)).toEqual(["landscape"]);
  expect(state.objects.has("api")).toBe(true);
});
