// What GitHub says about a repo, remembered a few minutes; asked with the person's own token;
// unknown or failed means none. GitHub is faked.
import { describe, expect, it } from "vitest";
import type { GitHub } from "./github.ts";
import {
  githubSource,
  PUBLIC_TTL_MS,
  RepoAccess,
  RIGHTS_TTL_MS,
  type RepoSource,
} from "./repoaccess.ts";

const repo = { owner: "Acme", repo: "Shop" };

function setup(answer: () => Promise<"none" | "read" | "push">) {
  let asked = 0;
  let now = 1000;
  const src: RepoSource = {
    repoRights: async () => (asked++, answer()),
    repoIsPublic: async () => (asked++, true),
  };
  return {
    ra: new RepoAccess(
      () => src,
      () => now,
    ),
    asked: () => asked,
    tick: (ms: number) => (now += ms),
  };
}

describe("RepoAccess", () => {
  it("knows nothing until asked, then remembers for a few minutes, per person", async () => {
    const t = setup(async () => "push");
    expect(t.ra.rights("u1", repo)).toBe("none");
    await Promise.all([t.ra.warmRights("u1", repo), t.ra.warmRights("u1", repo)]);
    expect(t.asked()).toBe(1);
    expect(t.ra.rights("u1", { owner: "acme", repo: "shop" })).toBe("push");
    expect(t.ra.rights("u2", repo)).toBe("none");
    await t.ra.warmRights("u1", repo);
    expect(t.asked()).toBe(1);
    t.tick(RIGHTS_TTL_MS + 1);
    expect(t.ra.rights("u1", repo)).toBe("none");
    await t.ra.warmRights("u1", repo);
    expect(t.asked()).toBe(2);
  });

  it("a failed question is none and not public, never an error", async () => {
    const t = setup(async () => {
      throw new Error("GitHub is down");
    });
    await t.ra.warmRights("u1", repo);
    expect(t.ra.rights("u1", repo)).toBe("none");
    expect(t.ra.isPublic(repo)).toBe(false);
    await t.ra.warmPublic(repo);
    expect(t.ra.isPublic(repo)).toBe(true);
    t.tick(PUBLIC_TTL_MS + 1);
    expect(t.ra.isPublic(repo)).toBe(false);
  });

  it("with no GitHub to ask, everything is none", async () => {
    const ra = new RepoAccess(() => null);
    await ra.warmRights("u1", repo);
    await ra.warmPublic(repo);
    expect(ra.rights("u1", repo)).toBe("none");
    expect(ra.isPublic(repo)).toBe(false);
  });
});

describe("githubSource", () => {
  const gh = (token: string | null, reply: unknown) => {
    const calls: string[] = [];
    const fake = {
      userToken: async () => token,
      call: async (_m: string, path: string, t: string) => {
        calls.push(`${path} with ${t}`);
        if (reply instanceof Error) throw reply;
        return reply;
      },
    } as unknown as GitHub;
    return { src: githubSource(fake, "http://127.0.0.1:1"), calls };
  };

  it("asks with the person's own token, and a person with none gets none (no fallback)", async () => {
    const a = gh(null, { permissions: { push: true } });
    expect(await a.src.repoRights("github:x", "acme", "shop")).toBe("none");
    expect(a.calls).toEqual([]);
    const b = gh("their-token", { permissions: { push: true, pull: true } });
    expect(await b.src.repoRights("github:x", "acme", "shop")).toBe("push");
    expect(b.calls).toEqual(["/repos/acme/shop with their-token"]);
    expect(await gh("t", { permissions: { pull: true } }).src.repoRights("p", "a", "b")).toBe(
      "read",
    );
    expect(await gh("t", { permissions: {} }).src.repoRights("p", "a", "b")).toBe("none");
    expect(await gh("t", new Error("404")).src.repoRights("p", "a", "b")).toBe("none");
  });

  it("calls a repo public only when asked with no credentials and the answer says so", async () => {
    expect(await gh("t", {}).src.repoIsPublic("a", "b")).toBe(false);
  });
});
