// The server backend asks the server the same things the app used to ask it directly.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServerBackend } from "./server.ts";
import { BackendError } from "./types.ts";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

let calls: Call[];
let answer: (url: string) => Response;
let kept: Map<string, string>;

beforeEach(() => {
  calls = [];
  kept = new Map([
    ["archnm.token", "tok"],
    ["archnm.name", "Zed"],
  ]);
  answer = () => Response.json({});
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => kept.get(k) ?? null,
    setItem: (k: string, v: string) => void kept.set(k, v),
    removeItem: (k: string) => void kept.delete(k),
  });
  vi.stubGlobal("location", { protocol: "http:", host: "localhost:5190", hash: "#/shop" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({
        url,
        method: init.method ?? "GET",
        headers: (init.headers ?? {}) as Record<string, string>,
        body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return answer(url);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const signedIn = { authorization: "Bearer tok", "x-archnm-name": "Zed" };

describe("the server backend", () => {
  it("lists and creates designs as the signed-in person", async () => {
    const b = createServerBackend();
    answer = () => Response.json([{ key: "shop" }]);
    expect(await b.designs.list()).toEqual([{ key: "shop" }]);
    expect(calls[0]).toEqual({
      url: "/api/designs",
      method: "GET",
      headers: signedIn,
      body: undefined,
    });
    answer = () => Response.json({ key: "new", name: "New", doc: "id" }, { status: 201 });
    expect(await b.designs.create("New")).toEqual({ key: "new" });
    expect(calls[1]).toEqual({
      url: "/api/designs",
      method: "POST",
      headers: { "content-type": "application/json", ...signedIn },
      body: { name: "New" },
    });
    // The example asks the server for it, and checks it came with boxes.
    answer = (url) =>
      url.endsWith("/state")
        ? Response.json({ objects: [{ id: "a" }] })
        : Response.json({ key: "shop" }, { status: 201 });
    expect(await b.designs.create("Shop", { example: true })).toEqual({ key: "shop" });
    expect(calls[2]!.body).toEqual({ name: "Shop", from: "example" });
  });

  it("drops an example that came back empty (the server has examples off)", async () => {
    const b = createServerBackend();
    answer = (url) =>
      url.endsWith("/state") ? Response.json({ objects: [] }) : Response.json({ key: "shop" });
    await expect(b.designs.create("Shop", { example: true })).rejects.toMatchObject({
      code: "refused",
    });
    expect(calls.map((c) => c.method)).toEqual(["POST", "GET", "DELETE"]);
  });

  it("builds git and design requests under the design's key", async () => {
    const b = createServerBackend();
    answer = () => Response.json({ doc: "shop@x" });
    await b.git!.fork("shop", "x");
    await b.designs.remove("a b");
    await b.git!.edit("shop", [{ ops: [], label: "l" }]);
    await b.guide!.reply("shop@x", { seq: 2, action: "next" });
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ["POST", "/api/d/shop/fork", { name: "x" }],
      ["DELETE", "/api/d/a%20b", undefined],
      ["POST", "/api/d/shop/edit", { batches: [{ ops: [], label: "l" }] }],
      ["POST", "/api/d/shop%40x/guide", { seq: 2, action: "next" }],
    ]);
    expect(calls[0]!.headers).toEqual({ "content-type": "application/json", ...signedIn });
  });

  it("sends token calls and icon lookups without the person's headers, as before", async () => {
    const b = createServerBackend();
    answer = () => Response.json([]);
    await b.tokens!.list();
    answer = () => new Response("<svg/>");
    expect(await b.icons.svg("Go")).toBe("<svg/>");
    answer = () => Response.json([{ title: "Go" }]);
    expect(await b.icons.search(" go ")).toEqual(["Go"]);
    expect(calls.map((c) => [c.url, c.headers])).toEqual([
      ["/api/tokens", {}],
      ["/api/icon?tech=Go&color=brand&v=3", {}],
      ["/api/icons?q=go", {}],
    ]);
    expect(b.icons.url!("C++")).toBe("/api/icon?tech=C%2B%2B&color=brand&v=3");
  });

  it("turns a refusal into one error type, with the server's words", async () => {
    const b = createServerBackend();
    answer = () => Response.json({ error: "only its owner shares a design" }, { status: 403 });
    await expect(b.designs.share!("shop", true)).rejects.toMatchObject({
      code: "refused",
      message: "only its owner shares a design",
      status: 403,
    });
    answer = () => Response.json({}, { status: 404 });
    await expect(b.designs.info("nope")).rejects.toMatchObject({ code: "missing" });
    // Not signed in: the token is forgotten and the app is told.
    answer = () => new Response(null, { status: 401 });
    await expect(b.me()).rejects.toMatchObject({ code: "signin" });
    expect(kept.has("archnm.token")).toBe(false);
  });

  it("says offline for a network failure, never a bare TypeError", async () => {
    const b = createServerBackend();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    await expect(b.config()).rejects.toBeInstanceOf(BackendError);
    await expect(b.config()).rejects.toMatchObject({ code: "offline" });
  });

  it("reads who you are, and whether you're an admin", async () => {
    const b = createServerBackend();
    answer = () => Response.json({ id: "u1", name: "Zed", kind: "human", roles: ["admin"] });
    expect(await b.me()).toEqual({ id: "u1", name: "Zed", kind: "human", admin: true });
  });

  it("posts the call log to telemetry, and never throws from it", async () => {
    const b = createServerBackend();
    b.telemetry!.call({ tool: "read" });
    await Promise.resolve();
    expect(calls[0]).toMatchObject({
      url: "/api/telemetry/call",
      method: "POST",
      body: { tool: "read" },
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("down")));
    expect(() => b.telemetry!.call({ tool: "read" })).not.toThrow();
    expect(await b.telemetry!.feedback({ text: "x" })).toBeUndefined();
  });
});

describe("share links", () => {
  const TOKEN = "abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE";
  beforeEach(() => {
    const held = new Map([["archnm.share.secret", TOKEN]]);
    vi.stubGlobal("sessionStorage", {
      getItem: (k: string) => held.get(k) ?? null,
      setItem: () => {},
      removeItem: () => {},
      key: (i: number) => [...held.keys()][i] ?? null,
      length: held.size,
    });
  });

  it("sends the held link for that design only, in a header (never the address)", async () => {
    const b = createServerBackend();
    answer = () => Response.json({ key: "secret", name: "S", doc: "d", mode: "edit", git: false });
    await b.designs.info("secret");
    await b.designs.info("other");
    await b.designs.list();
    expect(calls[0]!.headers["x-archnm-share"]).toBe(TOKEN);
    expect(calls[0]!.url).not.toContain(TOKEN);
    expect(calls[1]!.headers["x-archnm-share"]).toBeUndefined();
    expect(calls[2]!.headers["x-archnm-share"]).toBeUndefined();
    expect(b.links!.holds("secret")).toBe(true);
    expect(b.links!.holds("other")).toBe(false);
  });

  it("reads what you may do here, and says so when it's a link", async () => {
    const b = createServerBackend();
    const can = { view: true, fork: true, edit: false, manage: false };
    answer = () =>
      Response.json({
        key: "secret",
        name: "S",
        doc: "d",
        mode: "edit",
        git: false,
        canEdit: false,
        can,
        viaLink: true,
      });
    expect(await b.designs.info("secret")).toMatchObject({ canEdit: false, can, viaLink: true });
  });

  it("makes, lists, revokes and copies under the design", async () => {
    const b = createServerBackend();
    answer = () =>
      Response.json({ links: [], reach: {}, url: "u", link: {}, key: "copy", ok: true });
    await b.links!.list("secret");
    await b.links!.create("secret", 7);
    await b.links!.revoke("secret", "ab12");
    await b.links!.copy("secret");
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ["GET", "/api/d/secret/links", undefined],
      ["POST", "/api/d/secret/links", { days: 7 }],
      ["DELETE", "/api/d/secret/links/ab12", undefined],
      ["POST", "/api/d/secret/copy", {}],
    ]);
  });
});
