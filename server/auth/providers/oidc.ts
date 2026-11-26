// oidc: sign in with any OpenID Connect provider (Keycloak, Authentik, Authelia, Okta, Auth0,
// Google, Entra ID, ...): the authorization-code flow with PKCE (S256), endpoints found through
// discovery (<issuer>/.well-known/openid-configuration).
//
// The flow: /auth/oidc/start makes a random state, nonce and PKCE verifier (single use, ten
// minutes), ties them to the browser with an HttpOnly cookie, and sends the browser to the
// issuer. The issuer sends it back to /auth/oidc/callback with a code; the state must match
// what was started AND this browser's cookie (so nobody can sign you in as them by handing you
// a link). The code is swapped for tokens at the issuer's token endpoint, the ID token is
// verified (signature, issuer, audience = our client id, expiry, nonce) and the person is
// signed in with the core's session. Only the ID token is used; the access token is dropped.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type http from "node:http";
import { JwtVerifier, jwksLoader } from "../jwt.ts";
import { nameFromEmail } from "../names.ts";
import type { AuthProvider, ProviderContext } from "../provider.ts";

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  label: string;
  /** The ID token claim that holds the login the role lists match. */
  loginClaim: string;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  token_endpoint_auth_methods_supported?: string[];
}

interface Started {
  nonce: string;
  verifier: string;
  back: string | null;
  at: number;
  binding: string;
}

const COOKIE = "archnm_oidc";
const TTL_MS = 10 * 60_000;
const b64 = (n: number) => randomBytes(n).toString("base64url");

/** https, or http on this machine (for a test issuer). */
function urlOk(u: string): boolean {
  try {
    const url = new URL(u);
    return (
      url.protocol === "https:" ||
      (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    );
  } catch {
    return false;
  }
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

function cookieOf(req: http.IncomingMessage): string | null {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
  }
  return null;
}

export function oidcProvider(cfg: OidcConfig, ctx: ProviderContext): AuthProvider {
  const started = new Map<string, Started>();
  const redirectUri = `${ctx.config.publicUrl}/auth/oidc/callback`;
  let found: Discovery | null = null;
  let verifier: JwtVerifier | null = null;

  const bindingCookie = (value: string, maxAge: number) =>
    `${COOKIE}=${value}; Path=/auth/oidc; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${ctx.config.secure ? "; Secure" : ""}`;
  const go = (res: http.ServerResponse, to: string) =>
    void res.writeHead(302, { location: to, "cache-control": "no-store" }).end();
  const fail = (res: http.ServerResponse, why: string) => {
    ctx.log.warn(`oidc sign-in refused: ${why}`);
    res.appendHeader("set-cookie", bindingCookie("", 0));
    go(res, ctx.failed("That sign-in didn't work: try again."));
  };

  async function discover(): Promise<void> {
    if (!urlOk(cfg.issuer)) throw new Error("ARCHNM_OIDC_ISSUER must be an https URL");
    const url = `${cfg.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
    const r = await ctx.fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`OpenID discovery at ${url} answered ${r.status}`);
    const d = (await r.json()) as Partial<Discovery>;
    if (d.issuer?.replace(/\/$/, "") !== cfg.issuer.replace(/\/$/, ""))
      throw new Error(`OpenID discovery at ${url} names a different issuer (${d.issuer})`);
    for (const k of ["authorization_endpoint", "token_endpoint", "jwks_uri"] as const)
      if (!d[k] || !urlOk(d[k])) throw new Error(`OpenID discovery at ${url} has no usable ${k}`);
    found = d as Discovery;
    verifier = new JwtVerifier({
      keys: jwksLoader(found.jwks_uri, ctx.fetch),
      issuer: found.issuer,
      audience: cfg.clientId,
    });
    await verifier.ready();
  }

  function start(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!found)
      return (
        void ctx.log.warn("oidc: not ready"),
        go(res, ctx.failed("Sign-in isn't ready yet: try again."))
      );
    for (const [k, v] of started) if (Date.now() - v.at > TTL_MS) started.delete(k);
    const back = new URL(req.url ?? "", ctx.config.publicUrl).searchParams.get("back");
    const state = b64(24);
    const s: Started = {
      nonce: b64(24),
      verifier: b64(48),
      back,
      at: Date.now(),
      binding: b64(24),
    };
    started.set(state, s);
    const q = new URLSearchParams({
      response_type: "code",
      client_id: cfg.clientId,
      redirect_uri: redirectUri,
      scope: cfg.scopes,
      state,
      nonce: s.nonce,
      code_challenge: createHash("sha256").update(s.verifier).digest("base64url"),
      code_challenge_method: "S256",
    });
    res.appendHeader("set-cookie", bindingCookie(s.binding, TTL_MS / 1000));
    go(
      res,
      `${found.authorization_endpoint}${found.authorization_endpoint.includes("?") ? "&" : "?"}${q}`,
    );
  }

  async function exchange(code: string, s: Started): Promise<string | null> {
    const d = found!;
    const methods = d.token_endpoint_auth_methods_supported;
    const basic = !methods || methods.includes("client_secret_basic");
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: s.verifier,
      ...(basic ? {} : { client_id: cfg.clientId, client_secret: cfg.clientSecret }),
    });
    const r = await ctx.fetch(d.token_endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        ...(basic
          ? {
              authorization: `Basic ${Buffer.from(`${encodeURIComponent(cfg.clientId)}:${encodeURIComponent(cfg.clientSecret)}`).toString("base64")}`,
            }
          : {}),
      },
      body: form,
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { id_token?: unknown };
    return typeof j.id_token === "string" ? j.id_token : null;
  }

  async function callback(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const q = new URL(req.url ?? "", ctx.config.publicUrl).searchParams;
    const state = q.get("state") ?? "";
    const s = started.get(state);
    started.delete(state); // single use, whatever happens next
    const mine = cookieOf(req);
    if (!s || Date.now() - s.at > TTL_MS || !mine || !same(mine, s.binding))
      return fail(res, "unknown or expired state");
    if (q.get("error")) return fail(res, `the issuer said ${q.get("error")}`);
    const code = q.get("code");
    const idToken = code ? await exchange(code, s) : null;
    const claims = verifier!.verify(idToken, { nonce: s.nonce });
    const raw = claims?.[cfg.loginClaim];
    if (!claims || typeof raw !== "string" || !raw.trim())
      return fail(res, "the ID token didn't check out");
    // An email the issuer says it has not verified is not a login.
    if (cfg.loginClaim === "email" && claims.email_verified === false)
      return fail(res, "email not verified");
    const login = raw.trim().toLowerCase();
    const name =
      typeof claims.name === "string" && claims.name.trim()
        ? claims.name.trim()
        : nameFromEmail(login);
    res.appendHeader("set-cookie", bindingCookie("", 0));
    const r = ctx.sessions.signIn(
      res,
      { id: `oidc:${login}`, login, name: name.slice(0, 40) },
      s.back,
    );
    go(res, r.redirect);
  }

  return {
    id: "oidc",
    openToInternet: true,
    describe: () => ({
      kind: "buttons",
      buttons: [{ label: cfg.label, start: "/auth/oidc/start" }],
    }),
    identify: () => null,
    ready: discover,
    async routes(req, res, path) {
      if (req.method === "GET" && path === "/auth/oidc/start") return (start(req, res), true);
      if (req.method === "GET" && path === "/auth/oidc/callback")
        return (await callback(req, res), true);
      return false;
    },
  };
}
