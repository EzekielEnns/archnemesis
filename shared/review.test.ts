// Regressions from the November 2026 review: each case once left the model or its files
// in a state Archnemesis couldn't read back.
import { describe as suite, expect, it } from "vitest";
import * as Y from "yjs";
import { seedOps } from "./seed.ts";
import { planChanges } from "./agent.ts";
import { applyOps, emptyState, mirror, sweep, type Actor } from "./doc.ts";
import { describeChanges, stateFromFiles } from "./diff.ts";
import { check, keyOps, readFiles, writeFiles } from "./files.ts";
import { makeDiagram, makeFlow, makeObject, makeStep } from "./model.ts";
import { buildIndex } from "./project.ts";
import { viewOps } from "./views.ts";

const me: Actor = { id: "t", name: "T", kind: "agent" };

function seeded() {
  const doc = new Y.Doc();
  const state = emptyState();
  mirror(doc, state, () => {});
  applyOps(doc, state, seedOps(), me, "seed");
  applyOps(doc, state, keyOps(state), me, "keys");
  const idx = () =>
    buildIndex({
      objects: state.objects.values(),
      connections: state.connections.values(),
      diagrams: state.diagrams.values(),
      placements: state.placements.values(),
      flows: state.flows.values(),
    });
  return { doc, state, idx };
}

/** Writing then reading the files has no errors. */
const readsBack = (state: ReturnType<typeof seeded>["state"]) => {
  const { model, problems } = readFiles(writeFiles(state));
  return [...problems, ...check(model)].filter((p) => p.level === "error");
};

suite("review regressions", () => {
  it("deleting an object drops the flow steps through it, and the files still read", () => {
    const { doc, state } = seeded();
    const [a, b] = [...state.objects.values()];
    const d = [...state.diagrams.values()][0]!;
    applyOps(
      doc,
      state,
      [
        {
          op: "flow.put",
          flow: makeFlow({
            diagramId: d.id,
            name: "F",
            steps: [makeStep({ fromId: a!.id, toId: b!.id })],
          }),
        },
      ],
      me,
      "flow",
    );
    applyOps(doc, state, [{ op: "object.delete", id: b!.id }], me, "del");
    expect([...state.flows.values()].find((f) => f.name === "F")!.steps).toHaveLength(0);
    expect(readsBack(state)).toEqual([]);
  });

  it("refuses flow steps to things that don't exist", () => {
    const { doc, state } = seeded();
    const d = [...state.diagrams.values()][0]!;
    expect(() =>
      applyOps(
        doc,
        state,
        [
          {
            op: "flow.put",
            flow: makeFlow({
              diagramId: d.id,
              name: "G",
              steps: [makeStep({ fromId: "nope", toId: "nada" })],
            }),
          },
        ],
        me,
        "x",
      ),
    ).toThrow();
  });

  it("refuses ids and keys that would be paths, and duplicate keys", () => {
    const { doc, state, idx } = seeded();
    expect(() =>
      planChanges(state, idx(), [{ add: { id: "../../evil", name: "Evil", kind: "system" } }]),
    ).toThrow();
    expect(() =>
      applyOps(
        doc,
        state,
        [{ op: "object.put", object: makeObject({ kind: "system", name: "E", key: "../x" }) }],
        me,
        "x",
      ),
    ).toThrow();
    expect(() =>
      applyOps(
        doc,
        state,
        [{ op: "diagram.put", diagram: makeDiagram({ name: "V", key: "a/b" }) }],
        me,
        "x",
      ),
    ).toThrow();
    const taken = [...state.objects.values()][0]!.key!;
    expect(() =>
      applyOps(
        doc,
        state,
        [{ op: "object.put", object: makeObject({ kind: "system", name: "Dup", key: taken }) }],
        me,
        "x",
      ),
    ).toThrow(/already/);
  });

  it("renaming a hand-picked view keeps its boxes; naming an existing view changes it", () => {
    const { doc, state, idx } = seeded();
    const hand = makeDiagram({ name: "Hand", key: "hand" });
    const o = [...state.objects.values()][0]!;
    applyOps(
      doc,
      state,
      [
        { op: "diagram.put", diagram: hand },
        {
          op: "placement.put",
          placement: { diagramId: hand.id, objectId: o.id, x: 0, y: 0, w: 200, h: 100 },
        },
      ],
      me,
      "hand",
    );
    const { ops } = planChanges(state, idx(), [{ view: { id: "hand", name: "Hand renamed" } }]);
    applyOps(doc, state, ops, me, "rename");
    expect(state.diagrams.get(hand.id)!.rules).toBeNull();
    expect(viewOps(idx(), hand.id)).toEqual([]);
    const n = state.diagrams.size;
    const again = planChanges(state, idx(), [{ view: { name: "Hand renamed" } }]);
    applyOps(doc, state, again.ops, me, "same name");
    expect(state.diagrams.size).toBe(n);
  });

  it("a cycle from two merged moves is broken, not deleted", () => {
    const { doc, state } = seeded();
    const a = makeObject({ kind: "system", name: "A" });
    const b = makeObject({ kind: "system", name: "B" });
    const c = makeObject({ kind: "app", name: "C", parentId: a.id });
    applyOps(
      doc,
      state,
      [
        { op: "object.put", object: a },
        { op: "object.put", object: b },
        { op: "object.put", object: c },
      ],
      me,
      "abc",
    );
    // What a merge of "A into B" and "B into A" leaves behind.
    doc.transact(() => {
      const objs = doc.getMap("objects");
      (objs.get(a.id) as Y.Map<unknown>).set("parentId", b.id);
      (objs.get(b.id) as Y.Map<unknown>).set("parentId", a.id);
    });
    const before = state.objects.size;
    sweep(doc, state, me);
    expect(state.objects.size).toBe(before);
    expect([a.id, b.id].some((id) => state.objects.get(id)!.parentId === null)).toBe(true);
    expect(() =>
      applyOps(doc, state, [{ op: "object.delete", id: a.id }], me, "del"),
    ).not.toThrow();
  });

  it("an empty or non-mapping model file is an error, not a delete", () => {
    const { state } = seeded();
    const files = writeFiles(state);
    const first = [...files.keys()].find((p) => p.startsWith("model/"))!;
    for (const bad of ["", "5\n", "# just a comment\n"]) {
      const { problems } = readFiles(new Map([...files, [first, bad]]));
      expect(problems.some((p) => p.level === "error" && p.file === first)).toBe(true);
    }
  });

  it("a zero-size box in a layout is an error", () => {
    const { state } = seeded();
    const files = writeFiles(state);
    const layout = [...files.keys()].find((p) => p.startsWith("layout/"))!;
    const boxes = JSON.parse(files.get(layout)!) as Record<string, number[]>;
    const k = Object.keys(boxes)[0]!;
    boxes[k] = [0, 0, 0, 0];
    const { problems } = readFiles(new Map([...files, [layout, JSON.stringify(boxes)]]));
    expect(problems.some((p) => p.level === "error")).toBe(true);
  });

  it("forbidden text is caught in flows and view names too", () => {
    const { doc, state } = seeded();
    const d = [...state.diagrams.values()][0]!;
    const [a, b] = [...state.objects.values()];
    applyOps(
      doc,
      state,
      [
        {
          op: "flow.put",
          flow: makeFlow({
            diagramId: d.id,
            name: "leak",
            steps: [makeStep({ fromId: a!.id, toId: b!.id, text: "password at 10.1.2.3" })],
          }),
        },
      ],
      me,
      "f",
    );
    const { model } = readFiles(writeFiles(state));
    expect(check(model).some((p) => p.level === "error")).toBe(true);
  });

  it("many new boxes on a rules view never stack", () => {
    const { doc, state, idx } = seeded();
    const sys = makeObject({ kind: "system", name: "Big" });
    const kids = Array.from({ length: 400 }, (_, i) =>
      makeObject({ kind: "app", name: `App ${i}`, parentId: sys.id }),
    );
    const view = makeDiagram({
      name: "Big",
      key: "big",
      rules: { include: [{ children: sys.id }], exclude: [] },
    });
    applyOps(
      doc,
      state,
      [
        { op: "object.put", object: sys },
        ...kids.map((o) => ({ op: "object.put" as const, object: o })),
        { op: "diagram.put", diagram: view },
      ],
      me,
      "big",
    );
    const ops = viewOps(idx(), view.id);
    const spots = new Set(
      ops
        .filter((o) => o.op === "placement.put")
        .map((o) => (o.op === "placement.put" ? `${o.placement.x},${o.placement.y}` : "")),
    );
    expect(spots.size).toBe(400);
  });

  it("a diagram's arrow style goes through its file and back; taking it out means curved", () => {
    const { doc, state } = seeded();
    const d = [...state.diagrams.values()][0]!;
    applyOps(doc, state, [{ op: "diagram.put", diagram: { ...d, arrows: "elbow" } }], me, "elbow");
    const files = writeFiles(state);
    const view = [...files.entries()].find(
      ([p, t]) => p.startsWith("views/") && t.includes(`name: ${d.name}`),
    )!;
    expect(view[1]).toContain("arrows: elbow");
    expect(readFiles(files).model.views.find((v) => v.name === d.name)!.arrows).toBe("elbow");
    const bad = readFiles(
      new Map([...files, [view[0], view[1].replace("arrows: elbow", "arrows: wavy")]]),
    );
    expect(bad.problems.some((p) => p.level === "error" && p.file === view[0])).toBe(true);
  });

  it("keep tidy goes through the view file and back; taking it out turns it off", () => {
    const { doc, state } = seeded();
    const d = [...state.diagrams.values()][0]!;
    applyOps(
      doc,
      state,
      [{ op: "diagram.put", diagram: { ...d, tidy: "down", keepTidy: true } }],
      me,
      "tidy",
    );
    const files = writeFiles(state);
    const view = [...files.entries()].find(
      ([p, t]) => p.startsWith("views/") && t.includes(`name: ${d.name}`),
    )!;
    expect(view[1]).toContain("tidy: down");
    expect(view[1]).toContain("keep_tidy: true");
    const byName = (st: ReturnType<typeof stateFromFiles>) =>
      [...st.diagrams.values()].find((x) => x.name === d.name);
    expect(byName(stateFromFiles(files))?.tidy).toBe("down");
    expect(byName(stateFromFiles(files))?.keepTidy).toBe(true);
    // tidy on its own is only a direction: nothing keeps it tidy.
    expect(
      byName(
        stateFromFiles(new Map([...files, [view[0], view[1].replace("keep_tidy: true\n", "")]])),
      )?.keepTidy,
    ).toBe(false);
    const off = stateFromFiles(new Map([...files, [view[0], view[1].replace("tidy: down\n", "")]]));
    expect(byName(off)?.tidy ?? null).toBe(null);
    const bad = readFiles(
      new Map([...files, [view[0], view[1].replace("tidy: down", "tidy: sideways")]]),
    );
    expect(bad.problems.some((p) => p.level === "error" && p.file === view[0])).toBe(true);
  });

  it("a second connection between the same boxes reads as one added", () => {
    const { doc, state } = seeded();
    const before = stateFromFiles(writeFiles(state));
    const c = [...state.connections.values()][0]!;
    applyOps(
      doc,
      state,
      [{ op: "connection.put", connection: { ...c, id: "c_second", name: "second" } }],
      me,
      "c2",
    );
    const lines = describeChanges(before, stateFromFiles(writeFiles(state)));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Connected .*\(second\)$/);
  });
});
