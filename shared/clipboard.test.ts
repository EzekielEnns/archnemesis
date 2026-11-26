// Copy and paste as Archnemesis YAML: what's copied comes back as new objects, inside each other as
// they were, with their connections, columns and layout; plain model YAML pastes too.
import { describe, expect, it } from "vitest";
import { stateFromFiles } from "./diff.ts";
import { buildIndex } from "./project.ts";
import { CLIP_HEAD, copyText, groupKind, pasteOps } from "./clipboard.ts";
import type { ModelObject, Op } from "./model.ts";

const MODEL = `objects:
  db:
    kind: store
    name: Postgres
  users:
    kind: table
    in: db
    columns:
      - name: id
        type: uuid
        pk: true
  orders:
    kind: table
    in: db
    columns:
      - name: id
        type: uuid
        pk: true
      - name: user_id
        type: uuid
connections:
  - { from: orders, to: users, column: user_id }
`;

function load() {
  const state = stateFromFiles(
    new Map([
      ["archnm.yaml", "name: t\n"],
      ["model/m.yaml", MODEL],
      ["views/v.yaml", "name: V\nboxes:\n  - db\n  - users\n  - orders\n"],
    ]),
  );
  const idx = buildIndex({
    objects: state.objects.values(),
    connections: state.connections.values(),
    diagrams: state.diagrams.values(),
    placements: state.placements.values(),
    flows: state.flows.values(),
    boundaries: state.boundaries.values(),
  });
  const d = [...state.diagrams.values()][0]!.id;
  const id = (k: string) => [...state.objects.values()].find((o) => o.key === k)!.id;
  return { idx, d, id };
}

describe("clipboard", () => {
  it("copies a box with what's inside it, and pastes new ones, nested and connected the same", () => {
    const { idx, d, id } = load();
    const text = copyText(idx, d, [id("db")])!;
    expect(text.startsWith(CLIP_HEAD)).toBe(true);
    expect(text).toContain("column: user_id");
    const made = pasteOps(idx, d, text, { x: 1000, y: 500 }, null)!;
    const objs = made.ops.flatMap((o: Op) =>
      o.op === "object.put" ? [o.object as ModelObject] : [],
    );
    expect(objs.map((o) => o.name).sort()).toEqual(["Postgres", "orders", "users"]);
    expect(objs.every((o) => !idx.objects.has(o.id))).toBe(true);
    const store = objs.find((o) => o.kind === "store")!;
    expect(objs.filter((o) => o.kind === "table").every((t) => t.parentId === store.id)).toBe(true);
    expect(objs.find((o) => o.name === "users")!.columns).toEqual([
      { name: "id", type: "uuid", pk: true },
    ]);
    const conns = made.ops.filter((o) => o.op === "connection.put");
    expect(conns).toHaveLength(1);
    expect(conns[0]).toMatchObject({ connection: { column: "user_id" } });
    const boxes = made.ops.flatMap((o) => (o.op === "placement.put" ? [o.placement] : []));
    expect(Math.min(...boxes.map((b) => b.x))).toBe(1000);
  });

  it("pastes plain model YAML in a row, into an object it names that exists", () => {
    const { idx, d, id } = load();
    const made = pasteOps(
      idx,
      d,
      "objects:\n  payments:\n    kind: Table\n    in: db\n  api:\n    kind: app\n",
      { x: 0, y: 0 },
      null,
    )!;
    const objs = made.ops.flatMap((o) => (o.op === "object.put" ? [o.object] : []));
    expect(objs.find((o) => o.name === "payments")!.parentId).toBe(id("db"));
    expect(objs.find((o) => o.name === "api")!.parentId).toBeNull();
    expect(pasteOps(idx, d, "just some words", { x: 0, y: 0 }, null)).toBeNull();
  });

  it("carries references and notes, and a dependency on a library that's here", () => {
    const { idx, d, id } = load();
    const db = idx.objects.get(id("db"))!;
    const lib = {
      ...db,
      id: "o_lib",
      key: "sqlx",
      kind: "library" as const,
      name: "sqlx",
      parentId: null,
    };
    idx.objects.set(lib.id, lib);
    idx.objects.set(db.id, {
      ...db,
      links: [{ title: "Runbook", url: "https://r.example/" }],
      references: [
        { kind: "code", to: "hub:db.sql#L3" },
        { kind: "dependency", to: lib.id },
      ],
      notes: "- [ ] Nightly backups.",
    });
    const text = copyText(idx, d, [id("db")])!;
    expect(text).toContain("link: https://r.example/");
    expect(text).toContain("dependency: sqlx");
    const made = pasteOps(idx, d, text, { x: 0, y: 0 }, null)!;
    const store = made.ops.flatMap((o) =>
      o.op === "object.put" && o.object.kind === "store" ? [o.object] : [],
    )[0]!;
    expect(store.links).toEqual([{ title: "Runbook", url: "https://r.example/" }]);
    expect(store.references).toEqual([
      { kind: "code", to: "hub:db.sql#L3" },
      { kind: "dependency", to: "o_lib" },
    ]);
    expect(store.notes).toBe("- [ ] Nightly backups.");
  });

  it("names a group by what it holds", () => {
    expect(groupKind(["table", "table"])).toBe("store");
    expect(groupKind(["module", "function"])).toBe("module");
    expect(groupKind(["app", "store"])).toBe("system");
  });
});
