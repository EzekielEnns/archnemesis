import { describe, expect, it } from "vitest";
import { check, overlay, readFiles } from "./files.ts";

const base = readFiles(
  new Map([
    ["archnm.yaml", "name: T\n"],
    [
      "model/shop.yaml",
      "objects:\n  shop:\n    kind: system\n    name: Shop\n  api:\n    kind: app\n    name: API\n    in: shop\n  db:\n    kind: store\n    name: DB\n    in: shop\n  billing:\n    kind: app\n    name: Billing\n    in: shop\n  invoices:\n    kind: component\n    name: Invoices\n    in: billing\nconnections:\n  - from: api\n    to: db\n  - from: invoices\n    to: db\n    label: old\n",
    ],
  ]),
).model;
const write = (text: string) => readFiles(new Map([["model/billing.yaml", text]])).model;

describe("overlay", () => {
  it("replaces by id, wherever the object was filed", () => {
    const m = overlay(
      base,
      write("objects:\n  billing:\n    kind: app\n    name: Billing v2\n    in: shop\n"),
    );
    expect(m.objects.filter((o) => o.id === "billing").map((o) => o.name)).toEqual(["Billing v2"]);
    expect(check(m).filter((p) => p.level === "error")).toEqual([]);
  });
  it("an object's connections are exactly the ones written with it", () => {
    const m = overlay(
      base,
      write(
        "objects:\n  invoices:\n    kind: component\n    name: Invoices\n    in: billing\nconnections:\n  - from: invoices\n    to: api\n",
      ),
    );
    expect(m.connections.filter((c) => c.from === "invoices").map((c) => c.to)).toEqual(["api"]);
    expect(m.connections.some((c) => c.from === "api" && c.to === "db")).toBe(true);
  });
  it("writing the same file twice changes nothing more", () => {
    const w = write(
      "objects:\n  refunds:\n    kind: component\n    name: Refunds\n    in: billing\n",
    );
    const once = overlay(base, w);
    expect(overlay(once, w).objects).toEqual(once.objects);
  });
  it("remove takes what's inside, and the lines to it", () => {
    const m = overlay(base, write(""), ["billing"]);
    expect(m.objects.map((o) => o.id)).toEqual(["shop", "api", "db"]);
    expect(m.connections.map((c) => `${c.from}>${c.to}`)).toEqual(["api>db"]);
  });
});
