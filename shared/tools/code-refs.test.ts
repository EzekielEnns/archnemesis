// Code in the tools (trial 7): repo:path and repo:path#fn wherever an id goes, ids on every
// line, import placing code by the boxes' paths, read {ref} on a file in counts, guesses kept
// apart (hide_lines, crossings), null on a new thing, and flow steps with no connection.
import { describe, expect, it } from "vitest";
import { seedOps } from "../seed.ts";
import { planChanges } from "../agent.ts";
import { importChanges, importSummary, type CodeIndex } from "../codeindex.ts";
import { keyOps } from "../files.ts";
import { projectDiagram } from "../project.ts";
import { scoreGraph } from "../score.ts";
import { memHost } from "./memhost.ts";
import { runTool, tool, type ToolName } from "./tools.ts";

function shop() {
  const h = memHost({ ops: seedOps() });
  h.commit(keyOps(h.state()), "keys", { undo: false });
  return h;
}
const call = (h: ReturnType<typeof shop>, name: ToolName, args: Record<string, unknown> = {}) =>
  runTool(tool(name), { host: h }, args);

/** web: server/a.ts (run, five callers of helper, Store.save), server/tools/b.ts (helper), server/types.ts (no functions), scripts/c.ts (go). */
function web(): CodeIndex {
  const fn = (file: string, name: string, line: number, owner?: string) => ({
    symbol: `${file}#${owner ? `${owner}.` : ""}${name}`,
    name,
    file,
    line,
    ...(owner ? { owner } : {}),
  });
  const callers = [1, 2, 3, 4, 5].map((i) => fn("server/a.ts", `step${i}`, 10 + i));
  return {
    repo: "web",
    files: ["server/a.ts", "server/tools/b.ts", "server/types.ts", "scripts/c.ts"].map((path) => ({
      path,
      language: "typescript",
    })),
    functions: [
      fn("server/a.ts", "run", 1),
      fn("server/a.ts", "save", 5, "Store"),
      ...callers,
      fn("server/tools/b.ts", "helper", 1),
      fn("scripts/c.ts", "go", 1),
    ],
    calls: [
      { from: "server/a.ts#run", to: "server/tools/b.ts#helper", confidence: "exact" as const },
      ...callers.map((c) => ({
        from: c.symbol,
        to: "server/tools/b.ts#helper",
        confidence: "name" as const,
      })),
    ],
    uses: [],
    packages: [],
  };
}

/** The shop, its API's code root at web:server, and web imported under the shop. */
async function imported() {
  const h = shop();
  expect(
    (await call(h, "write", { yaml: 'objects:\n  shop-api: {path: "web:server"}' })).isError,
  ).toBeFalsy();
  const plan = importChanges(h.index(), web(), { under: "shop", calls: "all" });
  h.commit(planChanges(h.state(), h.index(), plan.changes).ops, "import");
  return { h, plan };
}
const byName = (h: ReturnType<typeof shop>, name: string) =>
  [...h.state().objects.values()].find((o) => o.name === name)!;

describe("import, placed by the boxes' paths", () => {
  it("puts a folder a box has the path of in that box, the rest in under, and says so in the dry run", async () => {
    const { h, plan } = await imported();
    const api = byName(h, "Shop API");
    // server/ is the API itself: its files go straight in, no folder module beside it.
    expect([...h.state().objects.values()].filter((o) => o.path === "web:server")).toHaveLength(1);
    expect(byName(h, "a.ts").parentId).toBe(api.id);
    expect(byName(h, "tools").parentId).toBe(api.id);
    expect(byName(h, "scripts").parentId).toBe(byName(h, "Shop").id);
    // A file with no functions is a module too; a method is named with its class.
    expect(byName(h, "types.ts").kind).toBe("module");
    expect(byName(h, "Store.save()").kind).toBe("function");
    const said = importSummary(plan, { under: "shop" });
    expect(said).toMatch(/where they go/);
    expect(said).toMatch(
      /shop-api \(by its path\): server\/tools\/, server\/a\.ts, server\/types\.ts; 4 files and folders, 8 functions/,
    );
    expect(said).toMatch(/shop \(under\): scripts\/; 2 files and folders, 1 function\b/);
  });
});

describe("code refs wherever an id goes", () => {
  it("in write's keys, in:, connection ends, a view's scope, boxes and flow steps, and remove", async () => {
    const { h } = await imported();
    const r = await call(h, "write", {
      yaml: [
        "objects:",
        '  "web:server/a.ts#run": {context: "Starts it all."}',
        '  "web:server/a.ts#Store.save": {context: "Saves."}',
        '  fresh: {kind: function, name: fresh(), in: "web:server/tools/b.ts"}',
        "connections:",
        '  - {from: "web:server/a.ts#run", to: "web:scripts/c.ts#go", label: kicks off}',
        "views:",
        "  a-file:",
        "    name: The a file",
        '    scope: "web:server/a.ts"',
        "    flows:",
        '      - {name: start, steps: [{from: "web:server/a.ts#run", to: "web:server/tools/b.ts#helper", text: calls}]}',
        "  picked:",
        "    name: Picked",
        '    boxes: ["web:server/a.ts#run", "web:scripts/c.ts"]',
      ].join("\n"),
    });
    expect(r.isError, r.text).toBeFalsy();
    expect(byName(h, "run()").description).toBe("Starts it all.");
    expect(byName(h, "Store.save()").description).toBe("Saves.");
    expect(byName(h, "fresh()").parentId).toBe(byName(h, "b.ts").id);
    expect(
      [...h.state().connections.values()].some(
        (c) => c.fromId === byName(h, "run()").id && c.toId === byName(h, "go()").id,
      ),
    ).toBe(true);
    const view = [...h.state().diagrams.values()].find((d) => d.name === "The a file")!;
    expect(view.scopeId).toBe(byName(h, "a.ts").id);
    // A bare method name still finds it.
    expect((await call(h, "read", { ref: "web:server/a.ts#save" })).text).toContain("Store.save()");
    const gone = await call(h, "write", {
      remove: ["web:server/a.ts#run>web:scripts/c.ts#go:kicks off", "web:scripts/c.ts#go"],
    });
    expect(gone.isError, gone.text).toBeFalsy();
    expect([...h.state().objects.values()].some((o) => o.name === "go()")).toBe(false);
  });

  it("says a code ref that names nothing, and how to add it", async () => {
    const { h } = await imported();
    const r = await call(h, "write", {
      yaml: 'objects:\n  "web:server/zzz.ts": {kind: module}\nconnections:\n  - {from: "web:server/a.ts#nope", to: shop-api}',
    });
    expect(r.text).toContain(
      "no box has the code ref web:server/zzz.ts: a new box takes an id as its key, with the ref as its path (zzz: {kind: module, path: web:server/zzz.ts})",
    );
    // The file is there: the name isn't one of its functions, and its functions are named (trial 15).
    expect(r.text).toContain(
      "no box has the code ref web:server/a.ts#nope: web:server/a.ts is there, but the indexer gave no function nope in it",
    );
    expect(r.text).toContain("web:server/a.ts#run");
  });

  it("shows the id beside the ref on search and read lines", async () => {
    const { h } = await imported();
    const run = byName(h, "run()");
    expect((await call(h, "read", { q: "run" })).text).toContain(
      `web:server/a.ts#run [id ${run.key ?? run.id}]`,
    );
    expect((await call(h, "read", { ref: "web:server/tools/b.ts#helper" })).text).toContain(
      `[web:server/a.ts#run · id ${run.key ?? run.id}]`,
    );
  });

  it("reads a file's calls once each, counted, and capped with how many more", async () => {
    const { h } = await imported();
    // Guessed calls are left out unless asked for (trial 8).
    expect((await call(h, "read", { ref: "web:server/a.ts" })).text).toContain(
      "5 guessed calls left out",
    );
    const t = (await call(h, "read", { ref: "web:server/a.ts", guesses: true })).text;
    expect(t).toMatch(
      /calls \(6, 2 different\):\n {2}→ \[web:server\/tools\/b\.ts#helper · id [^\]]+\] \(guess\) ×5\n {2}→ \[web:server\/tools\/b\.ts#helper · id [^\]]+\]\n/,
    );
    const capped = (await call(h, "read", { ref: "web:server/a.ts", limit: 2 })).text;
    expect(capped).toMatch(
      /inside it \(7\):(\n {2}function .+){2}\n {2}… 5 more: read \{q: "", in: "[^"]+", limit: 7\}/,
    );
  });
});

describe("guesses kept apart", () => {
  it("hides guessed lines on a view, and scores their crossings apart", async () => {
    const { h } = await imported();
    const w = await call(h, "write", {
      yaml: 'views:\n  calls:\n    name: Calls\n    boxes: ["web:server/a.ts#step1", "web:server/a.ts#step2", "web:server/a.ts#run", "web:server/tools/b.ts#helper"]\n    hide_lines: [{guess: true}]',
    });
    expect(w.isError, w.text).toBeFalsy();
    const d = [...h.state().diagrams.values()].find((x) => x.name === "Calls")!;
    const g = projectDiagram(h.index(), d.id);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]!.guess).toBeUndefined();
    // Two lines crossing, one a guess: not the layout's crossing.
    const box = (id: string, x: number, y: number) => ({ id, x, y, w: 10, h: 10 });
    const graph = {
      groups: [],
      nodes: [box("a", 0, 0), box("b", 100, 100), box("c", 100, 0), box("d", 0, 100)],
      edges: [
        { id: "1", from: "a", to: "b" },
        { id: "2", from: "c", to: "d", guess: true as const },
      ],
    };
    expect(scoreGraph(graph as never)).toMatchObject({ crossings: 0, guessCrossings: 1 });
  });

  it("takes guess: null on a new connection as not set", async () => {
    const { h } = await imported();
    const r = await call(h, "write", {
      yaml: 'connections:\n  - {from: "web:scripts/c.ts#go", to: "web:server/a.ts#run", label: starts, guess: null}',
    });
    expect(r.isError, r.text).toBeFalsy();
    expect([...h.state().connections.values()].find((c) => c.name === "starts")?.guess).toBeFalsy();
  });
});

describe("flow steps", () => {
  // A flow is a guide through any boxes: a step needs no connection under it, either way.
  it("takes a step between any two boxes without a warning", async () => {
    const h = shop();
    const r = await call(h, "write", {
      yaml: "views:\n  story:\n    name: Story\n    scope: shop\n    flows:\n      - {name: buy, steps: [{from: storefront, to: shop-api, text: orders}, {from: payments, to: email, text: tells}]}",
    });
    expect(r.isError, r.text).toBeFalsy();
    expect(r.text).not.toContain("no connection storefront → shop-api");
    expect(r.text).not.toContain("no connection");
  });
});
