// Opening a running box follows its process to the code it runs (s-chan feedback, round 6).
import { describe, expect, it } from "vitest";
import { codeFor, codeHolder, insideAction, openCode } from "./actions.ts";
import { makeBoundary, makeObject } from "./model.ts";
import { buildIndex } from "./project.ts";

// The runtime tree (system → hub app) and the code tree (repo → board → hub/ → handlers.rs)
// apart, tied only by a process boundary that holds both.
const sys = makeObject({ id: "sys", kind: "system", name: "board" });
const hub = makeObject({ id: "hub", kind: "app", name: "board hub", parentId: "sys" });
const cli = makeObject({ id: "cli", kind: "app", name: "board CLI", parentId: "sys" });
const repo = makeObject({ id: "repo", kind: "module", name: "repo" });
const hubMod = makeObject({ id: "hub-mod", kind: "module", name: "hub/", parentId: "repo" });
const handlers = makeObject({
  id: "handlers",
  kind: "module",
  name: "handlers.rs",
  parentId: "hub-mod",
});
const store = makeObject({ id: "store-mod", kind: "module", name: "store.rs", parentId: "repo" });
const nodeMod = makeObject({ id: "node-mod", kind: "module", name: "node/", parentId: "repo" });
const pHub = makeBoundary({
  id: "p-hub",
  kind: "process",
  name: "hub process",
  rules: { include: [{ ids: ["hub", "hub-mod", "store-mod"] }], exclude: [] },
});
const pNode = makeBoundary({
  id: "p-node",
  kind: "process",
  name: "node process",
  rules: { include: [{ ids: ["node-mod"] }], exclude: [] },
});
const idx = buildIndex({
  objects: [sys, hub, cli, repo, hubMod, handlers, store, nodeMod],
  connections: [],
  diagrams: [],
  placements: [],
  flows: [],
  boundaries: [pHub, pNode],
});

describe("opening a running box", () => {
  it("finds the top of the code its process runs", () => {
    expect(codeFor(idx, "hub").sort()).toEqual(["hub-mod", "store-mod"]);
    expect(insideAction(idx, "hub")).toBe("open");
  });
  it("opens a view of it, scoped to the box", () => {
    const { ops } = openCode(idx, "hub", codeFor(idx, "hub"));
    const d = ops.find((o) => o.op === "diagram.put");
    expect(d && d.op === "diagram.put" && d.diagram.scopeId).toBe("hub");
    expect(ops.filter((o) => o.op === "placement.put")).toHaveLength(2);
  });
  it("leaves alone what has no process, or an inside of its own", () => {
    expect(codeFor(idx, "cli")).toEqual([]);
    expect(codeFor(idx, "sys")).toEqual([]);
    expect(codeFor(idx, "hub-mod")).toEqual([]);
  });
});

describe("sketching code by hand", () => {
  it("drops a function into a file, a file into a folder or app", () => {
    expect(codeHolder(idx, "function", "handlers")).toBe("handlers");
    expect(codeHolder(idx, "function", "hub-mod")).toBe("hub-mod");
    expect(codeHolder(idx, "function", "hub")).toBeNull();
    expect(codeHolder(idx, "module", "repo")).toBe("repo");
    expect(codeHolder(idx, "module", "hub")).toBe("hub");
  });
});
