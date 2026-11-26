import { describe, expect, it } from "vitest";
import { makeConnection, makeDiagram, makeObject, type Placement } from "./model.ts";
import { buildIndex, descendants, diagramForScope, projectDiagram, scopeTrail } from "./project.ts";

// A user, a shop system with two apps (the api has a component), and a payments provider.
function fixture() {
  const user = makeObject({ kind: "actor", name: "Shopper" });
  const shop = makeObject({ kind: "system", name: "Shop" });
  const web = makeObject({ kind: "app", name: "Web", parentId: shop.id });
  const api = makeObject({ kind: "app", name: "API", parentId: shop.id, technology: "Go" });
  const checkout = makeObject({ kind: "component", name: "Checkout", parentId: api.id });
  const pay = makeObject({ kind: "system", name: "Payments", external: true });
  const conns = [
    makeConnection({ fromId: user.id, toId: web.id, name: "browses" }),
    makeConnection({ fromId: web.id, toId: api.id, name: "calls" }),
    makeConnection({ fromId: checkout.id, toId: pay.id, name: "charges" }),
    makeConnection({ fromId: api.id, toId: pay.id, name: "refunds", status: "future" }),
  ];
  const landscape = makeDiagram({ name: "Landscape" });
  const inside = makeDiagram({ name: "Shop", scopeId: shop.id });
  const at = (d: string, o: string, x: number, y = 0): Placement => ({
    diagramId: d,
    objectId: o,
    x,
    y,
    w: 100,
    h: 50,
  });
  const placements = [
    at(landscape.id, user.id, 0),
    at(landscape.id, shop.id, 200),
    at(landscape.id, pay.id, 400),
    at(inside.id, user.id, 0),
    at(inside.id, web.id, 200),
    at(inside.id, api.id, 400),
    at(inside.id, pay.id, 600),
  ];
  const idx = buildIndex({
    objects: [user, shop, web, api, checkout, pay],
    connections: conns,
    diagrams: [landscape, inside],
    placements,
  });
  return { idx, user, shop, web, api, checkout, pay, landscape, inside };
}

describe("projectDiagram", () => {
  it("rolls connections up to the placed ancestor and merges them", () => {
    const f = fixture();
    const g = projectDiagram(f.idx, f.landscape.id);
    expect(g.nodes.map((n) => n.name).sort()).toEqual(["Payments", "Shop", "Shopper"]);
    const byPair = Object.fromEntries(g.edges.map((e) => [`${e.from}>${e.to}`, e]));
    // Shopper → Web lands on Shop; Web → API is inside Shop, so it's not drawn.
    expect(byPair[`${f.user.id}>${f.shop.id}`]?.label).toBe("browses");
    // Checkout → Payments and API → Payments both land on Shop → Payments.
    const shopToPay = byPair[`${f.shop.id}>${f.pay.id}`];
    expect(shopToPay?.connectionIds).toHaveLength(2);
    expect(shopToPay?.label).toBe("2 connections");
    // Each merged connection is listed, for the hover and the outline.
    expect(shopToPay?.merged).toHaveLength(2);
    expect(shopToPay?.status).toBe("live");
    expect(g.edges).toHaveLength(2);
    expect(g.groups).toEqual([]);
  });

  it("draws the same connections on the apps inside, with the scope as a boundary", () => {
    const f = fixture();
    const g = projectDiagram(f.idx, f.inside.id);
    const pairs = g.edges.map((e) => `${e.from}>${e.to}`).sort();
    expect(pairs).toEqual(
      [`${f.user.id}>${f.web.id}`, `${f.web.id}>${f.api.id}`, `${f.api.id}>${f.pay.id}`].sort(),
    );
    const group = g.groups[0];
    expect(group?.id).toBe(f.shop.id);
    // The boundary holds Web and API but not the actors around it.
    expect(group!.x).toBeLessThan(200);
    expect(group!.x + group!.w).toBeGreaterThan(500);
    expect(group!.x + group!.w).toBeLessThan(600);
    expect(g.nodes.find((n) => n.id === f.api.id)?.subtitle).toBe("App · Go");
    expect(g.nodes.find((n) => n.id === f.pay.id)?.subtitle).toBe("External system");
    expect(g.nodes.find((n) => n.id === f.api.id)?.childCount).toBe(1);
  });

  it("marks an arrow future only when every connection under it is", () => {
    const f = fixture();
    f.idx.connections.forEach((c) => {
      if (c.name === "charges") f.idx.connections.delete(c.id);
    });
    const g = projectDiagram(f.idx, f.landscape.id);
    expect(g.edges.find((e) => e.to === f.pay.id)?.status).toBe("future");
  });
});

describe("index helpers", () => {
  it("finds descendants, scope diagrams and the breadcrumb trail", () => {
    const f = fixture();
    expect(descendants(f.idx, f.shop.id).sort()).toEqual(
      [f.web.id, f.api.id, f.checkout.id].sort(),
    );
    expect(diagramForScope(f.idx, f.shop.id)?.id).toBe(f.inside.id);
    expect(diagramForScope(f.idx, null)?.id).toBe(f.landscape.id);
    expect(scopeTrail(f.idx, f.inside.id)).toEqual([
      { objectId: f.shop.id, name: "Shop", diagramId: f.inside.id },
    ]);
    expect(scopeTrail(f.idx, f.landscape.id)).toEqual([]);
  });
});

describe("off-diagram connections", () => {
  it("counts what's missing, but not the scope the diagram is inside", async () => {
    const { makeConnection, makeDiagram, makeObject } = await import("./model.ts");
    const { buildIndex, hiddenLinks, projectDiagram } = await import("./project.ts");
    const shop = makeObject({ kind: "system", name: "Shop" });
    const api = makeObject({ kind: "app", name: "API", parentId: shop.id });
    const db = makeObject({ kind: "store", name: "DB", parentId: shop.id });
    const user = makeObject({ kind: "actor", name: "User" });
    const inside = makeDiagram({ name: "Shop", scopeId: shop.id });
    const idx = buildIndex({
      objects: [shop, api, db, user],
      connections: [
        makeConnection({ fromId: user.id, toId: shop.id }),
        makeConnection({ fromId: api.id, toId: db.id }),
        makeConnection({ fromId: user.id, toId: api.id }),
      ],
      diagrams: [inside],
      placements: [
        { diagramId: inside.id, objectId: api.id, x: 0, y: 0, w: 184, h: 72 },
        { diagramId: inside.id, objectId: user.id, x: -300, y: 0, w: 184, h: 72 },
      ],
    });
    const g = projectDiagram(idx, inside.id);
    expect(g.nodes.find((n) => n.id === api.id)?.hidden).toBe(1); // DB isn't placed
    expect(g.nodes.find((n) => n.id === user.id)?.hidden).toBe(0);
    // User → Shop ends on the scope's frame.
    expect(g.edges.map((e) => e.id)).toContain(`${user.id}>${shop.id}`);
    expect(g.groups.find((f) => f.id === shop.id)).toBeTruthy();
    expect(hiddenLinks(idx, inside.id, api.id).map((h) => h.add)).toEqual([db.id]);
  });
});

it("takes the landscape as the top level over side views made the same moment", () => {
  const at = "2026-01-01T00:00:00.000Z";
  const deployment = { ...makeDiagram({ name: "Deployment", scopeId: null }), createdAt: at };
  const landscape = { ...makeDiagram({ name: "Landscape", scopeId: null }), createdAt: at };
  const idx = buildIndex({
    objects: [],
    connections: [],
    diagrams: [deployment, landscape],
    placements: [],
  });
  expect(diagramForScope(idx, null)?.id).toBe(landscape.id);
});
