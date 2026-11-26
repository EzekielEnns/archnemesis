import { describe, expect, it } from "vitest";
import { changeHeadline, changeList, describeChanges, stateFromFiles } from "./diff.ts";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { emptyState } from "./doc.ts";

const DIR = join(import.meta.dirname, "../examples/shop");
const shopFiles = () => {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n.endsWith(".yaml")) out.set(relative(DIR, p), readFileSync(p, "utf8"));
    }
  };
  walk(DIR);
  return out;
};

describe("describeChanges", () => {
  it("says nothing for the same files", () => {
    const files = shopFiles();
    expect(describeChanges(stateFromFiles(files), stateFromFiles(files))).toEqual([]);
  });

  it("names added, renamed and removed things and summarises moves", () => {
    const a = stateFromFiles(shopFiles());
    const b = stateFromFiles(shopFiles());
    const shop = [...b.objects.values()].find((o) => o.name === "Shop")!;
    const email = [...b.objects.values()].find((o) => o.name === "Email")!;
    b.objects.set(shop.id, { ...shop, name: "Storefront hub" });
    b.objects.delete(email.id);
    for (const [k, c] of b.connections)
      if (c.fromId === email.id || c.toId === email.id) b.connections.delete(k);
    for (const [k, p] of b.placements) if (p.objectId === email.id) b.placements.delete(k);
    b.objects.set("refunds", {
      ...shop,
      id: "refunds",
      key: "refunds",
      name: "Refunds",
      kind: "app",
      parentId: shop.id,
    });
    const p = [...b.placements.entries()].find(([, p]) => p.objectId === shop.id)!;
    b.placements.set(p[0], { ...p[1], x: p[1].x + 40 });
    const out = describeChanges(a, b);
    expect(out).toContain("Renamed Shop to Storefront hub");
    expect(out).toContain("Added app Refunds in Storefront hub");
    expect(
      out.some(
        (l) =>
          l.startsWith("Removed system Email") || (l.startsWith("Removed ") && l.includes("Email")),
      ),
    ).toBe(true);
    expect(out.some((l) => /^Rearranged 1 box on /.test(l))).toBe(true);
  });

  it("treats a design with no files yet as empty", () => {
    expect(describeChanges(emptyState(), stateFromFiles(shopFiles())).length).toBeGreaterThan(5);
  });

  it("leads with the boxes, connections, flows and views, libraries last, under a headline of counts", () => {
    const a = stateFromFiles(shopFiles());
    const b = stateFromFiles(shopFiles());
    const shop = [...b.objects.values()].find((o) => o.name === "Shop")!;
    const t = shop.createdAt;
    // Libraries first in the model, as an import adds them: they still go last.
    for (const n of ["left-pad", "lodash", "zod"])
      b.objects.set(n, { ...shop, id: n, key: n, name: n, kind: "library", parentId: null });
    b.objects.set("refunds", {
      ...shop,
      id: "refunds",
      key: "refunds",
      name: "Refunds",
      kind: "app",
      parentId: shop.id,
    });
    b.diagrams.set("dv", {
      id: "dv",
      key: "refunds-view",
      name: "Refunds view",
      scopeId: "refunds",
      createdAt: t,
      updatedAt: t,
    } as never);
    const list = changeList(a, b);
    const texts = list.map((x) => x.t);
    expect(texts[0]).toBe("Added app Refunds in Shop");
    expect(texts.indexOf("Added view Refunds view")).toBeLessThan(
      texts.indexOf("Added library left-pad"),
    );
    expect(texts.slice(-3).every((x) => x.startsWith("Added library"))).toBe(true);
    expect(changeHeadline(list)).toBe(
      "boxes: 1 added; views: 1 added (Refunds view); libraries: 3 added",
    );
  });
});
