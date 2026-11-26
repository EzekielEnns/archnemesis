// examples/auth/gcip/provider.js, loaded the way ARCHNM_AUTH=gcip loads it: the checks it makes on
// a Firebase ID token, its safety rule, and signing in through its routes.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { Auth } from "../auth.ts";
import { loadConfig } from "../config.ts";
import { COOKIE, cookie } from "../signin/session.ts";
import { startedAuth } from "../testing.ts";
import { fakeFetch, testKey } from "./testkeys.ts";

const NOW = Math.floor(Date.now() / 1000);
const key = testKey("RS256");
const CERTS =
  "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";
const certs = fakeFetch({ [CERTS]: { k1: key.pem } });
const lists = {
  ARCHNM_ADMINS: "zeek@example.com",
  ARCHNM_EDITORS: "@example.com",
  ARCHNM_VIEWERS: "@example.org",
};
const env = {
  ARCHNM_AUTH: "gcip",
  ARCHNM_GCIP_PROJECT: "acme-test",
  ARCHNM_GCIP_API_KEY: "k",
  ARCHNM_GCIP_TENANT: "staff-abc12",
  ...lists,
};

function token(
  claims: Record<string, unknown> = {},
  head: Record<string, unknown> = {},
  k = key,
): string {
  return k.token(
    {
      iss: "https://securetoken.google.com/acme-test",
      aud: "acme-test",
      iat: NOW - 10,
      exp: NOW + 3600,
      sub: "u1",
      email: "Sam@example.com",
      email_verified: true,
      name: "Sam Smith",
      firebase: { tenant: "staff-abc12" },
      ...claims,
    },
    head,
  );
}

describe("the gcip example", () => {
  it("ARCHNM_AUTH=gcip is the example, and its settings are still checked", async () => {
    expect(loadConfig({ ARCHNM_AUTH: "gcip" }).auth.module).toMatch(
      /examples\/auth\/gcip\/provider\.js$/,
    );
    await expect(
      startedAuth({ ARCHNM_AUTH: "gcip", ARCHNM_ADMINS: "a@b.c" }, certs),
    ).rejects.toThrow(/ARCHNM_GCIP_PROJECT/);
    await expect(
      startedAuth({ ARCHNM_AUTH: "gcip", ARCHNM_GCIP_PROJECT: "my-project" }, certs),
    ).rejects.toThrow(/ARCHNM_GCIP_API_KEY/);
  });

  it("accepts a good token from the right project and tenant", async () => {
    const a = await startedAuth(env, certs);
    expect(a.identify({ token: token() })).toEqual({
      id: "google:sam@example.com",
      name: "Sam Smith",
      kind: "human",
      roles: ["editor"],
    });
    expect(a.signInPage()).toEqual({
      kind: "buttons",
      buttons: [{ label: "Sign in with Google", start: "/auth/gcip/" }],
    });
  });

  it("refuses anything off", async () => {
    const a = await startedAuth(env, certs);
    const other = testKey("RS256");
    const bad = [
      token({}, {}, other), // wrong key
      token({ aud: "someone-else" }),
      token({ iss: "https://securetoken.google.com/someone-else" }),
      token({ firebase: { tenant: "other-tenant" } }),
      token({ firebase: {} }), // no tenant
      token({ email_verified: false }),
      token({ exp: NOW - 3600 }),
      token({}, { alg: "none" }),
      token({}, { kid: "unknown" }),
      token({ sub: "" }),
      token({ email: "not-an-email" }),
    ];
    for (const t of bad) expect(a.identify({ token: t }), t.slice(0, 20)).toBeNull();
    expect(a.identify({ token: "not.a.jwt" })).toBeNull();
  });

  it("won't start open to anyone who can sign in", async () => {
    const open = { ...env, ARCHNM_ADMINS: "", ARCHNM_VIEWERS: "" };
    await expect(startedAuth({ ...open, ARCHNM_EDITORS: "@example.com" }, certs)).rejects.toThrow(
      /ARCHNM_VIEWERS/,
    );
    await expect(startedAuth({ ...open, ARCHNM_OPEN: "yes" }, certs)).resolves.toBeDefined();
    await expect(startedAuth({ ...open, ARCHNM_OPEN: "on" }, certs)).resolves.toBeDefined();
  });
});

describe("signing in through the provider's routes", () => {
  let server: http.Server | null = null;
  afterEach(() => void server?.close());
  async function serve(a: Auth): Promise<string> {
    server = http.createServer((req, res) => {
      const path = new URL(req.url ?? "", "http://x").pathname;
      void a.provider.routes!(req, res, path).then((done) => done || res.writeHead(404).end());
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  const post = (base: string, body: unknown, type = "application/json") =>
    fetch(`${base}/auth/gcip/signin`, {
      method: "POST",
      headers: { "content-type": type },
      body: JSON.stringify(body),
    });

  it("serves its page, which loads Firebase from Google and carries the project", async () => {
    const base = await serve(await startedAuth(env, certs));
    const html = await (await fetch(`${base}/auth/gcip/`)).text();
    expect(html).toContain("https://www.gstatic.com/firebasejs/");
    expect(html).toContain('"projectId":"acme-test"');
    expect(html).not.toContain("</script><script>alert");
  });

  it("signs in people on the lists, with the core's cookie, and knows them by it", async () => {
    const a = await startedAuth(env, certs);
    const base = await serve(a);
    const r = await post(base, { idToken: token(), back: "/#/shop" });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ redirect: "http://127.0.0.1:5190/#/shop" });
    const set = r.headers.get("set-cookie")!;
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/SameSite=Lax/);
    const who = a.identify({ headers: { cookie: `${COOKIE}=${cookie(set, COOKIE)}` } });
    expect(who).toMatchObject({
      id: "google:sam@example.com",
      name: "Sam Smith",
      roles: ["editor"],
    });
    expect(a.identify({ headers: {} })).toBeNull();
  });

  it("refuses people off the lists, bad tokens and non-JSON, without a cookie", async () => {
    const base = await serve(await startedAuth(env, certs));
    const off = await post(base, { idToken: token({ email: "eve@gmail.com" }) });
    expect(off.status).toBe(403);
    expect((await off.json()).error).toMatch(/isn't allowed/);
    expect(off.headers.get("set-cookie")).toBeNull();
    const junk = await post(base, { idToken: "junk" });
    expect(junk.status).toBe(401);
    expect(junk.headers.get("set-cookie")).toBeNull();
    expect((await post(base, { idToken: token() }, "text/plain")).status).toBe(415);
  });

  it("sends nobody to another site", async () => {
    const base = await serve(await startedAuth(env, certs));
    for (const back of [
      "https://evil.example/",
      "//evil.example",
      "/\\evil.example",
      "javascript:alert(1)",
    ]) {
      const j = await (await post(base, { idToken: token(), back })).json();
      expect(j.redirect, back).toBe("http://127.0.0.1:5190/");
    }
  });

  it("a cookie made by another provider is no sign-in", async () => {
    const a = await startedAuth(env, certs);
    const forged = a.sessions.make({
      id: "google:sam@example.com",
      provider: "oidc",
      login: "sam@example.com",
      name: null,
    });
    expect(a.identify({ headers: { cookie: `${COOKIE}=${forged}` } })).toBeNull();
  });
});
