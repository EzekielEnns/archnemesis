// The eight tools on the example shop, through the same core the server and the page use.
import { describe, expect, it } from "vitest";
import { seedOps } from "../seed.ts";
import { keyOps } from "../files.ts";
import { makeNote } from "../model.ts";
import type { Canvas, Designs, Stop, StopReply } from "./host.ts";
import { memHost } from "./memhost.ts";
import { INSTRUCTIONS, PLAYBOOKS } from "./teach.ts";
import { TOOLS, runTool, tool, type ToolName } from "./tools.ts";
import { refList } from "./write.ts";

function shop(o: Parameters<typeof memHost>[0] = {}) {
  const h = memHost({ ops: seedOps(), ...o });
  h.commit(keyOps(h.state()), "keys", { undo: false });
  return h;
}
const call = (
  h: ReturnType<typeof shop>,
  name: ToolName,
  args: Record<string, unknown> = {},
  extra: object = {},
) => runTool(tool(name), { host: h, ...extra }, args);

describe("the tool set", () => {
  it("is eight tools, read-only where it should be, with short instructions", () => {
    expect(TOOLS.map((t) => t.name)).toEqual([
      "read",
      "write",
      "note",
      "show",
      "guide",
      "design",
      "index",
      "feedback",
    ]);
    expect(tool("read").annotations.readOnlyHint).toBe(true);
    expect(tool("guide").annotations.readOnlyHint).toBe(true);
    expect(tool("write").annotations.destructiveHint).toBe(true);
    expect(INSTRUCTIONS.length).toBeLessThanOrEqual(2500);
    for (const k of Object.keys(PLAYBOOKS)) expect(INSTRUCTIONS).toContain(k);
  });
});

describe("read", () => {
  it("with nothing asked, says what the design is and where to go", async () => {
    const r = await call(shop(), "read");
    expect(r.text).toMatch(/^test: .*3 apps/);
    expect(r.text).toContain("shop  Shop (system)");
    expect(r.text).toContain("next: read {q:");
  });

  it("searches, fuzzily, ranked, with refs first", async () => {
    const h = shop();
    expect((await call(h, "read", { q: "checkout" })).text.split("\n")[0]).toMatch(
      /^checkout  Checkout \(component\) in shop-api/,
    );
    expect((await call(h, "read", { q: "chekout" })).text).toContain("checkout  Checkout");
    expect((await call(h, "read", { q: "postgres" })).text).toContain("orders-db");
    expect((await call(h, "read", { q: "zzzz" })).text).toMatch(/nothing matches/);
    const capped = await call(h, "read", { q: "", limit: 3 });
    expect(capped.text).toMatch(/… \d+ more, showing 3: read \{q: "", limit: \d+\}/);
  });

  it("gives one box with its edges as refs, and what to read next", async () => {
    const r = await call(shop(), "read", { ref: "checkout" });
    expect(r.text).toContain("→ payments  charges cards (HTTPS)");
    expect(r.text).toContain("← storefront  places orders (JSON/HTTPS)");
    expect(r.text).toContain('read {ref: "checkout", impact: "upstream"}');
    expect(r.data).toMatchObject({ ref: "checkout", kind: "component" });
  });

  it("reads a connection by a>b, a view, and says what's near for a typo", async () => {
    const h = shop();
    expect((await call(h, "read", { ref: "checkout>payments" })).text).toMatch(
      /^checkout>payments  charges cards \(connection · HTTPS\)/,
    );
    expect((await call(h, "read", { view: "shop-api" })).text).toContain("Shop API [shop-api]");
    const bad = await call(h, "read", { ref: "chekout" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("read {q:");
  });

  it("walks as a tree, and computes impact and routes", async () => {
    const h = shop();
    const w = await call(h, "read", { ref: "storefront", depth: 2 });
    expect(w.text).toMatch(/^storefront[^\n]*\n {2}→ \w+/);
    expect(w.text).toContain("    → orders-db");
    const up = await call(h, "read", { ref: "orders-db", impact: "upstream" });
    expect(up.text).toMatch(/orders-db: 5 things depend on it/);
    expect(up.data).toMatchObject({ count: 5 });
    const r = await call(h, "read", { from: "customer", to: "payments" });
    expect(r.text).toContain("checkout → payments");
  });

  it("slices a scope under a budget: the scope, neighbours as contracts, the rest as names", async () => {
    const h = shop();
    const s = (await call(h, "read", { scope: "shop-api" })).text;
    expect(s).toMatch(/# scope shop-api/);
    expect(s).toMatch(/# neighbours \(6\), as contracts/);
    expect(s).toMatch(/# the rest/);
    const tight = (await call(h, "read", { scope: "shop-api", budget: 200 })).text;
    expect(tight).toMatch(/over the budget of 200 tokens/);
    expect(tight.length).toBeLessThan(s.length);
  });

  it("has lenses", async () => {
    const h = shop();
    expect((await call(h, "read", { lens: "spof" })).text).toContain("orders-db (store)");
    expect((await call(h, "read", { lens: "cycles" })).text).toMatch(
      /^cycles: none. Nothing calls round in a loop. \(checked \d+ boxes, \d+ connections, \d+ views\)$/,
    );
    expect((await call(h, "read", { lens: "problems" })).text).toMatch(/0 errors/);
    expect((await call(h, "read", { lens: "hotspots" })).text).toContain("orders-db");
  });

  it("reads files and history", async () => {
    const h = shop();
    expect((await call(h, "read", { file: "*" })).text).toContain("model/shop.yaml");
    expect((await call(h, "read", { file: "model/shop.yaml" })).text).toContain(
      "objects:\n  shop:",
    );
    expect((await call(h, "read", { history: true })).text).toContain("keys");
  });
});

describe("write", () => {
  const frag = `objects:
  billing: {kind: app, in: shop, tech: [Go], context: Charges orders.}
  checkout: {context: Takes the order and pays.}
entities:
  Invoice: {in: billing, fields: {id: uuid, total: Money}}
connections:
  - {from: checkout, to: billing, label: bills the order, tech: HTTPS, carries: [Invoice]}
  - {from: checkout, to: payments, tech: gRPC}
`;

  it("dry-runs: says what would change, changes nothing", async () => {
    const h = shop();
    const r = await call(h, "write", { yaml: frag, dry_run: true });
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain("+ billing (app) in shop");
    expect(r.text).toContain("~ checkout: context");
    expect(r.text).toContain("~ checkout>payments charges cards: tech");
    expect(r.text).toContain("+ entity Invoice");
    expect(h.index().objects.size).toBe(15);
  });

  it("merges by id: fields written change, the rest stay, nothing left out is deleted", async () => {
    const h = shop();
    const before = h.index().connections.size;
    const r = await call(h, "write", { yaml: frag });
    expect(r.text).toMatch(/^Written/);
    const idx = h.index();
    const checkout = [...idx.objects.values()].find((o) => o.key === "checkout")!;
    expect(checkout.kind).toBe("component");
    expect(checkout.description).toBe("Takes the order and pays.");
    expect(idx.connections.size).toBe(before + 1);
    const pay = [...idx.connections.values()].find(
      (c) => c.fromId === checkout.id && idx.objects.get(c.toId)?.key === "payments",
    )!;
    expect(pay.technology).toBe("gRPC");
    expect(pay.name).toBe("charges cards");
    expect([...idx.entities.values()].map((e) => e.name)).toContain("Invoice");
  });

  it("gives every error at once, with the nearest id, and writes nothing", async () => {
    const h = shop();
    const r = await call(h, "write", {
      yaml: "objects:\n  billing: {kind: ap, in: shopp}\nconnections:\n  - {from: checkout, to: biling}\n",
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Not written: \d errors/);
    expect(r.text).toContain("did you mean app?");
    expect(r.text).toContain("did you mean billing?");
    expect(r.text).toContain("For example:");
    expect(h.index().objects.size).toBe(15);
  });

  it("refuses what the grammar refuses: anchors, unknown sections", async () => {
    const h = shop();
    expect(
      (await call(h, "write", { yaml: "objects:\n  a: &x {kind: app}\n  b: *x\n" })).text,
    ).toMatch(/anchors|aliases/);
    expect((await call(h, "write", { yaml: "nope: [shop]\n" })).text).toContain(
      "`nope` isn't part of a fragment",
    );
  });

  it("reads remove loosely: in the yaml, a list in a string, refs split by commas", async () => {
    expect(refList("[view:a, view:b]")).toEqual(["view:a", "view:b"]);
    expect(refList('["a", "b>c:two words"]')).toEqual(["a", "b>c:two words"]);
    expect(refList("a, b,c")).toEqual(["a", "b", "c"]);
    expect(refList("checkout>payments:charges cards, then emails")).toEqual([
      "checkout>payments:charges cards, then emails",
    ]);
    expect(refList(["x", "y, z"])).toEqual(["x", "y", "z"]);
    const h = shop();
    const r = await call(h, "write", {
      yaml: 'remove: [view:shop-api]\nobjects:\n  catalog: {context: "Lists products."}',
      remove: "view:shop",
    });
    expect(r.isError).toBeFalsy();
    // A removed view takes its layout with it: no "this layout is unused" warning.
    expect(r.text).not.toContain("layout is unused");
    const keys = [...h.index().diagrams.values()].map((d) => d.key);
    expect(keys).not.toContain("shop-api");
    expect(keys).not.toContain("shop");
    await call(h, "write", { yaml: "objects:\n  x1: {kind: actor}\n  x2: {kind: actor}" });
    expect((await call(h, "write", { remove: "[x1, x2]" })).isError).toBeFalsy();
    expect([...h.index().objects.values()].some((o) => o.key === "x1" || o.key === "x2")).toBe(
      false,
    );
  });

  it("removes boxes (with what's inside), connections and entities", async () => {
    const h = shop();
    await call(h, "write", { yaml: frag });
    const r = await call(h, "write", { remove: ["checkout>warehouse", "Invoice", "billing"] });
    expect(r.isError).toBeUndefined();
    const idx = h.index();
    expect([...idx.objects.values()].some((o) => o.key === "billing")).toBe(false);
    expect(
      [...idx.connections.values()].some((c) => idx.objects.get(c.toId)?.key === "warehouse"),
    ).toBe(false);
    expect((await call(h, "write", { remove: ["nope"] })).text).toContain("no box has the id nope");
  });

  it("keeps a scoped write inside its scope", async () => {
    const h = shop();
    const r = await call(h, "write", {
      scope: "shop-api",
      yaml: "objects:\n  worker: {context: nope}\n  cart: {context: Holds the basket.}\n",
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/worker \(already a box, in .*, outside shop-api/);
    expect(r.text).toContain("claim");
    const ok = await call(h, "write", {
      scope: "shop-api",
      yaml: "objects:\n  cart: {context: Holds the basket.}\n  basket-store: {kind: component, in: shop-api}\n",
    });
    expect(ok.isError).toBeUndefined();
  });

  it("undoes the agent's own last change", async () => {
    const h = shop();
    await call(h, "write", { yaml: "objects:\n  billing: {kind: app, in: shop}\n" });
    expect((await call(h, "write", { undo: true })).text).toMatch(/^Undone/);
    expect([...h.index().objects.values()].some((o) => o.key === "billing")).toBe(false);
  });

  it("tidies a view after", async () => {
    const h = shop();
    const r = await call(h, "write", { tidy: "shop-api" });
    expect(r.text).toMatch(/tidied shop-api|already laid out/);
  });

  it("can't write without the right", async () => {
    const h = shop({ canEdit: false });
    expect((await call(h, "write", { yaml: "objects:\n  x: {kind: app}\n" })).isError).toBe(true);
    expect((await call(h, "write", { undo: true })).isError).toBe(true);
  });
});

// From the review of mcp-v2 (each a case that went wrong).
describe("write, reviewed", () => {
  const has = (h: ReturnType<typeof shop>, key: string) =>
    [...h.index().objects.values()].some((o) => o.key === key);

  it("undo with dry_run only says what it would take back, and says what it took back", async () => {
    const h = shop();
    await call(h, "write", {
      yaml: "objects:\n  zz: {kind: app, in: shop}\nconnections:\n  - {from: checkout, to: zz, label: pings}\n",
    });
    expect((await call(h, "write", { undo: true, dry_run: true })).text).toBe(
      "Dry run, nothing changed. Undo would take back: wrote 1 box, 1 connection.",
    );
    expect(has(h, "zz")).toBe(true);
    expect((await call(h, "write", { undo: true })).text).toBe(
      "Undone: wrote 1 box, 1 connection.",
    );
    expect(has(h, "zz")).toBe(false);
  });

  it("keeps notes out of write's undo", async () => {
    const h = shop();
    await call(h, "write", { yaml: "objects:\n  zz: {kind: app, in: shop}\n" });
    await call(h, "note", { about: "checkout", text: "Who owns this?" });
    expect((await call(h, "write", { undo: true })).text).toBe("Undone: wrote 1 box.");
    expect(has(h, "zz")).toBe(false);
    expect([...h.index().notes.values()].some((n) => n.text === "Who owns this?")).toBe(true);
    expect((await call(h, "write", { undo: true })).text).toMatch(/^Nothing of yours to undo/);
  });

  it("scope: a move needs both ends inside; removing views and entities is checked like writing them; tidy too", async () => {
    const h = shop();
    const move = await call(h, "write", {
      scope: "payments",
      yaml: "objects:\n  checkout: {in: payments}",
      dry_run: true,
    });
    expect(move.isError).toBe(true);
    expect(move.text).toContain("checkout");
    expect(
      (
        await call(h, "write", {
          scope: "checkout",
          yaml: "objects:\n  checkout: {in: payments}",
          dry_run: true,
        })
      ).text,
    ).toContain("moving checkout");
    await call(h, "write", {
      yaml: "entities:\n  Inv: {in: shop-api, fields: {id: uuid}}\nviews:\n  pay: {name: Pay, scope: payments}",
    });
    expect(
      (await call(h, "write", { scope: "payments", remove: ["Inv"], dry_run: true })).text,
    ).toContain("removing entity Inv");
    expect(
      (await call(h, "write", { scope: "checkout", remove: ["view:pay"], dry_run: true })).text,
    ).toContain("removing view pay");
    expect(
      (await call(h, "write", { scope: "checkout", tidy: "pay", dry_run: true })).text,
    ).toContain("tidy pay (a view not about checkout)");
    // Inside is fine.
    expect(
      (
        await call(h, "write", {
          scope: "shop-api",
          yaml: "objects:\n  checkout: {in: cart}",
          dry_run: true,
        })
      ).isError,
    ).toBeFalsy();
  });

  it("a bad tidy view stops the whole write before anything changes", async () => {
    const h = shop();
    const r = await call(h, "write", {
      yaml: "objects:\n  q1: {kind: app, in: shop}",
      tidy: "nope",
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("tidy: no view nope");
    expect(has(h, "q1")).toBe(false);
  });

  it("tidy is part of the write's step: one undo, one history line", async () => {
    const h = shop();
    const before = h.recent!(100).length;
    const r = await call(h, "write", {
      yaml: "objects:\n  q1: {kind: component, in: shop-api}\nviews:\n  shop-api: {boxes: [catalog, cart, checkout, q1]}",
      tidy: "shop-api",
    });
    expect(r.isError).toBeFalsy();
    expect(h.recent!(100).length - before).toBe(1);
    expect((await call(h, "write", { undo: true })).text).toMatch(/^Undone: wrote 1 box/);
    expect(has(h, "q1")).toBe(false);
    expect((await call(h, "write", { undo: true })).text).toMatch(/^Nothing of yours/);
  });

  it("edits a library where it lives (libraries.yaml)", async () => {
    const h = shop();
    await call(h, "write", {
      yaml: "objects:\n  lodash: {kind: library, in: shop-api, package: {ecosystem: npm, name: lodash, version: 4.17.21}}",
    });
    const r = await call(h, "write", { yaml: "objects:\n  lodash: {context: Utilities.}" });
    expect(r.text).toContain("~ lodash: context");
    expect((await call(h, "read", { file: "libraries.yaml" })).text).toContain("Utilities.");
  });

  it("asks for the label when two connections share the ends, on remove and on write", async () => {
    const h = shop();
    await call(h, "write", {
      yaml: "connections:\n  - {from: checkout, to: payments, label: second}",
    });
    const rm = await call(h, "write", { remove: ["checkout>payments"] });
    expect(rm.isError).toBe(true);
    expect(rm.text).toContain("checkout>payments:charges cards, checkout>payments:second");
    const add = await call(h, "write", {
      yaml: "connections:\n  - {from: checkout, to: payments, tech: X}",
    });
    expect(add.isError).toBe(true);
    expect(add.text).toContain("say which with its label");
    expect((await call(h, "write", { remove: "checkout>payments:second" })).text).toContain(
      "- checkout>payments",
    );
  });

  it("names each kind by its own namespace: a view and a box can share an id", async () => {
    const h = shop();
    // shop-api is a box and a view.
    const r = await call(h, "write", { remove: ["view:shop-api"] });
    expect(r.isError).toBeFalsy();
    expect(has(h, "shop-api")).toBe(true);
    expect([...h.index().diagrams.values()].some((d) => d.key === "shop-api")).toBe(false);
    await call(h, "write", { yaml: "views:\n  extra: {name: Extra, scope: shop}" });
    expect((await call(h, "write", { remove: ["extra"] })).text).toContain("remove view:extra");
    await call(h, "write", { yaml: "views:\n  extra: null" });
    expect([...h.index().diagrams.values()].some((d) => d.key === "extra")).toBe(false);
    await call(h, "write", {
      yaml: "decisions:\n  0001-x: {title: X, status: proposed, affects: [shop]}",
    });
    expect((await call(h, "write", { remove: ["decision:0001-x"] })).isError).toBeFalsy();
    expect(h.index().decisions.size).toBe(0);
  });

  it("counts the entities it defined, and says which are TBD", async () => {
    const h = shop();
    const r = await call(h, "write", {
      yaml: "objects:\n  billing: {kind: app, in: shop}\nconnections:\n  - {from: checkout, to: billing, label: bills, carries: [Invoice, Receipt]}\nentities:\n  Invoice: {in: billing, fields: {id: uuid, total: Money}}",
    });
    expect(r.text).toContain("+ entity Invoice");
    expect(r.text).toContain("Receipt (TBD");
    expect(h.recent!(1)[0]!.label).toBe("wrote 1 box, 1 connection, 1 entity");
  });

  it("takes one value where a list goes", async () => {
    const h = shop();
    expect((await call(h, "read", { ref: "checkout", follow: "calls" })).text).toContain(
      "→ payments",
    );
    expect(
      (await call(h, "write", { remove: "checkout>warehouse", dry_run: true })).text,
    ).toContain("- checkout>warehouse");
  });
});

describe("read, reviewed", () => {
  const big = async () => {
    const h = shop();
    let y = "objects:\n  big: {kind: app, in: shop}\n";
    for (let i = 0; i < 300; i++) y += `  c${i}: {kind: component, in: big}\n`;
    y += "connections:\n";
    for (let i = 0; i < 299; i++) y += `  - {from: c${i}, to: c${i + 1}, label: calls ${i}}\n`;
    y += "views:\n  bigv: {name: Big, scope: big, include: [{children: big}]}\n";
    await call(h, "write", { yaml: y });
    return h;
  };

  it("caps files, views and routes, and says how to get the rest", async () => {
    const h = await big();
    const f = await call(h, "read", { file: "model/shop.yaml" });
    expect(f.text).toMatch(/^--- model\/shop\.yaml \(lines 1-200 of \d+\)/);
    expect(f.text).toContain('read {file: "model/shop.yaml", from: 201}');
    expect((await call(h, "read", { file: "model/shop.yaml", from: 201 })).text).toMatch(
      /\(lines 201-/,
    );
    const v = await call(h, "read", { view: "bigv" });
    expect(v.text.split("\n").length).toBeLessThan(120);
    expect(v.text).toMatch(/more lines, showing 60/);
    const p = await call(h, "read", { from: "c0", to: "c299" });
    expect(p.text.split("\n").length).toBeLessThan(30);
    expect(p.text).toMatch(/hops in between/);
  });

  it("caps an entity's fields and a box's references", async () => {
    const h = shop();
    const fields = Array.from({ length: 80 }, (_, i) => `f${i}: string`).join(", ");
    await call(h, "write", { yaml: `entities:\n  Wide: {in: shop-api, fields: {${fields}}}` });
    const r = await call(h, "read", { ref: "Wide" });
    expect(r.text).toContain("fields (80):");
    expect(r.text).toContain("… 40 more");
  });

  it("shows views as view:<key>, reads that, and explains a broken connection ref", async () => {
    const h = shop();
    expect((await call(h, "read", { q: "shop" })).text).toContain("view:shop-api  Shop API (view");
    expect((await call(h, "read", { ref: "view:shop-api" })).text).toContain("open: archnm://");
    const bad = await call(h, "read", { ref: "a>" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("isn't a connection ref");
    expect((await call(h, "read", { view: "nope" })).text).toContain("no view nope");
    expect((await call(h, "read", { ref: "checkout>payments:nolabel" })).text).toContain(
      "there is checkout>payments:charges cards",
    );
  });
});

describe("write, twice the same", () => {
  it("removes one of two connections nothing tells apart, and reads them as one", async () => {
    const h = shop();
    const yaml = "connections:\n  - {from: checkout, to: payments, label: twin}\n";
    await call(h, "write", { yaml });
    const before = [...h.index().connections.values()].filter((c) => c.name === "twin");
    expect(before).toHaveLength(1);
    h.commit([{ op: "connection.put", connection: { ...before[0]!, id: "c_twin2" } }], "a twin");
    expect((await call(h, "read", { ref: "checkout>payments:twin" })).isError).toBeFalsy();
    const out = await call(h, "write", { remove: ["checkout>payments:twin"] });
    expect(out.isError).toBeFalsy();
    expect([...h.index().connections.values()].filter((c) => c.name === "twin")).toHaveLength(1);
  });

  it("applies a dry run without printing its changes again", async () => {
    const h = shop();
    const yaml = "objects:\n  ledger: {kind: store, in: shop, name: Ledger}\n";
    const dry = await call(h, "write", { yaml, dry_run: true });
    expect(dry.text).toContain("ledger");
    const out = await call(h, "write", { apply: dry.data!.apply });
    expect(out.isError).toBeFalsy();
    expect(out.text).toContain("of changes the dry run listed");
    expect(out.text.length).toBeLessThan(dry.text.length);
    expect(
      h.index().objects.has("ledger") ||
        [...h.index().objects.values()].some((o) => o.key === "ledger"),
    ).toBe(true);
  });
});

describe("note", () => {
  it("adds a note where the box is drawn, replies, resolves, lists", async () => {
    const h = shop();
    const add = await call(h, "note", { text: "Is this the only writer?", about: "orders-db" });
    expect(add.text).toMatch(/^Left a note n/);
    const id = add.data!.note as string;
    await call(h, "note", { action: "reply", note: id, text: "No: the worker too." });
    const list = await call(h, "note", { action: "list" });
    expect(list.text).toContain(`${id} note on orders-db`);
    expect(list.text).toContain("    Test agent: No: the worker too.");
    expect(list.text).not.toContain("A whole thread");
    await call(h, "note", { action: "resolve", note: id });
    expect((await call(h, "note", { action: "list" })).text).toMatch(/^no open notes/);
  });

  it("says where a note pinned to nothing sits, and what one inside an opened box is about", async () => {
    const h = shop();
    const idx = h.index();
    const [viewId, placed] = [...idx.placements].find(([, m]) => m.size > 1)!;
    const [boxId, at] = [...placed][0]!;
    const view = idx.diagrams.get(viewId)!;
    const box = idx.objects.get(boxId)!;
    const other = [...idx.objects.values()].find((o) => !placed.has(o.id))!;
    const author = { id: "ts:zeek", name: "Zeek", kind: "human" as const };
    const base = { diagramId: viewId, kind: "note" as const, author };
    h.commit(
      [
        // Dropped over a box without pinning it.
        { op: "note.put", note: makeNote({ ...base, text: "over it", x: at.x + 5, y: at.y + 5 }) },
        // Far from everything.
        { op: "note.put", note: makeNote({ ...base, text: "nowhere", x: -90000, y: -90000 }) },
        // On a box drawn inside one opened in place: about it, pinned to nothing.
        { op: "note.put", note: makeNote({ ...base, text: "inner", about: other.id }) },
      ],
      "notes",
    );
    const text = (await call(h, "note", { action: "list" })).text;
    const key = view.key ?? view.id;
    expect(text).toMatch(
      new RegExp(`note loose on ${key}, over ${box.key ?? box.id} Zeek: over it`),
    );
    expect(text).toMatch(new RegExp(`note loose on ${key} Zeek: nowhere`));
    expect(text).toMatch(new RegExp(`note on ${other.key ?? other.id} Zeek: inner`));
  });

  it("prints threads whole when they fit, and cut short with the latest reply when they don't", async () => {
    const h = shop();
    const long = "word ".repeat(300).trim();
    const add = await call(h, "note", { text: long, about: "orders-db" });
    await call(h, "note", { action: "reply", note: add.data!.note, text: "first" });
    await call(h, "note", { action: "reply", note: add.data!.note, text: "second" });
    const whole = (await call(h, "note", { action: "list" })).text;
    expect(whole).toContain(long);
    expect(whole).toContain("    Test agent: first");
    for (let i = 0; i < 5; i++) await call(h, "note", { text: long, about: "orders-db" });
    const cut = (await call(h, "note", { action: "list" })).text;
    expect(cut).not.toContain(long);
    expect(cut).toContain("latest, Test agent: second");
    expect(cut).toContain("A whole thread: read");
  });

  it("leaves claims and flags for agents", async () => {
    const h = shop();
    await call(h, "note", {
      about: "payments",
      claim: { field: "tech", value: "Stripe, Adyen", evidence: "shop:src/pay.go:12" },
    });
    const flags = await call(h, "note", { action: "list", flags: true });
    expect(flags.text).toContain("flag on payments");
    expect(flags.text).toContain("claim: tech = Stripe, Adyen");
    expect((await call(h, "read", { lens: "flags" })).text).toContain(
      "evidence: shop:src/pay.go:12",
    );
  });
});

describe("show", () => {
  const fake = (replies: (StopReply | null)[]) => {
    const shown: Stop[] = [];
    let ended = false;
    const canvas: Canvas = {
      show: async (s) => (shown.push(s), replies.shift() ?? null),
      end: () => void (ended = true),
      here: () => ({ diagram: null, selection: [] }),
    };
    return { canvas, shown, ended: () => ended };
  };

  it("opens a box on its view, and spotlights several", async () => {
    const f = fake([]);
    const h = shop({ canvas: f.canvas });
    await call(h, "show", { open: "checkout", say: "Here" });
    const shopApi = [...h.index().diagrams.values()].find((d) => d.key === "shop-api")!;
    expect(f.shown[0]).toMatchObject({ diagram: shopApi.id, say: "Here" });
    await call(h, "show", { spotlight: ["cart", "checkout"] });
    expect(f.shown[1]!.objects).toHaveLength(2);
  });

  it("tours: holds through Next, comes back with a question, ends", async () => {
    const f = fake([{ action: "next" }, { action: "ask", text: "Why Postgres?" }]);
    const h = shop({ canvas: f.canvas });
    const steps = [
      { ref: "storefront", say: "Start" },
      { ref: "checkout", say: "Then" },
      { ref: "orders-db", say: "Last" },
    ];
    const r = await call(h, "show", { tour: steps });
    expect(r.text).toContain("At step 2 they asked: Why Postgres?");
    expect(r.text).toContain("at: 1");
    const g = fake([{ action: "next" }, { action: "next" }]);
    const h2 = shop({ canvas: g.canvas });
    expect((await call(h2, "show", { tour: steps, at: 1 })).text).toBe("Tour done: all 3 steps.");
    expect(g.shown[0]!.say).toBe("Then (2/3)");
    expect(g.ended()).toBe(true);
  });

  it("without a canvas, says to send a link", async () => {
    expect((await call(shop(), "show", { open: "checkout" })).text).toMatch(/no canvas/);
  });

  it("reads here from the canvas", async () => {
    const h = shop();
    const d = [...h.index().diagrams.values()].find((x) => x.key === "shop-api")!;
    const checkout = [...h.index().objects.values()].find((o) => o.key === "checkout")!;
    h.canvas = {
      show: async () => null,
      end: () => {},
      here: () => ({
        diagram: d.id,
        selection: [checkout.id],
        recent: ["open shop", "open shop-api"],
      }),
    };
    const r = await call(h, "read", { here: true });
    expect(r.text).toContain("view: shop-api");
    expect(r.text).toContain("checkout  Checkout (component)");
    expect(r.text).toContain('next: read {ref: "checkout"}');
  });
});

describe("guide", () => {
  it("lists topics, gives the grammar, field sections, playbooks and the app", async () => {
    const g = (topic?: string) => runTool(tool("guide"), {}, topic ? { topic } : {});
    expect((await g()).text).toContain("grammar");
    expect((await g("grammar")).text).toContain("objects:");
    expect((await g("grammar")).text).toContain("Rules agents get wrong");
    expect((await g("connections")).text).toMatch(/^### Connections/);
    expect((await g("map")).text).toContain("read {scope");
    expect((await g("keys")).text.length).toBeGreaterThan(50);
    expect((await g("nope")).isError).toBe(true);
  });
});

describe("design", () => {
  it("lists, and the page can't delete or discard", async () => {
    const designs: Designs = {
      list: () => [{ key: "shop", name: "Shop", objects: 15, views: 3, url: "u" }],
      delete: async () => "gone",
      discard: async () => "gone",
    };
    expect((await runTool(tool("design"), { designs }, {})).text).toContain(
      "shop  Shop · 15 boxes",
    );
    expect(
      (await runTool(tool("design"), { designs, page: true }, { action: "delete", key: "shop" }))
        .isError,
    ).toBe(true);
    expect(
      (await runTool(tool("design"), { designs }, { action: "delete", key: "shop" })).text,
    ).toBe("gone");
  });

  it("create says first where writes go (a fork, when it follows git), and the view it starts with", async () => {
    const designs: Designs = {
      list: () => [],
      create: async () => ({
        key: "delivery",
        name: "Delivery",
        url: "u",
        writesTo: { key: "delivery@agent-zeek", url: "f" },
        views: [{ key: "landscape", rules: true }],
      }),
    };
    const t = (
      await runTool(tool("design"), { designs }, { action: "create", name: "Delivery" })
    ).text.split("\n");
    expect(t[1]).toMatch(/^It follows git, so your writes go to your fork delivery@agent-zeek/);
    expect(t[2]).toContain("one view: landscape (follows rules");
    expect(t[2]).toContain("boxes: [...]");
  });
});

// From a Sonnet session against the server (failed writes it hit).
describe("write, from a real session", () => {
  it("says once per line that prose in {…} needs quotes, for a comma and for a colon", async () => {
    const h = shop();
    const r = await call(h, "write", {
      yaml: "objects:\n  customer: {kind: actor, context: Hungry person who browses menus, places and pays for orders, and tracks delivery.}\n  platform: {kind: system, context: The platform: takes orders, matches couriers.}\n  rider: {kind: actor, context: Fast, cheap.}",
    });
    expect(r.isError).toBe(true);
    const errs = r.text.split("\n").filter((l) => l.startsWith("error:"));
    expect(errs).toEqual([
      'error: yaml:3: context: the text has a colon inside {…} (The platform: takes orders, matches couriers.): quote it (context: "The platform: takes orders, matches couriers.") or write the box as a block',
      'error: yaml:2: context: the text has a comma inside {…}, so "places and pays for orders" reads as a field of its own: quote it (context: "Hungry person who browses menus, places and pays for orders, and tracks deliver…") or write the box as a block',
      'error: yaml:4: context: the text has a comma inside {…}, so "cheap." reads as a field of its own: quote it (context: "Fast, cheap.") or write the box as a block',
    ]);
    // Block style, any text field: the field and the fix, from the line.
    const block = await call(h, "write", {
      yaml: "views:\n  server:\n    name: Server: the HTTP edge\n    scope: platform",
    });
    expect(block.text).toContain(
      'error: yaml:3: name: the text has a colon in it (Server: the HTTP edge), which YAML reads as a key: quote it (name: "Server: the HTTP edge")',
    );
    const label = await call(h, "write", {
      yaml: "connections:\n  - {from: customer, to: platform, label: Orders: and pays}",
    });
    expect(label.text).toContain("label: the text has a colon inside {…} (Orders: and pays)");
    expect(
      (
        await call(h, "write", {
          yaml: 'objects:\n  customer: {kind: actor, context: "Hungry: browses, orders, pays."}',
        })
      ).isError,
    ).toBeFalsy();
  });

  it("translates the YAML library's other messages", async () => {
    const r = await call(shop(), "write", { yaml: "objects:\n  a: {kind: app\n" });
    expect(r.text).toMatch(/error: yaml:\d: (something isn't closed|the indentation is off)/);
    expect(r.text).not.toContain("(YAML)");
    expect(r.text).not.toMatch(/flow collection|Expected/);
  });

  it("teaches context quoted or in block style, never bare in {…}", () => {
    const bare = /\{[^}"]*context: [A-Za-z][^"}]*\}/;
    expect(tool("write").description).not.toMatch(bare);
    for (const t of [INSTRUCTIONS, ...Object.values(PLAYBOOKS).map((p) => p.text)])
      expect(t).not.toMatch(bare);
  });

  it("switches a view between rules and boxes when one is written", async () => {
    const h = shop();
    await call(h, "write", { yaml: "views:\n  tops: {name: Tops, include: [{kind: system}]}" });
    const r = await call(h, "write", { yaml: "views:\n  tops: {boxes: [shop, payments]}" });
    expect(r.isError).toBeFalsy();
    const d = [...h.index().diagrams.values()].find((x) => x.key === "tops")!;
    expect(d.rules).toBeFalsy();
    expect(h.index().placements.get(d.id)?.size).toBe(2);
    expect(
      (await call(h, "write", { yaml: "views:\n  tops: {include: [{kind: actor}]}" })).isError,
    ).toBeFalsy();
    expect([...h.index().diagrams.values()].find((x) => x.key === "tops")!.rules).toBeTruthy();
  });

  it("explains a tidy that moves nothing", async () => {
    const h = shop();
    await call(h, "write", { tidy: "shop-api", direction: "down" });
    const r = await call(h, "write", { tidy: "shop-api", direction: "down" });
    expect(r.text).toMatch(
      /shop-api: nothing moved: it's already laid out down .*direction: "right"/,
    );
  });

  it("leads with the boxes still inside a box being removed", async () => {
    const r = await call(shop(), "write", { remove: ["shop-api"] });
    expect(r.isError).toBe(true);
    expect(r.text.split("\n")[1]).toBe(
      "error: remove: removing shop-api takes the 3 boxes inside it too (cart, catalog, checkout), and something below still names them: keep any by moving it out first (objects: {cart: {in: <another box>}}), and take the rest off the views and lines below",
    );
  });
});

describe("index", () => {
  it("needs the server, and imports through the host when it has one", async () => {
    const h = shop();
    expect((await call(h, "index", { action: "start" })).isError).toBe(true);
    h.indexer = {
      start: () => "run this",
      scan: () => "found",
      importPlan: () => ({ ops: [], summary: "0 new", label: "import" }),
      progress: () => {},
    };
    expect((await call(h, "index", { action: "start" })).text).toBe("run this");
    expect(
      (await call(h, "index", { action: "import", ticket: "t", under: "shop-api" })).text,
    ).toBe("Nothing to change: 0 new");
  });
});

describe("empty answers say what was checked; a view says how it's defined", () => {
  it("a lens with nothing found says what it looked at", async () => {
    const r = await call(shop(), "read", { lens: "flags" });
    expect(r.text).toMatch(/^flags: none\. .* \(checked \d+ boxes, \d+ connections, \d+ views\)$/);
    const m = await call(shop(), "read", { lens: "mismatches", ref: "payments" });
    expect(m.text).toMatch(/\(checked \d+ box(es)?, \d+ connections?, \d+ views? in payments\)$/);
  });

  it("a search with no hits says what it searched and the nearest names", async () => {
    const r = await call(shop(), "read", { q: "zzzqqqxx" });
    expect(r.text).toMatch(
      /^nothing matches "zzzqqqxx" \(searched \d+ boxes, \d+ entities and \d+ views\)\. Nearest names: [\w-]+(, [\w-]+){4}\./,
    );
  });

  it("read view gives how it reads, boxes, arrows, and its definition as written", async () => {
    const h = shop();
    const t = (await call(h, "read", { view: "shop-api" })).text;
    expect(t).toMatch(/^reads as: \d+ boxes, \d+ lines, \d+ crossings?/m);
    expect(t).toContain("arrows:");
    expect(t).toMatch(
      /^definition \(hand-picked; views\/shop-api\.yaml\): views: \{shop-api: \{scope: shop-api, boxes: \[/m,
    );
    await call(h, "write", { yaml: "views:\n  people: {name: People, include: [{kind: actor}]}" });
    expect((await call(h, "read", { view: "people" })).text).toContain(
      "definition (follows rules; views/people.yaml): views: {people: {include: [{kind: actor}]}}",
    );
    await call(h, "write", {
      yaml: "views:\n  nobody: {name: Nobody, include: [{tag: nothing-has-this}]}",
    });
    expect((await call(h, "read", { view: "nobody" })).text).toContain(
      "no boxes yet: its rules match nothing in the model",
    );
  });

  it("the guide's views section promises what read view gives", async () => {
    const g = (await call(shop(), "guide", { topic: "views" })).text;
    const t = (await call(shop(), "read", { view: "shop" })).text;
    expect(g).toContain("how it reads (boxes, lines, crossings)");
    for (const part of [
      "reads as:",
      "boxes (",
      "arrows:",
      "definition (",
      "why each box is there:",
    ])
      expect(t).toContain(part);
  });
});

// From trial 2: nesting, scoped views, the lines a frame lost.
describe("views and nesting", () => {
  const svc = `objects:
  customer: {kind: actor}
  platform: {kind: system}
  gateway: {kind: app, in: platform}
  ordering: {kind: app, in: platform}
  dispatch: {kind: app, in: platform}
  orders-db: {kind: store, in: ordering}
  dispatch-db: {kind: store, in: dispatch}
  maps: {kind: system, external: true}
connections:
  - {from: customer, to: gateway, label: orders}
  - {from: gateway, to: ordering, label: places}
  - {from: ordering, to: orders-db, label: saves}
  - {from: ordering, to: dispatch, label: asks for a courier}
  - {from: dispatch, to: dispatch-db, label: saves}
  - {from: dispatch, to: maps, label: routes}
`;
  const host = async (views: string) => {
    const h = memHost({});
    const r = await runTool(tool("write"), { host: h }, { yaml: `${svc}views:\n${views}` });
    expect(r.isError, r.text).toBeFalsy();
    return h;
  };
  const read = async (h: ReturnType<typeof memHost>, view: string) =>
    (await runTool(tool("read"), { host: h }, { view })).text;

  // Trial 5: a box beside its own insides drew callers to the box and its parts floating.
  it("a box with lines of its own is a frame around its insides, and its lines end on the frame", async () => {
    const h = await host(
      "  inside: {name: Inside, scope: platform, boxes: [gateway, ordering, dispatch, orders-db, dispatch-db]}",
    );
    const t = await read(h, "inside");
    expect(t).toContain("reads as: 3 boxes, 2 lines");
    expect(t).toContain(
      "frames (boxes drawn around their insides; their own lines end on the frame): platform (the view's scope), dispatch, ordering",
    );
    expect(t).toContain('gateway → ordering "places"');
    expect(t).toContain('ordering → dispatch "asks for a courier"');
    // A box's line into itself can't be drawn: said, with what to do.
    expect(t).toMatch(
      /not drawn \(a box's line to what's inside it; model it from the part that does it.*\): ordering → orders-db "saves", dispatch → dispatch-db "saves"/,
    );
  });

  it("a box with no lines of its own is still a frame around its insides", async () => {
    const h = await host("  all: {name: All, boxes: [platform, gateway, ordering]}");
    expect(await read(h, "all")).toContain("reads as: 2 boxes, 1 line");
  });

  it("a view with a scope and nothing else gets the scope's children and neighbours, and its own lines", async () => {
    const h = await host("  ordering: {name: Ordering, scope: ordering}");
    const t = await read(h, "ordering");
    expect(t).toContain("follows the model");
    for (const b of ["orders-db", "gateway", "dispatch"])
      expect(t).toMatch(new RegExp(`^  ${b}  `, "m"));
    // The scope is the frame, and its own lines end on it.
    expect(t).not.toMatch(/^  ordering  /m);
    expect(t).toContain("ordering (the view's scope)");
    expect(t).toContain('gateway → ordering "places"');
  });

  it("a scoped view with rules draws its own lines to its frame", async () => {
    const h = await host(
      "  dispatch: {name: Dispatch, scope: dispatch, include: [{children: dispatch}, {neighbours: dispatch}]}",
    );
    const t = await read(h, "dispatch");
    expect(t).toContain('dispatch → maps "routes"');
    expect(t).toContain('ordering → dispatch "asks for a courier"');
    expect(t).toContain("not drawn (a box's line to what's inside it");
  });

  it("boxes: [] stays an empty hand-picked view", async () => {
    const h = await host("  none: {name: None, scope: ordering, boxes: []}");
    expect(await read(h, "none")).toContain("hand-picked");
  });
});

describe("a connection's label with a comma", () => {
  it("is read whole when it can only mean one thing", async () => {
    const h = shop();
    const r = await call(h, "write", {
      yaml: "connections:\n  - {from: checkout, to: payments, label: charges cards, then emails the receipt, tech: HTTPS}\n  - {from: cart, to: catalog, label: reads prices, stock}",
    });
    expect(r.isError, r.text).toBeFalsy();
    const labels = [...h.index().connections.values()].map((c) => c.name);
    expect(labels).toContain("charges cards, then emails the receipt");
    expect(labels).toContain("reads prices, stock");
  });

  it("still refuses prose with a comma in a box's context", async () => {
    const r = await call(shop(), "write", {
      yaml: "objects:\n  rider: {kind: actor, context: Fast, cheap.}",
    });
    expect(r.text).toContain("the text has a comma inside {…}");
  });
});

// The manager's view of a shared fork: what changed, and which worker did it.
describe("a fork's diff, and who did what", () => {
  const fork = () => {
    const main = shop();
    const h = memHost({ ops: seedOps(), base: main.state() });
    h.commit(keyOps(h.state()), "keys", { undo: false });
    return h;
  };
  const as = (h: ReturnType<typeof memHost>, session: string, name: string) =>
    void (h.actor = { id: "agent:zeek", name: `Agent · ${name}`, kind: "agent", session });

  it("groups what the fork changed against its main, with refs and the fields that changed", async () => {
    const h = fork();
    as(h, "s-aaaa", "ordering-mapper");
    await call(h, "write", {
      yaml: 'objects:\n  billing: {kind: app, in: shop, context: "Charges orders."}\n  checkout: {tech: Go}\nconnections:\n  - {from: checkout, to: billing, label: bills}\nentities:\n  Invoice: {in: billing, fields: {id: uuid}}',
      label: "billing",
    });
    await call(h, "write", { remove: ["view:shop-api"] });
    const t = (await call(h, "read", { diff: true })).text;
    expect(t).toMatch(
      /^test against its main: boxes \+1 ~1, connections \+1, entities \+1, views -1/,
    );
    expect(t).toContain("  + billing (app) in shop");
    expect(t).toMatch(/  ~ checkout: .*tech/);
    expect(t).toContain("  + checkout>billing:bills");
    expect(t).toContain("  + Invoice in billing");
    expect(t).toContain("  - view:shop-api");
    // in: one box's subtree.
    const inside = (await call(h, "read", { diff: true, in: "billing" })).text;
    expect(inside).toContain("+ billing");
    expect(inside).not.toContain("~ checkout");
    expect(inside).not.toContain("view:shop-api");
  });

  it("says when it isn't a fork, and when nothing changed", async () => {
    expect((await call(shop(), "read", { diff: true })).text).toContain("isn't a fork");
    expect((await call(fork(), "read", { diff: true })).text).toMatch(
      /no changes \(compared \d+ boxes/,
    );
  });

  it("names the session (or worker) on writes and in history, and filters by it", async () => {
    const h = fork();
    as(h, "s-aaaa", "ordering-mapper");
    const w = await call(h, "write", {
      yaml: 'objects:\n  billing: {kind: app, in: shop, context: "Charges orders."}',
      label: "billing service",
    });
    expect(w.text).toMatch(/^Written by Agent · ordering-mapper \(s-aaaa\): "billing service"/);
    as(h, "s-bbbb", "s-bbbb");
    await call(h, "write", { yaml: "objects:\n  checkout: {tech: Go}", label: "checkout tech" });
    const hist = (await call(h, "read", { history: true })).text;
    expect(hist).toContain("Agent · ordering-mapper (agent, s-aaaa): billing service");
    expect(hist).toContain("Agent · s-bbbb (agent): checkout tech");
    const mine = (await call(h, "read", { history: true, by: "ordering-mapper" })).text;
    expect(mine).toContain("billing service");
    expect(mine).not.toContain("checkout tech");
    expect((await call(h, "read", { history: true, by: "s-bbbb" })).text).not.toContain(
      "billing service",
    );
    // diff by: only what that session touched.
    const d = (await call(h, "read", { diff: true, by: "s-bbbb" })).text;
    expect(d).toMatch(/~ checkout: .*tech/);
    expect(d).not.toContain("+ billing");
    expect((await call(h, "read", { diff: true, by: "nobody" })).text).toContain(
      "no changes by nobody",
    );
  });
});

describe("the manage guide", () => {
  it("is a topic, the map and design playbooks point at it, and it teaches the calls that exist", async () => {
    const t = (await call(shop(), "guide", { topic: "manage" })).text;
    for (const s of [
      "read {diff: true}",
      'by: "ordering-mapper"',
      'as: "ordering-mapper"',
      "read {scope: id",
      'lens: "mismatches"',
      'design {action: "propose"',
    ])
      expect(t).toContain(s);
    expect(PLAYBOOKS.map.text).toContain('guide {topic: "manage"}');
    expect(PLAYBOOKS.design.text).toContain('guide {topic: "manage"}');
    expect((await call(shop(), "guide", {})).text).toContain("- manage:");
  });
});

// From trial 3: one small repo, the manual route, a read description that leads with what's used.
describe("teaching for mapping a repo", () => {
  it("map starts with the one-repo, one-pass route, then the waves", () => {
    expect(PLAYBOOKS.map.text).toMatch(/^One repo, one service .*Do it yourself, in one pass/);
    expect(PLAYBOOKS.map.text.indexOf("Many repos, or a big one")).toBeGreaterThan(
      PLAYBOOKS.map.text.indexOf("Mapping a repo by reading it"),
    );
  });

  it("the manual route says what to read, what to write, and to mark guesses", async () => {
    const t = (await call(shop(), "guide", { topic: "map" })).text;
    for (const s of [
      "manifests",
      "Dockerfiles",
      "compose",
      "entry points",
      "top of each main file",
      "(kind: module, path: repo:path)",
      "guess: true",
      "scope: <app>",
      "Repos: a path is <repo>:<path in it>",
    ])
      expect(t).toContain(s);
  });

  it("read leads with q, ref and scope and points at guide for the rest, which has them all", async () => {
    const d = tool("read").description;
    expect(
      d
        .split("\n")
        .slice(1, 4)
        .map((l) => l.split(":")[0]),
    ).toEqual(["- q", "- ref", "- scope (+ budget)"]);
    expect(d).toContain('guide {topic: "read"}');
    expect(d.length).toBeLessThan(900);
    const g = (await call(shop(), "guide", { topic: "read" })).text;
    for (const o of [
      "q (+ kind, in)",
      "ref + depth",
      "impact",
      "from + to",
      "scope (+ budget",
      "view:",
      "lens:",
      "history",
      "diff",
      "file:",
      "here:",
    ])
      expect(g).toContain(o);
  });

  it("index start without a server says what to do instead", async () => {
    const r = await call(shop(), "index", { action: "start", path: "." });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Mapping a repo by reading it");
  });
});

// From trial 4: parameters written in the yaml, paths on apps, repos.
describe("write, loose in", () => {
  it("takes write's parameters written inside the yaml as the parameters", async () => {
    const h = shop();
    const r = await call(h, "write", {
      yaml: 'tidy: shop-api\nlabel: "billing, first pass"\nobjects:\n  billing: {kind: app, in: shop, context: "Charges orders."}',
    });
    expect(r.isError, r.text).toBeFalsy();
    expect(r.text).toContain("(tidy, label in the yaml: taken as parameters, beside yaml)");
    expect(r.text).toMatch(/: "billing, first pass"/);
    expect(r.text).toMatch(/tidied shop-api|nothing moved/);
    const dry = await call(h, "write", { yaml: "dry_run: true\nobjects:\n  billing: {tech: Go}" });
    expect(dry.text).toContain("Dry run, nothing changed");
    // A parameter given beside it wins, and the answer says so.
    const both = await call(h, "write", {
      yaml: "label: from yaml\nobjects:\n  billing: {tech: Rust}",
      label: "from the parameter",
    });
    expect(both.text).toContain(
      "(label in the yaml ignored: given as a parameter too, which wins)",
    );
    expect(both.text).toContain(': "from the parameter"');
  });

  it("lets apps and components say where their code lives, and points shared code at module", async () => {
    const h = shop();
    const r = await call(h, "write", {
      yaml: 'objects:\n  checkout: {path: "shop:services/checkout"}\n  common: {kind: library, in: shop-api, context: "Our shared helpers."}',
    });
    expect(r.isError, r.text).toBeFalsy();
    expect(r.text).not.toContain("only a module");
    expect(r.text).toContain("your own shared code is a module (kind: module, path: repo:path)");
    expect(
      (await call(h, "write", { yaml: 'objects:\n  orders-db: {path: "shop:db"}' })).text,
    ).toContain("only a module, app or component has a path");
  });

  it("warns when a path names a repo the design doesn't know", async () => {
    const h = shop();
    await call(h, "write", { yaml: 'objects:\n  checkout: {path: "shop:services/checkout"}' });
    const r = await call(h, "write", {
      yaml: 'objects:\n  cart: {path: "archnm-src:services/cart"}',
    });
    expect(r.text).toContain("warning: objects: cart: repo archnm-src isn't one test knows (shop)");
    expect(
      (await call(h, "write", { yaml: 'objects:\n  catalog: {path: "shop:services/catalog"}' }))
        .text,
    ).not.toContain("isn't one test knows");
    // Registered by index start: known even before any path uses it.
    const fresh = memHost({});
    (fresh as { repos?: () => string[] }).repos = () => ["delivery"];
    const w = await runTool(
      tool("write"),
      { host: fresh },
      { yaml: 'objects:\n  api: {kind: app, path: "delivry:api", context: "The API."}' },
    );
    expect(w.text).toContain("repo delivry isn't one test knows (delivery)");
  });
});

// From trial 5 (a plan, written by Opus).
describe("trial 5", () => {
  const canvas: Canvas = {
    show: async () => null,
    end: () => {},
    here: () => ({ diagram: null, selection: [] }),
  };

  it("says when a ref is both a box and a view, which it used, and the other's ref", async () => {
    const h = shop({ canvas });
    await call(h, "write", { yaml: "views:\n  checkout: {name: Checkout, scope: checkout}" });
    const r = await call(h, "read", { ref: "checkout" });
    expect(r.text.split("\n")[0]).toBe(
      '"checkout" is both a box and a view: this is the box; for the view, view:checkout.',
    );
    expect((await call(h, "show", { open: "checkout" })).text).toMatch(
      /^"checkout" is both a box and a view: this is the box; for the view, view:checkout\.\nShowing /,
    );
    // Plain refs say nothing more.
    expect((await call(h, "read", { ref: "cart" })).text).not.toContain("is both");
    expect((await call(h, "read", { ref: "view:checkout" })).text).not.toContain("is both");
  });

  it("says a view's settings changed even when tidying moves no box", async () => {
    const h = shop();
    await call(h, "write", { tidy: "shop-api" });
    const r = (
      await call(h, "write", { yaml: "views:\n  shop-api: {arrows: elbow}", tidy: "shop-api" })
    ).text;
    expect(r).toContain("  ~ view shop-api: arrows curved → elbow");
    expect(r).toContain(
      "shop-api: its settings changed (arrows curved → elbow); no box moved: it's already laid out",
    );
    expect(r).not.toContain("nothing moved");
  });

  it("warns about functions written straight into a component, once per box", async () => {
    const h = shop();
    const r = (
      await call(h, "write", {
        yaml: 'objects:\n  quote: {kind: function, in: checkout, signature: "quote(cart: Cart) -> Money"}\n  pay: {kind: function, in: checkout, signature: "pay(order: Order) -> Receipt"}',
      })
    ).text;
    expect(r).toContain(
      "checkout: functions written directly in it (quote, pay): functions live in a file module: add one (kind: module, in: checkout, path: repo:path, or no path yet in a plan) and put them in it",
    );
    expect(r.match(/functions written directly/g)).toHaveLength(1);
    // In a module, no warning.
    const ok = (
      await call(h, "write", {
        yaml: "objects:\n  pricing: {kind: module, in: checkout}\n  quote: {in: pricing}\n  pay: {in: pricing}",
      })
    ).text;
    expect(ok).not.toContain("functions written directly");
  });

  it("makes no TBD from a signature's types, and says why when uses makes one", async () => {
    const h = shop();
    const r = (
      await call(h, "write", {
        yaml: 'objects:\n  pricing: {kind: module, in: checkout}\n  quote: {kind: function, in: pricing, signature: "quote(id: CustomerId) -> Money", uses: [Quote]}',
      })
    ).text;
    expect(r).not.toMatch(/Money is TBD|CustomerId is TBD/);
    expect(r).toMatch(
      /Quote is TBD: a uses, carries or extends names it, and nothing defines it yet .*a signature's types link to entities that are defined, and the rest stay plain text/,
    );
  });

  it("lists each label of connections drawn as one arrow, in read", async () => {
    const h = shop();
    await call(h, "write", {
      yaml: "connections:\n  - {from: storefront, to: catalog, label: searches}",
    });
    const v = (await call(h, "read", { view: "shop-api" })).text;
    expect(v).toMatch(
      /storefront → catalog \(2 connections, one arrow\):\n {6}.* → Catalog: lists products\n {6}.* → Catalog: searches/,
    );
  });

  it("the guides say how a parent's lines follow its children's, and that a small design is one pass", async () => {
    const g = (await call(shop(), "guide", { topic: "grammar" })).text;
    expect(g).toContain("A parent's lines are drawn from its children's");
    expect(g).toContain(
      "Its types link to entities that are defined; one that isn't (Money, CustomerId) stays plain text",
    );
    const d = PLAYBOOKS.design.text;
    expect(d).toContain("A small design (about 20 boxes): do it yourself, in one pass");
    expect(d).toContain("read {diff: true}");
  });
});
