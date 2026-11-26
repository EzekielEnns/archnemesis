import { describe, expect, it } from "vitest";
import { Roles } from "./roles.ts";
import { Auth } from "../auth.ts";
import { nameFromEmail } from "../auth/names.ts";
import { fakeFetch, testKey } from "../auth/testkeys.ts";
import { authConfig, startedAuth } from "../testing.ts";

describe("roles", () => {
  it("several admins, domains, and who gets in at all", () => {
    const r = new Roles(
      authConfig("local", {
        ARCHNM_ADMINS: "zeek@example.com, Jack@example.com",
        ARCHNM_EDITORS: "@example.com",
        ARCHNM_VIEWERS: "guest@else.com",
      }),
    );
    expect(r.of("zeek@example.com")).toEqual(["admin"]);
    expect(r.of("jack@example.com")).toEqual(["admin"]);
    expect(r.of("sam@example.com")).toEqual(["editor"]);
    expect(r.of("sam@notexample.com")).toEqual([]);
    expect(r.of("guest@else.com")).toEqual(["viewer"]);
    expect(r.of("stranger@else.com")).toEqual([]);
  });
  it("no lists: everyone signed in edits; editors only: everyone else reads", () => {
    expect(new Roles(authConfig("local")).of("a@b.c")).toEqual(["editor"]);
    const r = new Roles(authConfig("local", { ARCHNM_EDITORS: "a@b.c" }));
    expect(r.of("x@y.z")).toEqual(["viewer"]);
    expect(new Roles(authConfig("local", { ARCHNM_TAILSCALE_USERS: "a@b.c" })).of("a@b.c")).toEqual(
      ["editor"],
    );
  });
});

const AUD = "/projects/123/global/backendServices/456";
const KEYS = "https://www.gstatic.com/iap/verify/public_key-jwk";
const key = testKey("ES256");
const now = Math.floor(Date.now() / 1000);
const jwt = (claims: Record<string, unknown>, k = key, kid = "k1") =>
  k.token(
    {
      iss: "https://cloud.google.com/iap",
      aud: AUD,
      iat: now - 10,
      exp: now + 600,
      sub: "accounts.google.com:1",
      email: "accounts.google.com:Jack.Smith@example.com",
      ...claims,
    },
    { kid },
  );

describe("iap", () => {
  const lists = {
    ARCHNM_ADMINS: "jack.smith@example.com",
    ARCHNM_EDITORS: "@example.com",
    ARCHNM_VIEWERS: "@example.com",
  };
  const iap = () =>
    startedAuth({ ARCHNM_AUTH: "iap", ...lists }, fakeFetch({ [KEYS]: { keys: [key.jwk] } }));
  const h = (t: string) => ({ headers: { "x-goog-iap-jwt-assertion": t } });

  it("accepts IAP's JWT and nothing else", async () => {
    const auth = await iap();
    expect(auth.identify(h(jwt({})))).toMatchObject({ id: "google:jack.smith@example.com" });
    const other = testKey("ES256");
    const bad = [
      jwt({}, other), // someone else's key
      jwt({ aud: "/projects/123/global/backendServices/999" }),
      jwt({ iss: "https://evil" }),
      jwt({ exp: now - 120 }),
      jwt({}, key, "unknown"),
    ];
    for (const t of bad) expect(auth.identify(h(t))).toBeNull();
    const [head, , sig] = jwt({}).split(".");
    const swapped = Buffer.from(
      JSON.stringify({
        iss: "https://cloud.google.com/iap",
        aud: AUD,
        iat: now,
        exp: now + 600,
        sub: "x",
        email: "admin@example.com",
      }),
    ).toString("base64url");
    expect(auth.identify(h(`${head}.${swapped}.${sig}`))).toBeNull(); // claims changed after signing
    expect(
      auth.identify(h(`${Buffer.from('{"alg":"none"}').toString("base64url")}.${swapped}.`)),
    ).toBeNull();
    expect(auth.identify(h(""))).toBeNull();
  });
  it("needs a real audience", () => {
    expect(() => authConfig("iap", { ARCHNM_IAP_AUDIENCE: "" })).toThrow(/ARCHNM_IAP_AUDIENCE/);
  });
  it("signs people in with their email and the role lists", async () => {
    const auth = await iap();
    expect(auth.identify(h(jwt({})))).toEqual({
      id: "google:jack.smith@example.com",
      name: "Jack Smith",
      kind: "human",
      roles: ["admin"],
    });
    expect(auth.identify({ ...h(jwt({})), agent: true })?.roles).toEqual(["editor"]);
    expect(auth.identify(h(jwt({ email: "x@gmail.com" })))).toBeNull();
    expect(auth.identify({})).toBeNull(); // no IAP header: no one, not "the machine itself"
    expect(nameFromEmail("zeek+test2@example.com")).toBe("Zeek Test");
    expect(auth.signInPage()).toEqual({ kind: "none" });
  });
});

describe("tailscale", () => {
  it("no identity is an editor, never an admin", () => {
    const auth = new Auth(authConfig("tailscale", { ARCHNM_ADMINS: "me@github" }));
    expect(auth.identify({ headers: {} })?.roles).toEqual(["editor"]);
    expect(auth.identify({ headers: { "tailscale-user-login": "me@github" } })?.roles).toEqual([
      "admin",
    ]);
  });
  it("is the same person under the same names as before", () => {
    const auth = new Auth(authConfig("tailscale", { ARCHNM_LOCAL_NAME: "box" }));
    const ts = { "tailscale-user-login": "sam@github", "tailscale-user-name": "Sam S" };
    expect(auth.identify({ headers: ts })).toEqual({
      id: "ts:sam@github",
      name: "Sam S",
      kind: "human",
      roles: ["editor"],
    });
    expect(auth.identify({ headers: { "tailscale-user-login": "sam@github" } })?.name).toBe("sam");
    expect(auth.identify({ headers: {} })).toEqual({
      id: "local:box",
      name: "box",
      kind: "human",
      roles: ["editor"],
    });
    expect(auth.identify({ headers: {}, agent: true })).toEqual({
      id: "agent:box",
      name: "Agent",
      kind: "agent",
      roles: ["editor"],
      for: "local:box",
    });
    expect(auth.identify({ headers: ts, agent: true })).toMatchObject({
      id: "agent:sam@github",
      for: "ts:sam@github",
    });
  });
  it("never lets Funnel traffic in, with or without a login", () => {
    const auth = new Auth(authConfig("tailscale"));
    expect(auth.identify({ headers: { "tailscale-funnel-request": "?1" } })).toBeNull();
    expect(
      auth.identify({
        headers: { "tailscale-funnel-request": "?1", "tailscale-user-login": "a@b.c" },
      }),
    ).toBeNull();
  });
  it("only listens beyond loopback when told", () => {
    expect(() => authConfig("tailscale", { ARCHNM_HOST: "0.0.0.0" })).toThrow(
      /only listens on loopback/,
    );
    expect(() =>
      authConfig("tailscale", { ARCHNM_HOST: "0.0.0.0", ARCHNM_ALLOW_OPEN: "yes" }),
    ).not.toThrow();
  });
});

describe("a plain trusted header", () => {
  const env = {
    ARCHNM_AUTH: "header",
    ARCHNM_HEADER_LOGIN: "X-Forwarded-Email",
    ARCHNM_HEADER_DISPLAY_NAME: "X-Forwarded-User",
  };
  it("names the person, on loopback", () => {
    const auth = new Auth(authConfig("header", env));
    expect(
      auth.identify({
        headers: { "x-forwarded-email": "Sam@Example.com", "x-forwarded-user": "Sam S" },
      }),
    ).toEqual({
      id: "header:Sam@Example.com",
      name: "Sam S",
      kind: "human",
      roles: ["editor"],
    });
  });
  it("no header is no one (there is no local pass), and Funnel is not a thing here", () => {
    const auth = new Auth(authConfig("header", env));
    expect(auth.identify({ headers: {} })).toBeNull();
    expect(auth.identify({ headers: { "tailscale-user-login": "a@b.c" } })).toBeNull();
  });
  it("is refused beyond loopback, however it is set", () => {
    expect(() => authConfig("header", { ...env, ARCHNM_HOST: "0.0.0.0" })).toThrow(
      /only listens on loopback/,
    );
  });
  it("needs a header to read, and not two shapes at once", () => {
    expect(() => authConfig("header")).toThrow(/ARCHNM_HEADER_JWT.*ARCHNM_HEADER_LOGIN/);
    expect(() => authConfig("header", { ...env, ARCHNM_HEADER_JWT: "x" })).toThrow(/not both/);
  });
});

describe("a signed header", () => {
  const JWKS = "https://proxy.example/keys";
  const env = {
    ARCHNM_AUTH: "header",
    ARCHNM_HEADER_JWT: "X-Proxy-Jwt",
    ARCHNM_HEADER_JWKS_URL: JWKS,
    ARCHNM_HEADER_ISSUER: "https://proxy.example",
    ARCHNM_HEADER_AUDIENCE: "archnm",
    ARCHNM_HOST: "0.0.0.0", // a verified JWT is believed on any address
  };
  const k = testKey("RS256", "p1");
  const tok = (c: Record<string, unknown> = {}) =>
    k.token({
      iss: "https://proxy.example",
      aud: "archnm",
      iat: now - 5,
      exp: now + 300,
      email: "Sam@Example.com",
      name: "Sam S",
      ...c,
    });
  it("is believed only when it verifies", async () => {
    const auth = await startedAuth(env, fakeFetch({ [JWKS]: { keys: [k.jwk] } }));
    expect(auth.identify({ headers: { "x-proxy-jwt": tok() } })).toEqual({
      id: "header:sam@example.com",
      name: "Sam S",
      kind: "human",
      roles: ["editor"],
    });
    expect(auth.identify({ headers: { "x-proxy-jwt": tok({ aud: "other" }) } })).toBeNull();
    expect(auth.identify({ headers: { "x-proxy-jwt": "sam@example.com" } })).toBeNull(); // a plain value is not a JWT
    expect(auth.identify({ headers: {} })).toBeNull();
  });
  it("reads the claims it is told to", async () => {
    const auth = await startedAuth(
      {
        ...env,
        ARCHNM_HEADER_LOGIN_CLAIM: "preferred_username",
        ARCHNM_HEADER_NAME_CLAIM: "display",
      },
      fakeFetch({ [JWKS]: { keys: [k.jwk] } }),
    );
    expect(
      auth.identify({
        headers: { "x-proxy-jwt": tok({ preferred_username: "sam", display: "Sam Smith" }) },
      }),
    ).toMatchObject({ id: "header:sam", name: "Sam Smith" });
    expect(auth.identify({ headers: { "x-proxy-jwt": tok() } })).toBeNull(); // no such claim
  });
  it("fails to start if the keys can't be loaded", async () => {
    await expect(startedAuth(env, fakeFetch({}))).rejects.toThrow(/404/);
  });
});

describe("cloudflare-access", () => {
  const team = "acme.cloudflareaccess.com";
  const k = testKey("RS256", "cf1");
  const env = {
    ARCHNM_AUTH: "cloudflare-access",
    ARCHNM_CLOUDFLARE_TEAM: "acme",
    ARCHNM_CLOUDFLARE_AUD: "tag123",
    ARCHNM_ADMINS: "sam@example.com",
  };
  const tok = (c: Record<string, unknown> = {}) =>
    k.token({
      iss: `https://${team}`,
      aud: ["tag123"],
      iat: now - 5,
      exp: now + 300,
      sub: "u",
      email: "sam@example.com",
      type: "app",
      ...c,
    });
  it("reads Cf-Access-Jwt-Assertion against the team's certs", async () => {
    const auth = await startedAuth(
      env,
      fakeFetch({ [`https://${team}/cdn-cgi/access/certs`]: { keys: [k.jwk], public_certs: [] } }),
    );
    expect(auth.identify({ headers: { "cf-access-jwt-assertion": tok() } })).toMatchObject({
      id: "cf:sam@example.com",
      roles: ["admin"],
    });
    expect(
      auth.identify({ headers: { "cf-access-jwt-assertion": tok({ aud: ["other"] }) } }),
    ).toBeNull();
    expect(
      auth.identify({
        headers: { "cf-access-jwt-assertion": tok({ iss: "https://evil.cloudflareaccess.com" }) },
      }),
    ).toBeNull();
    expect(auth.identify({ headers: {} })).toBeNull();
  });
  it("needs the team and the tag", () => {
    expect(() => authConfig("cloudflare-access")).toThrow(/ARCHNM_CLOUDFLARE_TEAM/);
    expect(() => authConfig("cloudflare-access", { ARCHNM_CLOUDFLARE_TEAM: "acme" })).toThrow(
      /ARCHNM_CLOUDFLARE_AUD/,
    );
  });
});

describe("the gate (what providers sign people in through)", () => {
  const res = () => {
    const set: string[] = [];
    return { set, res: { appendHeader: (_: string, v: string) => set.push(v) } as never };
  };
  const gate = new Auth(
    authConfig("local", { ARCHNM_EDITORS: "@example.com", ARCHNM_VIEWERS: "@example.org" }),
  ).gate.ctx;
  it("refuses a machine identity, a malformed one and someone off the lists, with no cookie", () => {
    for (const who of [
      {
        id: "x:a@example.com",
        login: "a@example.com",
        name: "A",
        machine: { role: "admin" as const, agent: { id: "a", for: "x" } },
      },
      { id: "no-colon", login: "a@example.com", name: "A" },
      { id: "x:other", login: "a@example.com", name: "A" }, // id must end in :login
      { id: "x:eve@gmail.com", login: "eve@gmail.com", name: "Eve" },
    ]) {
      const r = res();
      const out = gate.sessions.signIn(r.res, who, "/");
      expect(out.ok, who.id).toBe(false);
      expect(out.redirect).toContain("#~signin-error=");
      expect(r.set).toEqual([]);
    }
  });
  it("redirects only to this server", () => {
    expect(gate.safeRedirect("/#/shop")).toBe("http://127.0.0.1:5190/#/shop");
    for (const bad of [
      "//evil.example",
      "https://evil.example",
      "\\evil",
      "/a\r\nSet-Cookie: x",
      "",
      null,
      undefined,
    ])
      expect(gate.safeRedirect(bad)).toBe("http://127.0.0.1:5190/");
  });
});
