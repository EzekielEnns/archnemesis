// A design can start in a repo of its own on the Archnemesis server (forks and history with no
// GitHub), and move to a real repo later, once its forks are merged or discarded.
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Auth, type Principal } from "./auth.ts";
import { testConfig } from "./testing.ts";
import { Repo } from "./git.ts";
import { bindDesign } from "./gitsync.ts";
import { Hub } from "./live.ts";
import { DocStore } from "./store.ts";

const alice: Principal = { id: "ts:alice", name: "Alice", kind: "human", roles: ["admin"] };

let hub: Hub;
let dir: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "archnm-localrepo-"));
  hub = new Hub(
    new DocStore(join(dir, "archnm.sqlite")),
    new Auth(testConfig(dir).auth),
    testConfig(dir, { ARCHNM_GIT_LOCAL_REMOTES: "1" }),
  );
  await hub.start();
});
afterEach(async () => {
  await hub.close();
});

describe("a design in a repo on the server", () => {
  it("moves to a real repo, keeping what's on main", async () => {
    const live = await hub.create("Shop", "shop", "example", alice);
    const objects = live.state.objects.size;
    await bindDesign(hub, live, { local: true });
    expect(hub.git.get("shop")!.info().local).toBe(true);

    const real = join(dir, "real.git");
    await Repo.initBare(real, "main", hub.config.git);
    const g = await bindDesign(hub, hub.designs.get("shop")!, { remote: real });
    expect(g.info().local).toBe(false);
    expect(hub.git.get("shop")).toBe(g);
    expect(hub.designs.get("shop")!.state.objects.size).toBe(objects);
  });

  it("won't move while it has forks", async () => {
    const live = await hub.create("Shop", "shop", "example", alice);
    await bindDesign(hub, live, { local: true });
    await hub.git.get("shop")!.fork(alice, "try");
    const real = join(dir, "real.git");
    await Repo.initBare(real, "main", hub.config.git);
    await expect(bindDesign(hub, hub.designs.get("shop")!, { remote: real })).rejects.toThrow(
      /merge or discard its fork/,
    );
    expect(hub.git.get("shop")!.info().local).toBe(true);
  });

  it("a real repo stays put", async () => {
    const live = await hub.create("Shop", "shop", "example", alice);
    const real = join(dir, "real.git");
    await Repo.initBare(real, "main", hub.config.git);
    await bindDesign(hub, live, { remote: real });
    await expect(bindDesign(hub, hub.designs.get("shop")!, { local: true })).rejects.toThrow(
      /already follows/,
    );
  });
});

describe("deleting a design in a repo on the server", () => {
  it("lets go of the repo, then deletes it", async () => {
    const { dropLocalRepo } = await import("./gitsync.ts");
    await hub.create("Other", "other", "empty", alice);
    const live = await hub.create("Shop", "shop", "example", alice);
    await bindDesign(hub, live, { local: true });
    await dropLocalRepo(hub, "shop");
    expect(hub.git.has("shop")).toBe(false);
    hub.remove("shop", "test");
    expect(hub.designs.has("shop")).toBe(false);
  });
});

// Trial 8: a plan on an unmerged map. A fork of a fork starts from it, and its diff and pull
// request are against it, so the plan proposes only the plan.
describe("stacked forks", () => {
  it("forks a fork, compares with it, and proposes against its branch", async () => {
    const live = await hub.create("Shop", "shop", "example", alice);
    const real = join(dir, "real.git");
    await Repo.initBare(real, "main", hub.config.git);
    const g = await bindDesign(hub, live, { remote: real });
    const byKey = (
      l: { state: { objects: Map<string, { key?: string; id: string; description: string }> } },
      k: string,
    ) => [...l.state.objects.values()].find((o) => (o.key ?? o.id) === k)!;
    const edit = (l: typeof live, k: string, d: string) =>
      l.commit(
        alice,
        [
          {
            op: "object.put",
            object: { ...(byKey(l, k) as never as object), description: d } as never,
          },
        ],
        `describe ${k}`,
      );

    const map = await g.fork(alice, "map");
    edit(map, "checkout", "Takes the order, then pays.");
    const plan = await g.fork(alice, "plan", map.key);
    // It starts with the map's change.
    expect(byKey(plan, "checkout").description).toBe("Takes the order, then pays.");
    edit(plan, "cart", "Holds what the customer picked.");

    // Compared with the map, not main.
    expect(g.parentOf(plan.key)?.doc).toBe(map.key);
    const base = await g.baseState(plan.key);
    expect([...base!.objects.values()].find((o) => o.key === "checkout")!.description).toBe(
      "Takes the order, then pays.",
    );

    const p = await g.propose(plan.key, "http://x");
    expect(p.stacked).toBe(map.key);
    expect(p.base).toBe(g.info().forks.find((f) => f.doc === map.key)!.branch);
    expect(p.changes.join("\n")).toContain("Cart");
    expect(p.changes.join("\n")).not.toContain("Checkout");
    // The map itself still proposes against main, with its own change.
    const m = await g.propose(map.key, "http://x");
    expect(m.stacked).toBeNull();
    expect(m.changes.join("\n")).toContain("Checkout");
  });

  it("follows its repo when the state folder moves", async () => {
    const live = await hub.create("Shop", "shop", "example", alice);
    await bindDesign(hub, live, { local: true });
    await hub.git.get("shop")!.fork(alice, "try");
    await hub.close();

    const moved = `${dir}-moved`;
    renameSync(dir, moved);
    hub = new Hub(
      new DocStore(join(moved, "archnm.sqlite")),
      new Auth(testConfig(moved).auth),
      testConfig(moved, { ARCHNM_GIT_LOCAL_REMOTES: "1" }),
    );
    await hub.start();
    const g = hub.git.get("shop")!;
    expect(g.info().local).toBe(true);
    expect(g.info().error ?? null).toBeNull();
    expect(g.info().forks.map((f) => f.name)).toEqual(["try"]);
  });

  it("keeps the design's own folder a copy of main, for committing with your code", async () => {
    const live = await hub.create("Shop", "shop", "example", alice);
    await bindDesign(hub, live, { local: true });
    const own = join(hub.root, "shop");
    const all = () =>
      readdirSync(join(own, "model"))
        .map((f) => readFileSync(join(own, "model", f), "utf8"))
        .join("\n");
    expect(all()).toContain("checkout");
    expect(all()).not.toContain("loyalty points");

    // An edit lands on a fork, not in the folder, until it's merged.
    const g = hub.git.get("shop")!;
    const fork = await g.fork(alice, "try");
    const checkout = [...fork.state.objects.values()].find((o) => o.key === "checkout")!;
    fork.commit(
      alice,
      [
        {
          op: "object.put",
          object: { ...checkout, description: "Takes the order, then pays with loyalty points." },
        },
      ],
      "describe checkout",
    );
    await g.merge(fork.key, alice);
    // Main takes the merge, and the copy follows a moment later.
    await expect.poll(all, { timeout: 5000 }).toContain("loyalty points");
    expect(existsSync(join(own, "archnm.yaml"))).toBe(true);
  });
});
