// The three layers: your private designs, the team's, and git's. Who sees what, who may
// share or delete.
import { mkdtempSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Auth, type Principal } from "./auth.ts";
import { testConfig } from "./testing.ts";
import { Hub } from "./live.ts";
import { DocStore } from "./store.ts";

const alice: Principal = { id: "ts:alice", name: "Alice", kind: "human", roles: ["editor"] };
const bob: Principal = { id: "ts:bob", name: "Bob", kind: "human", roles: ["admin"] };
const alicesAgent: Principal = {
  id: "agent:alice",
  name: "Agent",
  kind: "agent",
  roles: ["editor"],
  for: "ts:alice",
};

let hub: Hub;
let dir: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "archnm-access-"));
  hub = new Hub(
    new DocStore(join(dir, "archnm.sqlite")),
    new Auth(testConfig(dir).auth),
    testConfig(dir),
  );
  await hub.start();
});
afterEach(async () => {
  await hub.close();
});

describe("design access", () => {
  it("a new design is private to whoever made it, and to their agent", async () => {
    await hub.create("Scratch", "scratch", "empty", alice);
    expect(hub.perms.can(alice, "scratch", "view")).toBe(true);
    expect(hub.perms.can(alicesAgent, "scratch", "view")).toBe(true);
    expect(hub.perms.can(bob, "scratch", "view")).toBe(false);
    expect(hub.list(bob).map((d) => d.key)).not.toContain("scratch");
    expect(hub.list(alice).find((d) => d.key === "scratch")).toMatchObject({
      private: true,
      mine: true,
    });
    // Nor does it give away that someone is there, or where: only those who may view it see them.
    expect(hub.presence.here({ who: bob, pass: null }).some((e) => e.doc === "scratch")).toBe(
      false,
    );
  });

  it("an agent's design goes to its person", async () => {
    await hub.create("Agent made", "agent-made", "empty", alicesAgent);
    expect(hub.perms.owns(alice, "agent-made")).toBe(true);
    expect(hub.perms.can(bob, "agent-made", "view")).toBe(false);
  });

  it("sharing moves it to the team, and back", async () => {
    await hub.create("Scratch", "scratch", "empty", alice);
    hub.setPrivate("scratch", false);
    expect(hub.perms.can(bob, "scratch", "view")).toBe(true);
    expect(hub.list(bob).find((d) => d.key === "scratch")).toMatchObject({
      private: false,
      mine: false,
    });
    hub.setPrivate("scratch", true);
    expect(hub.perms.can(bob, "scratch", "view")).toBe(false);
  });

  it("designs from before owners are the team's", () => {
    const first = hub.list(null, true)[0]!.key;
    expect(hub.perms.can(bob, first, "view")).toBe(true);
    expect(() => hub.setPrivate(first, true)).toThrow(/no owner/);
  });

  it("deleting moves the files aside and forgets the design", async () => {
    await hub.create("Scratch", "scratch", "empty", alice);
    expect(existsSync(join(dir, "designs", "scratch"))).toBe(true);
    hub.remove("scratch", "Alice deleted Scratch");
    expect(hub.get("scratch")).toBeUndefined();
    expect(existsSync(join(dir, "designs", "scratch"))).toBe(false);
    expect(readdirSync(join(dir, "deleted")).some((n) => n.startsWith("scratch-"))).toBe(true);
    expect(hub.store.docs()).not.toContain("scratch");
    expect(hub.access("scratch").owner).toBeNull();
  });

  it("won't delete the last design", () => {
    for (const d of hub.list(null, true).slice(1)) hub.remove(d.key, "tidy");
    expect(() => hub.remove(hub.list(null, true)[0]!.key, "x")).toThrow(/only design/);
  });

  it("a delete that can't move the files aside changes nothing", async () => {
    await hub.create("Scratch", "scratch", "empty", alice);
    await hub.create("Other", "other", "empty", alice);
    // Where deleted designs go is a file, so moving it aside fails.
    writeFileSync(join(dir, "deleted"), "in the way");
    expect(() => hub.remove("scratch", "test")).toThrow();
    expect(hub.list(alice).map((d) => d.key)).toContain("scratch");
    expect(existsSync(join(dir, "designs", "scratch"))).toBe(true);
  });

  it("an agent working over MCP shows in who's on Archnemesis, but only to those who may see its design", async () => {
    await hub.create("Scratch", "scratch", "empty", alice);
    hub.presence.agentSeen(alicesAgent, "scratch", null, "reading");
    hub.presence.agentSeen(alice, "scratch", null, "reading");
    // Bob may not see the private design, so he is not told anyone is on it.
    expect(hub.presence.here({ who: bob, pass: null })).toEqual([]);
    expect(hub.presence.here({ who: null, pass: null })).toEqual([]);
    const mine = hub.presence.here({ who: alice, pass: null });
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      doc: "scratch",
      user: { id: alicesAgent.id, kind: "agent" },
      activity: "reading",
      for: "ts:alice",
    });
    hub.setPrivate("scratch", false);
    expect(hub.presence.here({ who: bob, pass: null })[0]).toMatchObject({
      doc: "scratch",
      docName: "Scratch",
    });
  });
});

describe("a guided tour's wait", () => {
  it("comes back empty-handed on time, keeps a press made between calls, and tells the tab", async () => {
    const live = await hub.create("Tour", "tour", "example", alice);
    const states: { guide?: { listening?: boolean } }[] = [];
    live.awareness = () => ({ setLocalState: (s: unknown) => void states.push(s as never) });
    const d = [...live.index().diagrams.values()][0]!;
    live.point(alicesAgent, {
      diagram: d.id,
      object: null,
      flow: null,
      step: -1,
      say: "here",
      waiting: true,
    });
    const seq = live.guideSeq!;
    // Nobody presses: the call returns rather than hanging past the client's deadline.
    expect(await live.waitReply(seq, 20)).toBeNull();
    expect(states.at(-1)?.guide?.listening).toBe(true);
    // A press with no call open is kept, and the next call gets it at once.
    expect(live.reply(alice, seq, { action: "next" })).toBe(true);
    expect(await live.waitReply(seq, 5000)).toMatchObject({ action: "next" });
  });
});
