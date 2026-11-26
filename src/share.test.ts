// A share link in the address: its token is kept for that one design, in session storage (never
// local storage), and the address is left without it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetShare, shareTokenFor, takeShareFromHash } from "./share.ts";

const TOKEN = "abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE";
let session: Map<string, string>;
let local: Map<string, string>;
let address: string;

function stub(hash: string) {
  address = "";
  vi.stubGlobal("sessionStorage", {
    getItem: (k: string) => session.get(k) ?? null,
    setItem: (k: string, v: string) => void session.set(k, v),
    removeItem: (k: string) => void session.delete(k),
    key: (i: number) => [...session.keys()][i] ?? null,
    get length() {
      return session.size;
    },
  });
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => local.get(k) ?? null,
    setItem: (k: string, v: string) => void local.set(k, v),
  });
  vi.stubGlobal("location", { pathname: "/", search: "", hash });
  vi.stubGlobal("history", {
    replaceState: (_s: unknown, _t: string, url: string) => void (address = url),
  });
}

beforeEach(() => {
  session = new Map();
  local = new Map();
});
afterEach(() => vi.unstubAllGlobals());

describe("takeShareFromHash", () => {
  it("keeps the token in session storage for that design and strips it from the address", () => {
    stub(`#/shop~share=${TOKEN}`);
    takeShareFromHash();
    expect(address).toBe("/#/shop");
    expect(shareTokenFor("shop")).toBe(TOKEN);
    expect(local.size).toBe(0);
    // Not for another design.
    expect(shareTokenFor("other")).toBeNull();
    expect(shareTokenFor("shopper")).toBeNull();
  });

  it("keeps what follows (a diagram), and a fork's token also serves its base", () => {
    stub(`#/shop@one~share=${TOKEN}/d/web`);
    takeShareFromHash();
    expect(address).toBe("/#/shop@one/d/web");
    expect(shareTokenFor("shop@one")).toBe(TOKEN);
    expect(shareTokenFor("shop")).toBe(TOKEN);
    expect(shareTokenFor("shop@two")).toBeNull();
    forgetShare("shop@one");
    expect(shareTokenFor("shop")).toBeNull();
  });

  it("leaves an ordinary address alone", () => {
    stub("#/shop/d/web");
    takeShareFromHash();
    expect(address).toBe("");
    expect(session.size).toBe(0);
  });

  it("does nothing, and doesn't throw, where session storage is refused", () => {
    stub(`#/shop~share=${TOKEN}`);
    vi.stubGlobal("sessionStorage", {
      get length(): number {
        throw new Error("blocked");
      },
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(() => takeShareFromHash()).not.toThrow();
    expect(address).toBe("/#/shop");
    expect(shareTokenFor("shop")).toBeNull();
  });
});
