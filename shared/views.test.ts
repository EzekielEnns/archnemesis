import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { openInside } from "./actions.ts";
import { applyOps, emptyState, mirror, pkey, type Actor } from "./doc.ts";
import { makeConnection, makeDiagram, makeObject, type Op } from "./model.ts";
import { buildIndex } from "./project.ts";
import { adoptRules, pinEdits, resolve, selectorError, viewOps } from "./views.ts";

const me: Actor = { id: "t", name: "T", kind: "human" };

function model() {
  const doc = new Y.Doc();
  const state = emptyState();
  mirror(doc, state, () => {});
  const customer = makeObject({ kind: "actor", name: "Customer" });
  const shop = makeObject({ kind: "system", name: "Shop" });
  const api = makeObject({ kind: "app", name: "API", parentId: shop.id });
  const db = makeObject({ kind: "store", name: "DB", parentId: shop.id, tags: ["pci"] });
  const cart = makeObject({ kind: "component", name: "Cart", parentId: api.id });
  const pay = makeObject({ kind: "system", name: "Payments", external: true, tags: ["pci"] });
  const ops: Op[] = [customer, shop, api, db, cart, pay].map((object) => ({
    op: "object.put",
    object,
  }));
  ops.push(
    { op: "connection.put", connection: makeConnection({ fromId: customer.id, toId: api.id }) },
    { op: "connection.put", connection: makeConnection({ fromId: cart.id, toId: pay.id }) },
    { op: "connection.put", connection: makeConnection({ fromId: api.id, toId: db.id }) },
  );
  applyOps(doc, state, ops, me, "seed");
  const idx = () =>
    buildIndex({
      flows: state.flows.values(),
      objects: state.objects.values(),
      connections: state.connections.values(),
      diagrams: state.diagrams.values(),
      placements: state.placements.values(),
    });
  return { doc, state, idx, customer, shop, api, db, cart, pay };
}

describe("selectors", () => {
  it("rejects malformed rules with a reason", () => {
    expect(selectorError({ children: "x" })).toBeNull();
    expect(selectorError({ chidlren: "x" })).toMatch(/unknown rule "chidlren"/);
    expect(selectorError({ children: "x", tag: "y" })).toMatch(/exactly one key/);
    expect(selectorError({ kind: "database" })).toMatch(/unknown kind/);
    expect(selectorError({ ids: "x" })).toMatch(/list/);
  });

  it("resolves children and neighbours, rolled up, minus the frame", () => {
    const m = model();
    const d = makeDiagram({
      name: "Shop",
      scopeId: m.shop.id,
      rules: { include: [{ children: m.shop.id }, { neighbours: m.shop.id }], exclude: [] },
    });
    const r = resolve(m.idx(), d);
    expect([...r.ids].sort()).toEqual([m.api.id, m.db.id, m.customer.id, m.pay.id].sort());
    expect(r.why.get(m.pay.id)).toEqual([{ neighbours: m.shop.id }]);
  });

  it("excludes win, and say which rule did it", () => {
    const m = model();
    const d = makeDiagram({
      name: "PCI",
      rules: { include: [{ tag: "pci" }], exclude: [{ kind: "store" }] },
    });
    const r = resolve(m.idx(), d);
    expect([...r.ids]).toEqual([m.pay.id]);
    expect(r.excluded.get(m.db.id)).toEqual({ kind: "store" });
  });
});

describe("diagrams that follow the model", () => {
  it("opening an object's inside makes a diagram that picks up new children", () => {
    const m = model();
    const { diagramId, ops } = openInside(m.idx(), m.shop.id);
    applyOps(m.doc, m.state, ops, me, "open");
    expect(viewOps(m.idx(), diagramId)).toEqual([]);
    const worker = makeObject({ kind: "app", name: "Worker", parentId: m.shop.id });
    applyOps(m.doc, m.state, [{ op: "object.put", object: worker }], me, "add worker");
    const follow = viewOps(m.idx(), diagramId);
    expect(follow).toHaveLength(1);
    expect(follow[0]).toMatchObject({ op: "placement.put", placement: { objectId: worker.id } });
  });

  it("a box that leaves and comes back (an undone move) goes back where it was", () => {
    const m = model();
    const { diagramId, ops } = openInside(m.idx(), m.shop.id);
    applyOps(m.doc, m.state, ops, me, "open");
    const worker = makeObject({ kind: "app", name: "Worker", parentId: m.shop.id });
    applyOps(m.doc, m.state, [{ op: "object.put", object: worker }], me, "add worker");
    applyOps(m.doc, m.state, viewOps(m.idx(), diagramId), me, "follow");
    const was = m.idx().placements.get(diagramId)!.get(worker.id)!;
    // Moved out of Shop: the view drops it (the server remembers where it was).
    applyOps(
      m.doc,
      m.state,
      [{ op: "object.put", object: { ...worker, parentId: null } }],
      me,
      "take out",
    );
    const drop = viewOps(m.idx(), diagramId);
    expect(drop).toEqual([{ op: "placement.delete", diagramId, objectId: worker.id }]);
    applyOps(m.doc, m.state, drop, me, "follow");
    // Back in: with the memory, its old spot.
    applyOps(m.doc, m.state, [{ op: "object.put", object: worker }], me, "undo");
    const back = viewOps(m.idx(), diagramId, (d, id) =>
      d === diagramId && id === worker.id ? was : undefined,
    );
    expect(back).toEqual([
      {
        op: "placement.put",
        placement: { diagramId, objectId: worker.id, x: was.x, y: was.y, w: was.w, h: was.h },
      },
    ]);
  });

  it("removing a box by hand adds an exclude, so it stays off", () => {
    const m = model();
    const { diagramId, ops } = openInside(m.idx(), m.shop.id);
    applyOps(m.doc, m.state, ops, me, "open");
    applyOps(
      m.doc,
      m.state,
      [{ op: "placement.delete", diagramId, objectId: m.pay.id }],
      me,
      "remove",
    );
    expect(m.state.diagrams.get(diagramId)?.rules?.exclude).toEqual([{ ids: [m.pay.id] }]);
    expect(viewOps(m.idx(), diagramId)).toEqual([]);
    // Putting it back drops the exclude instead of pinning it.
    const p = { diagramId, objectId: m.pay.id, x: 0, y: 400, w: 184, h: 72 };
    applyOps(m.doc, m.state, [{ op: "placement.put", placement: p }], me, "put back");
    expect(m.state.diagrams.get(diagramId)?.rules?.exclude).toEqual([]);
    expect(m.state.placements.has(pkey(diagramId, m.pay.id))).toBe(true);
  });

  it("placing a box the rules don't cover pins it by id", () => {
    const m = model();
    const d = makeDiagram({
      name: "Shop",
      scopeId: m.shop.id,
      rules: { include: [{ children: m.shop.id }], exclude: [] },
    });
    const next = pinEdits(m.idx(), d, [m.cart.id], []);
    expect(next?.rules?.include).toEqual([{ children: m.shop.id }, { ids: [m.cart.id] }]);
  });

  it("adopting rules keeps today's boxes exactly", () => {
    const m = model();
    const d = makeDiagram({ name: "Shop", scopeId: m.shop.id });
    const at = (objectId: string, x: number): Op => ({
      op: "placement.put",
      placement: { diagramId: d.id, objectId, x, y: 0, w: 184, h: 72 },
    });
    applyOps(
      m.doc,
      m.state,
      [{ op: "diagram.put", diagram: d }, at(m.api.id, 0), at(m.cart.id, 300)],
      me,
      "hand-picked",
    );
    const adopted = adoptRules(m.idx(), m.state.diagrams.get(d.id)!);
    applyOps(m.doc, m.state, [{ op: "diagram.put", diagram: adopted }], me, "follow");
    expect(viewOps(m.idx(), d.id)).toEqual([]);
  });
});
