import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { codeSeedOps } from "../server/seed.ts";
import { planChanges } from "./agent.ts";
import { applyOps, emptyState, fill, mirror, readState } from "./doc.ts";
import { keyOps } from "./files.ts";
import { buildIndex } from "./project.ts";
import { changedWithContext } from "./whatsnew.ts";

const me = { id: "t", name: "T", kind: "agent" as const };
function board() {
  const doc = new Y.Doc();
  const state = emptyState();
  mirror(doc, state, () => {});
  applyOps(doc, state, codeSeedOps(), me, "s");
  applyOps(doc, state, keyOps(state), me, "k");
  const base = emptyState();
  fill(base, readState(doc));
  const idx = () =>
    buildIndex({
      objects: state.objects.values(),
      connections: state.connections.values(),
      diagrams: state.diagrams.values(),
      placements: state.placements.values(),
      flows: state.flows.values(),
      boundaries: state.boundaries.values(),
    });
  const name = (id: string) => state.objects.get(id)?.name;
  return { doc, state, base, idx, name };
}

describe("what's new, with where it plugs in", () => {
  it("is empty with no change", () => {
    const { state, base } = board();
    expect(changedWithContext(base, state)).toEqual({
      changed: [],
      context: [],
      connections: [],
      added: [],
      lines: {},
      removed: [],
      addedConnections: [],
      removedConnections: [],
      removedViews: [],
    });
  });

  it("lights a new function, what it calls and what calls it, and the file it's in", () => {
    const { doc, state, base, idx, name } = board();
    const { ops } = planChanges(state, idx(), [
      { add: { id: "rate-limit", name: "rate_limit()", kind: "function", in: "hub-routes-rs" } },
      { connect: { from: "post-message", to: "rate-limit" } },
      { connect: { from: "rate-limit", to: "append" } },
    ]);
    applyOps(doc, state, ops, me, "plan");
    const w = changedWithContext(base, state);
    expect(w.changed.map(name)).toEqual(["rate_limit()"]);
    expect(w.context.map(name).sort()).toEqual(["append()", "hub/routes.rs", "post_message()"]);
    expect(w.connections).toHaveLength(2);
  });

  it("a new call between two old functions lights both as where it plugs in", () => {
    const { doc, state, base, idx, name } = board();
    const { ops } = planChanges(state, idx(), [{ connect: { from: "events", to: "append" } }]);
    applyOps(doc, state, ops, me, "plan");
    const w = changedWithContext(base, state);
    expect(w.changed).toEqual([]);
    expect(w.context.map(name).sort()).toEqual(["append()", "events()"]);
    expect(w.connections).toHaveLength(1);
  });

  it("a changed field counts; a box moved on a diagram doesn't", () => {
    const { doc, state, base, idx, name } = board();
    const { ops } = planChanges(state, idx(), [
      { update: "axum", set: { package: { ecosystem: "cargo", name: "axum", version: "0.9.0" } } },
    ]);
    applyOps(doc, state, ops, me, "bump");
    const p = [...state.placements.values()][0]!;
    applyOps(doc, state, [{ op: "placement.put", placement: { ...p, x: p.x + 40 } }], me, "move");
    expect(changedWithContext(base, state).changed.map(name)).toEqual(["axum"]);
  });
});

describe("drawn like a file diff", () => {
  it("says what's new, a changed thing's old and new lines, and where a deleted thing sat on main", () => {
    const { doc, state, base, idx, name } = board();
    const axum = [...state.objects.values()].find((o) => o.name === "axum")!;
    const gone = [...state.objects.values()].find((o) => o.name === "serve()")!;
    const sat = [...state.placements.values()].filter((p) => p.objectId === gone.id);
    const { ops } = planChanges(state, idx(), [
      { add: { id: "rate-limit", name: "rate_limit()", kind: "function", in: "hub-routes-rs" } },
      { update: "axum", set: { package: { ecosystem: "cargo", name: "axum", version: "0.9.0" } } },
      { remove: gone.id },
    ]);
    applyOps(doc, state, ops, me, "plan");
    const w = changedWithContext(base, state);
    expect(w.added!.map(name)).toEqual(["rate_limit()"]);
    // Its YAML, line by line: the old version, then the new.
    expect(w.lines![axum.id]!.slice(0, 2)).toEqual([
      ["-", `    version: ${axum.package!.version}`],
      ["+", "    version: 0.9.0"],
    ]);
    expect(w.removed!.map((r) => r.name)).toEqual(["serve()"]);
    expect(Object.keys(w.removed![0]!.at).sort()).toEqual(sat.map((p) => p.diagramId).sort());
  });
});

describe("a new function joins its file's frame", () => {
  it("is placed under its siblings on every diagram that draws the file as a frame, once", () => {
    const { doc, state, idx } = board();
    const code = [...state.diagrams.values()].find((d) => d.name === "board (code)")!;
    const { ops } = planChanges(state, idx(), [
      { add: { id: "rate-limit", name: "rate_limit()", kind: "function", in: "hub-routes-rs" } },
    ]);
    applyOps(doc, state, ops, me, "plan");
    const p =
      state.placements.get(`${code.id}|rate-limit`) ??
      [...state.placements.values()].find(
        (x) => x.diagramId === code.id && x.objectId === "rate-limit",
      );
    expect(p).toBeDefined();
    const events = [...state.placements.values()].find(
      (x) => x.diagramId === code.id && state.objects.get(x.objectId)?.name === "events()",
    )!;
    expect(p!.x).toBe(events.x);
    expect(p!.y).toBe(events.y + events.h + 10);
    expect(p!.h).toBe(40);
    // Only on the code view: no other diagram draws the file as a frame.
    expect([...state.placements.values()].filter((x) => x.objectId === "rate-limit")).toHaveLength(
      1,
    );
  });
});

describe("a growing frame makes room", () => {
  it("moves what's under the file down by the new row", () => {
    const { doc, state, idx } = board();
    const code = [...state.diagrams.values()].find((d) => d.name === "board (code)")!;
    const at = (name: string) =>
      [...state.placements.values()].find(
        (x) => x.diagramId === code.id && state.objects.get(x.objectId)?.name === name,
      )!;
    const before = at("append()").y;
    const serve = at("serve()").y;
    const { ops } = planChanges(state, idx(), [
      { add: { id: "rate-limit", name: "rate_limit()", kind: "function", in: "hub-routes-rs" } },
    ]);
    applyOps(doc, state, ops, me, "plan");
    expect(at("append()").y).toBe(before + 50);
    // Above it, or beside it: left alone.
    expect(at("serve()").y).toBe(serve);
  });
});
