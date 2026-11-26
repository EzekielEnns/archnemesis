import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { OAuth, OAuthError } from "./oauth.ts";
import { PersonalTokens } from "./personal.ts";

function setup() {
  const kv = new Map<string, string>();
  const store = {
    setting: (k: string) => kv.get(k) ?? null,
    setSetting: (k: string, v: string) => void kv.set(k, v),
    deleteSetting: (k: string) => void kv.delete(k),
    settings: (p: string) =>
      [...kv].filter(([k]) => k.startsWith(p)).map(([key, value]) => ({ key, value })),
  };
  let t = 1_000_000;
  const now = () => t;
  const tokens = new PersonalTokens(store, now);
  const oauth = new OAuth(store, tokens, "https://archnm.example", now);
  return { oauth, tokens, advance: (ms: number) => (t += ms) };
}

const verifier = "v".repeat(50);
const challenge = createHash("sha256").update(verifier).digest("base64url");
const REDIRECT = "http://localhost:33418/callback";
const who = { owner: "google:sam@example.com", login: "sam@example.com" };

function start(oauth: OAuth, extra: Record<string, string> = {}) {
  const client = oauth.register({
    client_name: "Claude Code (archnm-acme)",
    redirect_uris: [REDIRECT],
  });
  const q = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "s1",
    resource: "https://archnm.example/mcp",
    ...extra,
  });
  return { client, r: oauth.begin(q) };
}

describe("MCP OAuth", () => {
  it("signs a client in as the person who allowed it", () => {
    const { oauth, tokens } = setup();
    const { client, r } = start(oauth);
    expect("pending" in r).toBe(true);
    const id = (r as { pending: string }).pending;
    expect(oauth.describe(id)).toEqual({
      client: "Claude Code (archnm-acme)",
      to: "localhost:33418",
    });
    const back = new URL(oauth.decide(id, true, who));
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get("state")).toBe("s1");
    const code = back.searchParams.get("code")!;
    const t = oauth.token(
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: client.client_id,
        redirect_uri: REDIRECT,
      }),
    );
    expect(t.token_type).toBe("Bearer");
    expect(tokens.check(t.access_token)).toEqual({ owner: who.owner, login: who.login });
    expect(tokens.list(who.owner)[0]!.label).toBe("Claude Code (archnm-acme)");
    // A code works once.
    expect(() =>
      oauth.token(
        new URLSearchParams({
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          client_id: client.client_id,
          redirect_uri: REDIRECT,
        }),
      ),
    ).toThrow(OAuthError);
  });

  it("refuses a wrong verifier, a run-out code and Deny", () => {
    const { oauth, advance } = setup();
    const { client, r } = start(oauth);
    const code = new URL(
      oauth.decide((r as { pending: string }).pending, true, who),
    ).searchParams.get("code")!;
    expect(() =>
      oauth.token(
        new URLSearchParams({
          grant_type: "authorization_code",
          code,
          code_verifier: "w".repeat(50),
          client_id: client.client_id,
          redirect_uri: REDIRECT,
        }),
      ),
    ).toThrow(/verifier/);
    const again = start(oauth);
    const code2 = new URL(
      oauth.decide((again.r as { pending: string }).pending, true, who),
    ).searchParams.get("code")!;
    advance(3 * 60_000);
    expect(() =>
      oauth.token(
        new URLSearchParams({
          grant_type: "authorization_code",
          code: code2,
          code_verifier: verifier,
          client_id: again.client.client_id,
          redirect_uri: REDIRECT,
        }),
      ),
    ).toThrow(/ran out/);
    const denied = start(oauth);
    expect(
      new URL(oauth.decide((denied.r as { pending: string }).pending, false, who)).searchParams.get(
        "error",
      ),
    ).toBe("access_denied");
  });

  it("never sends errors to an address the client didn't register, and wants PKCE", () => {
    const { oauth } = setup();
    expect(() => oauth.register({ redirect_uris: ["http://evil.example/cb"] })).toThrow(OAuthError);
    const { client } = start(oauth);
    expect(() =>
      oauth.begin(
        new URLSearchParams({
          client_id: client.client_id,
          redirect_uri: "https://evil.example/cb",
          response_type: "code",
        }),
      ),
    ).toThrow(/redirect_uri/);
    expect(() =>
      oauth.begin(new URLSearchParams({ client_id: "archnm_client_nope", redirect_uri: REDIRECT })),
    ).toThrow(/registered/);
    const { r } = start(oauth, { code_challenge_method: "plain" });
    expect(new URL((r as { redirect: string }).redirect).searchParams.get("error")).toBe(
      "invalid_request",
    );
    const other = start(oauth, { resource: "https://other.example/mcp" });
    expect(new URL((other.r as { redirect: string }).redirect).searchParams.get("error")).toBe(
      "invalid_target",
    );
  });
});
