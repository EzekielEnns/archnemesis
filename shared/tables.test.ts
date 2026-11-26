// Tables: one box per table, its columns a field on it. A key between tables is a connection
// naming its column; between regions it says so on the line, to agents and in check.
import { describe, expect, it } from "vitest";
import { contextText } from "./context.ts";
import { stateFromFiles } from "./diff.ts";
import { check, readFiles, writeFiles } from "./files.ts";
import { buildIndex, projectDiagram } from "./project.ts";
import { viewProblems } from "./score.ts";
import { keysOf } from "./tables.ts";

const MODEL = `objects:
  us-db:
    kind: store
    name: US Postgres
    tech: Postgres
  uk-db:
    kind: store
    name: UK Postgres
    tech: Postgres
  us-faces:
    kind: table
    name: faces
    in: us-db
    columns:
      - name: id
        type: uuid
        pk: true
      - name: uk_face_ref
        type: uuid
        nullable: true
  uk-faces:
    kind: table
    name: faces
    in: uk-db
    tags: [personal-data:holds]
    columns:
      - name: id
        type: uuid
        pk: true
      - name: embedding
        type: vector(512)
        personal: true
connections:
  - from: us-faces
    to: uk-faces
    column: uk_face_ref
    tech: lane pointer
`;

const BOUNDARIES = `boundaries:
  - id: us
    kind: region
    name: us-central1
    include:
      - ids: [us-db]
  - id: uk
    kind: region
    name: europe-west2
    include:
      - ids: [uk-db]
`;

const VIEW = `name: Faces bridge
boundaries: true
boxes:
  - us-faces
  - uk-faces
`;

function load(model = MODEL) {
  const files = new Map([
    ["archnm.yaml", "name: bridge\n"],
    ["model/data.yaml", model],
    ["boundaries.yaml", BOUNDARIES],
    ["views/bridge.yaml", VIEW],
  ]);
  const state = stateFromFiles(files);
  const idx = buildIndex({
    objects: state.objects.values(),
    connections: state.connections.values(),
    diagrams: state.diagrams.values(),
    placements: state.placements.values(),
    flows: state.flows.values(),
    boundaries: state.boundaries.values(),
  });
  const id = (k: string) => [...state.objects.values()].find((o) => o.key === k)!.id;
  return { files, state, idx, id };
}

describe("tables", () => {
  it("read, check and write back unchanged, columns and keys included", () => {
    const { files, state } = load();
    const { model, problems } = readFiles(files);
    expect([...problems, ...check(model)].filter((p) => p.level === "error")).toEqual([]);
    const out = writeFiles(state);
    const text = [...out.values()].join("\n");
    expect(text).toContain("columns:\n      - name: id\n        type: uuid\n        pk: true");
    expect(text).toContain("column: uk_face_ref");
    const again = stateFromFiles(out);
    expect([...again.objects.values()].find((o) => o.key === "uk-faces")?.columns).toEqual([
      { name: "id", type: "uuid", pk: true },
      { name: "embedding", type: "vector(512)", personal: true },
    ]);
    expect([...again.connections.values()][0]).toMatchObject({ column: "uk_face_ref" });
  });

  it("is one box saying how many columns, and a key's line is named by its column", () => {
    const { idx, state, id } = load();
    const g = projectDiagram(idx, [...state.diagrams.values()][0]!.id);
    expect(g.nodes.map((n) => n.id).sort()).toEqual([id("uk-faces"), id("us-faces")].sort());
    expect(g.nodes.find((n) => n.id === id("us-faces"))!.subtitle).toBe("Table · 2 cols");
    const e = g.edges[0]!;
    expect(e.crosses).toBe("us-central1 → europe-west2");
    expect(e.label).toBe("uk_face_ref");
  });

  it("knows each key's column and the one it points at", () => {
    const { idx, id } = load();
    const k = keysOf(idx, id("us-faces"));
    expect(k.out).toHaveLength(1);
    expect(k.out[0]).toMatchObject({
      column: "uk_face_ref",
      toColumn: "id",
      across: "us-central1 → europe-west2",
      acrossShort: "US → UK",
    });
    expect(keysOf(idx, id("uk-faces")).in).toHaveLength(1);
  });

  it("opening a table shows the table at the other end of a key, not its store", async () => {
    const { idx, id } = load();
    const { matchSelector } = await import("./views.ts");
    expect([...matchSelector(idx, { neighbours: id("us-faces") })]).toEqual([id("uk-faces")]);
    expect([...matchSelector(idx, { neighbours: id("us-db") })]).toEqual([id("uk-db")]);
  });

  it("tells an agent the columns, which one points where, across which regions", () => {
    const { idx, id } = load();
    const text = contextText(idx, id("us-faces"), { design: "bridge" });
    expect(text).toContain(
      "columns (2):\n  id: uuid · pk\n  uk_face_ref: uuid · nullable → faces.id [uk-faces] (across regions: us-central1 → europe-west2)",
    );
    expect(text).toContain(
      "points to:\n  → faces [uk-faces] by uk_face_ref → faces.id (across regions: us-central1 → europe-west2): lane pointer",
    );
  });

  it("warns when a key across regions is held in a personal column", () => {
    expect(viewProblems(load().idx).filter((p) => p.message.includes("across regions"))).toEqual(
      [],
    );
    const leaky = MODEL.replace(
      "        type: uuid\n        nullable: true",
      "        type: bytea\n        personal: true",
    );
    const warned = viewProblems(load(leaky).idx).filter((p) =>
      p.message.includes("across regions"),
    );
    expect(warned).toHaveLength(1);
    expect(warned[0]!.message).toContain("faces.uk_face_ref");
  });

  it("check: a table belongs in a store, only a table has columns, columns are well formed", () => {
    const { model, problems } = readFiles(
      new Map([
        [
          "model/x.yaml",
          "objects:\n  t:\n    kind: table\n    columns:\n      - name: a\n        type: int\n      - name: a\n        type: int\n        primary: true\n  s:\n    kind: store\n    columns:\n      - name: x\n",
        ],
      ]),
    );
    const msgs = [...problems, ...check(model)].map((p) => p.message);
    expect(msgs.some((m) => m.startsWith("t: a table belongs in its store"))).toBe(true);
    expect(msgs.some((m) => m.includes("two columns are named a"))).toBe(true);
    expect(msgs.some((m) => m.includes('no field "primary"'))).toBe(true);
    expect(msgs.some((m) => m.includes("only a table has columns"))).toBe(true);
  });
});
