import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { seedOps } from "./seed.ts";
import { applyOps, emptyState, mirror, type Actor } from "./doc.ts";
import { check, keyOps, readFiles, toOps, writeFiles } from "./files.ts";

const me: Actor = { id: "t", name: "T", kind: "human" };

function seeded() {
  const doc = new Y.Doc();
  const state = emptyState();
  mirror(doc, state, () => {});
  applyOps(doc, state, seedOps(), me, "seed");
  applyOps(doc, state, keyOps(state), me, "keys");
  return { doc, state };
}

const edit = (files: Map<string, string>, path: string, fn: (s: string) => string) => {
  const next = new Map(files);
  next.set(path, fn(files.get(path) ?? ""));
  return next;
};

describe("files", () => {
  it("gives everything a readable key and writes one file per system", () => {
    const { state } = seeded();
    const files = writeFiles(state);
    expect([...files.keys()].filter((f) => f.startsWith("model/")).sort()).toEqual([
      "model/_top.yaml",
      "model/shop.yaml",
    ]);
    expect(files.get("model/shop.yaml")).toContain("  shop-api:\n    kind: app");
    expect(files.get("model/shop.yaml")).toContain("in: shop");
    expect(files.has("views/shop-api.yaml")).toBe(true);
  });

  it("round-trips: reading what was written changes nothing, and writes the same bytes", () => {
    const { state } = seeded();
    const files = writeFiles(state);
    const { model, problems } = readFiles(files);
    expect(problems).toEqual([]);
    expect(check(model).filter((p) => p.level === "error")).toEqual([]);
    expect(toOps(state, model)).toEqual([]);
    expect(writeFiles(state)).toEqual(files);
  });

  it("keeps a function's signature", () => {
    const { doc, state } = seeded();
    const files = edit(writeFiles(state), "model/shop.yaml", (s) =>
      s.replace(
        "objects:\n",
        'objects:\n  add-points:\n    kind: function\n    name: add_points()\n    signature: "(CustomerId, Order) -> Points"\n',
      ),
    );
    const { model, problems } = readFiles(files);
    expect(problems).toEqual([]);
    applyOps(doc, state, toOps(state, model), me, "files", me, { pin: false });
    expect([...state.objects.values()].find((o) => o.key === "add-points")?.signature).toBe(
      "(CustomerId, Order) -> Points",
    );
    const out = [...writeFiles(state)].find(([, v]) => v.includes("add-points"));
    expect(out?.[1]).toContain("signature: (CustomerId, Order) -> Points");
  });

  it("applies a hand edit to a file as just that edit", () => {
    const { doc, state } = seeded();
    const files = edit(writeFiles(state), "model/shop.yaml", (s) =>
      s.replace("name: Worker", "name: Background worker"),
    );
    const ops = toOps(state, readFiles(files).model);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      op: "object.put",
      object: { key: "worker", name: "Background worker" },
    });
    applyOps(doc, state, ops, me, "files", me, { pin: false });
    expect(writeFiles(state).get("model/shop.yaml")).toContain("name: Background worker");
  });

  it("adds an object and a connection an agent wrote by key", () => {
    const { doc, state } = seeded();
    const files = edit(writeFiles(state), "model/shop.yaml", (s) =>
      s
        .replace(
          "objects:\n",
          "objects:\n  refunds:\n    kind: app\n    name: Refunds\n    in: shop\n",
        )
        .replace(
          "connections:\n",
          "connections:\n  - { from: refunds, to: payments, label: refunds cards }\n",
        ),
    );
    const { model, problems } = readFiles(files);
    expect(problems).toEqual([]);
    applyOps(doc, state, toOps(state, model), me, "files", me, { pin: false });
    const refunds = state.objects.get("refunds");
    expect(refunds?.parentId).toBe([...state.objects.values()].find((o) => o.key === "shop")?.id);
    expect(
      [...state.connections.values()].some(
        (c) => c.fromId === "refunds" && c.name === "refunds cards",
      ),
    ).toBe(true);
    // And the next write is stable.
    const again = writeFiles(state);
    expect(toOps(state, readFiles(again).model)).toEqual([]);
  });

  it("explains what's wrong instead of applying it", () => {
    const { state } = seeded();
    const files = edit(writeFiles(state), "model/shop.yaml", (s) =>
      s
        .replace("name: Worker", "name: Worker\n    colour: red")
        .replace("in: shop-api", "in: nowhere"),
    );
    const { model, problems } = readFiles(files);
    const all = [...problems, ...check(model)].map((p) => p.message);
    expect(all.some((m) => m.includes('unknown field "colour"'))).toBe(true);
    expect(all.some((m) => m.includes('in: no object "nowhere"'))).toBe(true);
  });

  it("refuses YAML tricks and forbidden content", () => {
    const { state } = seeded();
    let files = edit(writeFiles(state), "model/shop.yaml", (s) =>
      s.replace("name: Worker", "name: &w Worker"),
    );
    expect(readFiles(files).problems.some((p) => p.message.includes("anchors"))).toBe(true);
    files = edit(writeFiles(state), "model/shop.yaml", (s) =>
      s.replace("name: Worker", "name: Worker\n    context: runs on 10.0.4.12"),
    );
    expect(
      check(readFiles(files).model).some(
        (p) => p.level === "error" && p.message.includes("forbids"),
      ),
    ).toBe(true);
  });

  it("lets prose name addresses that aren't a machine", () => {
    const { state } = seeded();
    const files = edit(writeFiles(state), "model/shop.yaml", (s) =>
      s.replace("name: Worker", "name: Worker\n    context: binds 127.0.0.1, never 0.0.0.0"),
    );
    expect(check(readFiles(files).model).some((p) => p.message.includes("forbids"))).toBe(false);
  });
});

it("takes a source for a file that isn't written yet", async () => {
  const { sourceLink } = await import("./files.ts");
  expect(sourceLink("acme", "s-chan:crates/board/src/hub/")).toBe(
    "https://github.com/acme/s-chan/blob/HEAD/crates/board/src/hub/",
  );
  expect(sourceLink("acme", "s-chan@main:Cargo.toml:3")).toBe(
    "https://github.com/acme/s-chan/blob/main/Cargo.toml#L3",
  );
  expect(sourceLink("acme", "not a source")).toBeNull();
});
