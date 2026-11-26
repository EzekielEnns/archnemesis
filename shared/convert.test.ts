// archnm convert: a version 1 folder comes out as version 2, meaning the same thing.
import { describe, expect, it } from "vitest";
import { convert } from "../cli/convert.ts";
import { check, readFiles } from "./files.ts";

const V1 = new Map([
  ["archnm.yaml", "name: t\nversion: 1\n"],
  [
    "model/shop.yaml",
    `objects:
  - id: shop
    kind: system
    name: Shop
    description: Sells things.
    context: |
      Runs on Go.
  - id: api
    kind: app
    name: API
    in: shop
    tech: Go, Cloud Run
    links:
      - title: Runbook
        url: https://runbooks.example/api
    references:
      - entity: order
      - code: shop:cmd/api/main.go
  - id: charge
    kind: function
    name: charge()
    in: api
    signature: (Cart) -> Order
    references:
      - entity: order
      - entity: cart
connections:
  - from: api
    to: payments
    label: charges cards
    confidence: name
    references:
      - entity: order
`,
  ],
  [
    "model/landscape.yaml",
    "objects:\n  - id: payments\n    kind: system\n    name: Payments\n    external: true\n",
  ],
  [
    "entities.yaml",
    "entities:\n  - id: order\n    name: Order\n    source: api\n    fields:\n      - id uuid\n      - items [Item]\n  - id: paid-order\n    name: PaidOrder\n    extends: [order]\n    fields: [paid_at timestamp]\n  - id: cart\n    name: Cart\n  - id: status\n    name: order-status\n    values: [open, paid]\n",
  ],
  [
    "views/shop.yaml",
    "name: Shop\nscope: shop\nboxes:\n  - api\nlinks:\n  - title: Dash\n    url: https://dash.example\n    on: api\n",
  ],
  [
    "layout/shop.json",
    '{\n  "api": [10, 20, 184, 72],\n  "payments": [300, 20, 240, 96, 5, 6]\n}\n',
  ],
]);

describe("archnm convert", () => {
  it("rewrites a v1 folder as v2 that reads clean and means the same", () => {
    const { files, problems } = convert(V1);
    expect(problems.filter((p) => p.level === "error")).toEqual([]);
    expect(files.has("entities.yaml")).toBe(false);
    expect(files.has("model/landscape.yaml")).toBe(false);
    expect(files.get("archnm.yaml")).toContain("version: 2");
    const shop = files.get("model/shop.yaml")!;
    expect(shop).toContain(
      "  shop:\n    kind: system\n    name: Shop\n    context: |\n      Sells things.\n\n      Runs on Go.\n",
    );
    expect(shop).toContain("    tech: [Go, Cloud Run]\n");
    expect(shop).toContain("    uses: [Order]\n");
    expect(shop).toContain("      - link: https://runbooks.example/api\n        title: Runbook\n");
    expect(shop).toContain("      - link: https://dash.example/\n        title: Dash\n");
    expect(shop).toContain(
      "  - {from: api, to: payments, label: charges cards, guess: true, carries: [Order]}\n",
    );
    expect(shop).toContain(
      'entities:\n  Order:\n    in: api\n    fields: {id: uuid, items: "[Item]"}\n',
    );
    // charge's signature names Cart and Order: they're its entities without a uses.
    expect(shop).toMatch(/  charge:\n(    .*\n)*?    signature: \(Cart\) -> Order\n/);
    expect(shop.slice(shop.indexOf("  charge:"), shop.indexOf("entities:"))).not.toContain("uses:");
    const top = files.get("model/_top.yaml")!;
    expect(top).toContain(
      "  payments:\n    kind: system\n    name: Payments\n    external: true\n",
    );
    expect(top).toContain("  Cart: {}\n");
    expect(top).toContain("  PaidOrder:\n    extends: [Order]\n");
    // A name from before names were checked is made a type name.
    expect(top).toContain("  OrderStatus:\n    values: [open, paid]\n");
    expect(files.get("views/shop.yaml")).not.toContain("on:");
    expect(files.get("layout/shop.json")).toBe('{\n  "api": {"x": 10, "y": 20}\n}\n');
    const again = readFiles(files);
    expect(again.problems).toEqual([]);
    expect(check(again.model).filter((p) => p.level === "error")).toEqual([]);
  });
});
