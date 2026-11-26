import { describe, expect, it } from "vitest";
import { addObject, freeSpot, openInside } from "./actions.ts";
import { CARD_W, makeConnection, makeDiagram, makeObject } from "./model.ts";
import { buildIndex } from "./project.ts";

function fixture() {
  const shop = makeObject({ kind: "system", name: "Shop" });
  const web = makeObject({ kind: "app", name: "Web", parentId: shop.id });
  const api = makeObject({ kind: "app", name: "API", parentId: shop.id });
  const user = makeObject({ kind: "actor", name: "User" });
  const pay = makeObject({ kind: "system", name: "Payments", external: true });
  const card = makeObject({ kind: "app", name: "Card API", parentId: pay.id });
  const landscape = makeDiagram({ name: "Landscape" });
  const idx = buildIndex({
    objects: [shop, web, api, user, pay, card],
    connections: [
      makeConnection({ fromId: user.id, toId: web.id }),
      makeConnection({ fromId: web.id, toId: api.id }),
      makeConnection({ fromId: api.id, toId: card.id }),
    ],
    diagrams: [landscape],
    placements: [{ diagramId: landscape.id, objectId: shop.id, x: 0, y: 0, w: 184, h: 72 }],
  });
  return { idx, shop, web, api, user, pay, landscape };
}

describe("openInside", () => {
  it("makes a diagram with the children, callers on the left and callees on the right", () => {
    const f = fixture();
    const { diagramId, ops } = openInside(f.idx, f.shop.id);
    const placed = ops.flatMap((o) => (o.op === "placement.put" ? [o.placement] : []));
    expect(placed.every((p) => p.diagramId === diagramId)).toBe(true);
    const at = Object.fromEntries(placed.map((p) => [p.objectId, p.x]));
    expect(Object.keys(at).sort()).toEqual([f.web.id, f.api.id, f.user.id, f.pay.id].sort());
    expect(at[f.user.id]).toBeLessThan(at[f.web.id]!);
    // Card API is inside Payments, so Payments is what's placed next to the shop.
    expect(at[f.pay.id]).toBeGreaterThan(at[f.api.id]!);
  });

  it("reuses the diagram once it exists", () => {
    const f = fixture();
    const scoped = makeDiagram({ name: "Shop", scopeId: f.shop.id });
    f.idx.diagrams.set(scoped.id, scoped);
    expect(openInside(f.idx, f.shop.id)).toEqual({ diagramId: scoped.id, ops: [] });
  });
});

describe("adding", () => {
  it("never lands a new box on an old one", () => {
    const f = fixture();
    const spot = freeSpot(f.idx, f.landscape.id, { x: 10, y: 10 });
    expect(spot.x >= CARD_W || spot.y >= 72).toBe(true);
  });

  it("puts a new object inside the diagram's scope, but not an actor", () => {
    const f = fixture();
    const inside = makeDiagram({ name: "Shop", scopeId: f.shop.id });
    f.idx.diagrams.set(inside.id, inside);
    expect(addObject(f.idx, inside.id, "app", { x: 0, y: 0 }).object.parentId).toBe(f.shop.id);
    expect(addObject(f.idx, inside.id, "actor", { x: 0, y: 0 }).object.parentId).toBeNull();
  });
});
