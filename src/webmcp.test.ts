// The page's WebMCP: the shared tools registered with the browser's modelContext, acting as the
// person on the open design.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UndoSteps, type Actor } from "../shared/doc.ts";
import { keyOps } from "../shared/files.ts";
import { makeDiagram, makeObject, type Op } from "../shared/model.ts";
import { memHost } from "../shared/tools/memhost.ts";
import type { Store } from "./store.ts";
import { modelContext, registerWebMcp } from "./webmcp.ts";

type Registered = {
  name: string;
  description: string;
  inputSchema: { properties?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean };
  execute: (i: Record<string, unknown>) => Promise<string>;
};

/** A small design to read and write: a shop with a checkout in it, on one diagram. */
function fixtureOps(): Op[] {
  const shop = makeObject({ kind: "system", name: "Shop" });
  const checkout = makeObject({ kind: "component", name: "Checkout", parentId: shop.id });
  const d = makeDiagram({ name: "Shop", scopeId: shop.id });
  return [
    { op: "object.put", object: shop },
    { op: "object.put", object: checkout },
    { op: "diagram.put", diagram: d },
    {
      op: "placement.put",
      placement: { diagramId: d.id, objectId: shop.id, x: 0, y: 0, w: 400, h: 300 },
    },
    {
      op: "placement.put",
      placement: { diagramId: d.id, objectId: checkout.id, x: 40, y: 60, w: 160, h: 80 },
    },
  ] as Op[];
}

function fakeStore(mode: "edit" | "mirror" = "edit") {
  const h = memHost({ ops: fixtureOps(), actor: { id: "local:You", name: "You", kind: "human" } });
  h.commit(keyOps(h.state()), "keys", { undo: false });
  const store = {
    design: "example",
    designKey: "example",
    branch: null,
    me: { id: "local:You", name: "You", kind: "human" },
    canEdit: true,
    mode,
    config: {},
    canUndo: true,
    model: () => h.state(),
    index: () => h.index(),
    liveIndex: () => h.index(),
    send: async (ops: never[], label: string) => h.commit(ops, label),
    undo: async () => void h.undo!(),
    // As the store's: the agent's own steps on the same doc.
    helper: (actor: Actor) => {
      const steps = new UndoSteps(h.doc, { agent: actor.id });
      return {
        send: async (ops: never[], label: string, opts?: object) =>
          void steps.apply(h.state(), ops, actor, label, opts),
        undo: (dry?: boolean) => steps.undo(dry),
      };
    },
    log: (n: number) => h.recent!(n),
    gitAction: {
      fork: async () => ({ doc: "example@mine" }),
      propose: async () => ({ url: null, branch: "b" }),
    },
  };
  return { h, store: store as unknown as Store };
}

describe("WebMCP in the page", () => {
  let tools: Map<string, Registered>;
  let signals: AbortSignal[];
  beforeEach(() => {
    tools = new Map();
    signals = [];
    const mc = {
      registerTool: (t: Registered, o?: { signal?: AbortSignal }) => {
        tools.set(t.name, t);
        if (o?.signal) signals.push(o.signal);
      },
      unregisterTool: (name: string) => void tools.delete(name),
    };
    Object.assign(globalThis, {
      document: { modelContext: mc },
      location: { origin: "http://localhost:5190", pathname: "/" },
    });
  });
  afterEach(() => {
    delete (globalThis as { document?: unknown }).document;
  });

  it("does nothing where the browser has no WebMCP", () => {
    (globalThis as { document: object }).document = {};
    expect(modelContext()).toBeNull();
    const { store } = fakeStore();
    registerWebMcp(store, () => undefined)();
  });

  it("registers seven tools with JSON schemas, without design or index", () => {
    const { store } = fakeStore();
    registerWebMcp(store, () => undefined);
    expect([...tools.keys()]).toEqual([
      "read",
      "write",
      "note",
      "show",
      "guide",
      "design",
      "feedback",
    ]);
    expect(tools.get("read")!.inputSchema.properties).toHaveProperty("q");
    expect(tools.get("read")!.inputSchema.properties).not.toHaveProperty("design");
    expect(tools.get("read")!.annotations?.readOnlyHint).toBe(true);
  });

  it("reads and writes the open design as the person, and unregisters when it closes", async () => {
    const { h, store } = fakeStore();
    const off = registerWebMcp(store, () => undefined);
    expect(await tools.get("read")!.execute({ q: "checkout" })).toContain("checkout  Checkout");
    const w = await tools
      .get("write")!
      .execute({ yaml: "objects:\n  billing: {kind: app, in: shop}\n" });
    expect(w).toMatch(/^Written/);
    expect([...h.index().objects.values()].some((o) => o.key === "billing")).toBe(true);
    // In its own name, for the person: history says so, and its undo takes back only its own.
    expect(h.recent!(1)[0]!.actor).toMatchObject({ name: "Agent (for You)", kind: "agent" });
    await store.send(
      [
        {
          op: "object.put",
          object: {
            ...[...h.index().objects.values()].find((o) => o.key === "checkout")!,
            description: "the person's own edit",
          },
        },
      ] as never,
      "person",
    );
    expect(await tools.get("write")!.execute({ undo: true, dry_run: true })).toContain(
      "would take back: wrote 1 box",
    );
    expect(await tools.get("write")!.execute({ undo: true })).toBe("Undone: wrote 1 box.");
    expect([...h.index().objects.values()].some((o) => o.key === "billing")).toBe(false);
    expect([...h.index().objects.values()].find((o) => o.key === "checkout")!.description).toBe(
      "the person's own edit",
    );
    expect(await tools.get("read")!.execute({ design: "other" })).toMatch(
      /^This page has example open, not other/,
    );
    off();
    expect(tools.size).toBe(0);
    expect(signals.every((s) => s.aborted)).toBe(true);
  });

  it("says a write on a design that follows git went to the fork; design can't delete", async () => {
    const { store } = fakeStore("mirror");
    registerWebMcp(store, () => undefined);
    expect(
      await tools.get("write")!.execute({ yaml: "objects:\n  billing: {kind: app, in: shop}\n" }),
    ).toContain("went to your fork");
    expect(await tools.get("design")!.execute({ action: "delete", key: "example" })).toMatch(
      /^In this page design does list, fork/,
    );
    expect(
      (tools.get("design")!.inputSchema.properties as { action: { enum: string[] } }).action.enum,
    ).toEqual(["list", "fork", "propose"]);
    expect(await tools.get("design")!.execute({ action: "fork" })).toContain("example@mine");
  });

  it("drives the page's canvas: show and here are direct", async () => {
    const { store } = fakeStore();
    const shown: string[] = [];
    registerWebMcp(store, () => ({
      show: async (s) => (shown.push(s.say), null),
      end: () => {},
      here: () => ({ diagram: null, selection: [] }),
    }));
    await tools.get("show")!.execute({ open: "checkout", say: "This one" });
    expect(shown).toEqual(["This one"]);
  });
});
