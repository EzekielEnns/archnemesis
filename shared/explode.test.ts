import { describe, expect, it } from "vitest";
import { explode, unexplode } from "./explode.ts";
import { buildIndex, projectDiagram } from "./project.ts";
import { makeObject, type Diagram, type Placement } from "./model.ts";

const at = (diagramId: string, objectId: string, x: number, y: number): Placement => ({
  diagramId,
  objectId,
  x,
  y,
  w: 180,
  h: 72,
});
const view = (id: string, scopeId: string | null): Diagram =>
  ({ id, name: id, scopeId, rules: null, createdAt: "", updatedAt: "" }) as Diagram;

function world() {
  const shop = makeObject({ kind: "system", name: "Shop" });
  const api = makeObject({ kind: "app", name: "API", parentId: shop.id });
  const db = makeObject({ kind: "store", name: "DB", parentId: shop.id });
  const handler = makeObject({ kind: "component", name: "Handler", parentId: api.id });
  const right = makeObject({ kind: "system", name: "Right" });
  const below = makeObject({ kind: "system", name: "Below" });
  const idx = buildIndex({
    objects: [shop, api, db, handler, right, below],
    connections: [],
    diagrams: [view("top", null), view("inside", shop.id)],
    placements: [
      at("top", shop.id, 0, 0),
      at("top", right.id, 300, 0),
      at("top", below.id, 0, 200),
      at("inside", api.id, 0, 0),
      at("inside", db.id, 300, 0),
    ],
  } as never);
  return { idx, shop, api, db, handler, right, below };
}

describe("explode", () => {
  it("draws a box's inside where it was, moves the rest over, and changes nothing", () => {
    const { idx, shop, api, db, right, below } = world();
    const before = JSON.stringify([...idx.placements.get("top")!]);
    const ex = explode(idx, "top", [shop.id])!;
    const g = projectDiagram(ex.idx, "top", { frames: false });
    const ids = g.nodes.map((n) => n.id);
    expect(ids).toEqual(expect.arrayContaining([api.id, db.id, right.id, below.id]));
    expect(ids).not.toContain(shop.id);
    const frame = ex.frames[0]!;
    expect(frame.name).toBe("Shop");
    // What was right of it and below it is now clear of the frame.
    expect(g.nodes.find((n) => n.id === right.id)!.x).toBeGreaterThanOrEqual(frame.x + frame.w);
    expect(g.nodes.find((n) => n.id === below.id)!.y).toBeGreaterThanOrEqual(frame.y + frame.h);
    expect(ex.moved.get(right.id)!.dx).toBeGreaterThan(0);
    // A drop on the opened layout is saved where it really is: undoing the room made gives the spot back.
    for (const o of [right, below]) {
      const n = g.nodes.find((x) => x.id === o.id)!;
      const real = idx.placements.get("top")!.get(o.id)!;
      expect(unexplode(ex, { x: n.x, y: n.y })).toEqual({ x: real.x, y: real.y });
    }
    expect(JSON.stringify([...idx.placements.get("top")!])).toBe(before);
    expect(explode(idx, "top", [])).toBeNull();
  });

  it("opens a box inside an opened box, its frame inside the first, which grows to hold it", () => {
    const { idx, shop, api, db, handler } = world();
    const one = explode(idx, "top", [shop.id])!;
    const two = explode(idx, "top", [shop.id, api.id])!;
    const g = projectDiagram(two.idx, "top", { frames: false });
    expect(g.nodes.map((n) => n.id)).toEqual(expect.arrayContaining([handler.id, db.id]));
    expect(g.nodes.map((n) => n.id)).not.toContain(api.id);
    const [outer, inner] = two.frames;
    expect(inner!.x).toBeGreaterThanOrEqual(outer!.x);
    expect(inner!.x + inner!.w).toBeLessThanOrEqual(outer!.x + outer!.w);
    expect(inner!.y + inner!.h).toBeLessThanOrEqual(outer!.y + outer!.h);
    expect(outer!.w).toBeGreaterThan(one.frames[0]!.w);
    // DB, beside API, moved over to make room.
    expect(g.nodes.find((n) => n.id === db.id)!.x).toBeGreaterThanOrEqual(inner!.x + inner!.w);
  });

  it("keeps an open panel's insides in it when another box opens beside it", () => {
    // Like Order API (open, lower) next to Pricing Engine (opened after, higher up): its
    // insides are below Pricing Engine, but they move with their panel, not on their own.
    const left = makeObject({ kind: "app", name: "Left" });
    const lk = makeObject({ kind: "module", name: "left.rs", parentId: left.id });
    const up = makeObject({ kind: "app", name: "Up" });
    const uk = makeObject({ kind: "module", name: "up.rs", parentId: up.id });
    const idx = buildIndex({
      objects: [left, lk, up, uk],
      connections: [],
      diagrams: [view("top", null)],
      placements: [at("top", left.id, 0, 40), at("top", up.id, 400, 0)],
    } as never);
    const ex = explode(idx, "top", [left.id, up.id])!;
    const g = projectDiagram(ex.idx, "top", { frames: false });
    const panel = ex.frames.find((f) => f.name === "Left")!;
    const n = g.nodes.find((x) => x.id === lk.id)!;
    expect(n.x).toBeGreaterThanOrEqual(panel.x);
    expect(n.y).toBeGreaterThanOrEqual(panel.y);
    expect(n.x + n.w).toBeLessThanOrEqual(panel.x + panel.w);
    expect(n.y + n.h).toBeLessThanOrEqual(panel.y + panel.h);
  });

  it("opens a box whose insides are also drawn here, moving them into its panel", () => {
    // A new box, and a box dropped into it on this same diagram.
    const box = makeObject({ kind: "app", name: "New" });
    const kid = makeObject({ kind: "component", name: "Kid", parentId: box.id });
    const idx = buildIndex({
      objects: [box, kid],
      connections: [],
      diagrams: [view("top", null)],
      placements: [at("top", box.id, 0, 0), at("top", kid.id, 600, 400)],
    } as never);
    const ex = explode(idx, "top", [box.id])!;
    expect(ex).not.toBeNull();
    const panel = ex.frames[0]!;
    const n = projectDiagram(ex.idx, "top", { frames: false }).nodes.find((x) => x.id === kid.id)!;
    expect(n.x).toBeGreaterThanOrEqual(panel.x);
    expect(n.y + n.h).toBeLessThanOrEqual(panel.y + panel.h);
    // A drag saves it where it really is.
    expect(n.x - ex.moved.get(kid.id)!.dx).toBe(600);
    expect(n.y - ex.moved.get(kid.id)!.dy).toBe(400);
  });
});
