import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { seedOps } from "./seed.ts";
import { applyOps, emptyState, mirror, type Actor } from "./doc.ts";
import {
  completeType,
  entitySummary,
  makeEntity as makeEntityFor,
  typeAt,
  entitiesOf,
  entityShape,
  parseEntityName,
  signatureOps,
  signatureTypes,
  splitField,
} from "./entities.ts";
import { check, keyOps, readFiles, toOps, writeFiles } from "./files.ts";
import { makeObject } from "./model.ts";
import { buildIndex } from "./project.ts";

const me: Actor = { id: "t", name: "T", kind: "human" };

function design() {
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
      entities: state.entities.values(),
    });
  return { doc, state, idx };
}

describe("signatures", () => {
  it("names the design's types, not the inputs' names or the language's own", () => {
    expect(signatureTypes("(cart: Cart, UserId) -> Result<Order, ApiError>")).toEqual([
      "Cart",
      "UserId",
      "Order",
      "ApiError",
    ]);
    expect(signatureTypes("(&self, items: Vec<OrderItem>) -> Option<String>")).toEqual([
      "OrderItem",
    ]);
    expect(signatureTypes("([Order], Order?) -> int")).toEqual(["Order"]);
    expect(signatureTypes(undefined)).toEqual([]);
  });

  it("links each type, making TBD entities for new names, and lets go of the old signature's", () => {
    const { doc, state, idx } = design();
    const fn = makeObject({
      id: "fn",
      kind: "function",
      name: "create_order()",
    });
    applyOps(doc, state, [{ op: "object.put", object: fn }], me, "t");
    const first = signatureOps(idx(), state.objects.get("fn")!, "(Cart) -> Order");
    expect(first.ops.map((o) => o.op === "entity.put" && o.entity.name)).toEqual(["Cart", "Order"]);
    applyOps(
      doc,
      state,
      [
        ...first.ops,
        {
          op: "object.put",
          object: {
            ...state.objects.get("fn")!,
            signature: "(Cart) -> Order",
            references: first.references,
          },
        },
      ],
      me,
      "t",
    );
    expect(entitiesOf(idx(), state.objects.get("fn")!).map((e) => e.name)).toEqual([
      "Cart",
      "Order",
    ]);
    // Cart goes from the signature: its link goes, and so does Cart (a TBD nothing else uses);
    // Order stays; Receipt is new.
    const next = signatureOps(idx(), state.objects.get("fn")!, "(Order) -> Receipt");
    const cart = [...state.entities.values()].find((e) => e.name === "Cart")!;
    expect(
      next.ops.map((o) =>
        o.op === "entity.put" ? o.entity.name : o.op === "entity.delete" ? `-${o.id}` : "",
      ),
    ).toEqual(["Receipt", `-${cart.id}`]);
    applyOps(
      doc,
      state,
      [
        ...next.ops,
        {
          op: "object.put",
          object: {
            ...state.objects.get("fn")!,
            signature: "(Order) -> Receipt",
            references: next.references,
          },
        },
      ],
      me,
      "t",
    );
    expect(entitiesOf(idx(), state.objects.get("fn")!).map((e) => e.name)).toEqual([
      "Order",
      "Receipt",
    ]);
    expect([...state.entities.values()].map((e) => e.name).sort()).toEqual(["Order", "Receipt"]);
  });
});

describe("entities in the files", () => {
  it("round-trip in their box's file, by name", () => {
    const { doc, state, idx } = design();
    const api = [...state.objects.values()].find((o) => o.key === "shop-api")!;
    applyOps(
      doc,
      state,
      [
        {
          op: "entity.put",
          entity: {
            id: "e1",
            name: "Order",
            fields: [
              "id uuid",
              "status OrderStatus",
              "note text?",
              "charge(amount: Money) -> Receipt",
            ],
            sourceId: api.id,
            description: "An order.",
            createdAt: "",
            updatedAt: "",
          },
        },
        {
          op: "entity.put",
          entity: {
            id: "e2",
            name: "OrderStatus",
            fields: [],
            values: ["pending", "paid"],
            sourceId: null,
            description: "",
            createdAt: "",
            updatedAt: "",
          },
        },
        {
          op: "entity.put",
          entity: {
            id: "e3",
            name: "PaidOrder",
            fields: ["paid_at timestamp"],
            extends: ["e1"],
            sourceId: null,
            description: "",
            createdAt: "",
            updatedAt: "",
          },
        },
        { op: "object.put", object: { ...api, references: [{ kind: "entity", to: "e1" }] } },
      ],
      me,
      "t",
    );
    applyOps(doc, state, keyOps(state), me, "keys");
    const files = writeFiles(state);
    expect(files.has("entities.yaml")).toBe(false);
    const shop = files.get("model/shop.yaml")!;
    expect(shop).toContain(
      'entities:\n  Order:\n    in: shop-api\n    context: An order.\n    fields: {id: uuid, status: OrderStatus, note: text?, "charge(amount: Money)": Receipt}\n',
    );
    expect(shop).toContain("    uses: [Order]\n");
    const top = files.get("model/_top.yaml")!;
    expect(top).toContain("  OrderStatus:\n    values: [pending, paid]\n");
    expect(top).toContain("  PaidOrder:\n    extends: [Order]\n    fields: {paid_at: timestamp}\n");
    const { model, problems } = readFiles(files);
    expect(problems).toEqual([]);
    expect(check(model).filter((p) => p.level === "error")).toEqual([]);
    expect(toOps(state, model)).toEqual([]);
    expect(entitiesOf(idx(), state.objects.get(api.id)!).map((e) => e.name)).toEqual(["Order"]);
  });

  it("reads an entity an agent wrote, extending one later in the file", () => {
    const { doc, state, idx } = design();
    const files = new Map(writeFiles(state));
    files.set(
      "model/_top.yaml",
      `${files.get("model/_top.yaml")}entities:\n  PaidOrder:\n    extends: Order\n    fields: [paid_at timestamp]\n  Order:\n    fields: { id: uuid }\n`,
    );
    const { model, problems } = readFiles(files);
    expect(problems).toEqual([]);
    applyOps(doc, state, toOps(state, model), me, "files", me, { pin: false });
    const byName = (n: string) => [...idx().entities.values()].find((e) => e.name === n)!;
    expect(byName("PaidOrder").extends).toEqual([byName("Order").id]);
    expect(byName("PaidOrder").fields).toEqual(["paid_at timestamp"]);
    expect(byName("Order").fields).toEqual(["id uuid"]);
  });

  it("says what's wrong", () => {
    const { state } = design();
    const files = new Map(writeFiles(state));
    files.set(
      "model/_top.yaml",
      `${files.get("model/_top.yaml")}entities:\n  Order: {}\n  A:\n    extends: [Ordr]\n    in: nowhere\n`,
    );
    const msgs = check(readFiles(files).model).map((p) => p.message);
    expect(msgs).toContain("A: extends: no entity Ordr (did you mean Order?)");
    expect(msgs.some((m) => m.startsWith('A: in: no object "nowhere"'))).toBe(true);
  });
});

describe("shapes", () => {
  it("knows TBD, enum, interface, type from what it has", () => {
    expect(entityShape({ fields: [] })).toBe("TBD");
    expect(entityShape({ fields: [], values: ["a"] })).toBe("enum");
    expect(entityShape({ fields: ["charge(amount: money) -> Receipt"] })).toBe("interface");
    expect(entityShape({ fields: ["id uuid"] })).toBe("type");
  });
  it("splits names and fields", () => {
    expect(parseEntityName("PaidOrder : Order, Auditable")).toEqual({
      name: "PaidOrder",
      extends: ["Order", "Auditable"],
    });
    expect(parseEntityName("Order")).toEqual({ name: "Order", extends: [] });
    expect(splitField("items [OrderItem]")).toEqual(["items", "[OrderItem]"]);
    expect(splitField("charge(amount: money) -> Receipt")).toEqual([
      "charge(amount: money) -> Receipt",
      "",
    ]);
  });
});

describe("on the canvas", () => {
  it("sums one up in a few words", () => {
    expect(entitySummary({ fields: [] })).toBe("TBD");
    expect(entitySummary({ fields: ["id uuid"] })).toBe("type · 1 field");
    expect(entitySummary({ fields: [], values: ["pending", "paid"] })).toBe("enum · 2 values");
  });
});

describe("suggesting types in a signature", () => {
  it("finds the type being typed, only inside the inputs", () => {
    expect(typeAt("create_order(cart: Ca", 21)).toEqual({ word: "Ca", start: 19 });
    expect(typeAt("(Cart, Us) -> Order", 9)).toEqual({ word: "Us", start: 7 });
    expect(typeAt("(Cart, Us) -> Order", 8)).toBeNull(); // the cursor is inside the word
    expect(typeAt("Cart::total", 4)).toBeNull(); // the name, not a type
    expect(typeAt("(cart", 5)).toBeNull(); // not capitalised
  });
  it("puts the picked name in its place", () => {
    expect(completeType("(Ca, UserId)", { word: "Ca", start: 1 }, "Cart")).toEqual({
      text: "(Cart, UserId)",
      cursor: 5,
    });
  });
});

describe("where a box's layer nodes sit", () => {
  it("goes in its layout line, and comes back the same", () => {
    const { doc, state } = design();
    const p = [...state.placements.values()][0]!;
    applyOps(
      doc,
      state,
      [{ op: "placement.put", placement: { ...p, parts: { x: 220.4, y: -12 } } }],
      me,
      "move parts",
    );
    const files = new Map(writeFiles(state));
    const [file, text] = [...files].find(
      ([f, t]) =>
        f.startsWith("layout/") &&
        t.includes(`{"x": ${Math.round(p.x)}, "y": ${Math.round(p.y)}, "parts": [220, -12]}`),
    )!;
    expect(file).toMatch(/^layout\//);
    expect(text).toBeTruthy();
    const { model, problems } = readFiles(files);
    expect(problems).toEqual([]);
    expect(toOps(state, model)).toEqual([]);
    // Dragged back (no spot): the file loses the two numbers, and reading it drops the spot.
    applyOps(
      doc,
      state,
      [{ op: "placement.put", placement: { ...p, parts: undefined } }],
      me,
      "reset parts",
    );
    expect(toOps(state, readFiles(new Map(writeFiles(state))).model)).toEqual([]);
    expect([...state.placements.values()][0]!.parts).toBeUndefined();
  });
});

describe("where an arrow's layer nodes sit", () => {
  it("goes on its shape in the layout file, and comes back the same", () => {
    const { doc, state } = design();
    const c = [...state.connections.values()][0]!;
    const d = [...state.placements.values()][0]!.diagramId;
    applyOps(
      doc,
      state,
      [
        {
          op: "arrow.put",
          arrow: { diagramId: d, from: c.fromId, to: c.toId, parts: { x: 40.6, y: -30 } },
        },
      ],
      me,
      "move what it carries",
    );
    const files = new Map(writeFiles(state));
    expect(
      [...files].some(([f, t]) => f.startsWith("layout/") && t.includes(`{"parts": [41, -30]}`)),
    ).toBe(true);
    const { model, problems } = readFiles(files);
    expect(problems).toEqual([]);
    expect(toOps(state, model)).toEqual([]);
  });
});

describe("what a connection carries", () => {
  it("is written as carries, by name, and comes back the same", () => {
    const { doc, state } = design();
    const c = [...state.connections.values()][0]!;
    const e = { ...makeEntityFor("Order"), key: "Order" };
    applyOps(
      doc,
      state,
      [
        { op: "entity.put", entity: e },
        {
          op: "connection.put",
          connection: {
            ...c,
            references: [{ kind: "entity", to: e.id }],
            links: [{ title: "API docs", url: "https://example.com/api" }],
          },
        },
      ],
      me,
      "carries",
    );
    const files = new Map(writeFiles(state));
    const text = [...files].find(
      ([f, t]) => f.startsWith("model/") && t.includes("carries: [Order]"),
    )![1];
    expect(text).toContain("- link: https://example.com/api\n        title: API docs");
    const { model, problems } = readFiles(files);
    expect(problems).toEqual([]);
    expect(check(model).filter((p) => p.level === "error")).toEqual([]);
    expect(toOps(state, model)).toEqual([]);
    // Deleting the entity lets go of it on the connection too.
    applyOps(doc, state, [{ op: "entity.delete", id: e.id }], me, "gone");
    expect(state.connections.get(c.id)!.references).toEqual([]);
  });
});
