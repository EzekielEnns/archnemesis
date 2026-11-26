// Share links: a token that lets whoever holds it view (and fork) one design or fork. Never edit.
//
// The token is 32 random bytes, shown once; only its SHA-256 is kept (table share_links), so a copy
// of the database gives no link away. A lookup costs the same whether the token exists or not
// (hash, index lookup, constant-time compare against the stored hash or a dummy). The token only
// ever travels in the URL fragment and the X-Archnm-Share header (or a sync connection's auth
// message): never a path or query, and never logged.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ShareLink } from "../shared/api.ts";
import type { LinkRow } from "./access.ts";
import type { LinkRecord, DocStore } from "./store.ts";

const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");
const DUMMY = hashOf("no such link");
const SECOND = 1000;

const iso = (n: number | null) => (n === null ? null : new Date(n).toISOString());

export class Links {
  private store: DocStore;
  private now: () => number;
  /** When last use was last written, by link (not a write per request). */
  private touched = new Map<string, number>();

  constructor(store: DocStore, now: () => number = Date.now) {
    this.store = store;
    this.now = now;
  }

  /** A new link for `doc`; the token is only ever in this return value. */
  make(doc: string, by: { id: string; name: string }, expiresInMs?: number | null) {
    const token = randomBytes(32).toString("base64url");
    const id = randomBytes(6).toString("hex");
    const at = this.now();
    this.store.addLink({
      id,
      hash: hashOf(token),
      doc,
      byId: by.id,
      byName: by.name.slice(0, 80),
      createdAt: at,
      expiresAt: expiresInMs ? at + expiresInMs : null,
    });
    return { token, id, info: this.info(this.store.linkRow("id", id)!) };
  }

  /** The link a token names (any state), or null. Same work either way. */
  find(token: string): LinkRow | null {
    const h = hashOf(token);
    const row = this.store.linkRow("hash", h);
    const same = timingSafeEqual(Buffer.from(row?.hash ?? DUMMY), Buffer.from(h));
    if (!row || !same) return null;
    return { id: row.id, doc: row.doc, expiresAt: row.expiresAt, revokedAt: row.revokedAt };
  }

  /** Whether a link still works (for the connections open on it). */
  valid(id: string): boolean {
    const r = this.store.linkRow("id", id);
    return !!r && r.revokedAt === null && (r.expiresAt === null || r.expiresAt > this.now());
  }

  /** Note that a link was just used (at most once a minute per link). */
  used(id: string): void {
    const at = this.now();
    const last = this.touched.get(id);
    if (last !== undefined && at - last < 60 * SECOND) return;
    this.touched.set(id, at);
    this.store.touchLink(id, at);
  }

  list(doc: string): ShareLink[] {
    return this.store.linksOf(doc).map((r) => this.info(r));
  }

  /** Revoke one of `doc`'s links; false when it isn't one of its links. */
  revoke(doc: string, id: string): boolean {
    const r = this.store.linkRow("id", id);
    if (!r || r.doc !== doc) return false;
    this.store.revokeLink(id, this.now());
    return true;
  }

  /** Every link to a document (and, for a design, its forks) goes. */
  drop(doc: string, withForks: boolean): void {
    this.store.dropLinks(doc, withForks);
  }

  private info(r: LinkRecord): ShareLink {
    return {
      id: r.id,
      doc: r.doc,
      by: r.byName,
      created: new Date(r.createdAt).toISOString(),
      expires: iso(r.expiresAt),
      revoked: iso(r.revokedAt),
      lastUsed: iso(r.lastUsedAt),
      active: r.revokedAt === null && (r.expiresAt === null || r.expiresAt > this.now()),
    };
  }
}

/**
 * Failed link checks per address, in a sliding minute: past the limit, that address's links are
 * not looked at at all until it has been quiet (so tokens can't be guessed cheaply). A link that
 * works never counts.
 */
export class FailureLimiter {
  private fails = new Map<string, number[]>();
  private limit: number;
  private windowMs: number;
  private now: () => number;

  constructor(limit = 20, windowMs = 60_000, now: () => number = Date.now) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
  }

  blocked(addr: string): boolean {
    return this.recent(addr).length >= this.limit;
  }

  fail(addr: string): void {
    const list = this.recent(addr);
    list.push(this.now());
    this.fails.set(addr, list);
    if (this.fails.size > 5000) this.fails.clear();
  }

  private recent(addr: string): number[] {
    const cut = this.now() - this.windowMs;
    const list = (this.fails.get(addr) ?? []).filter((t) => t > cut);
    if (list.length) this.fails.set(addr, list);
    else this.fails.delete(addr);
    return list;
  }
}
