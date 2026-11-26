import { describe, expect, it } from "vitest";
import { Sessions, cookie, sessionCookie } from "./session.ts";
import { PersonalTokens } from "./personal.ts";
import { fakeFetch, testKey } from "../auth/testkeys.ts";
import { startedAuth } from "../testing.ts";

const NOW = 1_800_000_000;
const sam = {
  id: "google:sam@example.com",
  provider: "gcip",
  login: "sam@example.com",
  name: "Sam",
};

describe("sessions", () => {
  it("round-trips, refuses tampering and expiry", () => {
    let now = NOW;
    const s = new Sessions({ secret: "x", now: () => now });
    const v = s.make(sam);
    expect(s.read(v)).toEqual(sam);
    const [body, sig] = v.split(".");
    const forged = Buffer.from(
      JSON.stringify({
        i: "google:zeek@example.com",
        p: "gcip",
        e: "zeek@example.com",
        n: null,
        x: NOW + 99999,
      }),
    ).toString("base64url");
    expect(s.read(`${forged}.${sig}`)).toBeNull();
    expect(new Sessions({ secret: "y", now: () => now }).read(v)).toBeNull();
    expect(s.read(`${body}`)).toBeNull();
    now += 25 * 3600;
    expect(s.read(v)).toBeNull();
  });
  it("refuses a cookie from before providers (no id), even one signed with the right key", () => {
    const s = new Sessions({ secret: "x", now: () => NOW });
    const old = Buffer.from(
      JSON.stringify({ e: "sam@example.com", n: null, x: NOW + 600 }),
    ).toString("base64url");
    const signed = `${old}.${(s as unknown as { sign(b: string): string }).sign(old)}`;
    expect(s.read(signed)).toBeNull();
  });
  it("cookie parsing and headers", () => {
    expect(cookie("a=1; archnm_session=abc.def; b=2", "archnm_session")).toBe("abc.def");
    expect(cookie("archnm_session=%E0%A4%A", "archnm_session")).toBeNull(); // bad escapes: no cookie
    expect(sessionCookie("v", true)).toContain("Secure");
    expect(sessionCookie("v", true)).toContain("HttpOnly");
    expect(sessionCookie("v", false)).toContain("SameSite=Lax");
    expect(sessionCookie(null, false)).toContain("Max-Age=0");
  });
});

function memStore() {
  const m = new Map<string, string>();
  return {
    setting: (k: string) => m.get(k) ?? null,
    setSetting: (k: string, v: string) => void m.set(k, v),
    deleteSetting: (k: string) => void m.delete(k),
    settings: (p: string) =>
      [...m].filter(([k]) => k.startsWith(p)).map(([key, value]) => ({ key, value })),
  };
}

describe("personal tokens", () => {
  const key = testKey("RS256");
  const certs = fakeFetch({
    "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com": {
      k1: key.pem,
    },
  });
  const env = {
    ARCHNM_AUTH: "gcip",
    ARCHNM_GCIP_PROJECT: "test-project",
    ARCHNM_GCIP_API_KEY: "k",
    ARCHNM_ADMINS: "zeek@example.com",
    ARCHNM_EDITORS: "@example.com",
    ARCHNM_VIEWERS: "@example.org",
  };
  it("act as their owner with today's role; revoke; run out; survive a restart", async () => {
    let now = Date.parse("2026-11-20T00:00:00Z");
    const store = memStore();
    const pats = new PersonalTokens(store, () => now);
    const { token, info } = pats.make("google:sam@example.com", "sam@example.com", "Claude Code");
    expect(token.startsWith("archnm_pat_")).toBe(true);
    expect(JSON.stringify([...store.settings("pat:")])).not.toContain(token);
    const a = await startedAuth(env, certs);
    a.personal = new PersonalTokens(store, () => now); // a restart: loaded from the store
    expect(a.identify({ token, agent: true })).toMatchObject({
      id: "agent:sam@example.com",
      kind: "agent",
      roles: ["editor"],
    });
    expect(a.identify({ token: token + "x" })).toBeNull();
    // Off the lists: the token stops working at once.
    const strict = await startedAuth(
      { ...env, ARCHNM_EDITORS: "zeek@example.com", ARCHNM_VIEWERS: "zeek@example.com" },
      certs,
    );
    strict.personal = a.personal;
    expect(strict.identify({ token })).toBeNull();
    expect(a.personal.list("google:sam@example.com").map((t) => t.id)).toEqual([info.id]);
    expect(a.personal.revoke("google:eve@x.com", info.id)).toBe(false);
    now += 181 * 86_400_000;
    expect(a.identify({ token })).toBeNull();
    now -= 181 * 86_400_000;
    expect(a.personal.revoke("google:sam@example.com", info.id)).toBe(true);
    expect(a.identify({ token })).toBeNull();
  });
  it("don't exist where nobody signs in as themselves (local)", async () => {
    const a = await startedAuth({ ARCHNM_AUTH: "local" });
    a.personal = new PersonalTokens(memStore());
    const { token } = a.personal.make("local:You", "You", "x");
    expect(a.personalTokens).toBe(false);
    expect(a.identify({ token, agent: true })).toBeNull();
  });
});
