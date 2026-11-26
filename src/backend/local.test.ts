// The backend with no server: designs in the browser's storage (a fake IndexedDB here).
import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { applyOps, readState } from "../../shared/doc.ts";
import { makeObject } from "../../shared/model.ts";
import { createLocalBackend, type ListStore } from "./local.ts";
import { BackendError, type Backend, type DocConnection } from "./types.ts";

const person = { id: "local:You", name: "You", kind: "human" } as const;

function memoryList(): ListStore {
  let text: string | null = null;
  return { read: () => text, write: (v) => void (text = v) };
}

/** Open a design's document and wait until it has loaded. */
async function open(backend: Backend, key: string): Promise<{ ydoc: Y.Doc; conn: DocConnection }> {
  const info = await backend.designs.info(key);
  const ydoc = new Y.Doc();
  let loaded = () => {};
  const live = new Promise<void>((resolve) => (loaded = resolve));
  const conn = backend.designs.open(info, ydoc, {
    onStatus: (s) => s === "live" && loaded(),
    onEvent: () => {},
  });
  await live;
  return { ydoc, conn };
}

/** Edit the way a person's tab does: ops applied to the document, in their name. */
function edit(ydoc: Y.Doc, ...objects: ReturnType<typeof makeObject>[]) {
  const state = readState(ydoc);
  applyOps(
    ydoc,
    state,
    objects.map((object) => ({ op: "object.put" as const, object })),
    person,
    "test edit",
  );
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("the local backend", () => {
  it("starts a new install with one empty design, not the example", async () => {
    const b = createLocalBackend(memoryList());
    const list = await b.designs.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: "My design", objects: 0, git: false, mine: true });
    const { ydoc, conn } = await open(b, list[0]!.key);
    const state = readState(ydoc);
    expect(state.objects.size).toBe(0);
    expect([...state.diagrams.values()].map((d) => d.name)).toEqual(["Landscape"]);
    conn.close();
  });

  it("makes a design from the example shop when asked, and an empty one otherwise", async () => {
    const b = createLocalBackend(memoryList());
    const shop = await b.designs.create("Shop", { example: true });
    const blank = await b.designs.create("Blank");
    const full = await open(b, shop.key);
    const names = [...readState(full.ydoc).objects.values()].map((o) => o.name);
    expect(names).toEqual(expect.arrayContaining(["Customer", "Shop", "Payments"]));
    // It's the person's own design: they can edit it.
    edit(full.ydoc, makeObject({ kind: "system", name: "Mine" }));
    expect([...readState(full.ydoc).objects.values()].map((o) => o.name)).toContain("Mine");
    full.conn.close();
    const empty = await open(b, blank.key);
    expect(readState(empty.ydoc).objects.size).toBe(0);
    empty.conn.close();
  });

  it("creates, lists and deletes designs", async () => {
    const b = createLocalBackend(memoryList());
    const a = await b.designs.create("Shop");
    const again = await b.designs.create("Shop");
    expect(a.key).toBe("shop");
    expect(again.key).toBe("shop-2");
    expect((await b.designs.list()).map((d) => d.key)).toEqual(["my-design", "shop", "shop-2"]);
    await b.designs.remove("shop");
    expect((await b.designs.list()).map((d) => d.key)).toEqual(["my-design", "shop-2"]);
    await expect(b.designs.info("shop")).rejects.toMatchObject({ code: "missing" });
    await expect(b.designs.create("  ")).rejects.toBeInstanceOf(BackendError);
    // A fork is a git thing: there are none here.
    await expect(b.designs.info("shop-2@mine")).rejects.toMatchObject({ code: "missing" });
  });

  it("keeps edits when a design is opened again, and in the list it saves", async () => {
    const list = memoryList();
    const b = createLocalBackend(list);
    const { key } = await b.designs.create("Persist");
    const first = await open(b, key);
    const shop = makeObject({ kind: "system", name: "Shop" });
    edit(first.ydoc, shop);
    // Let the cache write it, then close the tab.
    await new Promise((r) => setTimeout(r, 50));
    first.conn.close();

    // A new tab, and even a new backend over the same storage, see it.
    const again = await open(createLocalBackend(list), key);
    expect([...readState(again.ydoc).objects.values()].map((o) => o.name)).toEqual(["Shop"]);
    again.conn.close();
    expect((await b.designs.state(key)).objects.map((o) => o.name)).toEqual(["Shop"]);
  });

  it("brings views that follow rules in line after an edit", async () => {
    const b = createLocalBackend(memoryList());
    const { key } = await b.designs.create("Rules");
    const { ydoc, conn } = await open(b, key);
    const shop = makeObject({ kind: "system", name: "Shop" });
    edit(ydoc, shop);
    const placed = () => readState(ydoc).placements.size > 0;
    await until(placed);
    const state = readState(ydoc);
    expect([...state.placements.values()].map((p) => p.objectId)).toEqual([shop.id]);
    // The server's own edits aren't in anyone's undo, and are logged as the system.
    expect(readState(ydoc).diagrams.size).toBe(1);
    conn.close();
  });

  it("sweeps up references left dangling", async () => {
    const b = createLocalBackend(memoryList());
    const { key } = await b.designs.create("Sweep");
    const { ydoc, conn } = await open(b, key);
    const a = makeObject({ kind: "system", name: "A" });
    edit(ydoc, a);
    await until(() => readState(ydoc).placements.size === 1);
    applyOps(ydoc, readState(ydoc), [{ op: "object.delete", id: a.id }], person, "remove it");
    await until(() => readState(ydoc).placements.size === 0);
    conn.close();
  });

  it("is one person with edit rights, and nothing that needs a server", async () => {
    const b = createLocalBackend(memoryList());
    expect(await b.config()).toMatchObject({
      auth: "local",
      signin: { kind: "none" },
      mcp: null,
    });
    expect(await b.me()).toMatchObject({ kind: "human", admin: true });
    expect((await b.designs.info("my-design")).canEdit).toBe(true);
    for (const absent of [
      "git",
      "github",
      "tokens",
      "signIn",
      "oauth",
      "versions",
      "insights",
      "report",
      "telemetry",
      "trail",
      "guide",
    ] as const)
      expect(b[absent]).toBeUndefined();
    expect(b.designs.share).toBeUndefined();
    expect(b.icons.url).toBeUndefined();
  });

  it("answers icon questions from the Simple Icons package", async () => {
    const b = createLocalBackend(memoryList());
    expect(await b.icons.search("postgre")).toContain("PostgreSQL");
    expect(await b.icons.svg("Postgres", "brand")).toMatch(/^<svg/);
    expect(await b.icons.svg("Totally made up")).toBeNull();
  });

  it("uses the name this browser remembers", async () => {
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => (k === "archnm.name" ? "Zed" : null),
    });
    try {
      expect((await createLocalBackend(memoryList()).me()).name).toBe("Zed");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
