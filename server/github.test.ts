import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";
import { GitHub, repoOf } from "./github.ts";

const gh = () =>
  new GitHub(
    { setting: () => null, setSetting: () => {}, deleteSetting: () => {} } as never,
    "http://127.0.0.1:5190",
    loadConfig({}).github,
    undefined,
  );

describe("repoOf", () => {
  it("reads owner and repo from GitHub remotes", () => {
    for (const r of [
      "git@github.com:acme/designs.git",
      "https://github.com/acme/designs",
      "ssh://git@github.com/acme/designs.git",
      "https://x@github.com/acme/designs.git/",
    ])
      expect(repoOf(r, "github.com"), r).toEqual({ owner: "acme", repo: "designs" });
  });
  it("is null elsewhere", () => {
    expect(repoOf("git@gitlab.com:acme/designs.git", "github.com")).toBeNull();
    expect(repoOf("/srv/git/designs.git", "github.com")).toBeNull();
  });
});

describe("gitEnv", () => {
  it("sends the token as a header through git config, not the URL", () => {
    const env = gh().gitEnv("tok");
    expect(env.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraheader");
    expect(Buffer.from(env.GIT_CONFIG_VALUE_0!.split(" ").pop()!, "base64").toString()).toBe(
      "x-access-token:tok",
    );
  });
});

describe("being polite to the API", () => {
  // call() is private; this reaches it the way pullState and openPull do.
  const call = (g: GitHub, path: string) =>
    (g as unknown as { call: (m: string, p: string, t: string) => Promise<unknown> }).call(
      "GET",
      path,
      "tok",
    );

  it("asks with the last ETag and reuses the answer on 304", async () => {
    const seen: (string | null)[] = [];
    const real = globalThis.fetch;
    let n = 0;
    globalThis.fetch = (async (_u: string, init: RequestInit) => {
      seen.push(new Headers(init.headers).get("if-none-match"));
      return n++ === 0
        ? new Response(JSON.stringify({ ok: 1 }), { status: 200, headers: { etag: '"a"' } })
        : new Response(null, { status: 304 });
    }) as typeof fetch;
    try {
      const g = gh();
      expect(await call(g, "/x")).toEqual({ ok: 1 });
      expect(await call(g, "/x")).toEqual({ ok: 1 });
      expect(seen).toEqual([null, '"a"']);
    } finally {
      globalThis.fetch = real;
    }
  });

  it("stops calling until the reset GitHub gives", async () => {
    const real = globalThis.fetch;
    let calls = 0;
    const reset = Math.floor(Date.now() / 1000) + 600;
    globalThis.fetch = (async () => {
      calls++;
      return new Response("{}", {
        status: 403,
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
      });
    }) as typeof fetch;
    try {
      const g = gh();
      await expect(call(g, "/y")).rejects.toThrow(/rate limit/);
      await expect(call(g, "/z")).rejects.toThrow(/rate limit/);
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = real;
    }
  });
});
