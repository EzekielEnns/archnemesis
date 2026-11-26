// Forks and history in the static build: making a fork, the diff against main, merging, discarding,
// and main's versions, over a fake IndexedDB. Nothing here reaches a network.
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { applyOps, readState } from "../../shared/doc.ts";
import { makeObject } from "../../shared/model.ts";
import { createLocalBackend, type ListStore } from "./local.ts";
import { memoryVersions } from "./local-versions.ts";
import type { Backend, DocConnection, DocEvent } from "./types.ts";

const person = { id: "local:You", name: "You", kind: "human" } as const;

function memory(): ListStore {
  let text: string | null = null;
  return { read: () => text, write: (v) => void (text = v) };
}

function setup() {
  const forks = memory();
  const b = createLocalBackend(memory(), {
    forks,
    versions: memoryVersions(),
    remotes: memory(),
    idleMs: 30,
  });
  return b;
}

interface Opened {
  ydoc: Y.Doc;
  conn: DocConnection;
  events: DocEvent[];
}

async function open(b: Backend, doc: string): Promise<Opened> {
  const info = await b.designs.info(doc);
  const ydoc = new Y.Doc();
  const events: DocEvent[] = [];
  let loaded = () => {};
  const live = new Promise<void>((r) => (loaded = r));
  const conn = b.designs.open(info, ydoc, {
    onStatus: (s) => s === "live" && loaded(),
    onEvent: (e) => events.push(e),
  });
  await live;
  return { ydoc, conn, events };
}

const add = (ydoc: Y.Doc, name: string, label = `added ${name}`) => {
  const object = makeObject({ kind: "system", name });
  applyOps(ydoc, readState(ydoc), [{ op: "object.put", object }], person, label);
  return object;
};
async function gitInfo(b: Backend, key: string) {
  const g = await b.git!.info(key);
  if (!g) throw new Error("no git info");
  return g;
}
const names = (ydoc: Y.Doc) => [...readState(ydoc).objects.values()].map((o) => o.name).sort();

async function until(check: () => boolean | Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("local forks", () => {
  it("keeps main editable and shows it as in the browser", async () => {
    const b = setup();
    const { key } = await b.designs.create("Shop");
    const info = await b.designs.info(key);
    expect(info).toMatchObject({ mode: "edit", git: true, canEdit: true });
    const git = await b.git!.info(key);
    expect(git).toMatchObject({ inBrowser: true, local: false, forge: null, forks: [] });
  });

  it("forks main, shows the change against it, and merges it back with main's own edits", async () => {
    const b = setup();
    const { key } = await b.designs.create("Shop");
    const main = await open(b, key);
    add(main.ydoc, "Shop");
    // A version is kept once edits settle.
    await until(async () => (await b.versions!.list(key)).length >= 2);

    const { doc } = await b.git!.fork(key, "try-cart");
    expect(doc).toBe(`${key}@try-cart`);
    expect((await b.designs.info(doc)).mode).toBe("fork");
    const fork = await open(b, doc);
    expect(names(fork.ydoc)).toEqual(["Shop"]);
    expect((await b.git!.whatsNew(doc))?.changed).toEqual([]);

    // Nothing changed yet: no head, so no merge.
    expect((await gitInfo(b, key)).forks[0]).toMatchObject({ name: "try-cart", head: null });
    const cart = add(fork.ydoc, "Cart");
    expect(names(main.ydoc)).toEqual(["Shop"]);
    const now = await b.git!.whatsNew(doc);
    expect(now?.changed).toContain(cart.id);
    expect((await gitInfo(b, key)).forks[0]!.head).toBeTruthy();

    // Main keeps being edited meanwhile.
    add(main.ydoc, "Billing");
    const out = await b.git!.merge(doc);
    expect(out.result).toBe("Merged try-cart into main");
    expect(fork.events).toContainEqual({
      type: "moved",
      to: key,
      why: "Merged try-cart into main",
    });
    expect((await gitInfo(b, key)).forks).toEqual([]);
    await expect(b.designs.info(doc)).rejects.toMatchObject({ code: "missing" });

    // Both sets of edits are in main, in its history.
    const after = await b.designs.state(key);
    expect(after.objects.map((o) => o.name).sort()).toEqual(["Billing", "Cart", "Shop"]);
    const versions = await b.versions!.list(key);
    expect(versions[0]!.subject).toBe("Merged try-cart");
    main.conn.close();
    fork.conn.close();
  });

  it("brings main's edits to a fork up as 'behind' after main moves on", async () => {
    const b = setup();
    const { key } = await b.designs.create("Behind");
    const main = await open(b, key);
    add(main.ydoc, "A");
    const { doc } = await b.git!.fork(key, "side");
    expect((await gitInfo(b, key)).forks[0]!.behind).toBe(0);
    add(main.ydoc, "B");
    await until(async () => (await gitInfo(b, key)).forks[0]!.behind > 0);
    main.conn.close();
    await b.git!.discard(doc);
  });

  it("discards a fork and its changes, leaving main alone", async () => {
    const b = setup();
    const { key } = await b.designs.create("Throwaway");
    const main = await open(b, key);
    add(main.ydoc, "Keep");
    const { doc } = await b.git!.fork(key);
    const fork = await open(b, doc);
    add(fork.ydoc, "Gone");
    await b.git!.discard(doc);
    expect(fork.events.some((e) => e.type === "moved" && e.to === key)).toBe(true);
    expect((await gitInfo(b, key)).forks).toEqual([]);
    expect(names(main.ydoc)).toEqual(["Keep"]);
    expect((await b.designs.list())[0]!.forks).toBe(0);
    main.conn.close();
    fork.conn.close();
  });

  it("names forks so two never share a name, and lists them on the design", async () => {
    const b = setup();
    const { key } = await b.designs.create("Names");
    const one = await b.git!.fork(key, "idea");
    const two = await b.git!.fork(key, "idea");
    expect([one.doc, two.doc]).toEqual([`${key}@idea`, `${key}@idea-2`]);
    expect((await b.designs.list()).find((d) => d.key === key)!.forks).toBe(2);
    expect((await gitInfo(b, key)).forks.map((f) => f.name)).toEqual(["idea", "idea-2"]);
  });

  it("can't edit through the git capability: main is edited directly", async () => {
    const b = setup();
    const { key } = await b.designs.create("Direct");
    await expect(b.git!.edit(key, [])).rejects.toThrow(/directly/);
  });

  it("keeps main's history: a first version, one per settled stretch of edits, and the design as of each", async () => {
    const b = setup();
    const { key } = await b.designs.create("History");
    const main = await open(b, key);
    await until(async () => (await b.versions!.list(key)).length === 1);
    expect((await b.versions!.list(key))[0]!.subject).toBe("Started");
    add(main.ydoc, "First", "added First");
    await until(async () => (await b.versions!.list(key)).length === 2);
    add(main.ydoc, "Second", "added Second");
    await until(async () => (await b.versions!.list(key)).length === 3);
    const list = await b.versions!.list(key);
    expect(list.map((v) => v.subject)).toEqual(["Added Second", "Added First", "Started"]);
    const [latest, middle, first] = list;
    const at = async (sha: string) => (await b.versions!.at(key, sha)).objects.map((o) => o.name);
    expect(await at(first!.sha)).toEqual([]);
    expect(await at(middle!.sha)).toEqual(["First"]);
    expect((await at(latest!.sha)).sort()).toEqual(["First", "Second"]);
    await expect(b.versions!.at(key, "nope")).rejects.toMatchObject({ code: "missing" });
    main.conn.close();
  });

  it("deleting a design takes its forks and history with it", async () => {
    const b = setup();
    const { key } = await b.designs.create("Delete me");
    await b.git!.fork(key, "x");
    await b.designs.remove(key);
    await expect(b.designs.info(`${key}@x`)).rejects.toMatchObject({ code: "missing" });
  });
});
