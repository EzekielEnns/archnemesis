import { describe, expect, it } from "vitest";
import { JwtVerifier, jwksLoader, x509Loader } from "./jwt.ts";
import { fakeFetch, testKey } from "./testkeys.ts";

const NOW = 1_800_000_000;
const ISS = "https://issuer.example";
const AUD = "archnm";
const claims = (extra: Record<string, unknown> = {}) => ({
  iss: ISS,
  aud: AUD,
  iat: NOW - 10,
  exp: NOW + 600,
  sub: "u1",
  email: "sam@example.com",
  ...extra,
});

async function verifierFor(...keys: ReturnType<typeof testKey>[]) {
  const v = new JwtVerifier({
    keys: jwksLoader(
      "https://issuer.example/jwks",
      fakeFetch({ "https://issuer.example/jwks": { keys: keys.map((k) => k.jwk) } }),
    ),
    issuer: ISS,
    audience: AUD,
    now: () => NOW,
  });
  await v.ready();
  return v;
}

describe.each(["RS256", "ES256"] as const)("%s tokens", (alg) => {
  const key = testKey(alg);
  it("accepts a good token and returns its claims", async () => {
    const v = await verifierFor(key);
    expect(v.verify(key.token(claims()))).toMatchObject({ sub: "u1", email: "sam@example.com" });
  });

  it("refuses anything off", async () => {
    const v = await verifierFor(key);
    const other = testKey(alg, "k1"); // the same kid, someone else's key
    const bad = [
      other.token(claims()),
      key.token(claims({ aud: "someone-else" })),
      key.token(claims({ iss: "https://evil.example" })),
      key.token(claims({ exp: NOW - 120 })),
      key.token(claims({ exp: undefined })),
      key.token(claims({ iat: NOW + 3600 })), // issued in the future
      key.token(claims({ iat: undefined })),
      key.token(claims({ nbf: NOW + 3600 })),
      key.token(claims(), { alg: "none" }),
      key.token(claims(), { alg: "HS256" }),
      key.token(claims(), { kid: "unknown" }),
      "not.a.jwt",
      "a.b",
      "",
    ];
    for (const t of bad) expect(v.verify(t), t.slice(0, 30)).toBeNull();
    expect(v.verify(null)).toBeNull();
    expect(v.verify(undefined)).toBeNull();
  });

  it("refuses claims changed after signing, and an unsigned token", async () => {
    const v = await verifierFor(key);
    const [h, , s] = key.token(claims()).split(".");
    const swapped = Buffer.from(JSON.stringify(claims({ email: "admin@example.com" }))).toString(
      "base64url",
    );
    expect(v.verify(`${h}.${swapped}.${s}`)).toBeNull();
    expect(v.verify(`${h}.${swapped}.`)).toBeNull();
  });

  it("allows a minute of clock skew, not two", async () => {
    const v = await verifierFor(key);
    expect(v.verify(key.token(claims({ exp: NOW - 30 })))).not.toBeNull();
    expect(v.verify(key.token(claims({ exp: NOW - 90 })))).toBeNull();
  });

  it("checks the nonce when asked", async () => {
    const v = await verifierFor(key);
    const t = key.token(claims({ nonce: "n1" }));
    expect(v.verify(t, { nonce: "n1" })).not.toBeNull();
    expect(v.verify(t, { nonce: "n2" })).toBeNull();
    expect(v.verify(key.token(claims()), { nonce: "n1" })).toBeNull();
  });

  it("takes an audience list", async () => {
    const v = await verifierFor(key);
    expect(v.verify(key.token(claims({ aud: ["x", AUD] })))).not.toBeNull();
    expect(v.verify(key.token(claims({ aud: ["x", "y"] })))).toBeNull();
  });
});

describe("keys", () => {
  it("never lets a key of the other type check a token (algorithm confusion)", async () => {
    const rsa = testKey("RS256");
    const ec = testKey("ES256");
    const v = await verifierFor(rsa);
    // An ES256 header on a token the RSA key "signed": refused whatever the signature.
    expect(v.verify(rsa.token(claims(), { alg: "ES256" }))).toBeNull();
    const w = await verifierFor(ec);
    expect(w.verify(ec.token(claims(), { alg: "RS256" }))).toBeNull();
  });

  it("only the algorithms it was told", async () => {
    const ec = testKey("ES256");
    const v = new JwtVerifier({
      keys: jwksLoader("https://i/jwks", fakeFetch({ "https://i/jwks": { keys: [ec.jwk] } })),
      issuer: ISS,
      audience: AUD,
      algorithms: ["RS256"],
      now: () => NOW,
    });
    await v.ready();
    expect(v.verify(ec.token(claims()))).toBeNull();
  });

  it("picks the key by kid, and uses the only key when the token has no kid", async () => {
    const a = testKey("RS256", "a");
    const b = testKey("RS256", "b");
    const both = await verifierFor(a, b);
    expect(both.verify(a.token(claims()))).not.toBeNull();
    expect(both.verify(b.token(claims()))).not.toBeNull();
    expect(both.verify(b.token(claims(), { kid: undefined }))).toBeNull(); // two keys: which one?
    const one = await verifierFor(a);
    expect(one.verify(a.token(claims(), { kid: undefined }))).not.toBeNull();
  });

  it("refetches when a token names an unknown key, and lets the next one in", async () => {
    const a = testKey("RS256", "a");
    const b = testKey("RS256", "b");
    let published = [a.jwk];
    const v = new JwtVerifier({
      keys: jwksLoader(
        "https://i/jwks",
        (async () => new Response(JSON.stringify({ keys: published }))) as typeof fetch,
      ),
      issuer: ISS,
      audience: AUD,
      now: () => NOW,
    });
    await v.ready();
    published = [a.jwk, b.jwk]; // the issuer rotated
    expect(v.verify(b.token(claims()))).toBeNull(); // not known yet (and not refetched within a minute of loading)
    expect(v.verify(a.token(claims()))).not.toBeNull();
  });

  it("jwksLoader skips keys it can't use and fails when none are left", async () => {
    const rsa = testKey("RS256");
    const ok = await jwksLoader(
      "https://i/jwks",
      fakeFetch({
        "https://i/jwks": {
          keys: [{ kty: "oct", k: "x", kid: "s" }, rsa.jwk, { kty: "EC", crv: "P-384", kid: "p" }],
        },
      }),
    )();
    expect([...ok.keys()]).toEqual(["k1"]);
    await expect(
      jwksLoader(
        "https://i/jwks",
        fakeFetch({ "https://i/jwks": { keys: [{ kty: "oct", k: "x" }] } }),
      )(),
    ).rejects.toThrow(/no RSA or P-256/);
    await expect(jwksLoader("https://i/missing", fakeFetch({}))()).rejects.toThrow(/404/);
  });

  it("x509Loader reads a { kid: PEM } document (a public key stands in for Firebase's certificate)", async () => {
    const rsa = testKey("RS256");
    const keys = await x509Loader(
      "https://i/certs",
      fakeFetch({ "https://i/certs": { k1: rsa.pem } }),
    )();
    expect([...keys.keys()]).toEqual(["k1"]);
    await expect(
      x509Loader("https://i/certs", fakeFetch({ "https://i/certs": {} }))(),
    ).rejects.toThrow(/none/);
  });
});
