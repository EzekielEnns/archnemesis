// Forking off a public GitHub design in the static build, against a pretend GitHub: the local
// design remembers where it came from, shows the diff against it, and pulls upstream changes by
// reading the public repository again. Nothing is pushed, and nothing about the visitor is sent.
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { applyOps, readState } from "../../shared/doc.ts";
import { filesFromOps, smallOps } from "../../shared/filesFromOps.ts";
import { makeObject, type Op } from "../../shared/model.ts";
import { fakeRepo, githubFetch, type FakeRepo } from "./github-fake.ts";
import { createLocalBackend, type ListStore } from "./local.ts";
import { memoryVersions } from "./local-versions.ts";
import type { Backend } from "./types.ts";

const person = { id: "local:You", name: "You", kind: "human" } as const;
const memory = (): ListStore => {
  let text: string | null = null;
  return { read: () => text, write: (v) => void (text = v) };
};
const extra = (name: string): Op => ({
  op: "object.put",
  object: makeObject({ kind: "system", name, id: name.toLowerCase(), key: name.toLowerCase() }),
});
const shop = (...more: string[]) =>
  Object.fromEntries(
    [...filesFromOps([...smallOps(), ...more.map(extra)], { name: "Shop" })].map(([p, t]) => [
      `shop/${p}`,
      t,
    ]),
  );

function setup(repo: FakeRepo) {
  return createLocalBackend(memory(), {
    forks: memory(),
    versions: memoryVersions(),
    remotes: memory(),
    fetch: githubFetch(repo),
    idleMs: 30,
  });
}

async function open(b: Backend, doc: string) {
  const info = await b.designs.info(doc);
  const ydoc = new Y.Doc();
  let loaded = () => {};
  const live = new Promise<void>((r) => (loaded = r));
  const conn = b.designs.open(info, ydoc, {
    onStatus: (s) => s === "live" && loaded(),
    onEvent: () => {},
  });
  await live;
  return { ydoc, conn };
}
const names = (b: Backend, key: string) =>
  b.designs.state(key).then((s) => s.objects.map((o) => o.name).sort());
const gitInfo = async (b: Backend, key: string) => (await b.git!.info(key))!;

/** Fork the public design in the repo into a local one. */
async function forkedOff(b: Backend): Promise<string> {
  const opened = await b.portable!.openShared("~gh=acme/designs:shop");
  expect(opened.readOnly).toBe(true);
  return (await b.portable!.copy(opened.key)).key;
}

describe("forking off a public design", () => {
  it("makes a local design whose main remembers the repository", async () => {
    const repo = fakeRepo({ main: shop() });
    const b = setup(repo);
    const key = await forkedOff(b);
    const info = await gitInfo(b, key);
    expect(info).toMatchObject({ remote: "acme/designs", path: "shop", inBrowser: true });
    expect(info.syncedAt).toBeTruthy();
    expect((await b.versions!.list(key))[0]!.subject).toBe("Forked from acme/designs");
    expect((await names(b, key)).length).toBeGreaterThan(0);
    // Only public reads: nothing about the visitor went to GitHub.
    expect(repo.auth.every((a) => a === null)).toBe(true);
  });

  it("shows a fork's changes against the upstream version, and pulls upstream's changes into main", async () => {
    const repo = fakeRepo({ main: shop() });
    const b = setup(repo);
    const key = await forkedOff(b);
    const { doc } = await b.git!.fork(key, "mine");
    const fork = await open(b, doc);
    applyOps(fork.ydoc, readState(fork.ydoc), [extra("Mine")], person, "added Mine");
    expect((await b.git!.whatsNew(doc))?.changed).toContain("mine");

    const kept = (await b.versions!.list(key)).length;
    await b.git!.sync(key); // nothing new upstream
    expect((await b.versions!.list(key)).length).toBe(kept);

    repo.branches.set("main", new Map(Object.entries(shop("Upstream"))));
    await b.git!.sync(key);
    expect(await names(b, key)).toContain("Upstream");
    expect((await b.versions!.list(key))[0]!.subject).toBe("Pulled from acme/designs");
    fork.conn.close();
  });

  it("won't trample main's own edits when pulling", async () => {
    const repo = fakeRepo({ main: shop() });
    const b = setup(repo);
    const key = await forkedOff(b);
    const main = await open(b, key);
    applyOps(main.ydoc, readState(main.ydoc), [extra("Mine")], person, "added Mine");
    repo.branches.set("main", new Map(Object.entries(shop("Later"))));
    await expect(b.git!.sync(key)).rejects.toThrow(/changes of its own/);
    expect((await gitInfo(b, key)).error).toMatch(/changes of its own/);
    expect(await names(b, key)).toContain("Mine");
    main.conn.close();
  });

  it("can't link a repository or push: that needs your own Archnemesis", async () => {
    const b = setup(fakeRepo({ main: shop() }));
    const { key } = await b.designs.create("Plain");
    await expect(b.git!.follow(key, { remote: "acme/designs" })).rejects.toThrow(/self-hosted/);
    const { doc } = await b.git!.fork(key, "x");
    await expect(b.git!.propose(doc)).rejects.toThrow(/self-hosted/);
    expect(b.github).toBeUndefined();
  });
});
