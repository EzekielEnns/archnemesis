// The providers as the server uses them: /api/config's sign-in description, /auth/<id>/ routes,
// custom modules loaded by path (and failing closed), and which sign-in features each kind turns on.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createApp, type App } from "../app.ts";
import { testConfig } from "../testing.ts";

const dirs: string[] = [];
const apps: { app: App; server: http.Server }[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "archnm-auth-"));
  dirs.push(d);
  return d;
};
afterAll(async () => {
  for (const { app, server } of apps) {
    server.close();
    await app.close();
  }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const base = {
  ARCHNM_EXAMPLES: "off",
  ARCHNM_NEW_IN_GIT: "no",
  ARCHNM_LIBSTATS: "off",
  ARCHNM_TELEMETRY: "off",
};

/** The app on a free port. Its public address is that port, so the Host check passes. */
async function boot(env: Record<string, string>) {
  const dir = scratch();
  const probe = http.createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as AddressInfo).port;
  probe.close();
  const app = await createApp(testConfig(dir, { ...base, ARCHNM_PORT: String(port), ...env }));
  await app.ready();
  const server = http.createServer((req, res) => void app.handle(req, res));
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  apps.push({ app, server });
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    dir,
    get: (p: string, headers: Record<string, string> = {}) =>
      fetch(url + p, { headers, redirect: "manual" }),
  };
}

function module(dir: string, source: string, name = "provider.js"): string {
  const file = join(dir, name);
  writeFileSync(file, source);
  return file;
}

const TEMPLATE = resolve("examples/auth/custom/provider.js");
const PASSWORD = "correct-horse-battery";

describe("the sign-in page /api/config describes", () => {
  it("local: nothing to do; tokens: a token field", async () => {
    const local = await boot({});
    expect((await (await local.get("/api/config")).json()).signin).toEqual({ kind: "none" });
    expect((await (await local.get("/api/config")).json()).auth).toBe("local");
    const dir = scratch();
    const tokens = await boot({
      ARCHNM_AUTH: "tokens",
      ARCHNM_TOKENS: module(
        dir,
        JSON.stringify([{ token: "t".repeat(20), id: "a", name: "A" }]),
        "t.json",
      ),
    });
    const j = await (await tokens.get("/api/config")).json();
    expect(j.signin).toMatchObject({ kind: "token" });
    expect(j.auth).toBe("tokens");
    expect(j.gcip).toBeUndefined();
  });

  it("a header proxy: nothing to do (and no identity, no entry)", async () => {
    const s = await boot({ ARCHNM_AUTH: "header", ARCHNM_HEADER_LOGIN: "x-user" });
    expect((await (await s.get("/api/config")).json()).signin).toEqual({ kind: "none" });
    expect((await s.get("/api/me")).status).toBe(401);
    expect((await s.get("/api/me", { "x-user": "sam@example.com" })).status).toBe(200);
  });
});

describe("a custom provider, by path", () => {
  it("the template: a token field; the shared password is a sign-in, a wrong one is not", async () => {
    const s = await boot({ ARCHNM_AUTH: TEMPLATE, ARCHNM_SHARED_PASSWORD: PASSWORD });
    const j = await (await s.get("/api/config")).json();
    expect(j).toMatchObject({
      auth: "shared-password",
      signin: { kind: "token", hint: "Ask the team for the shared password." },
    });
    expect((await s.get("/api/me")).status).toBe(401);
    expect(
      (await s.get("/api/me", { authorization: "Bearer wrong-wrong-wrong-wrong" })).status,
    ).toBe(401);
    const me = await s.get("/api/me", { authorization: `Bearer ${PASSWORD}` });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ id: "shared:team@shared", roles: ["editor"] });
  });

  it("the role lists apply to a custom provider's logins, and an agent is at most an editor", async () => {
    const s = await boot({
      ARCHNM_AUTH: TEMPLATE,
      ARCHNM_SHARED_PASSWORD: PASSWORD,
      ARCHNM_ADMINS: "team@shared",
    });
    const me = await s.get("/api/me", { authorization: `Bearer ${PASSWORD}` });
    expect((await me.json()).roles).toEqual(["admin"]);
    const off = await boot({
      ARCHNM_AUTH: TEMPLATE,
      ARCHNM_SHARED_PASSWORD: PASSWORD,
      ARCHNM_EDITORS: "someone@else",
      ARCHNM_VIEWERS: "other@else",
    });
    expect((await off.get("/api/me", { authorization: `Bearer ${PASSWORD}` })).status).toBe(401);
  });

  it("a provider that throws or answers nonsense signs nobody in (fails closed)", async () => {
    const dir = scratch();
    const throws = module(
      dir,
      `export const createProvider = () => ({ id: "boom", describe: () => ({ kind: "none" }), identify() { throw new Error("db down"); } });`,
      "throws.js",
    );
    const bad = module(
      dir,
      `export const createProvider = () => ({ id: "nonsense", describe: () => ({ kind: "none" }), identify: () => ({ id: "x", login: "sam@example.com", name: "S" }) });`,
      "bad.js",
    );
    const admin = module(
      dir,
      `export const createProvider = () => ({ id: "sneaky", describe: () => ({ kind: "none" }), identify: () => ({ id: "x:y", login: "y", name: "Y", machine: { role: "admin", agent: { id: "a", for: "x" } } }) });`,
      "sneaky.js",
    );
    for (const [file, status] of [
      [throws, 401],
      [bad, 401],
    ] as const) {
      const s = await boot({ ARCHNM_AUTH: file });
      expect((await s.get("/api/me")).status, file).toBe(status);
      expect((await s.get("/api/designs")).status).toBe(401);
    }
    // A provider that names the machine's role is believed (it is the hoster's own code, and the contract says so);
    // a browser sign-in can never claim it (server/signin/signin.test.ts, "the gate").
    expect((await (await boot({ ARCHNM_AUTH: admin })).get("/api/me")).status).toBe(200);
  });

  it("stops the server at start, with the reason, for a bad module", async () => {
    const dir = scratch();
    const cases: [string, RegExp][] = [
      [join(dir, "missing.js"), /couldn't load the provider/],
      [module(dir, "export const other = 1;", "noexport.js"), /must export createProvider/],
      [module(dir, "export const createProvider = () => 5;", "notobj.js"), /must return an object/],
      [
        module(
          dir,
          `export const createProvider = () => ({ id: "Bad Id", describe() {}, identify() {} });`,
          "badid.js",
        ),
        /id must be lowercase/,
      ],
      [
        module(
          dir,
          `export const createProvider = () => ({ id: "x", describe: () => ({ kind: "buttons", buttons: [{ label: "Go", start: "https://evil.example/" }] }), identify: () => null });`,
          "evil.js",
        ),
        /path on this server/,
      ],
      [
        module(
          dir,
          `export const createProvider = () => ({ id: "x", describe: () => ({ kind: "none" }) });`,
          "noidentify.js",
        ),
        /identify\(\)/,
      ],
      [
        module(
          dir,
          `export const createProvider = () => ({ id: "tokens", describe: () => ({ kind: "none" }), identify: () => null });`,
          "reserved.js",
        ),
        /reserved/,
      ],
      [
        module(
          dir,
          `export const createProvider = () => { throw new Error("no password set"); };`,
          "throws.js",
        ),
        /no password set/,
      ],
      [
        module(
          dir,
          `export const createProvider = () => ({ id: "x", describe: () => ({ kind: "none" }), identify: () => null, ready: async () => { throw new Error("no keys"); } });`,
          "ready.js",
        ),
        /no keys/,
      ],
    ];
    for (const [file, why] of cases)
      await expect(boot({ ARCHNM_AUTH: file }), file).rejects.toThrow(why);
  });

  it("serves /auth/<its id>/ only to the provider with that id, and 500s (without a sign-in) when it breaks", async () => {
    const dir = scratch();
    const file = module(
      dir,
      `export const createProvider = () => ({
        id: "demo",
        describe: () => ({ kind: "none" }),
        identify: () => null,
        async routes(req, res, path) {
          if (path === "/auth/demo/hello") { res.end("hi"); return true; }
          if (path === "/auth/demo/break") throw new Error("secret detail");
          return false;
        },
      });`,
    );
    const s = await boot({ ARCHNM_AUTH: file });
    expect(await (await s.get("/auth/demo/hello")).text()).toBe("hi");
    expect((await s.get("/auth/demo/nothing")).status).toBe(404);
    expect((await s.get("/auth/other/hello")).status).toBe(404);
    const broke = await s.get("/auth/demo/break");
    expect(broke.status).toBe(500);
    expect(await broke.text()).not.toContain("secret detail");
    const local = await boot({});
    expect((await local.get("/auth/demo/hello")).status).toBe(404);
  });
});

describe("what a kind of sign-in turns on", () => {
  const button = `export const createProvider = () => ({ id: "btn", describe: () => ({ kind: "buttons", buttons: [{ label: "Go", start: "/auth/btn/start" }] }), identify: () => null });`;
  it("buttons: the MCP OAuth server and personal tokens; the first-open card says Authenticate", async () => {
    const dir = scratch();
    const s = await boot({ ARCHNM_AUTH: module(dir, button), ARCHNM_OPEN: "yes" });
    expect((await s.get("/.well-known/oauth-authorization-server")).status).toBe(200);
    const j = await (await s.get("/api/config")).json();
    expect(j.signin).toEqual({
      kind: "buttons",
      buttons: [{ label: "Go", start: "/auth/btn/start" }],
    });
    expect(j.mcp).toMatchObject({ oauth: "archnm", personal: true });
  });
  it("no browser sign-in: no OAuth server (a clean 404)", async () => {
    const s = await boot({ ARCHNM_AUTH: "header", ARCHNM_HEADER_LOGIN: "x-user" });
    expect((await s.get("/.well-known/oauth-authorization-server")).status).toBe(404);
    expect((await (await s.get("/api/config")).json()).mcp.oauth).toBeUndefined();
    // ...but people there sign in as themselves, so they may make personal tokens.
    const tok = await fetch(`${s.url}/api/tokens`, { headers: { "x-user": "sam@example.com" } });
    expect(tok.status).toBe(200);
  });
});
