// Designs that travel, in the local backend: links, copies, opening the same link twice, and
// read-only designs from a pretend GitHub.
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { applyOps, readState } from "../../shared/doc.ts";
import { filesFromOps, smallOps } from "../../shared/filesFromOps.ts";
import { makeConnection, makeObject } from "../../shared/model.ts";
import { createLocalBackend, type ListStore } from "./local.ts";
import { MAX_LINK } from "./portable.ts";
import type { Backend, PortableCapability } from "./types.ts";

const person = { id: "local:You", name: "You", kind: "human" } as const;

function memory(): ListStore {
  let text: string | null = null;
  return { read: () => text, write: (v) => void (text = v) };
}

const portableOf = (b: Backend): PortableCapability => b.portable!;

/** A browser: its own list of designs and its own memory of GitHub links. */
function browser(fetch?: typeof globalThis.fetch) {
  return createLocalBackend(memory(), { remotes: memory(), fetch });
}

async function open(b: Backend, key: string): Promise<{ ydoc: Y.Doc; close: () => void }> {
  const info = await b.designs.info(key);
  const ydoc = new Y.Doc();
  let loaded = () => {};
  const live = new Promise<void>((r) => (loaded = r));
  const conn = b.designs.open(info, ydoc, {
    onStatus: (s) => s === "live" && loaded(),
    onEvent: () => {},
  });
  await live;
  return { ydoc, close: () => conn.close() };
}

/** A design with a few boxes and a connection, as a person would make it. */
async function shop(b: Backend, name = "Shop") {
  const { key } = await b.designs.create(name);
  const { ydoc, close } = await open(b, key);
  const a = makeObject({ kind: "system", name: "Shop" });
  const c = makeObject({ kind: "system", name: "Payments" });
  const d = makeObject({ kind: "actor", name: "Customer" });
  applyOps(
    ydoc,
    readState(ydoc),
    [
      { op: "object.put", object: a },
      { op: "object.put", object: c },
      { op: "object.put", object: d },
      {
        op: "connection.put",
        connection: makeConnection({ fromId: d.id, toId: a.id, name: "buys" }),
      },
      {
        op: "connection.put",
        connection: makeConnection({ fromId: a.id, toId: c.id, name: "charges" }),
      },
    ],
    person,
    "test edit",
  );
  await new Promise((r) => setTimeout(r, 100));
  close();
  return key;
}

const fragmentOf = (url: string) => url.slice(url.indexOf("#") + 1);

describe("a link that carries the design", () => {
  it("opens as a copy in another browser, with its boxes and connections", async () => {
    const mine = browser();
    const key = await shop(mine);
    const made = await portableOf(mine).link(key);
    if (!("url" in made)) throw new Error("link too big");
    expect(made.url).toMatch(/#~d=a1\./);
    expect(made.length).toBe(made.url.length);

    const theirs = browser();
    const got = await portableOf(theirs).openShared(fragmentOf(made.url));
    expect(got).toMatchObject({ readOnly: false });
    expect(got.existing).toBeUndefined();
    const { ydoc, close } = await open(theirs, got.key);
    const s = readState(ydoc);
    expect([...s.objects.values()].map((o) => o.name).sort()).toEqual([
      "Customer",
      "Payments",
      "Shop",
    ]);
    expect([...s.connections.values()].map((c) => c.name).sort()).toEqual(["buys", "charges"]);
    expect(s.diagrams.size).toBeGreaterThan(0);
    close();
    expect((await theirs.designs.list()).map((d) => d.name)).toContain("Shop");
    // Editing the copy changes nothing at the sender's.
    const edited = await open(theirs, got.key);
    applyOps(
      edited.ydoc,
      readState(edited.ydoc),
      [{ op: "object.put", object: makeObject({ kind: "actor", name: "Extra" }) }],
      person,
      "x",
    );
    edited.close();
    expect((await mine.designs.state(key)).objects).toHaveLength(3);
  });

  it("names the copy '(shared)' when a design of that name exists here", async () => {
    const mine = browser();
    const link = await portableOf(mine).link(await shop(mine));
    if (!("url" in link)) throw new Error("too big");
    const here = browser();
    await shop(here);
    const got = await portableOf(here).openShared(fragmentOf(link.url));
    expect((await here.designs.info(got.key)).name).toBe("Shop (shared)");
  });

  it("opens the same link twice as one copy, and makes another only when asked", async () => {
    const mine = browser();
    const link = await portableOf(mine).link(await shop(mine));
    if (!("url" in link)) throw new Error("too big");
    const fragment = fragmentOf(link.url);
    const theirs = browser();
    const p = portableOf(theirs);
    const first = await p.openShared(fragment);
    const second = await p.openShared(fragment);
    expect(second).toMatchObject({ key: first.key, existing: true });
    expect((await theirs.designs.list()).filter((d) => d.name.startsWith("Shop"))).toHaveLength(1);
    const third = await p.openShared(fragment, { again: true });
    expect(third.key).not.toBe(first.key);
    expect(third.existing).toBeUndefined();
    expect((await theirs.designs.list()).filter((d) => d.name.startsWith("Shop"))).toHaveLength(2);
    // The link now finds the newest copy; deleting copies makes the link open fresh again.
  });

  it("says plainly what is wrong with a bad or cut-short link", async () => {
    const b = browser();
    const p = portableOf(b);
    await expect(p.openShared("~d=a1.AAAA")).rejects.toMatchObject({
      code: "refused",
      message: expect.stringMatching(/doesn't hold a design/),
    });
    await expect(p.openShared("~d=hello")).rejects.toMatchObject({ code: "refused" });
    await expect(p.openShared("~nonsense=1")).rejects.toMatchObject({ code: "refused" });
    // Nothing was added to the designs.
    expect(await b.designs.list()).toHaveLength(1);
  });

  it("shows a design's problems rather than opening it half-read", async () => {
    const b = browser();
    const { encodeDesign } = await import("../../shared/sharelink.ts");
    const text = await encodeDesign(
      new Map([
        ["archnm.yaml", "name: Broken\n"],
        ["model/a.yaml", "{ not: [valid"],
      ]),
    );
    await expect(portableOf(b).openShared(`~d=${text}`)).rejects.toMatchObject({
      code: "refused",
      message: expect.stringMatching(/problem.*can't be opened/),
    });
    expect(await b.designs.list()).toHaveLength(1);
  });

  it("does not make a link too long to share: it says the design is too big", async () => {
    const b = browser();
    const { key } = await b.designs.create("Heavy");
    const { ydoc, close } = await open(b, key);
    // Text that doesn't compress, so the link really is long.
    const noise = (n: number) =>
      Array.from({ length: n }, () => Math.random().toString(36).slice(2)).join("");
    const many = Array.from({ length: 80 }, (_, i) => ({
      op: "object.put" as const,
      object: makeObject({
        kind: "system",
        name: `Box ${i}`,
        description: noise(40).slice(0, 500),
      }),
    }));
    applyOps(ydoc, readState(ydoc), many, person, "x");
    await new Promise((r) => setTimeout(r, 100));
    close();
    expect(await portableOf(b).link(key)).toEqual({ tooBig: true });
    expect(MAX_LINK).toBe(30_000);
  });
});

describe("copy", () => {
  it("duplicates a design of your own under a new name", async () => {
    const b = browser();
    const key = await shop(b);
    const { key: copy } = await portableOf(b).copy(key);
    expect(copy).not.toBe(key);
    expect((await b.designs.info(copy)).name).toBe("Shop (copy)");
    expect((await b.designs.state(copy)).objects).toHaveLength(3);
  });
});

/** A pretend GitHub with one design, and a fork of it that adds a box. */
function pretendGithub() {
  const main = filesFromOps(smallOps(), { name: "Shop" });
  const forkOps = [
    ...smallOps(),
    { op: "object.put" as const, object: makeObject({ kind: "actor", name: "Courier" }) },
  ];
  const forked = filesFromOps(forkOps, { name: "Shop" });
  const repo: Record<string, Map<string, string>> = {
    main: new Map([...main].map(([p, t]) => [`shop/${p}`, t])),
    "archnm/shop/zeek": new Map([...forked].map(([p, t]) => [`shop/${p}`, t])),
  };
  const f = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const tree = /git\/trees\/(.+)\?recursive=1$/.exec(url);
    if (tree) {
      const files = repo[tree[1] === "HEAD" ? "main" : decodeURIComponent(tree[1]!)];
      return files
        ? Response.json({
            tree: [...files].map(([path, t]) => ({ path, type: "blob", size: t.length })),
          })
        : new Response("{}", { status: 404 });
    }
    const ref = Object.keys(repo).find((r) => url.includes(`/designs/${r}/`)) ?? "main";
    const path = url.split(
      `/designs/${ref === "main" && !url.includes("/designs/main/") ? "HEAD" : ref}/`,
    )[1]!;
    const text = repo[ref]?.get(decodeURIComponent(path));
    return text === undefined ? new Response("", { status: 404 }) : new Response(text);
  }) as typeof globalThis.fetch;
  return { f, forked, main };
}

describe("a design from a public GitHub repository", () => {
  it("opens read-only, with its own key, and reads again after a reload", async () => {
    const { f } = pretendGithub();
    const remotes = memory();
    const b = createLocalBackend(memory(), { remotes, fetch: f });
    const got = await portableOf(b).openShared("~gh=acme/designs:shop");
    expect(got).toMatchObject({ readOnly: true, from: "acme/designs" });
    const info = await b.designs.info(got.key);
    expect(info).toMatchObject({ canEdit: false, from: "acme/designs", git: false });
    const { ydoc, close } = await open(b, got.key);
    expect(readState(ydoc).objects.size).toBe(4);
    close();
    // It isn't one of your designs.
    expect((await b.designs.list()).map((d) => d.key)).toEqual(["my-design"]);
    expect((await b.designs.state(got.key)).objects.length).toBe(4);

    // After a reload nothing is in memory, but the link is remembered and opens it again.
    const after = createLocalBackend(memory(), { remotes, fetch: f });
    await expect(after.designs.info(got.key)).rejects.toMatchObject({ code: "missing" });
    const fragment = portableOf(after).fragmentOf(got.key)!;
    expect(fragment).toBe("~gh=acme/designs:shop");
    expect((await portableOf(after).openShared(fragment)).key).toBe(got.key);
    expect((await after.designs.info(got.key)).canEdit).toBe(false);
  });

  it("makes your own copy, which you can edit", async () => {
    const { f } = pretendGithub();
    const b = createLocalBackend(memory(), { remotes: memory(), fetch: f });
    const got = await portableOf(b).openShared("~gh=acme/designs:shop");
    const { key } = await portableOf(b).copy(got.key);
    const info = await b.designs.info(key);
    expect(info).toMatchObject({ canEdit: true, name: "Shop" });
    expect(info.from).toBeUndefined();
    expect((await b.designs.state(key)).objects).toHaveLength(4);
  });

  it("opens a fork against main: its design, and what changed", async () => {
    const { f } = pretendGithub();
    const b = createLocalBackend(memory(), { remotes: memory(), fetch: f });
    const got = await portableOf(b).openShared("~gh=acme/designs@archnm/shop/zeek:shop");
    expect(got.key).toMatch(/^gh-[a-z0-9-]+@zeek$/);
    expect(got.from).toBe("acme/designs@archnm/shop/zeek");
    const { ydoc, close } = await open(b, got.key);
    const names = [...readState(ydoc).objects.values()].map((o) => o.name);
    expect(names).toContain("Courier");
    const changes = await portableOf(b).whatsNew(got.key);
    const courier = [...readState(ydoc).objects.values()].find((o) => o.name === "Courier")!;
    expect(changes?.changed).toEqual([courier.id]);
    close();
    // A plain design has nothing to compare with.
    const plain = await portableOf(b).openShared("~gh=acme/designs:shop");
    await open(b, plain.key).then((o) => o.close());
    expect(await portableOf(b).whatsNew(plain.key)).toBeNull();
  });

  it("says why when it can't", async () => {
    const b = createLocalBackend(memory(), { remotes: memory(), fetch: pretendGithub().f });
    await expect(portableOf(b).openShared("~gh=acme/designs@nope:shop")).rejects.toMatchObject({
      code: "missing",
    });
    await expect(portableOf(b).openShared("~gh=not a link")).rejects.toMatchObject({
      code: "refused",
    });
  });
});
