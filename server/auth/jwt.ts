// One JWT verifier for everything that signs people in with a token a third party issued: an
// OpenID Connect ID token, a proxy's header (Cloudflare Access, Google IAP), Firebase's ID token.
// Dependency-free: node:crypto only. It checks, in this order: the shape, the algorithm (RS256
// or ES256, never "none", and the key must be of the matching type), the signature against the
// issuer's published keys, then issuer, audience, expiry, issue time, not-before and, when
// asked, the nonce. Anything off, or any error at all, is "no": verify() returns null.
//
// Keys come from a KeyLoader: jwksLoader (a JWK Set URL) or x509Loader (a { kid: PEM
// certificate } document, which is what Firebase publishes). The verifier loads them at ready(),
// refreshes them every few hours, and when a token names a key it doesn't know it fetches again
// (at most once a minute) and says no to that token; the next one gets in.
//
// A provider that lives outside this repo can import this file: the Docker image keeps it at
// /app/server/auth/jwt.ts (see examples/auth/README.md).
import { createPublicKey, verify, type KeyObject } from "node:crypto";

export type JwtAlgorithm = "RS256" | "ES256";
export type JwtClaims = Record<string, unknown>;
export type KeyLoader = () => Promise<Map<string, KeyObject>>;

type Fetch = typeof fetch;

const REFRESH_MS = 3 * 3_600_000;
const REFETCH_MIN_MS = 60_000;
const DEFAULT_SKEW_S = 60;

const decode = (s: string) => Buffer.from(s, "base64url");

async function getJson(fetchFn: Fetch, url: string, what: string): Promise<unknown> {
  const r = await fetchFn(url, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`${what}: ${url} answered ${r.status}`);
  return r.json();
}

/** Keys from a JWK Set (RSA, or EC on P-256), by kid. A key without a kid is kept as "" (a set of one). */
export function jwksLoader(url: string, fetchFn: Fetch = fetch): KeyLoader {
  return async () => {
    const set = (await getJson(fetchFn, url, "signing keys")) as { keys?: unknown };
    const keys = new Map<string, KeyObject>();
    for (const k of Array.isArray(set.keys) ? (set.keys as Record<string, unknown>[]) : []) {
      const usable = k.kty === "RSA" || (k.kty === "EC" && k.crv === "P-256") ? k : null;
      if (!usable || (usable.use && usable.use !== "sig")) continue;
      try {
        keys.set(
          typeof k.kid === "string" ? k.kid : "",
          createPublicKey({ key: k as never, format: "jwk" }),
        );
      } catch {
        // A key we can't read is one we don't use.
      }
    }
    if (!keys.size) throw new Error(`signing keys: ${url} has no RSA or P-256 key`);
    return keys;
  };
}

/** Keys from a { kid: PEM certificate } document (Firebase's securetoken certificates). */
export function x509Loader(url: string, fetchFn: Fetch = fetch): KeyLoader {
  return async () => {
    const certs = (await getJson(fetchFn, url, "signing certificates")) as Record<string, unknown>;
    const keys = new Map<string, KeyObject>();
    for (const [kid, pem] of Object.entries(certs))
      if (typeof pem === "string") keys.set(kid, createPublicKey(pem));
    if (!keys.size) throw new Error(`signing certificates: ${url} has none`);
    return keys;
  };
}

export interface JwtRules {
  keys: KeyLoader;
  /** The `iss` claim, exactly. */
  issuer: string;
  /** The token's `aud` (a string or a list) must include this. */
  audience: string;
  /** Default both. */
  algorithms?: readonly JwtAlgorithm[];
  /** Clock skew allowed on exp, iat and nbf, in seconds. Default 60. */
  skewSeconds?: number;
  /** For tests. */
  now?: () => number;
}

export class JwtVerifier {
  private keys = new Map<string, KeyObject>();
  private fetchedAt = 0;
  private fetching: Promise<void> | null = null;
  private readonly rules: JwtRules;
  private readonly algs: readonly JwtAlgorithm[];
  private readonly now: () => number;

  constructor(rules: JwtRules) {
    this.rules = rules;
    this.algs = rules.algorithms ?? ["RS256", "ES256"];
    this.now = rules.now ?? (() => Date.now() / 1000);
  }

  /** Load the keys (at start: a failure stops the server with the reason), and again every few hours. */
  async ready(): Promise<void> {
    await this.refresh();
    setInterval(
      () => void this.refresh().catch((e) => console.error("archnm: signing keys:", e)),
      REFRESH_MS,
    ).unref();
  }

  private refresh(): Promise<void> {
    this.fetching ??= this.rules
      .keys()
      .then((next) => {
        this.keys = next;
        this.fetchedAt = Date.now();
      })
      .finally(() => {
        this.fetching = null;
      });
    return this.fetching;
  }

  /** The token's claims if it checks out, else null. `nonce`: the one the sign-in started with. */
  verify(token: string | null | undefined, opts: { nonce?: string } = {}): JwtClaims | null {
    if (!token) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    try {
      const head = JSON.parse(decode(parts[0]!).toString("utf8")) as { alg?: string; kid?: string };
      const alg = this.algs.find((a) => a === head.alg);
      if (!alg) return null;
      const key = this.keyFor(head.kid);
      if (!key || !signatureOk(alg, `${parts[0]}.${parts[1]}`, key, decode(parts[2]!))) return null;
      const claims = JSON.parse(decode(parts[1]!).toString("utf8")) as JwtClaims;
      return this.claimsOk(claims, opts.nonce) ? claims : null;
    } catch {
      return null;
    }
  }

  private keyFor(kid: string | undefined): KeyObject | null {
    const key = kid ? this.keys.get(kid) : this.keys.size === 1 ? [...this.keys.values()][0] : null;
    if (!key && Date.now() - this.fetchedAt > REFETCH_MIN_MS) {
      // The issuer rotated its keys: fetch again, and let the next token through once they're in.
      void this.refresh().catch(() => {});
    }
    return key ?? null;
  }

  private claimsOk(c: JwtClaims, nonce: string | undefined): boolean {
    const now = this.now();
    const skew = this.rules.skewSeconds ?? DEFAULT_SKEW_S;
    if (c.iss !== this.rules.issuer) return false;
    const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
    if (!aud.includes(this.rules.audience)) return false;
    if (typeof c.exp !== "number" || c.exp < now - skew) return false;
    if (typeof c.iat !== "number" || c.iat > now + skew) return false;
    if (c.nbf !== undefined && (typeof c.nbf !== "number" || c.nbf > now + skew)) return false;
    return nonce === undefined || c.nonce === nonce;
  }
}

function signatureOk(alg: JwtAlgorithm, data: string, key: KeyObject, sig: Buffer): boolean {
  // The key's type must match the algorithm: an RSA public key never checks an ES256 token.
  if (alg === "RS256")
    return key.asymmetricKeyType === "rsa" && verify("RSA-SHA256", Buffer.from(data), key, sig);
  return (
    key.asymmetricKeyType === "ec" &&
    verify("sha256", Buffer.from(data), { key, dsaEncoding: "ieee-p1363" }, sig)
  );
}
