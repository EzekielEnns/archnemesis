// Share link tokens: stored only as a hash, found at the same cost whether they exist or not,
// ended by revoking or expiring, and not guessable from one address.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FailureLimiter, Links } from "./links.ts";
import { DocStore } from "./store.ts";

const by = { id: "u1", name: "Una" };
const fresh = (now: () => number = () => 1000) =>
  new Links(new DocStore(join(mkdtempSync(join(tmpdir(), "archnm-links-")), "t.sqlite")), now);

describe("Links", () => {
  it("makes a 32-byte token, shown once, and keeps only its hash", () => {
    const store = new DocStore(":memory:");
    const links = new Links(store, () => 1000);
    const made = links.make("shop", by, null);
    expect(Buffer.from(made.token, "base64url")).toHaveLength(32);
    const row = store.linksOf("shop")[0]!;
    expect(row.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(made.token);
    expect(JSON.stringify(links.list("shop"))).not.toContain(made.token);
    expect(links.find(made.token)).toMatchObject({ id: made.id, doc: "shop" });
    expect(links.find(`${made.token}x`)).toBeNull();
    expect(links.find("")).toBeNull();
  });

  it("expires, revokes (only its own document's), and notes when it was last used", () => {
    let now = 1000;
    const links = fresh(() => now);
    const a = links.make("shop", by, 500);
    expect(links.valid(a.id)).toBe(true);
    now = 1600;
    expect(links.valid(a.id)).toBe(false);
    const b = links.make("shop", by, null);
    expect(links.revoke("other", b.id)).toBe(false);
    expect(links.revoke("shop", b.id)).toBe(true);
    expect(links.valid(b.id)).toBe(false);
    expect(links.find(b.token)).toMatchObject({ revokedAt: 1600 });
    const c = links.make("shop", by, null);
    links.used(c.id);
    expect(links.list("shop").find((l) => l.id === c.id)!.lastUsed).not.toBeNull();
  });

  it("dropping a design drops its links and its forks'", () => {
    const links = fresh();
    const d = links.make("shop", by, null);
    const f = links.make("shop@one", by, null);
    const other = links.make("shopper", by, null);
    links.drop("shop", true);
    expect(links.find(d.token)).toBeNull();
    expect(links.find(f.token)).toBeNull();
    expect(links.find(other.token)).not.toBeNull();
  });
});

describe("FailureLimiter", () => {
  it("blocks an address after its limit of failures in the window, then forgives", () => {
    let now = 0;
    const l = new FailureLimiter(3, 1000, () => now);
    for (let i = 0; i < 3; i++) {
      expect(l.blocked("a")).toBe(false);
      l.fail("a");
    }
    expect(l.blocked("a")).toBe(true);
    expect(l.blocked("b")).toBe(false);
    now = 1001;
    expect(l.blocked("a")).toBe(false);
  });
});
