// Grammar v2 (docs/grammar-v2.md), rule by rule: each form reads, writes back in its one
// canonical form, and reads again as no change; and check says what's wrong, where, with the
// fix when it can guess it.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { applyOps, emptyState, mirror, type Actor, type ModelState } from "./doc.ts";
import {
  check,
  commentLine,
  overlay,
  readFiles,
  toOps,
  writeFiles,
  type Problem,
} from "./files.ts";

const me: Actor = { id: "t", name: "T", kind: "agent" };
const ARCHNM = "name: t\nversion: 2\n";

/** A design loaded from these files the way Archnemesis loads a folder. */
function load(files: Record<string, string>): { state: ModelState; problems: Problem[] } {
  const all = new Map(Object.entries({ "archnm.yaml": ARCHNM, ...files }));
  const { model, problems: read } = readFiles(all);
  const problems = [...read, ...check(model)];
  const doc = new Y.Doc();
  const state = emptyState();
  mirror(doc, state, () => {});
  // As Archnemesis does: files with errors aren't applied.
  if (!problems.some((p) => p.level === "error"))
    applyOps(doc, state, toOps(state, model), me, "load", me, { pin: false });
  return { state, problems };
}

/** Written, read back: no change, and the same bytes the second time. */
function roundTrip(state: ModelState): Map<string, string> {
  const files = writeFiles(state, { name: "t" });
  const { model, problems } = readFiles(files);
  expect(problems).toEqual([]);
  expect(check(model).filter((p) => p.level === "error")).toEqual([]);
  expect(toOps(state, model)).toEqual([]);
  expect(writeFiles(state, { name: "t" })).toEqual(files);
  return files;
}

const errors = (ps: Problem[]) =>
  ps.filter((p) => p.level === "error").map((p) => `${p.file}: ${p.message}`);
const warnings = (ps: Problem[]) =>
  ps.filter((p) => p.level === "warning").map((p) => `${p.file}: ${p.message}`);

const PAYMENTS = `objects:
  payments:
    kind: system
    name: Payments
    tech: [Stripe]
    external: true
    context: |
      Charges cards through Stripe.
  charge:
    kind: function
    in: payments
    signature: "(order: Order, card: CardToken) -> Result<PaidOrder, ChargeError>"
    uses: [Ledger]
    references:
      - code: payments:src/charge.rs#charge
      - link: https://stripe.com/docs/api/charges
  stripe-api:
    kind: app
    in: payments
    tech: [HTTPS]
    context: Stripe's API.
entities:
  Order:
    in: payments
    fields: { id: uuid }
  PaidOrder:
    in: payments
    extends: [Order]
    fields: { charge_id: text, paid_at: timestamp }
  ChargeError:
    in: charge
    values: [declined, expired, network]
  Ledger:
    in: payments
    fields:
      entries: "[LedgerEntry]"
      "balance(&self)": Money
connections:
  - { from: charge, to: stripe-api, label: creates a charge, tech: HTTPS, carries: [PaidOrder], guess: true }
`;

describe("objects", () => {
  it("are a map by id; the name is left out when it's the id", () => {
    const { state, problems } = load({ "model/payments.yaml": PAYMENTS });
    expect(errors(problems)).toEqual([]);
    const charge = [...state.objects.values()].find((o) => o.key === "charge")!;
    expect(charge.name).toBe("charge");
    const files = roundTrip(state);
    const text = files.get("model/payments.yaml")!;
    expect(text).toContain(
      "  payments:\n    kind: system\n    name: Payments\n    context: Charges cards through Stripe.\n    tech: [Stripe]\n",
    );
    // Links come first among references.
    expect(text).toContain(
      "    references:\n      - link: https://stripe.com/docs/api/charges\n      - code: payments:src/charge.rs#charge\n",
    );
    expect(text).toContain("  charge:\n    kind: function\n    in: payments\n");
  });

  it("one id twice in a file is a parse error; in two files, a check error naming both", () => {
    const twice = load({ "model/a.yaml": "objects:\n  x: { kind: app }\n  x: { kind: store }\n" });
    expect(errors(twice.problems)).toContainEqual(
      "model/a.yaml:3: `x` appears twice in objects; keep one",
    );
    const across = load({
      "model/a.yaml": "objects:\n  x: { kind: app }\n",
      "model/b.yaml": "objects:\n  x: { kind: store }\n",
    });
    expect(errors(across.problems)).toContainEqual(
      'model/b.yaml:2: id "x" is used twice (also at model/a.yaml:2): one id, one object',
    );
  });

  it("a list of objects (v1) says it's a map now", () => {
    const { problems } = load({ "model/a.yaml": "objects:\n  - id: x\n    kind: app\n" });
    expect(errors(problems)).toContainEqual(
      "model/a.yaml:1: objects is a map keyed by id (shop-api: { kind: app }), not a list",
    );
  });

  it("an id is a slug: letters (either case), digits, - . _", () => {
    const { problems } = load({ "model/a.yaml": "objects:\n  Shop API: { kind: app }\n" });
    expect(errors(problems)).toContainEqual(
      "model/a.yaml:2: Shop API: an id is letters, digits, - . and _, starting with a letter or digit (shop-api)",
    );
    expect(
      errors(
        load({ "model/a.yaml": "objects:\n  Shop_API: { kind: system, context: x }\n" }).problems,
      ),
    ).toEqual([]);
  });
});

describe("entities", () => {
  it("live in their box's file, keyed by name, fields as a map (a key with ( ) is a method)", () => {
    const { state, problems } = load({ "model/payments.yaml": PAYMENTS });
    expect(errors(problems)).toEqual([]);
    const byName = (n: string) => [...state.entities.values()].find((e) => e.name === n)!;
    expect(byName("Ledger").fields).toEqual(["entries [LedgerEntry]", "balance(&self) -> Money"]);
    expect(byName("ChargeError").values).toEqual(["declined", "expired", "network"]);
    expect(byName("PaidOrder").extends).toEqual([byName("Order").id]);
    expect(byName("ChargeError").sourceId).toBe(
      [...state.objects.values()].find((o) => o.key === "charge")!.id,
    );
    const text = roundTrip(state).get("model/payments.yaml")!;
    expect(text).toContain(
      "entities:\n  ChargeError:\n    in: charge\n    values: [declined, expired, network]\n",
    );
    expect(text).toContain(
      '  Ledger:\n    in: payments\n    fields: {entries: "[LedgerEntry]", balance(&self): Money}\n',
    );
  });

  it("a name used and defined nowhere is TBD: made, warned, and not written back", () => {
    const { state, problems } = load({
      "model/payments.yaml": PAYMENTS.replace(/  Ledger:\n(.*\n){4}/, ""),
    });
    expect(errors(problems)).toEqual([]);
    expect(warnings(problems)).toContainEqual(
      expect.stringMatching(
        /^model\/payments\.yaml:\d+: Ledger is TBD: a uses, carries or extends names it, and nothing defines it yet.*a signature.s types link to entities that are defined/,
      ),
    );
    const ledger = [...state.entities.values()].find((e) => e.name === "Ledger")!;
    expect(ledger.fields).toEqual([]);
    const files = roundTrip(state);
    expect(
      [...files]
        .filter(([f]) => f.startsWith("model/"))
        .map(([, t]) => t)
        .join("\n"),
    ).not.toContain("Ledger:");
    expect(files.get("model/payments.yaml")).toContain("uses: [Ledger]");
  });

  it("a name a letter off one that exists is an error with the suggestion, not a new TBD", () => {
    const { problems } = load({
      "model/payments.yaml": PAYMENTS.replace("uses: [Ledger]", "uses: [Ledgr]").replace(
        "carries: [PaidOrder]",
        "carries: [paidorder]",
      ),
    });
    expect(errors(problems)).toContainEqual(
      expect.stringMatching(/charge: uses: no entity Ledgr \(did you mean Ledger\?\)$/),
    );
    expect(errors(problems)).toContainEqual(
      expect.stringMatching(/connection charge → stripe-api: carries: no entity paidorder/),
    );
  });

  it("what a signature names is worked out, not written; uses holds the rest", () => {
    const { state } = load({ "model/payments.yaml": PAYMENTS });
    const charge = [...state.objects.values()].find((o) => o.key === "charge")!;
    const names = (charge.references ?? [])
      .filter((r) => r.kind === "entity")
      .map((r) => state.entities.get(r.to)!.name)
      .sort();
    expect(names).toEqual(["ChargeError", "Ledger", "Order", "PaidOrder"]);
    const text = roundTrip(state).get("model/payments.yaml")!;
    expect(text).toContain("    uses: [Ledger]\n");
    expect(text).not.toContain("- entity:");
  });

  it("v1's entities.yaml isn't read: it says where they go", () => {
    const { problems } = load({ "entities.yaml": "entities: []\n" });
    expect(errors(problems)[0]).toContain(
      "entities.yaml isn't read any more: each entity goes under entities: in the file of the box that defines it",
    );
  });

  it("warns about one nothing uses", () => {
    const { problems } = load({
      "model/payments.yaml": PAYMENTS.replace(
        "  ChargeError:",
        "  Refund:\n    in: payments\n    fields: { id: uuid }\n  ChargeError:",
      ),
    });
    expect(warnings(problems)).toContainEqual(expect.stringMatching(/Refund: nothing uses it/));
  });
});

describe("connections", () => {
  it("one line each, with what they carry; a long one in block form", () => {
    const { state } = load({ "model/payments.yaml": PAYMENTS });
    const c = [...state.connections.values()][0]!;
    expect(c.guess).toBe(true);
    const text = roundTrip(state).get("model/payments.yaml")!;
    expect(text).toContain(
      "connections:\n  - {from: charge, to: stripe-api, label: creates a charge, tech: HTTPS, guess: true, carries: [PaidOrder]}\n",
    );
    const long = load({
      "model/payments.yaml": PAYMENTS.replace(
        "label: creates a charge",
        `label: ${"creates a charge and ".repeat(6)}waits`,
      ),
    });
    expect(roundTrip(long.state).get("model/payments.yaml")).toContain(
      "connections:\n  - from: charge\n    to: stripe-api\n",
    );
  });
});

describe("guess", () => {
  it("marks an object or a connection believed, not confirmed; check counts them per file", () => {
    const { state, problems } = load({
      "model/payments.yaml": PAYMENTS.replace(
        "    tech: [HTTPS]\n",
        "    tech: [HTTPS]\n    guess: true\n",
      ),
    });
    expect([...state.objects.values()].find((o) => o.key === "stripe-api")!.guess).toBe(true);
    expect(warnings(problems)).toContainEqual(
      "model/payments.yaml: 2 guesses (guess: true): confirm each in the code and drop guess, or remove it",
    );
    expect(roundTrip(state).get("model/payments.yaml")).toContain("    guess: true\n");
  });

  it("is true or left out", () => {
    const { problems } = load({ "model/a.yaml": "objects:\n  a: { kind: app, guess: maybe }\n" });
    expect(errors(problems)).toContainEqual(
      'model/a.yaml:2: a: guess is true or left out (got "maybe")',
    );
  });
});

describe("loose in, tidy out", () => {
  it("takes one value for a list, a comma string for tech, kind and status in any case, fields as lines", () => {
    const { state, problems } = load({
      "model/a.yaml":
        "objects:\n  api:\n    kind: App\n    status: Future\n    tech: Rust, Axum\n    tags: pci\n    uses: Order\n    context: The API.\nentities:\n  Order:\n    in: api\n    fields: [id uuid, total Money]\n",
    });
    expect(errors(problems)).toEqual([]);
    const api = [...state.objects.values()][0]!;
    expect(api).toMatchObject({
      kind: "app",
      status: "future",
      technology: "Rust, Axum",
      tags: ["pci"],
    });
    const text = roundTrip(state).get("model/_top.yaml")!;
    expect(text).toContain("    kind: app\n");
    expect(text).toContain("    tech: [Rust, Axum]\n");
    expect(text).toContain("    status: future\n");
    expect(text).toContain("    tags: [pci]\n");
    expect(text).toContain("    fields: {id: uuid, total: Money}\n");
  });

  it("keeps a comma inside brackets in one tech", () => {
    const { state } = load({
      "model/a.yaml":
        "objects:\n  web:\n    kind: app\n    tech: TypeScript (browser, server), Vite\n    context: x\n",
    });
    expect(roundTrip(state).get("model/_top.yaml")).toContain(
      '    tech: ["TypeScript (browser, server)", Vite]\n',
    );
  });

  it("a near miss on a kind says what was meant", () => {
    const { problems } = load({ "model/a.yaml": "objects:\n  a: { kind: aap }\n" });
    expect(errors(problems)).toContainEqual(
      expect.stringContaining('a: kind "aap" isn\'t one of actor, system, app'),
    );
    expect(errors(problems)[0]).toContain("(did you mean app?)");
  });
});

describe("strict where it matters", () => {
  it("refuses anchors, aliases and tags, each at its line", () => {
    const { problems } = load({
      "model/a.yaml":
        "objects:\n  a: &x { kind: app }\n  b: *x\n  c: { kind: !!str app }\n  d: { kind: !thing app }\n",
    });
    const msgs = errors(problems);
    expect(msgs).toContainEqual(
      expect.stringMatching(/^model\/a\.yaml:2: anchors \(&x\) aren't allowed/),
    );
    expect(msgs).toContainEqual(
      expect.stringMatching(/^model\/a\.yaml:3: aliases \(\*x\) aren't allowed/),
    );
    expect(msgs).toContainEqual(
      expect.stringMatching(/^model\/a\.yaml:5: tags \(!thing\) aren't allowed/),
    );
  });

  it("types a scalar by the field, not by YAML: 1.10, no and null in a string field stay strings", () => {
    const { state } = load({
      "model/a.yaml":
        "objects:\n  v:\n    kind: app\n    name: 1.10\n    context: no\n  n:\n    kind: app\n    name: null\n    context: x\n",
    });
    const byKey = (k: string) => [...state.objects.values()].find((o) => o.key === k)!;
    expect(byKey("v").name).toBe("1.10");
    expect(byKey("v").description).toBe("no");
    expect(byKey("n").name).toBe("null");
  });

  it("warns about a comment (it won't survive a rewrite), but not the file's heading", () => {
    expect(commentLine("# heading\n# more\nobjects:\n  a: { kind: app } # here\n")).toBe(4);
    expect(commentLine('# heading\nobjects:\n  a: { kind: app, name: "a # b" }\n')).toBe(0);
    const { problems } = load({
      "model/a.yaml": "objects:\n  a:\n    # the main one\n    kind: app\n",
    });
    expect(warnings(problems)).toContainEqual(
      "model/a.yaml:3: comments aren't kept (Archnemesis rewrites its files): put what it says in a context or notes field",
    );
  });

  it("refuses a version 1 folder, pointing at archnm convert", () => {
    const { problems } = load({ "archnm.yaml": "name: t\nversion: 1\n" });
    expect(errors(problems)).toContainEqual(
      "archnm.yaml: version 1 files aren't read any more: convert the folder once with `archnm convert <dir>`",
    );
  });

  it("model/landscape.yaml is _top.yaml now", () => {
    const { problems } = load({ "model/landscape.yaml": "objects: {}\n" });
    expect(errors(problems)).toContainEqual(
      "model/landscape.yaml: model/landscape.yaml is model/_top.yaml now: rename it",
    );
  });
});

describe("layout", () => {
  it("names its fields; w and h only when not the kind's size", () => {
    const { state, problems } = load({
      "model/a.yaml":
        "objects:\n  api: { kind: app, tech: [Go], context: x }\n  db: { kind: store, tech: [Postgres], context: x }\n  run: { kind: function }\n",
      "views/v.yaml": "name: V\nboxes: [api, db, run]\n",
      "layout/v.json":
        '{\n  "api": {"x": 0, "y": 0},\n  "db": {"x": 300, "y": 0, "w": 240, "h": 96},\n  "run": {"x": 0, "y": 200, "parts": [10, 20]}\n}\n',
    });
    expect(errors(problems)).toEqual([]);
    const placed = [...state.placements.values()];
    const at = (k: string) => placed.find((p) => state.objects.get(p.objectId)!.key === k)!;
    expect(at("api")).toMatchObject({ x: 0, y: 0, w: 184, h: 72 });
    expect(at("db")).toMatchObject({ w: 240, h: 96 });
    expect(at("run")).toMatchObject({ h: 40, parts: { x: 10, y: 20 } });
    expect(roundTrip(state).get("layout/v.json")).toBe(
      '{\n  "api": {"x": 0, "y": 0},\n  "db": {"x": 300, "y": 0, "w": 240, "h": 96},\n  "run": {"x": 0, "y": 200, "parts": [10, 20]}\n}\n',
    );
  });

  it("refuses v1's arrays", () => {
    const { problems } = load({
      "model/a.yaml": "objects:\n  api: { kind: app }\n",
      "views/v.yaml": "name: V\nboxes: [api]\n",
      "layout/v.json": '{"api": [0, 0, 184, 72]}',
    });
    expect(errors(problems)[0]).toContain('layout/v.json: api: a box is {"x": 0, "y": 0}');
  });
});

describe("check", () => {
  it("names the id a typo meant, or where to define one that's missing", () => {
    const { problems } = load({
      "model/payments.yaml": PAYMENTS.replace("to: stripe-api", "to: stripe-apl").replace(
        "in: payments\n    signature",
        "in: nowhere\n    signature",
      ),
    });
    expect(errors(problems)).toContainEqual(
      expect.stringMatching(
        /^model\/payments\.yaml:\d+: connection charge → stripe-apl: no object "stripe-apl" \(did you mean stripe-api\?\)$/,
      ),
    );
    expect(errors(problems)).toContainEqual(
      expect.stringMatching(
        /charge: in: no object "nowhere" \(define it under objects: in the file of the box it's in, or model\/_top\.yaml at the top level\)$/,
      ),
    );
  });

  it("names the field a typo meant", () => {
    const { problems } = load({ "model/a.yaml": "objects:\n  a: { kind: app, contxt: x }\n" });
    expect(errors(problems)[0]).toMatch(
      /^model\/a\.yaml:2: a: unknown field "contxt" \(did you mean context\?\); allowed: kind, name/,
    );
  });

  it("gives every problem at once, each with its file and line", () => {
    const { problems } = load({
      "model/a.yaml": "objects:\n  a: { kind: aap }\n  b: { kind: app, in: c }\n",
      "model/b.yaml": "objects:\n  x: { kind: app, external: yes }\n",
    });
    expect(errors(problems)).toEqual([
      'model/a.yaml:2: a: kind "aap" isn\'t one of actor, system, app, store, component, module, function, library, table (did you mean app?)',
      'model/b.yaml:2: x: external is true or left out (got "yes")',
      expect.stringMatching(/^model\/a\.yaml:3: b: in: no object "c"/),
    ]);
  });

  it("warns, never blocks, on what's still to do: no tech, no context", () => {
    const { problems } = load({ "model/a.yaml": "objects:\n  a: { kind: app }\n" });
    expect(errors(problems)).toEqual([]);
    expect(warnings(problems)).toEqual([
      "model/a.yaml:2: a: no tech (what it's built with or runs on)",
      "model/a.yaml:2: a: no context (what it does and why, in a sentence or two)",
    ]);
  });
});

describe("an agent writing its scope's file", () => {
  it("owns the entities in it: what it leaves out of the file goes, what it writes replaces by name", () => {
    const base = readFiles(
      new Map([
        ["archnm.yaml", ARCHNM],
        ["model/payments.yaml", PAYMENTS],
      ]),
    ).model;
    const mine = PAYMENTS.replace(/  ChargeError:\n(.*\n){2}/, "").replace(
      "fields: { id: uuid }",
      "fields: { id: uuid, total: Money }",
    );
    const m = overlay(base, readFiles(new Map([["model/payments.yaml", mine]])).model);
    expect(m.entities.map((e) => e.id).sort()).toEqual(["Ledger", "Order", "PaidOrder"]);
    expect(m.entities.find((e) => e.id === "Order")!.fields).toEqual(["id uuid", "total Money"]);
    expect(check(m).filter((p) => p.level === "error")).toEqual([]);
  });
});

describe("a TBD entity made in the app by typing a signature", () => {
  it("is written with no body where nothing defines it, and reads back as no change", () => {
    const { state } = load({
      "model/a.yaml":
        "objects:\n  svc: { kind: app, tech: [Go], context: x }\n  run: { kind: function, in: svc }\n",
    });
    const doc = new Y.Doc();
    const live = emptyState();
    mirror(doc, live, () => {});
    applyOps(
      doc,
      live,
      [...state.objects.values()].map((object) => ({ op: "object.put" as const, object })),
      me,
      "copy",
    );
    const run = [...live.objects.values()].find((o) => o.key === "run")!;
    const e = {
      id: "e_cart",
      key: "Cart",
      name: "Cart",
      fields: [],
      sourceId: null,
      description: "",
      createdAt: "",
      updatedAt: "",
    };
    applyOps(
      doc,
      live,
      [
        { op: "entity.put", entity: e },
        {
          op: "object.put",
          object: {
            ...run,
            signature: "(Cart) -> Receipt",
            references: [{ kind: "entity", to: e.id }],
          },
        },
      ],
      me,
      "type",
    );
    const files = roundTrip(live);
    expect(files.get("model/_top.yaml")).toContain("entities:\n  Cart: {}\n");
    expect(files.get("model/svc.yaml")).not.toContain("uses:");
  });
});
