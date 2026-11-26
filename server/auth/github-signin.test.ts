// ARCHNM_AUTH=github: the GitHub App's own login flow, used to sign people in. GitHub itself is
// answered by a fake fetch.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { Call, Ctx } from "../app.ts";
import { loadConfig } from "../config.ts";
import { GitHub } from "../github.ts";
import { githubReturnRoutes } from "../routes/github.ts";
import { COOKIE, cookie } from "../signin/session.ts";
import { createAuth } from "./load.ts";

const app = {
  ARCHNM_GITHUB_APP_ID: "7",
  ARCHNM_GITHUB_CLIENT_ID: "cid",
  ARCHNM_GITHUB_CLIENT_SECRET: "csecret",
  ARCHNM_GITHUB_PRIVATE_KEY: "pem",
};
const lists = { ARCHNM_ADMINS: "octocat", ARCHNM_EDITORS: "hubot", ARCHNM_VIEWERS: "monalisa" };

function store() {
  const m = new Map<string, string>();
  return {
    setting: (k: string) => m.get(k) ?? null,
    setSetting: (k: string, v: string) => void m.set(k, v),
    deleteSetting: (k: string) => void m.delete(k),
    deleteSettings: () => {},
    settings: () => [],
  };
}

/** GitHub, answered here; the test's own calls to the local server go through. */
const githubFetch = (login: string, real: typeof fetch) =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith("http://127.0.0.1")) return real(url, init);
    if (u.endsWith("/login/oauth/access_token"))
      return new Response(
        JSON.stringify({ access_token: "tok", expires_in: 28800, refresh_token: "r" }),
      );
    if (u.endsWith("/user")) return new Response(JSON.stringify({ login, name: "The Cat" }));
    return new Response("?", { status: 404 });
  }) as typeof fetch;

let server: http.Server | null = null;
afterEach(() => void server?.close());

async function setup(env: Record<string, string> = {}, login = "octocat") {
  const config = loadConfig({ ARCHNM_AUTH: "github", ...app, ...lists, ...env });
  const github = new GitHub(store() as never, config.listen.publicUrl, config.github, undefined);
  const auth = await createAuth(config, { github });
  await auth.ready();
  const real = globalThis.fetch;
  globalThis.fetch = githubFetch(login, real);
  const ctx = { auth, github, config } as unknown as Ctx;
  server = http.createServer((req, res) => {
    const path = new URL(req.url ?? "", "http://x").pathname;
    const call = { req, res, path, who: null } as Call;
    void (async () => {
      if (path.startsWith("/auth/")) {
        if (await auth.provider.routes!(req, res, path)) return;
      } else if (await githubReturnRoutes(ctx, call)) return;
      res.writeHead(404).end();
    })();
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return {
    auth,
    github,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    restore: () => (globalThis.fetch = real),
  };
}
const manual = { redirect: "manual" } as const;

describe("github sign-in", () => {
  it("fails at start, saying what to set, when the App isn't set up", async () => {
    const config = loadConfig({ ARCHNM_AUTH: "github", ...lists });
    const github = new GitHub(store() as never, config.listen.publicUrl, config.github, undefined);
    const auth = await createAuth(config, { github });
    await expect(auth.ready()).rejects.toThrow(
      /ARCHNM_GITHUB_APP_ID.*ARCHNM_GITHUB_CLIENT_ID.*ARCHNM_GITHUB_CLIENT_SECRET/,
    );
  });

  it("won't start with open role lists, and describes one GitHub button", async () => {
    const config = loadConfig({ ARCHNM_AUTH: "github", ...app });
    const github = new GitHub(store() as never, config.listen.publicUrl, config.github, undefined);
    await expect(createAuth(config, { github })).rejects.toThrow(/ARCHNM_OPEN=yes/);
    const { auth, restore } = await setup();
    restore();
    expect(auth.signInPage()).toEqual({
      kind: "buttons",
      buttons: [{ label: "Sign in with GitHub", start: "/auth/github/start" }],
    });
  });

  it("signs in by GitHub login: state tied to the browser, the role lists, the core's cookie", async () => {
    const { auth, url, restore } = await setup();
    try {
      const start = await fetch(
        `${url}/auth/github/start?back=${encodeURIComponent("/#/shop")}`,
        manual,
      );
      const to = new URL(start.headers.get("location")!);
      expect(to.origin + to.pathname).toBe("https://github.com/login/oauth/authorize");
      expect(to.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:5190/api/github/callback");
      const bind = start.headers.get("set-cookie")!;
      expect(bind).toMatch(/HttpOnly/);
      const state = to.searchParams.get("state")!;
      const mine = bind.split(";")[0]!;

      // Someone else's browser (no cookie): refused, and the state is spent.
      const stolen = await fetch(`${url}/api/github/callback?code=c&state=${state}`, manual);
      expect(stolen.status).toBe(400);
      const spent = await fetch(`${url}/api/github/callback?code=c&state=${state}`, {
        ...manual,
        headers: { cookie: mine },
      });
      expect(spent.status).toBe(400);

      const start2 = await fetch(
        `${url}/auth/github/start?back=${encodeURIComponent("/#/shop")}`,
        manual,
      );
      const state2 = new URL(start2.headers.get("location")!).searchParams.get("state")!;
      const ok = await fetch(`${url}/api/github/callback?code=c&state=${state2}`, {
        ...manual,
        headers: { cookie: start2.headers.get("set-cookie")!.split(";")[0]! },
      });
      expect(ok.status).toBe(302);
      expect(ok.headers.get("location")).toBe("http://127.0.0.1:5190/#/shop");
      const set = ok.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE}=`))!;
      expect(set).toMatch(/HttpOnly/);
      expect(auth.identify({ headers: { cookie: `${COOKIE}=${cookie(set, COOKIE)}` } })).toEqual({
        id: "github:octocat",
        name: "The Cat",
        kind: "human",
        roles: ["admin"],
      });
    } finally {
      restore();
    }
  });

  it("refuses a GitHub user who isn't on the lists, with no cookie", async () => {
    const { url, restore } = await setup({}, "stranger");
    try {
      const start = await fetch(`${url}/auth/github/start`, manual);
      const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
      const r = await fetch(`${url}/api/github/callback?code=c&state=${state}`, {
        ...manual,
        headers: { cookie: start.headers.get("set-cookie")!.split(";")[0]! },
      });
      expect(decodeURIComponent(r.headers.get("location")!)).toMatch(/stranger isn't allowed/);
      expect(r.headers.getSetCookie().some((c) => c.startsWith(`${COOKIE}=`))).toBe(false);
    } finally {
      restore();
    }
  });
});
