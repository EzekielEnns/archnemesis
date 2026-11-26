// header: who someone is comes from a header a trusted proxy in front sets. Two shapes:
//
//  - a signed JWT in a header (Cloudflare Access, Google IAP, Pomerium, oauth2-proxy with a JWT,
//    ...): verified here on every request with server/auth/jwt.ts against the proxy's published
//    keys, issuer and audience. A forged header is just a bad signature, so this is safe to
//    expose on any address (the proxy should still be the only way in).
//  - plain trusted headers (a login header, optionally a name header): believed as they are, so
//    only where nothing but the proxy can reach the port: loopback (or ARCHNM_ALLOW_OPEN).
//
// Presets fill the settings in (ARCHNM_AUTH=tailscale | iap | cloudflare-access; server/config.ts).
// No identity header means no one, except Tailscale's preset, where a request on the machine
// itself (no tailnet user) is the machine's owner, an editor, and Funnel traffic is never.
import type { JwtClaims } from "../jwt.ts";
import { JwtVerifier, jwksLoader } from "../jwt.ts";
import { nameFromEmail } from "../names.ts";
import type { AuthProvider, Identity, ProviderContext, ProviderCredentials } from "../provider.ts";

export interface HeaderConfig {
  /** The provider's id: "header", or its preset's name. */
  id: string;
  /** Identity.id is `<idPrefix>:<login>`. */
  idPrefix: string;
  jwt: {
    header: string;
    jwksUrl: string;
    issuer: string;
    audience: string;
    loginClaim: string;
    nameClaim: string | null;
    /** Removed from the front of the login (IAP: "accounts.google.com:"). */
    loginPrefix: string;
  } | null;
  plain: {
    loginHeader: string;
    nameHeader: string | null;
    /** A request with this header is public-internet traffic: never signed in (Tailscale Funnel). */
    refuseHeader: string | null;
    /** A request with no login is the machine's owner, under this name (Tailscale). Null: no one. */
    localName: string | null;
    /** ARCHNM_ALLOW_OPEN: trust the headers beyond loopback too. */
    allowOpen: boolean;
  } | null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function fromJwt(cfg: NonNullable<HeaderConfig["jwt"]>, claims: JwtClaims): Identity | null {
  let login = str(claims[cfg.loginClaim]);
  if (login?.startsWith(cfg.loginPrefix)) login = login.slice(cfg.loginPrefix.length);
  if (!login) return null;
  login = login.toLowerCase();
  const name = cfg.nameClaim ? str(claims[cfg.nameClaim]) : null;
  return { id: "", login, name: (name ?? nameFromEmail(login)).slice(0, 40) };
}

function fromPlain(
  cfg: NonNullable<HeaderConfig["plain"]>,
  creds: ProviderCredentials,
  prefix: string,
): Identity | null {
  // Funnel traffic is the public internet: it never gets the no-identity local pass.
  if (cfg.refuseHeader && creds.header(cfg.refuseHeader)) return null;
  const login = creds.header(cfg.loginHeader);
  if (!login) {
    const name = cfg.localName;
    return name
      ? {
          id: `local:${name}`,
          login: name,
          name,
          machine: { role: "editor", agent: { id: `agent:${name}`, for: `local:${name}` } },
        }
      : null;
  }
  const name = (cfg.nameHeader && creds.header(cfg.nameHeader)) || login.split("@")[0]!;
  return { id: `${prefix}:${login}`, login, name };
}

export function headerProvider(cfg: HeaderConfig, ctx: ProviderContext): AuthProvider {
  if (cfg.plain && !ctx.config.loopback && !cfg.plain.allowOpen)
    throw new Error(
      `ARCHNM_AUTH=${cfg.id} trusts a plain header, so it only listens on loopback. Use a signed one (ARCHNM_HEADER_JWT), or ARCHNM_AUTH=tokens to listen on another address.`,
    );
  const jwt = cfg.jwt;
  const verifier = jwt
    ? new JwtVerifier({
        keys: jwksLoader(jwt.jwksUrl, ctx.fetch),
        issuer: jwt.issuer,
        audience: jwt.audience,
      })
    : null;
  return {
    id: cfg.id,
    describe: () => ({ kind: "none" }),
    ready: () => verifier?.ready() ?? Promise.resolve(),
    identify(creds) {
      if (jwt && verifier) {
        const claims = verifier.verify(creds.header(jwt.header));
        const who = claims && fromJwt(jwt, claims);
        return who ? { ...who, id: `${cfg.idPrefix}:${who.login}` } : null;
      }
      return cfg.plain ? fromPlain(cfg.plain, creds, cfg.idPrefix) : null;
    },
  };
}
