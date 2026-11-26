// A design written as files, from a batch of ops: how tests (and anything else with ops in hand)
// get what writeFiles gives for them, keys and layout included.
import * as Y from "yjs";
import { applyOps, emptyState, mirror } from "./doc.ts";
import { keyOps, writeFiles, type FConfig } from "./files.ts";
import { CARD_H, CARD_W, makeConnection, makeDiagram, makeObject, type Op } from "./model.ts";

export function filesFromOps(ops: Op[], config: FConfig = {}): Map<string, string> {
  const who = { id: "files", name: "files", kind: "system" } as const;
  const doc = new Y.Doc();
  const state = emptyState();
  mirror(doc, state, () => {});
  applyOps(doc, state, ops, who, "ops");
  applyOps(doc, state, keyOps(state), who, "keys");
  return writeFiles(state, config);
}

/** A small design (a landscape with a few boxes, one with parts inside, and connections) for tests that sit outside the server. */
export function smallOps(): Op[] {
  const customer = makeObject({ kind: "actor", name: "Customer" });
  const shop = makeObject({ kind: "system", name: "Shop", description: "Sells things." });
  const payments = makeObject({ kind: "system", name: "Payments", external: true });
  const api = makeObject({ kind: "app", name: "Shop API", parentId: shop.id });
  const landscape = makeDiagram({ name: "Landscape", key: "landscape" });
  const at = (o: { id: string }, x: number, y: number): Op => ({
    op: "placement.put",
    placement: { diagramId: landscape.id, objectId: o.id, x, y, w: CARD_W, h: CARD_H },
  });
  return [
    ...[customer, shop, payments, api].map((object): Op => ({ op: "object.put", object })),
    { op: "diagram.put", diagram: landscape },
    at(customer, 0, 0),
    at(shop, 300, 0),
    at(payments, 600, 0),
    {
      op: "connection.put",
      connection: makeConnection({ fromId: customer.id, toId: shop.id, name: "buys" }),
    },
    {
      op: "connection.put",
      connection: makeConnection({ fromId: shop.id, toId: payments.id, name: "charges" }),
    },
  ];
}
