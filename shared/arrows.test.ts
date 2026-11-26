// Arrows shaped by hand: kept per diagram, saved in the layout file, gone with their boxes.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { seedOps } from "./seed.ts";
import { applyOps, emptyState, mirror, ModelError, type Actor } from "./doc.ts";
import { stateFromFiles } from "./diff.ts";
import { keyOps, readFiles, writeFiles } from "./files.ts";

const me: Actor = { id: "t", name: "T", kind: "agent" };

function seeded() {
  const doc = new Y.Doc();
  const state = emptyState();
  mirror(doc, state, () => {});
  applyOps(doc, state, seedOps(), me, "seed");
  applyOps(doc, state, keyOps(state), me, "keys");
  // An arrow that's drawn: a connection whose two ends are both on some diagram.
  const placedOn = (id: string) =>
    new Set(
      [...state.placements.values()].filter((p) => p.objectId === id).map((p) => p.diagramId),
    );
  const c = [...state.connections.values()].find((c) =>
    [...placedOn(c.fromId)].some((d) => placedOn(c.toId).has(d)),
  )!;
  const diagramId = [...placedOn(c.fromId)].find((d) => placedOn(c.toId).has(d))!;
  return { doc, state, c, diagramId };
}

describe("arrow shapes", () => {
  it("go through the layout file and back", () => {
    const { doc, state, c, diagramId } = seeded();
    applyOps(
      doc,
      state,
      [
        {
          op: "arrow.put",
          arrow: {
            diagramId,
            from: c.fromId,
            to: c.toId,
            fromSide: "bottom",
            bends: [{ x: 100.4, y: 40 }],
            label: 0.25,
          },
        },
      ],
      me,
      "shape",
    );
    const files = writeFiles(state);
    const layout = [...files.entries()].find(
      ([p, t]) => p.startsWith("layout/") && t.includes("@arrows"),
    )!;
    expect(layout[1]).toMatch(/"from": "bottom"/);
    const back = stateFromFiles(files);
    const shapes = [...back.arrows.values()];
    expect(shapes).toHaveLength(1);
    expect(shapes[0]).toMatchObject({
      fromSide: "bottom",
      bends: [{ x: 100, y: 40 }],
      label: 0.25,
    });
    expect(readFiles(files).problems.filter((p) => p.level === "error")).toEqual([]);
  });

  it("taking one out of the file takes it off the diagram", () => {
    const { doc, state, c, diagramId } = seeded();
    applyOps(
      doc,
      state,
      [{ op: "arrow.put", arrow: { diagramId, from: c.fromId, to: c.toId, toSide: "left" } }],
      me,
      "shape",
    );
    const files = writeFiles(state);
    const [path, text] = [...files.entries()].find(([, t]) => t.includes("@arrows"))!;
    const without = JSON.parse(text) as Record<string, unknown>;
    delete without["@arrows"];
    expect(stateFromFiles(new Map([...files, [path, JSON.stringify(without)]])).arrows.size).toBe(
      0,
    );
  });

  it("an empty shape is no shape", () => {
    const { doc, state, c, diagramId } = seeded();
    applyOps(
      doc,
      state,
      [{ op: "arrow.put", arrow: { diagramId, from: c.fromId, to: c.toId, label: 0.5 } }],
      me,
      "shape",
    );
    expect(state.arrows.size).toBe(1);
    applyOps(
      doc,
      state,
      [{ op: "arrow.put", arrow: { diagramId, from: c.fromId, to: c.toId } }],
      me,
      "reset",
    );
    expect(state.arrows.size).toBe(0);
  });

  it("goes when either box does", () => {
    const { doc, state, c, diagramId } = seeded();
    applyOps(
      doc,
      state,
      [{ op: "arrow.put", arrow: { diagramId, from: c.fromId, to: c.toId, fromSide: "top" } }],
      me,
      "shape",
    );
    applyOps(doc, state, [{ op: "object.delete", id: c.toId }], me, "delete");
    expect(state.arrows.size).toBe(0);
  });

  it("rejects nonsense", () => {
    const { doc, state, c, diagramId } = seeded();
    const put = (arrow: object) => () =>
      applyOps(
        doc,
        state,
        [{ op: "arrow.put", arrow: { diagramId, from: c.fromId, to: c.toId, ...arrow } }],
        me,
        "bad",
      );
    expect(put({ fromSide: "north" })).toThrow(ModelError);
    expect(put({ label: 2 })).toThrow(ModelError);
    expect(put({ bends: [{ x: "a", y: 1 }] })).toThrow(ModelError);
  });

  it("a bad shape in a file is an error that names it", () => {
    const { state } = seeded();
    const files = writeFiles(state);
    const [path] = [...files.entries()].find(([p]) => p.startsWith("layout/"))!;
    const bad = readFiles(
      new Map([...files, [path, JSON.stringify({ "@arrows": { "a>b": { from: "up" } } })]]),
    );
    expect(
      bad.problems.some((p) => p.level === "error" && p.file === path && p.message.includes("a>b")),
    ).toBe(true);
  });
});
