// Big inputs stay fast: an import the size of a real repo, and writes and lenses on a design of
// thousands of boxes. Trial 6 hung the server for minutes on 1,835 functions (each change
// re-checked the whole batch so far). Bounds are generous; the times are printed.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Auth, type Principal } from "./auth.ts";
import { testConfig } from "./testing.ts";
import { Hub } from "./live.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { buildServer } from "./mcp.ts";
import { Uploads } from "./uploads.ts";
import { DocStore } from "./store.ts";
import * as Y from "yjs";
import { planChanges } from "../shared/agent.ts";
import { importChanges } from "../shared/codeindex.ts";
import { applyOps, emptyState, mirror, type Actor } from "../shared/doc.ts";
import { keyOps } from "../shared/files.ts";
import { buildIndex } from "../shared/project.ts";
import { seedOps } from "../shared/seed.ts";
import { bigIndex } from "./scale-index.ts";
import { memHost } from "../shared/tools/memhost.ts";
import { runTool, tool } from "../shared/tools/tools.ts";

const me: Actor = { id: "t", name: "T", kind: "agent" };
const BOUND = 10_000;

function shop() {
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
  return { doc, state, idx };
}

const time = async <T>(what: string, f: () => T | Promise<T>): Promise<{ ms: number; out: T }> => {
  const t0 = performance.now();
  const out = await f();
  const ms = Math.round(performance.now() - t0);
  console.log(`${what}: ${ms} ms`);
  return { ms, out };
};

describe("checking a batch a change at a time", () => {
  it("names each change that can't be made, changes nothing, and with skip takes back only those", () => {
    const s = shop();
    const changes = [
      { add: { id: "a1", kind: "component" as const, name: "A1", in: "cart" } },
      // Its key is taken by a1, added before it: only this change fails.
      { add: { id: "a2", kind: "component" as const, name: "A2", in: "cart" } },
      { update: "a2", set: { in: "nowhere" } },
      { connect: { from: "a1", to: "a2", label: "calls" } },
      { add: { id: "a3", kind: "component" as const, name: "A3", in: "a1" } },
    ];
    expect(() => planChanges(s.state, s.idx(), changes)).toThrow(
      /1 of 5 change\(s\) can't be made, so nothing was applied:\nchange 3 \(update a2\): no object "nowhere"/,
    );
    expect(s.state.objects.has("a1")).toBe(false);
    const p = planChanges(s.state, s.idx(), changes, {}, { onError: "skip" });
    expect(p.skipped).toEqual([expect.stringMatching(/^change 3 \(update a2\)/)]);
    applyOps(s.doc, s.state, p.ops, me, "batch");
    expect(["a1", "a2", "a3"].every((k) => s.state.objects.has(k))).toBe(true);
    expect(
      [...s.state.connections.values()].some((c) => c.fromId === "a1" && c.toId === "a2"),
    ).toBe(true);
    // A key that's taken by something the batch changed (the checks see the batch so far).
    expect(() =>
      planChanges(s.state, s.idx(), [
        { add: { id: "a1", kind: "component" as const, name: "Again" } },
        { update: "a3", set: { in: "a3" } },
      ]),
    ).toThrow(/change 2 \(update a3\): .*inside itself/);
  });
});

describe("at scale", () => {
  it("plans and applies an import of 2,000 functions and 4,000 calls in seconds", async () => {
    const s = shop();
    const index = bigIndex(Number(process.env.SCALE_FILES) || 200);
    const { ms: dry, out: planned } = await time("import plan (dry run)", () =>
      planChanges(s.state, s.idx(), importChanges(s.idx(), index, { under: "cart" }).changes),
    );
    expect(planned.ops.length).toBeGreaterThan(5000);
    expect(dry).toBeLessThan(BOUND);
    const { ms: real } = await time("import plan + apply", () => {
      const p = planChanges(
        s.state,
        s.idx(),
        importChanges(s.idx(), index, { under: "cart" }).changes,
      );
      applyOps(s.doc, s.state, p.ops, me, "import");
    });
    expect(real).toBeLessThan(BOUND);
    expect([...s.state.objects.values()].filter((o) => o.kind === "function").length).toBe(
      index.functions.length,
    );
    // Again, on top of itself: refreshes, not adds.
    const { ms: again } = await time("re-import plan", () =>
      planChanges(s.state, s.idx(), importChanges(s.idx(), index, { under: "cart" }).changes),
    );
    expect(again).toBeLessThan(BOUND);
  }, 60_000);

  it("commits that import to a live design (and reads it back) in seconds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "archnm-scale-"));
    const hub = new Hub(
      new DocStore(join(dir, "archnm.sqlite")),
      new Auth(testConfig(dir).auth),
      testConfig(dir),
    );
    await hub.start();
    try {
      const who: Principal = { id: "agent:t", name: "T", kind: "agent", roles: ["admin"] };
      const live = await hub.create("Big", "big", "example", who);
      const changes = importChanges(live.index(), bigIndex(), { under: "cart" }).changes;
      const { out: p } = await time("live: plan", () =>
        planChanges(live.state, live.index(), changes),
      );
      const { ms } = await time("live: commit + index", () => {
        live.commit(who, p.ops, "import");
        return live.index().objects.size;
      });
      expect(ms).toBeLessThan(BOUND);
    } finally {
      await hub.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  // A design of 5,000 boxes (the import above, plus the shop) and 10,000 connections.
  const bigHost = () => {
    const h = memHost({ ops: seedOps() });
    h.commit(keyOps(h.state()), "keys", { undo: false });
    const p = planChanges(
      h.state(),
      h.index(),
      importChanges(h.index(), bigIndex(450, 11, 2), { under: "cart" }).changes,
    );
    h.commit(p.ops, "import", { undo: false });
    return h;
  };

  // And 5,000 components in one app: one model file of 5,000 entries (finding each one's line was quadratic).
  const flatHost = () => {
    const h = memHost({ ops: seedOps() });
    h.commit(keyOps(h.state()), "keys", { undo: false });
    const t = "2026-01-01T00:00:00.000Z";
    const cart = [...h.state().objects.values()].find((o) => o.key === "cart")!;
    const parts = Array.from({ length: 5000 }, (_, i) => ({
      op: "object.put" as const,
      object: {
        id: `part${i}`,
        key: `part${i}`,
        kind: "component" as const,
        name: `Part ${i}`,
        description: "A part.",
        technology: "Go",
        status: "live" as const,
        parentId: cart.id,
        external: false,
        tags: [],
        createdAt: t,
        updatedAt: t,
      },
    }));
    const calls = parts.map((p, i) => ({
      op: "connection.put" as const,
      connection: {
        id: `c${i}`,
        fromId: p.object.id,
        toId: `part${(i * 7 + 1) % 5000}`,
        name: "calls",
        description: "",
        technology: "",
        status: "live" as const,
      },
    }));
    h.commit([...parts, ...calls], "parts", { undo: false });
    return h;
  };

  it("writes to a design of 5,000 boxes in one file in seconds", async () => {
    const h = flatHost();
    const { ms, out } = await time("write: one change, 5,000 boxes in one file", () =>
      runTool(tool("write"), { host: h }, { yaml: "objects:\n  part7: {tech: Rust}" }),
    );
    expect(out.isError, out.text).toBeFalsy();
    expect(ms).toBeLessThan(BOUND);
    const { ms: lens } = await time("read lens problems, 5,000 boxes in one file", () =>
      runTool(tool("read"), { host: h }, { lens: "problems" }),
    );
    expect(lens).toBeLessThan(BOUND);
  }, 60_000);

  it("writes to a 5,000-box design in seconds", async () => {
    const h = bigHost();
    expect(h.index().objects.size).toBeGreaterThan(5000);
    const { ms, out } = await time("write: 20 boxes and 20 connections on 5,000 boxes", () =>
      runTool(
        tool("write"),
        { host: h },
        {
          yaml: `objects:\n${Array.from({ length: 20 }, (_, i) => `  svc${i}: {kind: component, in: cart, context: "Part ${i}."}`).join("\n")}\nconnections:\n${Array.from({ length: 20 }, (_, i) => `  - {from: svc${i}, to: checkout, label: calls}`).join("\n")}`,
        },
      ),
    );
    expect(out.isError, out.text).toBeFalsy();
    expect(ms).toBeLessThan(BOUND);
    const { ms: dry } = await time("write: dry run of one change on 5,000 boxes", () =>
      runTool(
        tool("write"),
        { host: h },
        { yaml: "objects:\n  checkout: {tech: Go}", dry_run: true },
      ),
    );
    expect(dry).toBeLessThan(BOUND);
  }, 60_000);

  it("reads lens problems on a 5,000-box design in seconds", async () => {
    const h = bigHost();
    const { ms, out } = await time("read lens problems on 5,000 boxes", () =>
      runTool(tool("read"), { host: h }, { lens: "problems" }),
    );
    expect(out.isError, out.text).toBeFalsy();
    expect(ms).toBeLessThan(BOUND);
    const { ms: q } = await time("read search on 5,000 boxes", () =>
      runTool(tool("read"), { host: h }, { q: "fn12" }),
    );
    expect(q).toBeLessThan(BOUND);
  }, 60_000);

  it("imports through the MCP with progress, and other calls get in while it works", async () => {
    const dir = mkdtempSync(join(tmpdir(), "archnm-scale-"));
    const hub = new Hub(
      new DocStore(join(dir, "archnm.sqlite")),
      new Auth(testConfig(dir).auth),
      testConfig(dir),
    );
    await hub.start();
    try {
      const who: Principal = { id: "agent:t", name: "T", kind: "agent", roles: ["admin"] };
      await hub.create("Big", "big", "example", who);
      const uploads = new Uploads();
      const ticket = uploads.mint(who.id, "big", "/repo");
      uploads.put(ticket, { survey: { repo: "big" } as never, index: bigIndex() });
      const server = buildServer(
        { hub, uploads, identify: () => who, baseUrl: "http://archnm.test" },
        who,
      );
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(a);
      const client = new Client({ name: "test", version: "1" });
      await client.connect(b);
      const done: string[] = [];
      const progress: string[] = [];
      const { ms, out } = await time(
        "mcp: import (dry run, then for real) + a read alongside",
        async () => {
          const dry = await client.callTool(
            {
              name: "index",
              arguments: { design: "big", action: "import", ticket, under: "cart", dry_run: true },
            },
            CallToolResultSchema,
            { onprogress: (p) => void progress.push(p.message ?? "") },
          );
          const real = client
            .callTool(
              {
                name: "index",
                arguments: { design: "big", action: "import", ticket, under: "cart" },
              },
              CallToolResultSchema,
            )
            .then((r) => (done.push("import"), r));
          const read = client
            .callTool({ name: "read", arguments: { design: "big", q: "cart" } })
            .then(() => void done.push("read"));
          const [r] = await Promise.all([real, read]);
          return { dry, r };
        },
      );
      expect(out.dry.isError, JSON.stringify(out.dry.content)).toBeFalsy();
      expect(out.r.isError, JSON.stringify(out.r.content)).toBeFalsy();
      expect(progress[0]).toBe("planning the import");
      expect(progress.some((m) => /^planned: \d+ changes$/.test(m))).toBe(true);
      // The read didn't wait for the import to finish.
      expect(done[0]).toBe("read");
      expect(ms).toBeLessThan(BOUND);
      await client.close();
    } finally {
      await hub.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
