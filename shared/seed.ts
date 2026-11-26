// A small example landscape for an empty model: an online shop, three levels deep, so
// the roll-up of connections shows from the first click. Delete it whenever you like.
import {
  CARD_H,
  CARD_W,
  makeConnection,
  makeDiagram,
  makeObject,
  type ModelObject,
  type Op,
  type Status,
} from "./model.ts";

/** The example landscape as one batch of ops. */
export function seedOps(): Op[] {
  const ops: Op[] = [];
  const obj = (fields: Parameters<typeof makeObject>[0]): ModelObject => {
    const o = makeObject(fields);
    ops.push({ op: "object.put", object: o });
    return o;
  };

  const customer = obj({
    kind: "actor",
    name: "Customer",
    description: "Someone buying from the shop.",
  });
  const support = obj({ kind: "actor", name: "Support agent" });
  const shop = obj({
    kind: "system",
    name: "Shop",
    description: "Everything we run to sell online.",
  });
  const payments = obj({ kind: "system", name: "Payments", external: true, technology: "Stripe" });
  const email = obj({ kind: "system", name: "Email", external: true, technology: "Postmark" });
  const warehouse = obj({
    kind: "system",
    name: "Warehouse",
    status: "future",
    description: "Fulfilment, planned for next year.",
  });
  const analytics = obj({ kind: "system", name: "Analytics", technology: "BigQuery" });

  const storefront = obj({
    kind: "app",
    name: "Storefront",
    parentId: shop.id,
    technology: "React",
  });
  const api = obj({ kind: "app", name: "Shop API", parentId: shop.id, technology: "Go" });
  const worker = obj({ kind: "app", name: "Worker", parentId: shop.id, technology: "Go" });
  const ordersDb = obj({
    kind: "store",
    name: "Orders DB",
    parentId: shop.id,
    technology: "Postgres",
  });
  const search = obj({
    kind: "store",
    name: "Search index",
    parentId: shop.id,
    technology: "OpenSearch",
  });

  const catalog = obj({ kind: "component", name: "Catalog", parentId: api.id });
  const cart = obj({ kind: "component", name: "Cart", parentId: api.id });
  const checkout = obj({ kind: "component", name: "Checkout", parentId: api.id });

  const link = (
    from: ModelObject,
    to: ModelObject,
    name: string,
    technology = "",
    status: Status = "live",
  ) =>
    ops.push({
      op: "connection.put",
      connection: makeConnection({ fromId: from.id, toId: to.id, name, technology, status }),
    });
  link(customer, storefront, "browses and buys", "HTTPS");
  link(support, catalog, "edits products", "HTTPS");
  link(storefront, catalog, "lists products", "JSON/HTTPS");
  link(storefront, cart, "updates the cart", "JSON/HTTPS");
  link(storefront, checkout, "places orders", "JSON/HTTPS");
  link(catalog, search, "queries");
  link(cart, ordersDb, "reads and writes", "SQL");
  link(checkout, ordersDb, "writes orders", "SQL");
  link(checkout, payments, "charges cards", "HTTPS");
  link(checkout, warehouse, "ships orders", "", "future");
  link(worker, ordersDb, "reads new orders", "SQL");
  link(worker, search, "indexes products");
  link(worker, email, "sends receipts", "HTTPS");
  link(worker, analytics, "exports events");

  const diagram = (
    name: string,
    scope: ModelObject | null,
    at: [ModelObject, number, number][],
  ) => {
    const d = makeDiagram({ name, scopeId: scope?.id ?? null });
    ops.push({ op: "diagram.put", diagram: d });
    for (const [o, x, y] of at) {
      ops.push({
        op: "placement.put",
        placement: { diagramId: d.id, objectId: o.id, x, y, w: CARD_W, h: CARD_H },
      });
    }
  };
  diagram("Landscape", null, [
    [customer, 0, 40],
    [support, 0, 240],
    [shop, 340, 140],
    [payments, 700, 0],
    [email, 700, 140],
    [warehouse, 700, 280],
    [analytics, 340, 340],
  ]);
  diagram("Shop", shop, [
    [customer, 0, 60],
    [support, 0, 320],
    [storefront, 340, 60],
    [api, 640, 60],
    [worker, 640, 320],
    [ordersDb, 940, 60],
    [search, 940, 320],
    [payments, 1300, 0],
    [email, 1300, 150],
    [warehouse, 1300, 300],
    [analytics, 1300, 450],
  ]);
  diagram("Shop API", api, [
    [storefront, 0, 140],
    [support, 0, 340],
    [catalog, 340, 40],
    [cart, 340, 180],
    [checkout, 340, 320],
    [search, 700, 0],
    [ordersDb, 700, 160],
    [payments, 700, 320],
    [warehouse, 700, 460],
  ]);

  return ops;
}
