// Test support: signing keys and tokens made in the test, for the JWT and provider tests.
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";

const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

export interface TestKey {
  kid: string;
  alg: "RS256" | "ES256";
  publicKey: KeyObject;
  privateKey: KeyObject;
  /** The public half as a JWK, kid included. */
  jwk: Record<string, unknown>;
  /** The public half as a PEM public key (what x509Loader's fake serves; a real one is a certificate). */
  pem: string;
  /** A signed token; `head` overrides header fields. */
  token(claims: Record<string, unknown>, head?: Record<string, unknown>): string;
}

export function testKey(alg: "RS256" | "ES256", kid = "k1"): TestKey {
  const { publicKey, privateKey } =
    alg === "RS256"
      ? generateKeyPairSync("rsa", { modulusLength: 2048 })
      : generateKeyPairSync("ec", { namedCurve: "P-256" });
  const signWith = (data: string) =>
    alg === "RS256"
      ? sign("RSA-SHA256", Buffer.from(data), privateKey)
      : sign("sha256", Buffer.from(data), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return {
    kid,
    alg,
    publicKey,
    privateKey,
    jwk: { ...publicKey.export({ format: "jwk" }), kid, alg, use: "sig" },
    pem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    token(claims, head = {}) {
      const body = `${enc({ alg, kid, ...head })}.${enc(claims)}`;
      return `${body}.${signWith(body).toString("base64url")}`;
    },
  };
}

/** A fetch that answers these URLs with these JSON documents, and 404s the rest. */
export function fakeFetch(docs: Record<string, unknown>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    return url in docs
      ? new Response(JSON.stringify(docs[url]), { headers: { "content-type": "application/json" } })
      : new Response("not found", { status: 404 });
  }) as typeof fetch;
}
