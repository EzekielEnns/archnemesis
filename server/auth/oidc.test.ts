// The oidc provider against a tiny fake issuer started here: discovery, JWKS, an authorize
// endpoint we read the request off, and a token endpoint that checks PKCE.
import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Auth } from "../auth.ts";
import { COOKIE, cookie } from "../signin/session.ts";
import { startedAuth } from "../testing.ts";
import { testKey } from "./testkeys.ts";

const key = testKey("RS256", "o1");
const CLIENT = "archnm-client";
const SECRET = "s3cret-value";
const lists = {
  ARCHNM_ADMINS: "zeek@example.com",
  ARCHNM_EDITORS: "@example.com",
  ARCHNM_VIEWERS: "@example.org",
};

interface Issued {
  nonce: string;
  challenge: string;
  redirect: string;
}

let issuer: http.Server;
let base = "";
let issued = new Map<string, Issued>();
let claimsFor: Record<string, unknown> = {};
let authMethod = "";
let lastForm = new URLSearchParams();

beforeEach(async () => {
  issued = new Map();
  claimsFor = { email: "sam@example.com", email_verified: true, name: "Sam Smith" };
  issuer = http.createServer((req, res) => {
    const url = new URL(req.url ?? "", base);
    const json = (v: unknown) =>
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(v));
    if (url.pathname === "/.well-known/openid-configuration")
      return json({
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        jwks_uri: `${base}/jwks`,
      });
    if (url.pathname === "/jwks") return json({ keys: [key.jwk] });
    if (url.pathname === "/token" && req.method === "POST") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        authMethod = req.headers.authorization ? "basic" : "post";
        const f = new URLSearchParams(raw);
        lastForm = f;
        const grant = issued.get(f.get("code") ?? "");
        const secretOk = req.headers.authorization
          ? req.headers.authorization ===
            `Basic ${Buffer.from(`${CLIENT}:${SECRET}`).toString("base64")}`
          : f.get("client_secret") === SECRET && f.get("client_id") === CLIENT;
        const pkceOk =
          grant &&
          createHash("sha256")
            .update(f.get("code_verifier") ?? "")
            .digest("base64url") === grant.challenge;
        if (!grant || !secretOk || !pkceOk || f.get("redirect_uri") !== grant.redirect)
          return void res.writeHead(400).end(JSON.stringify({ error: "invalid_grant" }));
        const now = Math.floor(Date.now() / 1000);
        json({
          access_token: "ignored",
          id_token: key.token({
            iss: base,
            aud: CLIENT,
            iat: now,
            exp: now + 300,
            sub: "1",
            nonce: grant.nonce,
            ...claimsFor,
          }),
        });
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => issuer.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(issuer.address() as AddressInfo).port}`;
});

let app: http.Server | null = null;
afterEach(() => {
  issuer.close();
  app?.close();
});

async function oidc(extra: Record<string, string> = {}): Promise<{ auth: Auth; url: string }> {
  const auth = await startedAuth({
    ARCHNM_AUTH: "oidc",
    ARCHNM_OIDC_ISSUER: base,
    ARCHNM_OIDC_CLIENT_ID: CLIENT,
    ARCHNM_OIDC_CLIENT_SECRET: SECRET,
    ARCHNM_OIDC_LABEL: "Sign in with Acme",
    ...lists,
    ...extra,
  });
  app = http.createServer((req, res) => {
    const path = new URL(req.url ?? "", "http://x").pathname;
    void auth.provider.routes!(req, res, path).then((done) => done || res.writeHead(404).end());
  });
  await new Promise<void>((r) => app!.listen(0, "127.0.0.1", r));
  return { auth, url: `http://127.0.0.1:${(app.address() as AddressInfo).port}` };
}

const manual = { redirect: "manual" } as const;

/** Start, "log in at the issuer", and come back: the callback's response, and the cookies sent. */
async function flow(
  url: string,
  over: { state?: string; cookie?: string | null; code?: string } = {},
) {
  const start = await fetch(`${url}/auth/oidc/start?back=${encodeURIComponent("/#/shop")}`, manual);
  expect(start.status).toBe(302);
  const to = new URL(start.headers.get("location")!);
  const bind = start.headers.get("set-cookie")!.split(";")[0]!;
  const q = to.searchParams;
  issued.set("code-1", {
    nonce: q.get("nonce")!,
    challenge: q.get("code_challenge")!,
    redirect: q.get("redirect_uri")!,
  });
  const back = new URLSearchParams({
    code: over.code ?? "code-1",
    state: over.state ?? q.get("state")!,
  });
  const headers: Record<string, string> =
    over.cookie === null ? {} : { cookie: over.cookie ?? bind };
  return {
    start,
    to,
    cb: await fetch(`${url}/auth/oidc/callback?${back}`, { ...manual, headers }),
  };
}

describe("oidc", () => {
  it("describes one button, with the label", async () => {
    const { auth } = await oidc();
    expect(auth.signInPage()).toEqual({
      kind: "buttons",
      buttons: [{ label: "Sign in with Acme", start: "/auth/oidc/start" }],
    });
  });

  it("sends the browser to the issuer with state, nonce and an S256 challenge", async () => {
    const { url } = await oidc();
    const { to, start } = await flow(url);
    expect(to.origin + to.pathname).toBe(`${base}/authorize`);
    const q = to.searchParams;
    expect(q.get("response_type")).toBe("code");
    expect(q.get("client_id")).toBe(CLIENT);
    expect(q.get("scope")).toBe("openid email profile");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("redirect_uri")).toBe("http://127.0.0.1:5190/auth/oidc/callback");
    for (const k of ["state", "nonce", "code_challenge"])
      expect(q.get(k)!.length).toBeGreaterThan(20);
    expect(start.headers.get("set-cookie")).toMatch(/HttpOnly.*SameSite=Lax/);
  });

  it("signs in an allowed person: the ID token is verified, the core's cookie is set, back is honoured", async () => {
    const { auth, url } = await oidc();
    const { cb } = await flow(url);
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("http://127.0.0.1:5190/#/shop");
    const set = cb.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE}=`))!;
    expect(auth.identify({ headers: { cookie: `${COOKIE}=${cookie(set, COOKIE)}` } })).toEqual({
      id: "oidc:sam@example.com",
      name: "Sam Smith",
      kind: "human",
      roles: ["editor"],
    });
    expect(authMethod).toBe("basic");
    expect(lastForm.get("grant_type")).toBe("authorization_code");
  });

  it("each flow is single use", async () => {
    const { url } = await oidc();
    const first = await flow(url);
    const again = await fetch(
      `${url}/auth/oidc/callback?code=code-1&state=${first.to.searchParams.get("state")}`,
      { ...manual, headers: { cookie: first.start.headers.get("set-cookie")!.split(";")[0]! } },
    );
    expect(again.headers.get("location")).toMatch(/#~signin-error=/);
    expect(again.headers.getSetCookie().some((c) => c.startsWith(`${COOKIE}=`))).toBe(false);
  });

  it("refuses a callback with another browser's (or no) cookie, or an unknown state", async () => {
    const { url } = await oidc();
    for (const over of [{ cookie: null }, { cookie: "archnm_oidc=forged" }, { state: "made-up" }]) {
      const { cb } = await flow(url, over);
      expect(cb.headers.get("location"), JSON.stringify(over)).toMatch(/#~signin-error=/);
      expect(cb.headers.getSetCookie().some((c) => c.startsWith(`${COOKIE}=`))).toBe(false);
    }
  });

  it("refuses an ID token with the wrong nonce, audience, issuer or an unverified email", async () => {
    const { url } = await oidc();
    for (const bad of [
      { aud: "other-client" },
      { iss: "https://evil.example" },
      { email_verified: false },
      { email: undefined },
      { exp: 1 },
    ]) {
      claimsFor = { email: "sam@example.com", email_verified: true, ...bad };
      const { cb } = await flow(url);
      expect(cb.headers.get("location"), JSON.stringify(bad)).toMatch(/#~signin-error=/);
    }
    // A nonce the issuer put in the token that is not the one we started with.
    const { url: u2 } = await oidc();
    const start = await fetch(`${u2}/auth/oidc/start`, manual);
    const q = new URL(start.headers.get("location")!).searchParams;
    issued.set("code-1", {
      nonce: "someone-elses",
      challenge: q.get("code_challenge")!,
      redirect: q.get("redirect_uri")!,
    });
    const cb = await fetch(`${u2}/auth/oidc/callback?code=code-1&state=${q.get("state")}`, {
      ...manual,
      headers: { cookie: start.headers.get("set-cookie")!.split(";")[0]! },
    });
    expect(cb.headers.get("location")).toMatch(/#~signin-error=/);
  });

  it("refuses a code whose PKCE verifier doesn't match", async () => {
    const { url } = await oidc();
    const start = await fetch(`${url}/auth/oidc/start`, manual);
    const q = new URL(start.headers.get("location")!).searchParams;
    issued.set("code-1", {
      nonce: q.get("nonce")!,
      challenge: "a-different-challenge",
      redirect: q.get("redirect_uri")!,
    });
    const cb = await fetch(`${url}/auth/oidc/callback?code=code-1&state=${q.get("state")}`, {
      ...manual,
      headers: { cookie: start.headers.get("set-cookie")!.split(";")[0]! },
    });
    expect(cb.headers.get("location")).toMatch(/#~signin-error=/);
  });

  it("applies the role lists: someone off them is told so, with no cookie", async () => {
    const { url } = await oidc();
    claimsFor = { email: "eve@gmail.com", email_verified: true };
    const { cb } = await flow(url);
    expect(decodeURIComponent(cb.headers.get("location")!)).toMatch(/eve@gmail.com isn't allowed/);
    expect(cb.headers.getSetCookie().some((c) => c.startsWith(`${COOKIE}=`))).toBe(false);
  });

  it("reads another claim for the login when told to", async () => {
    const { url, auth } = await oidc({
      ARCHNM_OIDC_LOGIN_CLAIM: "preferred_username",
      ARCHNM_ADMINS: "sam",
    });
    claimsFor = { preferred_username: "Sam", name: "Sam S" };
    const { cb } = await flow(url);
    const set = cb.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE}=`))!;
    expect(
      auth.identify({ headers: { cookie: `${COOKIE}=${cookie(set, COOKIE)}` } }),
    ).toMatchObject({ id: "oidc:sam", roles: ["admin"] });
  });

  it("won't start open to anyone, with a wrong issuer, or without its settings", async () => {
    await expect(
      oidc({ ARCHNM_EDITORS: "@example.com", ARCHNM_ADMINS: "", ARCHNM_VIEWERS: "" }),
    ).rejects.toThrow(/ARCHNM_OPEN=yes/);
    await expect(oidc({ ARCHNM_OIDC_ISSUER: `${base}/other` })).rejects.toThrow(/discovery/);
    await expect(oidc({ ARCHNM_OIDC_ISSUER: "http://issuer.example.com" })).rejects.toThrow(
      /https/,
    );
    await expect(startedAuth({ ARCHNM_AUTH: "oidc" })).rejects.toThrow(/ARCHNM_OIDC_ISSUER/);
  });
});
