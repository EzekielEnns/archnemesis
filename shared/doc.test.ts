import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  applyOps,
  danglingOps,
  emptyState,
  logOf,
  mirror,
  ModelError,
  pkey,
  sweep,
  undoManager,
  type Actor,
  type ModelState,
} from "./doc.ts";
import { makeConnection, makeDiagram, makeFlow, makeObject, makeStep, type Op } from "./model.ts";

const zeek: Actor = { id: "zeek", name: "Zeek", kind: "human" };
const jack: Actor = { id: "jack", name: "Jack", kind: "human" };

/** A document with its plain mirror, like each tab and the server keep. */
function replica(doc = new Y.Doc()) {
  const state = emptyState();
  mirror(doc, state, () => {});
  // Load whatever the doc already holds.
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(doc));
  return { doc, state };
}

function setup() {
  const r = replica();
  const shop = makeObject({ kind: "system", name: "Shop" });
  const api = makeObject({ kind: "app", name: "API", parentId: shop.id });
  const pay = makeObject({ kind: "system", name: "Payments", external: true });
  const conn = makeConnection({ fromId: api.id, toId: pay.id, name: "charges" });
  const landscape = makeDiagram({ name: "Landscape" });
  const inside = makeDiagram({ name: "Shop", scopeId: shop.id });
  const ops: Op[] = [
    { op: "object.put", object: shop },
    { op: "object.put", object: api },
    { op: "object.put", object: pay },
    { op: "connection.put", connection: conn },
    { op: "diagram.put", diagram: landscape },
    { op: "diagram.put", diagram: inside },
    {
      op: "placement.put",
      placement: { diagramId: landscape.id, objectId: shop.id, x: 0, y: 0, w: 184, h: 72 },
    },
    {
      op: "placement.put",
      placement: { diagramId: landscape.id, objectId: pay.id, x: 300, y: 0, w: 184, h: 72 },
    },
    {
      op: "placement.put",
      placement: { diagramId: inside.id, objectId: api.id, x: 0, y: 0, w: 184, h: 72 },
    },
  ];
  applyOps(r.doc, r.state, ops, zeek, "seed");
  return { ...r, shop, api, pay, conn, landscape, inside };
}

const counts = (s: ModelState) => [
  s.objects.size,
  s.connections.size,
  s.diagrams.size,
  s.placements.size,
];

/** Two replicas wired together, the way the sync server relays updates. */
function pair() {
  const a = replica();
  const b = replica();
  a.doc.on(
    "update",
    (u: Uint8Array, origin: unknown) => origin !== "remote" && Y.applyUpdate(b.doc, u, "remote"),
  );
  b.doc.on(
    "update",
    (u: Uint8Array, origin: unknown) => origin !== "remote" && Y.applyUpdate(a.doc, u, "remote"),
  );
  return { a, b };
}

describe("applyOps", () => {
  it("cascades a delete through placements, connections, children and scoped diagrams", () => {
    const { state, doc, shop } = setup();
    expect(counts(state)).toEqual([3, 1, 2, 3]);
    const ids = applyOps(doc, state, [{ op: "object.delete", id: shop.id }], zeek, "delete shop");
    expect(counts(state)).toEqual([1, 0, 1, 1]);
    expect(ids).toContain(shop.id);
  });

  it("rejects a bad batch whole", () => {
    const { doc, state, api, shop } = setup();
    const before = JSON.stringify([...state.objects.values()]);
    expect(() =>
      applyOps(
        doc,
        state,
        [
          { op: "object.put", object: { ...api, name: "renamed" } },
          { op: "object.put", object: { ...shop, parentId: api.id } }, // a cycle
        ],
        zeek,
        "bad",
      ),
    ).toThrow(ModelError);
    expect(JSON.stringify([...state.objects.values()])).toBe(before);
    expect(() =>
      applyOps(
        doc,
        state,
        [{ op: "connection.put", connection: makeConnection({ fromId: api.id, toId: "nope" }) }],
        zeek,
        "x",
      ),
    ).toThrow(ModelError);
  });

  it("logs who made each batch", () => {
    const { doc, state, pay } = setup();
    applyOps(
      doc,
      state,
      [{ op: "object.put", object: { ...pay, name: "Stripe" } }],
      jack,
      "renamed Payments",
    );
    const last = logOf(doc).toArray().at(-1)!;
    expect(last.actor.name).toBe("Jack");
    expect(last.label).toBe("renamed Payments");
    expect(last.ids).toEqual([pay.id]);
  });

  it("stores tags and flows, and flows go with their diagram", () => {
    const { doc, state } = replica();
    const a = makeObject({ kind: "app", name: "A", tags: ["pci"] });
    const b = makeObject({ kind: "app", name: "B" });
    const d = makeDiagram({ name: "D" });
    applyOps(
      doc,
      state,
      [
        { op: "object.put", object: a },
        { op: "object.put", object: b },
        { op: "diagram.put", diagram: d },
      ],
      zeek,
      "setup",
    );
    expect(state.objects.get(a.id)?.tags).toEqual(["pci"]);
    const f = makeFlow({
      diagramId: d.id,
      name: "F",
      steps: [makeStep({ fromId: a.id, toId: b.id, text: "calls" })],
    });
    applyOps(doc, state, [{ op: "flow.put", flow: f }], zeek, "flow");
    expect(state.flows.get(f.id)?.steps[0]?.text).toBe("calls");
    applyOps(doc, state, [{ op: "diagram.delete", id: d.id }], zeek, "drop");
    expect(state.flows.size).toBe(0);
  });
});

describe("undo", () => {
  it("undoes and redoes a cascade exactly", () => {
    const { doc, state, shop } = setup();
    const um = undoManager(doc, zeek);
    const before = JSON.stringify(counts(state));
    applyOps(doc, state, [{ op: "object.delete", id: shop.id }], zeek, "delete shop");
    um.undo();
    expect(JSON.stringify(counts(state))).toBe(before);
    expect(state.objects.get(shop.id)?.name).toBe("Shop");
    um.redo();
    expect(counts(state)).toEqual([1, 0, 1, 1]);
  });

  it("moves a placement and undoes the move", () => {
    const { doc, state, landscape, shop } = setup();
    const um = undoManager(doc, zeek);
    applyOps(
      doc,
      state,
      [
        {
          op: "placement.put",
          placement: { diagramId: landscape.id, objectId: shop.id, x: 50, y: 60, w: 184, h: 72 },
        },
      ],
      zeek,
      "move",
    );
    expect(state.placements.get(pkey(landscape.id, shop.id))?.x).toBe(50);
    um.undo();
    expect(state.placements.get(pkey(landscape.id, shop.id))?.x).toBe(0);
  });

  it("only undoes your own edits", () => {
    const { a, b } = pair();
    const o = makeObject({ kind: "system", name: "Shop" });
    applyOps(a.doc, a.state, [{ op: "object.put", object: o }], zeek, "add");
    const zeekUndo = undoManager(a.doc, zeek);
    applyOps(
      a.doc,
      a.state,
      [{ op: "object.put", object: { ...a.state.objects.get(o.id)!, name: "Store" } }],
      zeek,
      "rename",
    );
    applyOps(
      b.doc,
      b.state,
      [{ op: "object.put", object: { ...b.state.objects.get(o.id)!, description: "sells" } }],
      jack,
      "describe",
    );
    zeekUndo.undo();
    // Zeek's rename is gone, Jack's description stays, on both sides.
    for (const r of [a, b]) {
      expect(r.state.objects.get(o.id)?.name).toBe("Shop");
      expect(r.state.objects.get(o.id)?.description).toBe("sells");
    }
  });
});

describe("concurrent edits", () => {
  it("merges two people editing different fields of one box", () => {
    const { a, b } = pair();
    const o = makeObject({ kind: "app", name: "API" });
    applyOps(a.doc, a.state, [{ op: "object.put", object: o }], zeek, "add");
    // Both edit from the same starting point, before seeing each other.
    const base = a.state.objects.get(o.id)!;
    const offline = replica();
    Y.applyUpdate(offline.doc, Y.encodeStateAsUpdate(b.doc));
    applyOps(
      a.doc,
      a.state,
      [{ op: "object.put", object: { ...base, name: "Shop API" } }],
      zeek,
      "rename",
    );
    applyOps(
      offline.doc,
      offline.state,
      [{ op: "object.put", object: { ...base, technology: "Go" } }],
      jack,
      "tech",
    );
    Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(offline.doc), "remote");
    expect(a.state.objects.get(o.id)).toMatchObject({ name: "Shop API", technology: "Go" });
  });

  it("tidies an arrow drawn to a box someone else deleted", () => {
    const { doc, state, api, pay } = setup();
    const other = replica();
    Y.applyUpdate(other.doc, Y.encodeStateAsUpdate(doc));
    // Jack deletes Payments while Zeek, offline, draws another arrow to it.
    applyOps(other.doc, other.state, [{ op: "object.delete", id: pay.id }], jack, "delete");
    applyOps(
      doc,
      state,
      [{ op: "connection.put", connection: makeConnection({ fromId: api.id, toId: pay.id }) }],
      zeek,
      "draw",
    );
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(other.doc), "remote");
    expect(danglingOps(state)).toHaveLength(1);
    expect(sweep(doc, state, { id: "server", name: "archnm", kind: "system" })).toBe(1);
    expect(danglingOps(state)).toHaveLength(0);
    expect(state.connections.size).toBe(0);
  });
});
