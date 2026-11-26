// The code layer in the model and the files: modules, functions and libraries are ordinary
// objects, written beside their source (code/<repo>/<path>.yaml) and in libraries.yaml.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { seedOps } from "./seed.ts";
import { planChanges } from "./agent.ts";
import { applyOps, emptyState, mirror, ModelError, type Actor } from "./doc.ts";
import { check, codeFile, keyOps, readFiles, toOps, writeFiles } from "./files.ts";
import { makeObject } from "./model.ts";
import { buildIndex } from "./project.ts";

const me: Actor = { id: "t", name: "T", kind: "agent" };

function withCode() {
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
      flows: state.flows.values(),
    });
  const { ops } = planChanges(state, idx(), [
    {
      add: {
        id: "cart-crate",
        name: "cart",
        kind: "module",
        in: "cart",
        path: "shop:crates/cart",
        tech: "Rust",
      },
    },
    {
      add: {
        id: "routes-rs",
        name: "routes.rs",
        kind: "module",
        in: "cart-crate",
        path: "shop:crates/cart/src/routes.rs",
      },
    },
    {
      add: {
        id: "add-item",
        name: "add_item()",
        kind: "function",
        in: "routes-rs",
        tech: "axum handler",
      },
    },
    {
      add: {
        id: "store-rs",
        name: "store.rs",
        kind: "module",
        in: "cart-crate",
        path: "shop:crates/cart/src/store.rs",
      },
    },
    { add: { id: "save", name: "save()", kind: "function", in: "store-rs" } },
    {
      add: {
        id: "axum",
        name: "axum",
        kind: "library",
        package: { ecosystem: "cargo", name: "axum", version: "0.8.9" },
      },
    },
    { connect: { from: "add-item", to: "save" } },
    { connect: { from: "add-item", to: "axum" } },
    {
      flow: {
        view: "shop-api",
        name: "add to cart",
        kind: "path",
        steps: [{ from: "add-item", to: "save" }],
      },
    },
  ]);
  applyOps(doc, state, ops, me, "code");
  return { doc, state, idx };
}

describe("code layer", () => {
  it("puts a source file's module, functions and calls at the source's own path", () => {
    const files = writeFiles(withCode().state);
    expect(codeFile("shop:crates/cart/src/routes.rs")).toBe(
      "code/shop/crates/cart/src/routes.rs.yaml",
    );
    expect(codeFile("shop:crates/cart")).toBe("code/shop/crates/cart/_.yaml");
    const routes = files.get("code/shop/crates/cart/src/routes.rs.yaml") ?? "";
    expect(routes).toContain("  routes-rs:\n    kind: module");
    expect(routes).toContain("  add-item:\n    kind: function");
    // A call lives with its caller, even when the callee is in another file.
    expect(routes).toContain("  - {from: add-item, to: save}");
    expect(files.get("code/shop/crates/cart/src/store.rs.yaml")).toContain("  save:\n");
    expect(files.get("code/shop/crates/cart/_.yaml")).toContain("path: shop:crates/cart");
    expect(files.get("libraries.yaml")).toContain("ecosystem: cargo");
    // None of it lands in the system's file.
    expect(files.get("model/shop.yaml")).not.toContain("add-item");
    expect(files.get("views/shop-api.yaml")).toContain("kind: path");
  });

  it("round-trips: reading what was written changes nothing, and writes the same bytes", () => {
    const { state } = withCode();
    const files = writeFiles(state);
    const { model, problems } = readFiles(files);
    expect(problems).toEqual([]);
    expect(check(model).filter((p) => p.level === "error")).toEqual([]);
    expect(toOps(state, model)).toEqual([]);
    expect(writeFiles(state)).toEqual(files);
  });

  it("reads an agent's new function written into a code file", () => {
    const { doc, state } = withCode();
    const files = new Map(writeFiles(state));
    const f = "code/shop/crates/cart/src/store.rs.yaml";
    files.set(
      f,
      files
        .get(f)!
        .replace(
          "objects:\n",
          "objects:\n  load:\n    kind: function\n    name: load()\n    in: store-rs\n",
        ),
    );
    const ops = toOps(state, readFiles(files).model);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ op: "object.put", object: { key: "load", kind: "function" } });
    applyOps(doc, state, ops, me, "files", me, { pin: false });
    expect(writeFiles(state).get(f)).toContain("  load:\n    kind: function");
  });

  it("refuses a path that climbs out of the repo, and fields on the wrong kind", () => {
    const { state } = withCode();
    const files = new Map(writeFiles(state));
    const f = "code/shop/crates/cart/src/store.rs.yaml";
    files.set(
      f,
      files
        .get(f)!
        .replace("path: shop:crates/cart/src/store.rs", "path: shop:../../etc/passwd")
        .replace(
          "    name: save()\n",
          "    name: save()\n    package:\n      ecosystem: cargo\n      name: x\n",
        ),
    );
    const messages = readFiles(files)
      .problems.map((p) => p.message)
      .join("\n");
    expect(messages).toContain("path is repo:path");
    expect(messages).toContain("only a library has a package");
  });

  it("warns about a function outside any module and a library with no package", () => {
    const { state } = withCode();
    const files = new Map(writeFiles(state));
    files.set(
      "libraries.yaml",
      files
        .get("libraries.yaml")!
        .replace("objects:\n", "objects:\n  mystery:\n    kind: library\n"),
    );
    files.set(
      "model/_top.yaml",
      files
        .get("model/_top.yaml")!
        .replace("objects:\n", "objects:\n  stray:\n    kind: function\n    name: stray()\n"),
    );
    const warnings = check(readFiles(files).model)
      .filter((p) => p.level === "warning")
      .map((p) => p.message);
    expect(warnings.some((w) => w.includes("stray: a function belongs in its file's module"))).toBe(
      true,
    );
    expect(warnings.some((w) => w.includes("mystery: a library needs its package"))).toBe(true);
  });

  it("refuses a bad path or package as an op, the way every client is checked", () => {
    const { doc, state } = withCode();
    expect(() =>
      applyOps(
        doc,
        state,
        [
          {
            op: "object.put",
            object: makeObject({ kind: "module", name: "x", path: "shop:a/../../b" }),
          },
        ],
        me,
        "x",
      ),
    ).toThrow(ModelError);
    expect(() =>
      applyOps(
        doc,
        state,
        [{ op: "object.put", object: makeObject({ kind: "store", name: "x", path: "shop:a.rs" }) }],
        me,
        "x",
      ),
    ).toThrow(ModelError);
    expect(() =>
      applyOps(
        doc,
        state,
        [
          {
            op: "object.put",
            object: makeObject({
              kind: "library",
              name: "x",
              package: { ecosystem: "nope" as never, name: "x" },
            }),
          },
        ],
        me,
        "x",
      ),
    ).toThrow(ModelError);
  });

  it("lets an agent change or take off a path and a package", () => {
    const { doc, state, idx } = withCode();
    const { ops } = planChanges(state, idx(), [
      { update: "axum", set: { package: { ecosystem: "cargo", name: "axum", version: "0.9.0" } } },
      { update: "store-rs", set: { path: "" } },
    ]);
    applyOps(doc, state, ops, me, "edit");
    const files = writeFiles(state);
    expect(files.get("libraries.yaml")).toContain("version: 0.9.0");
    // Without a path of its own, store.rs and its functions join the nearest module that has one.
    expect(files.has("code/shop/crates/cart/src/store.rs.yaml")).toBe(false);
    expect(files.get("code/shop/crates/cart/_.yaml")).toContain("  store-rs:\n");
  });
});
