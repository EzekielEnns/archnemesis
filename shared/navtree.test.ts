import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { codeSeedOps } from "../server/seed.ts";
import { applyOps, emptyState, mirror } from "./doc.ts";
import { keyOps } from "./files.ts";
import { navRows, rowLabel } from "./navtree.ts";
import { makeObject } from "./model.ts";
import { buildIndex } from "./project.ts";

function board() {
  const doc = new Y.Doc();
  const state = emptyState();
  mirror(doc, state, () => {});
  const me = { id: "t", name: "T", kind: "agent" as const };
  applyOps(doc, state, codeSeedOps(), me, "s");
  applyOps(doc, state, keyOps(state), me, "k");
  const idx = buildIndex({
    objects: state.objects.values(),
    connections: state.connections.values(),
    diagrams: state.diagrams.values(),
    placements: state.placements.values(),
    flows: state.flows.values(),
    boundaries: state.boundaries.values(),
  });
  const id = (name: string) => [...idx.objects.values()].find((o) => o.name === name)!.id;
  return { idx, id };
}

describe("model navigator", () => {
  it("starts folded: only the roots", () => {
    const { idx } = board();
    const rows = navRows(idx, new Set());
    expect(rows.every((r) => r.depth === 0)).toBe(true);
    expect(rows.map((r) => r.o.name)).toContain("Agent board");
    // A library is a row under what uses it (a function's, under its file), never a root of its own
    // while something uses it.
    const all = navRows(idx, new Set(idx.objects.keys()));
    const libRows = all.filter((r) => r.o.kind === "library");
    const usedLibs = new Set(
      [
        ...[...idx.connections.values()].map((c) => c.toId),
        ...[...idx.objects.values()].flatMap((o) =>
          (o.references ?? []).filter((r) => r.kind === "dependency").map((r) => r.to),
        ),
      ].filter((id) => idx.objects.get(id)?.kind === "library"),
    );
    expect(usedLibs.size).toBeGreaterThan(0);
    expect(new Set(libRows.filter((r) => r.usedBy).map((r) => r.o.id))).toEqual(usedLibs);
    for (const r of libRows.filter((x) => x.usedBy))
      expect(idx.objects.get(r.usedBy!)?.kind).not.toBe("function");
    expect(rows.some((r) => r.o.kind === "library" && usedLibs.has(r.o.id))).toBe(false);
    expect(rows.find((r) => r.o.name === "Agent board")?.branch).toBe(true);
  });

  it("opens into folders, then files, then functions, folders first", () => {
    const { idx, id } = board();
    const rows = navRows(idx, new Set([id("Agent board"), id("board"), id("board-core")]));
    const names = rows.map((r) => `${"  ".repeat(r.depth)}${r.o.name}:${r.icon}`);
    expect(names).toContain("    board:folder");
    expect(names).toContain("      guards.rs:file");
    expect(names.indexOf("    board:folder")).toBeLessThan(
      names.indexOf("    session-start.sh:file"),
    );
    const guards = rows.find((r) => r.o.name === "guards.rs")!;
    expect(guards.branch).toBe(true);
    expect(guards.open).toBe(false);
  });

  it("a filter keeps what matched and the way to it, opened", () => {
    const { idx, id } = board();
    const rows = navRows(idx, new Set(), new Set([id("post_message()")]));
    expect(rows.map((r) => r.o.name)).toEqual([
      "Agent board",
      "board",
      "board",
      "hub/routes.rs",
      "post_message()",
    ]);
    expect(rows.at(-1)!.icon).toBe("function");
    expect(rows.at(-1)!.lastAt).toHaveLength(4);
  });

  it("compacts folders that each hold one folder into one row", () => {
    const { idx, id } = board();
    const a = makeObject({
      kind: "module",
      name: "crates",
      parentId: id("board"),
      path: "r:crates",
    });
    const b = makeObject({
      kind: "module",
      name: "evidence",
      parentId: a.id,
      path: "r:crates/evidence",
    });
    const c = makeObject({
      kind: "module",
      name: "src",
      parentId: b.id,
      path: "r:crates/evidence/src",
    });
    const f = makeObject({
      kind: "module",
      name: "lib.rs",
      parentId: c.id,
      path: "r:crates/evidence/src/lib.rs",
    });
    const g = makeObject({
      kind: "module",
      name: "x.rs",
      parentId: c.id,
      path: "r:crates/evidence/src/x.rs",
    });
    const more = buildIndex({
      objects: [...idx.objects.values(), a, b, c, f, g],
      connections: idx.connections.values(),
      diagrams: idx.diagrams.values(),
      placements: [],
      flows: [],
      boundaries: [],
    });
    const rows = navRows(more, new Set([id("Agent board"), id("board"), c.id]));
    const row = rows.find((r) => r.o.id === c.id)!;
    expect(rowLabel(row)).toBe("crates/evidence/src");
    expect(rows.some((r) => r.o.id === a.id || r.o.id === b.id)).toBe(false);
    expect(rows.filter((r) => r.depth === row.depth + 1).map((r) => r.o.name)).toEqual([
      "lib.rs",
      "x.rs",
    ]);
  });
});
