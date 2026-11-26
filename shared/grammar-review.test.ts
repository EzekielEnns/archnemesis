// Grammar v2, the review's findings: one regression test each (docs/grammar-v2.md, "Decisions
// while building"). Every one of these was a way the files and the live document disagreed.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { draftYaml } from "../server/survey.ts";
import { copyText, pasteOps } from "./clipboard.ts";
import { worklist, worklistText } from "./curate.ts";
import {
  applyOps,
  emptyState,
  mirror,
  readState,
  tables,
  type Actor,
  type ModelState,
} from "./doc.ts";
import { makeEntity, parseEntityName } from "./entities.ts";
import {
  check,
  commentLine,
  keyOps,
  objectYaml,
  overlay,
  readFiles,
  replaced,
  toOps,
  writeFiles,
  type FileModel,
  type Problem,
} from "./files.ts";
import { FN_H, makeConnection, makeObject, typeName, type Entity, type Op } from "./model.ts";
import { buildIndex, type ModelIndex } from "./project.ts";
import { viewSlice } from "./slice.ts";

const me: Actor = { id: "t", name: "T", kind: "agent" };
const ARCHNM = "name: t\nversion: 2\n";

const files = (more: Record<string, string>) =>
  new Map(Object.entries({ "archnm.yaml": ARCHNM, ...more }));
const read = (more: Record<string, string>) => readFiles(files(more));
const errors = (ps: Problem[]) =>
  ps.filter((p) => p.level === "error").map((p) => `${p.file}: ${p.message}`);
const all = (r: { model: FileModel; problems: Problem[] }) => [...r.problems, ...check(r.model)];

function fresh(): { doc: Y.Doc; state: ModelState } {
  const doc = new Y.Doc();
  const state = emptyState();
  mirror(doc, state, () => {});
  return { doc, state };
}
function load(more: Record<string, string>, into = fresh()) {
  const { model, problems } = read(more);
  expect(errors([...problems, ...check(model)])).toEqual([]);
  applyOps(into.doc, into.state, toOps(into.state, model), me, "load", me, { pin: false });
  return into;
}
const run = (h: { doc: Y.Doc; state: ModelState }, ops: Op[]) =>
  applyOps(h.doc, h.state, ops, me, "edit");
const index = (s: ModelState): ModelIndex =>
  buildIndex({
    objects: s.objects.values(),
    connections: s.connections.values(),
    diagrams: s.diagrams.values(),
    placements: s.placements.values(),
    flows: s.flows.values(),
    arrows: s.arrows.values(),
    boundaries: s.boundaries.values(),
    entities: s.entities.values(),
  });
/** Written, read back: no errors, no change. */
function settles(state: ModelState): Map<string, string> {
  const out = writeFiles(state, { name: "t" });
  const r = readFiles(out);
  expect(errors(all(r))).toEqual([]);
  expect(toOps(state, r.model)).toEqual([]);
  return out;
}

describe("1. what Archnemesis writes, its reader takes", () => {
  it("an object id with capitals is kept as it is", () => {
    const h = fresh();
    run(h, [
      {
        op: "object.put",
        object: {
          ...makeObject({ name: "Shop API", kind: "system", description: "x" }),
          id: "Shop_API",
          key: "Shop_API",
        },
      },
    ]);
    expect(settles(h.state).get("model/_top.yaml")).toContain("  Shop_API:\n");
  });

  it("an entity's name is a type name where it's made and renamed", () => {
    expect(() => makeEntity("Paid Order")).toThrow(/type name/);
    expect(parseEntityName("PaidOrder : Order").error).toBeUndefined();
    expect(parseEntityName("Paid Order").error).toMatch(/type name/);
    expect(parseEntityName("PaidOrder : _Base").error).toMatch(/_Base/);
    const h = fresh();
    const e = makeEntity("Order");
    run(h, [{ op: "entity.put", entity: e }]);
    expect(() => run(h, [{ op: "entity.put", entity: { ...e, name: "order-status" } }])).toThrow(
      /type name/,
    );
  });

  it("a live entity named before names were checked reads as a type name, and writes clean", () => {
    expect([
      typeName("Paid Order"),
      typeName("order-status"),
      typeName("_Priv"),
      typeName("Order"),
    ]).toEqual(["PaidOrder", "OrderStatus", "Priv", "Order"]);
    const h = fresh();
    const row = (id: string, name: string) => ({
      id,
      name,
      fields: ["id uuid"],
      sourceId: null,
      description: "",
      createdAt: "",
      updatedAt: "",
    });
    tables(h.doc).entities.set("e_1", row("e_1", "Paid Order"));
    tables(h.doc).entities.set("e_2", row("e_2", "order-status"));
    const state = readState(h.doc);
    expect([...state.entities.values()].map((e) => e.name).sort()).toEqual([
      "OrderStatus",
      "PaidOrder",
    ]);
    expect(readFiles(writeFiles(state)).problems).toEqual([]);
  });

  it("_Foo and __proto__ are errors where they're read, not a crash later", () => {
    for (const n of ["_Private", "__proto__"]) {
      const r = read({
        "model/a.yaml": `objects:\n  s: { kind: system, context: x, uses: [${n}] }\nentities:\n  ${n}: { in: s, fields: { a: text } }\n`,
      });
      expect(errors(r.problems).some((m) => m.includes("type name"))).toBe(true);
    }
  });

  it("an object called constructor is placed where its kind's box goes, not at NaN", () => {
    const r = read({
      "model/a.yaml":
        "objects:\n  constructor: { kind: system, context: x }\n  b: { kind: system, context: x }\n",
      "views/v.yaml": "name: V\nboxes: [constructor, b]\n",
      "layout/v.json": '{\n  "b": {"x": 0, "y": 0}\n}\n',
    });
    expect(errors(all(r))).toEqual([]);
    const placed = toOps(emptyState(), r.model).flatMap((o) =>
      o.op === "placement.put" ? [o.placement] : [],
    );
    expect(placed.every((p) => [p.x, p.y, p.w, p.h].every(Number.isFinite))).toBe(true);
  });
});

describe("2. write's replace and remove, and entities", () => {
  const BASE =
    "objects:\n  pay: { kind: system, context: x }\n  app: { kind: app, in: pay, tech: [Go], context: x }\nentities:\n  Ledger: { in: pay, fields: { a: text } }\n  Card: { in: app, fields: { n: text } }\n";
  it("replace: the written entities come in; the ones in a box written again go; the ones in a box left out stay, homeless", () => {
    const base = read({ "model/pay.yaml": BASE }).model;
    const mine = read({
      "model/new.yaml":
        "objects:\n  pay: { kind: system, context: y }\n  new: { kind: system, context: y }\nentities:\n  Fresh: { in: new, fields: { a: text } }\n",
    }).model;
    const m = replaced(base, mine, { views: false, boundaries: false, decisions: false });
    expect(m.entities.map((e) => [e.id, e.in])).toEqual([
      ["Card", undefined],
      ["Fresh", "new"],
    ]);
    expect(errors(check(m))).toEqual([]);
  });

  it("remove: a box's entities stay, homeless; an object id never removes an entity", () => {
    const base = read({ "model/pay.yaml": BASE + "  pay2: {}\n" }).model;
    const m = overlay(base, read({}).model, ["app"]);
    expect(m.entities.find((e) => e.id === "Card")).toEqual({
      id: "Card",
      fields: ["n text"],
      in: undefined,
      extends: undefined,
      context: undefined,
      values: undefined,
    });
    const named = read({
      "model/pay.yaml":
        "objects:\n  Ledger: { kind: system, context: x }\nentities:\n  Ledger: { fields: { a: text } }\n",
    }).model;
    expect(overlay(named, read({}).model, ["Ledger"]).entities.map((e) => e.id)).toEqual([
      "Ledger",
    ]);
  });
});

describe("3. an entity renamed in the app, then one of its old name in the files", () => {
  it("is matched by name: the new one gets a fresh id", () => {
    const h = load({
      "model/shop.yaml":
        "objects:\n  shop: { kind: system, context: x }\nentities:\n  Order: { in: shop, fields: { id: uuid } }\n",
    });
    const e = h.state.entities.get("Order")!;
    run(h, [{ op: "entity.put", entity: { ...e, name: "Purchase", key: "Purchase" } }]);
    load(
      {
        "model/shop.yaml":
          "objects:\n  shop: { kind: system, context: x }\nentities:\n  Order: { in: shop, fields: { id: uuid, new: text } }\n  Purchase: { in: shop, fields: { id: uuid } }\n",
      },
      h,
    );
    expect(
      [...h.state.entities.values()].map((x) => `${x.id}:${x.name}:${x.fields.join(",")}`).sort(),
    ).toEqual(["Order:Purchase:id uuid", "Order_2:Order:id uuid,new text"]);
  });
});

describe("4. strict parse", () => {
  it("refuses directives and every tag", () => {
    const r = read({
      "model/a.yaml":
        "%YAML 1.1\n---\nobjects:\n  a:\n    kind: !!str system\n    name: !!binary aGVsbG8=\n",
    });
    const e = errors(r.problems);
    expect(e).toContainEqual(
      "model/a.yaml:1: directives (%YAML) aren't allowed: Archnemesis reads YAML 1.2; take the line out",
    );
    expect(e).toContainEqual("model/a.yaml:5: tags (!!str) aren't allowed; write the plain value");
    expect(e).toContainEqual(
      "model/a.yaml:6: tags (!!binary) aren't allowed; write the plain value",
    );
  });
});

describe("5. text fields are text", () => {
  it("a list or a map where text goes is an error; True keeps its source text; a flag takes True", () => {
    const e = errors(
      read({
        "model/a.yaml":
          "objects:\n  b: { kind: system }\n  a:\n    kind: app\n    name: [x, y]\n    context: { a: 1 }\n    in: [b]\n",
      }).problems,
    );
    expect(e).toEqual([
      `model/a.yaml:5: a: name is text, not a list (quote it if it's one: "a, b")`,
      `model/a.yaml:7: a: in is text, not a list (quote it if it's one: "a, b")`,
      "model/a.yaml:6: a: context is text, not a map",
    ]);
    const ok = read({
      "model/a.yaml": "objects:\n  a: { kind: system, name: True, context: YES, external: True }\n",
    });
    expect(ok.problems).toEqual([]);
    expect(ok.model.objects[0]).toMatchObject({ name: "True", context: "YES", external: true });
  });
});

describe("6. the survey's draft", () => {
  it("is version 2: objects by id, and reads clean", () => {
    const y = draftYaml({
      repo: "demo",
      languages: [{ language: "Go" }],
      runnables: [{ name: "demo-api", kind: "docker", at: "Dockerfile" }],
      stores: [{ name: "pg", kind: "postgres", at: "compose.yml" }],
    } as never);
    const r = read({ "model/demo.yaml": y });
    expect(r.problems).toEqual([]);
    expect(r.model.objects.map((o) => [o.id, o.kind, o.name, o.context, o.tech])).toEqual([
      ["demo", "system", "demo", undefined, undefined],
      ["demo-api", "app", "demo-api", "docker at Dockerfile", "Go"],
      ["pg", "store", "pg", "from compose.yml", "postgres"],
    ]);
  });
});

describe("7. an exported view, and a change shown as YAML", () => {
  it("carries the entities its boxes use, defined; never an id", () => {
    const h = load({
      "model/shop.yaml":
        "objects:\n  shop: { kind: system, context: x }\n  api: { kind: app, in: shop, tech: [Go], context: x, uses: [Order] }\nentities:\n  Order: { in: shop, extends: [Base], fields: { id: uuid } }\n  Base: { fields: { at: time } }\nconnections:\n  - {from: api, to: shop, carries: [Order]}\n",
      "views/v.yaml": "name: V\nboxes: [api]\n",
    });
    const d = [...h.state.diagrams.values()][0]!;
    const out = writeFiles(viewSlice(h.state, index(h.state), d.id, { deep: false }));
    expect(errors(all(readFiles(out)))).toEqual([]);
    expect(out.get("model/shop.yaml")).toContain("entities:\n  Order:");
    expect(out.get("model/_top.yaml")).toContain("  Base:");
    expect([...out.values()].join("\n")).not.toMatch(/\be_[0-9a-f]{6}/);
  });

  it("objectYaml names entities, and leaves out what the signature names and what it can't name", () => {
    const fn = {
      ...makeObject({ name: "charge", kind: "function", signature: "(o: Order) -> Receipt" }),
      key: "charge",
      references: [
        { kind: "entity" as const, to: "e_order" },
        { kind: "entity" as const, to: "e_ledger" },
        { kind: "entity" as const, to: "e_gone" },
      ],
    };
    const names: Record<string, string> = { e_order: "Order", e_ledger: "Ledger" };
    const y = objectYaml(
      fn,
      (id) => id,
      (id) => names[id],
    );
    expect(y).toContain("uses: [Ledger]");
    expect(y).not.toContain("e_");
  });
});

describe("8. did you mean", () => {
  it("only suggests an entity that's defined, not one made TBD in the same pass", () => {
    for (const uses of ["[Cat, Car]", "[Car, Cat]"]) {
      const ps = all(
        read({ "model/a.yaml": `objects:\n  s: { kind: system, context: x, uses: ${uses} }\n` }),
      );
      expect(errors(ps)).toEqual([]);
      expect(ps.filter((p) => p.message.includes("is TBD")).length).toBe(2);
    }
    const typo = all(
      read({
        "model/a.yaml":
          "objects:\n  s: { kind: system, context: x, uses: [Car] }\nentities:\n  Cat: { in: s, fields: { a: text } }\n",
      }),
    );
    expect(errors(typo)).toEqual(["model/a.yaml:2: s: uses: no entity Car (did you mean Cat?)"]);
  });
});

describe("9. what a signature names", () => {
  it("isn't added on the first read when the box didn't point at it", () => {
    const h = fresh();
    const sys = makeObject({ name: "Shop", kind: "system", description: "x" });
    const fn = makeObject({
      name: "charge",
      kind: "function",
      parentId: sys.id,
      signature: "(o: Order) -> Receipt",
    });
    run(h, [
      { op: "object.put", object: sys },
      { op: "object.put", object: fn },
      { op: "entity.put", entity: makeEntity("Order", sys.id, ["id uuid"]) },
    ]);
    run(h, keyOps(h.state));
    settles(h.state);
  });
});

describe("10. a field named before a bracket", () => {
  it("is a field, not a method, and round-trips: a method is name( with no space", () => {
    const h = fresh();
    const sys = makeObject({ name: "Shop", kind: "system", description: "x" });
    run(h, [
      { op: "object.put", object: sys },
      {
        op: "entity.put",
        entity: makeEntity("Pair", sys.id, [
          "pair (int, int)?",
          "cb (a: int) -> int",
          "charge(a: Money) -> Receipt",
        ]),
      },
    ]);
    run(h, keyOps(h.state));
    const out = settles(h.state);
    expect(out.get("model/_top.yaml")).toContain(
      '    fields: {pair: "(int, int)?", cb: "(a: int) -> int", "charge(a: Money)": Receipt}\n',
    );
  });
});

describe("11. the small ones", () => {
  it("a box not in the layout is its kind's size", () => {
    const r = read({
      "model/a.yaml": "objects:\n  m: { kind: module }\n  f: { kind: function, in: m }\n",
      "views/v.yaml": "name: V\nboxes: [f]\n",
    });
    const p = toOps(emptyState(), r.model).find((o) => o.op === "placement.put");
    expect(p?.op === "placement.put" && p.placement.h).toBe(FN_H);
  });

  it("curate lists boxes put in as a guess", () => {
    const h = load({
      "model/a.yaml": "objects:\n  a: { kind: system, context: x, guess: true }\n",
    });
    const w = worklist(index(h.state));
    expect(w.guessedObjects).toHaveLength(1);
    expect(worklistText(w, "t")).toContain("Boxes put in as a guess (1)");
  });

  it("copy keeps guess and signature; paste doesn't take entity references", () => {
    const h = load({
      "model/a.yaml":
        'objects:\n  m: { kind: module }\n  f: { kind: function, in: m, signature: "(o: Order)", guess: true }\nentities:\n  Order: { fields: { id: uuid } }\n',
      "views/v.yaml": "name: V\nboxes: [f]\n",
    });
    const idx = index(h.state);
    const d = [...h.state.diagrams.values()][0]!;
    const f = [...h.state.objects.values()].find((o) => o.key === "f")!;
    const text = copyText(idx, d.id, [f.id])!;
    expect(text).toContain('signature: "(o: Order)"');
    expect(text).toContain("guess: true");
    // Its entity reference isn't copied (it's an id in this design), so no empty references either.
    expect(text).not.toContain("references");
    const made = pasteOps(
      idx,
      d.id,
      text.replace("guess: true", "guess: true\n    references:\n      - entity: Order"),
      { x: 0, y: 0 },
      null,
    )!;
    const o = made.ops.find((x) => x.op === "object.put");
    expect(
      o?.op === "object.put" && [o.object.guess, o.object.signature, o.object.references],
    ).toEqual([true, "(o: Order)", undefined]);
  });

  it("prose is trimmed: trailing blank lines or a lone space don't come back as a change", () => {
    for (const s of ["x\n\n", " ", "  lead", "trail  "]) {
      const h = fresh();
      const sys = makeObject({ name: "N", kind: "system", description: s || "d" });
      const app = makeObject({ name: "A", kind: "app", parentId: sys.id, notes: s });
      const e: Entity = { ...makeEntity("Thing", sys.id, ["g text"]), description: s };
      run(h, [
        { op: "object.put", object: sys },
        { op: "object.put", object: app },
        {
          op: "connection.put",
          connection: {
            ...makeConnection({ fromId: app.id, toId: sys.id, name: "n", description: s }),
            context: s,
          },
        },
        { op: "entity.put", entity: e },
      ]);
      run(h, keyOps(h.state));
      const out = settles(h.state);
      expect([...out.values()].join("")).not.toContain("|+");
    }
  });

  it("an object or entity called fields or connections is written in block style like any other", () => {
    const r = read({
      "model/fields.yaml":
        "objects:\n  fields: { kind: system, context: x }\n  connections: { kind: app, in: fields, tech: [Go], context: x }\nentities:\n  fields: { in: fields, fields: { a: text } }\n",
    });
    expect(errors(all(r))).toEqual([]);
    const h = fresh();
    applyOps(h.doc, h.state, toOps(h.state, r.model), me, "load", me, { pin: false });
    const text = writeFiles(h.state).get("model/fields.yaml")!;
    expect(text).toContain("entities:\n  fields:\n    in: fields\n    fields: {a: text}\n");
    expect(text).toContain("  connections:\n    kind: app\n");
  });

  it("a heading after --- is still the heading", () => {
    expect(commentLine("---\n# head\nobjects: {}\n")).toBe(0);
  });

  it("the same connection twice is an error", () => {
    const ps = all(
      read({
        "model/a.yaml":
          "objects:\n  a: { kind: system, context: x }\n  b: { kind: system, context: x }\nconnections:\n  - {from: a, to: b, label: x}\n  - {from: a, to: b, label: x}\n  - {from: a, to: b}\n",
      }),
    );
    expect(errors(ps)).toEqual([
      'model/a.yaml:6: connection a → b "x" is listed twice (also at model/a.yaml:5): keep one, or label each',
    ]);
  });
});

describe("12. one bad field, one error", () => {
  it("a box whose kind doesn't read still answers for what points at it", () => {
    const ps = all(
      read({
        "model/a.yaml":
          "objects:\n  skycast:\n    kind: sytem\n  app:\n    kind: app\n    in: skycast\n    tech: [Go]\n    context: x\nconnections:\n  - {from: app, to: skycast}\n",
        "views/v.yaml": "name: V\nscope: skycast\nboxes: [skycast, app]\n",
      }),
    );
    expect(errors(ps)).toEqual([
      'model/a.yaml:3: skycast: kind "sytem" isn\'t one of actor, system, app, store, component, module, function, library, table (did you mean system?)',
    ]);
  });
});

describe("13. a duplicate key", () => {
  it("says which key and where, in Archnemesis's words", () => {
    const r = read({
      "model/a.yaml": "objects:\n  hungry-human:\n    kind: actor\n    kind: actor\n",
    });
    expect(errors(r.problems)).toEqual([
      "model/a.yaml:4: `kind` appears twice in hungry-human; keep one",
    ]);
  });
});

describe("14. a field's problem", () => {
  it("is at the field's own line", () => {
    const ps = all(
      read({
        "model/a.yaml":
          "objects:\n  rocket: { kind: system, context: x }\n  hungry-human:\n    kind: actor\n    statuss: live\n    external: no\n    in: rockett\n",
      }),
    );
    expect(errors(ps)).toEqual([
      'model/a.yaml:5: hungry-human: unknown field "statuss" (did you mean status?); allowed: kind, name, in, context, tech, icon, path, signature, uses, package, columns, status, external, tags, refs, sources, references, notes, guess',
      'model/a.yaml:6: hungry-human: external is true or left out (got "no")',
      'model/a.yaml:7: hungry-human: in: no object "rockett" (did you mean rocket?)',
    ]);
  });
});

describe("guesses stored before guess", () => {
  it("confidence: name in the live document reads as guess: true", () => {
    const h = fresh();
    tables(h.doc).connections.set("c_1", {
      id: "c_1",
      fromId: "a",
      toId: "b",
      name: "",
      description: "",
      technology: "",
      status: "live",
      confidence: "name",
    });
    const c = readState(h.doc).connections.get("c_1")!;
    expect(c.guess).toBe(true);
    expect("confidence" in c).toBe(false);
  });
});
