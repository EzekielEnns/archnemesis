// Where the live document is kept on disk: an append-only log of Yjs updates plus a
// periodic snapshot, in SQLite (node:sqlite, one file).
//
//   doc_updates    every update as it happens, with who made it
//   doc_snapshots  all updates up to `upto` merged into one, every COMPACT_EVERY updates
//   git_bindings   which designs follow a git repo (server/gitsync.ts)
//   forks          each fork of a design: its document is "<design>@<name>"
//   share_links    links that let someone view one document (token hash only; server/links.ts)
//
// Loading a document is: its snapshot, then every update after it. Nothing is ever
// rewritten in place, so a crash loses at most the update being written.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import * as Y from "yjs";

const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS doc_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc TEXT NOT NULL,
  data BLOB NOT NULL,
  actor TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS doc_updates_doc ON doc_updates(doc, id);
CREATE TABLE IF NOT EXISTS doc_snapshots (
  doc TEXT PRIMARY KEY,
  data BLOB NOT NULL,
  upto INTEGER NOT NULL,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS git_bindings (
  design TEXT PRIMARY KEY,
  remote TEXT NOT NULL,
  path TEXT NOT NULL DEFAULT '',
  branch TEXT NOT NULL DEFAULT 'main',
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS nav_trail (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  design TEXT NOT NULL,
  doc TEXT NOT NULL,
  session TEXT NOT NULL,
  user TEXT NOT NULL,
  at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS nav_trail_design ON nav_trail(design, id);
CREATE TABLE IF NOT EXISTS forks (
  doc TEXT PRIMARY KEY,
  design TEXT NOT NULL,
  name TEXT NOT NULL,
  base TEXT,
  head TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  by_id TEXT,
  by_name TEXT,
  agent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE TABLE IF NOT EXISTS share_links (
  id TEXT PRIMARY KEY,
  hash TEXT NOT NULL UNIQUE,
  doc TEXT NOT NULL,
  by_id TEXT NOT NULL,
  by_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS share_links_doc ON share_links(doc);
`;

export interface Binding {
  design: string;
  /** A URL or path git can clone. */
  remote: string;
  /** Where the design's files are in the repo ("" for the root). */
  path: string;
  /** The branch the design follows. */
  branch: string;
}

export type ForkStatus = "open" | "merged" | "discarded" | "closed";

export interface ForkRow {
  doc: string;
  design: string;
  name: string;
  /** The main commit the fork started from (or last caught up with). */
  base: string | null;
  /** The fork's latest commit on its branch, once it has one. */
  head: string | null;
  status: ForkStatus;
  byId: string | null;
  byName: string | null;
  agent: boolean;
  createdAt: string;
  /** When someone last opened a pull request page for it. */
  proposedAt?: string | null;
  /** Its pull request on GitHub, once Archnemesis opened one. */
  prNumber?: number | null;
  /** A fork of a fork: the fork it started from (its doc); its diff and pull request are against that. */
  parent?: string | null;
  /** Its git branch. Null on forks made before the rename: those keep their `atlas/...` branch. */
  branch?: string | null;
}

const COMPACT_EVERY = 500;

type Row = Record<string, unknown>;

/** One share link as stored (never the token itself). */
export interface LinkRecord {
  id: string;
  hash: string;
  doc: string;
  byId: string;
  byName: string;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  lastUsedAt: number | null;
}

const orNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const linkOf = (r: Row): LinkRecord => ({
  id: String(r.id),
  hash: String(r.hash),
  doc: String(r.doc),
  byId: String(r.by_id),
  byName: String(r.by_name),
  createdAt: Number(r.created_at),
  expiresAt: orNull(r.expires_at),
  revokedAt: orNull(r.revoked_at),
  lastUsedAt: orNull(r.last_used_at),
});

export class DocStore {
  private db: DatabaseSync;
  private sinceCompact = new Map<string, number>();

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") this.heal(path);
    this.db.exec(SCHEMA);
    // Columns added after a table first shipped.
    const cols = (this.db.prepare("PRAGMA table_info(forks)").all() as Row[]).map((c) =>
      String(c.name),
    );
    if (!cols.includes("proposed_at"))
      this.db.exec("ALTER TABLE forks ADD COLUMN proposed_at TEXT");
    if (!cols.includes("pr_number")) this.db.exec("ALTER TABLE forks ADD COLUMN pr_number INTEGER");
    if (!cols.includes("parent")) this.db.exec("ALTER TABLE forks ADD COLUMN parent TEXT");
    if (!cols.includes("branch")) this.db.exec("ALTER TABLE forks ADD COLUMN branch TEXT");
  }

  /**
   * A database restored from its replica can come back with an index out of step with its
   * table (seen with litestream 0.5: "row missing from index", which SQLite reports as
   * "database disk image is malformed" on the first read). The rows are the truth and an
   * index is rebuilt from them, so: check, rebuild the indexes if that's all it is, and
   * refuse to start only if the database is still broken.
   */
  private heal(path: string): void {
    const check = () =>
      (this.db.prepare("PRAGMA integrity_check").all() as Row[]).map((r) =>
        String(Object.values(r)[0]),
      );
    const found = check();
    if (found.length === 1 && found[0] === "ok") return;
    console.warn(
      `archnm: ${path} failed its integrity check (${found.slice(0, 3).join("; ")}); rebuilding indexes`,
    );
    this.db.exec("REINDEX");
    const after = check();
    if (after.length !== 1 || after[0] !== "ok")
      throw new Error(
        `archnm: ${path} is damaged beyond its indexes: ${after.slice(0, 5).join("; ")}`,
      );
    console.warn(`archnm: ${path} repaired (indexes rebuilt)`);
  }

  close(): void {
    this.db.close();
  }

  /** A consistent copy of the whole database at `path`, taken while it's in use. */
  async backupTo(path: string): Promise<void> {
    await backup(this.db, path);
  }

  /** Moves someone made in a design (opt-in in their browser), for `trail`. */
  addTrail(
    design: string,
    doc: string,
    session: string,
    user: string,
    events: { at: string }[],
  ): void {
    const ins = this.db.prepare(
      "INSERT INTO nav_trail (design, doc, session, user, at, data) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const e of events) ins.run(design, doc, session, user, e.at, JSON.stringify(e));
  }

  trail(
    design: string,
    opts: { since?: string; session?: string; user?: string; limit?: number } = {},
  ): { session: string; user: string; doc: string; event: unknown }[] {
    const where = ["design = ?"];
    const args: string[] = [design];
    if (opts.since) (where.push("at >= ?"), args.push(opts.since));
    if (opts.session) (where.push("session LIKE ?"), args.push(`${opts.session}%`));
    if (opts.user) (where.push("user = ?"), args.push(opts.user));
    const rows = this.db
      .prepare(
        `SELECT session, user, doc, data FROM nav_trail WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ${Math.max(1, Math.min(opts.limit ?? 400, 5000))}`,
      )
      .all(...args) as Row[];
    return rows.reverse().map((r) => ({
      session: String(r.session),
      user: String(r.user),
      doc: String(r.doc),
      event: JSON.parse(String(r.data)),
    }));
  }

  clearTrail(design: string, user: string): number {
    return Number(
      this.db.prepare("DELETE FROM nav_trail WHERE design = ? AND user = ?").run(design, user)
        .changes,
    );
  }

  /** True when nothing has ever been stored for this document. */
  isNew(doc: string): boolean {
    const s = this.db.prepare("SELECT 1 FROM doc_snapshots WHERE doc = ?").get(doc);
    const u = this.db.prepare("SELECT 1 FROM doc_updates WHERE doc = ? LIMIT 1").get(doc);
    return !s && !u;
  }

  /** Apply everything stored for `name` to `doc`. */
  load(name: string, doc: Y.Doc): void {
    const snap = this.db.prepare("SELECT data, upto FROM doc_snapshots WHERE doc = ?").get(name) as
      Row | undefined;
    const upto = Number(snap?.upto ?? 0);
    const updates = this.db
      .prepare("SELECT data FROM doc_updates WHERE doc = ? AND id > ? ORDER BY id")
      .all(name, upto) as Row[];
    const all = [
      ...(snap ? [snap.data as Uint8Array] : []),
      ...updates.map((r) => r.data as Uint8Array),
    ];
    if (all.length) Y.applyUpdate(doc, Y.mergeUpdates(all), "load");
    this.sinceCompact.set(name, updates.length);
  }

  append(name: string, update: Uint8Array, actor: string | null): void {
    this.db
      .prepare("INSERT INTO doc_updates (doc, data, actor, at) VALUES (?, ?, ?, ?)")
      .run(name, update, actor, new Date().toISOString());
    const n = (this.sinceCompact.get(name) ?? 0) + 1;
    this.sinceCompact.set(name, n);
    if (n >= COMPACT_EVERY) this.compact(name);
  }

  /** Every document that has anything stored. */
  /** Forget a document: its updates and snapshot. */
  dropDoc(name: string): void {
    this.db.prepare("DELETE FROM doc_updates WHERE doc = ?").run(name);
    this.db.prepare("DELETE FROM doc_snapshots WHERE doc = ?").run(name);
  }

  docs(): string[] {
    const rows = this.db
      .prepare("SELECT doc FROM doc_snapshots UNION SELECT DISTINCT doc FROM doc_updates")
      .all() as Row[];
    return rows.map((r) => String(r.doc));
  }

  /** Updates stored since the last snapshot. */
  count(name: string): number {
    return this.sinceCompact.get(name) ?? 0;
  }

  /** Merge the snapshot and the updates after it into a new snapshot. */
  compact(name: string): void {
    const last = this.db
      .prepare("SELECT MAX(id) AS id FROM doc_updates WHERE doc = ?")
      .get(name) as Row;
    const upto = Number(last.id ?? 0);
    const snap = this.db.prepare("SELECT data, upto FROM doc_snapshots WHERE doc = ?").get(name) as
      Row | undefined;
    const from = Number(snap?.upto ?? 0);
    if (upto <= from) return;
    const updates = this.db
      .prepare("SELECT data FROM doc_updates WHERE doc = ? AND id > ? AND id <= ? ORDER BY id")
      .all(name, from, upto) as Row[];
    const merged = Y.mergeUpdates([
      ...(snap ? [snap.data as Uint8Array] : []),
      ...updates.map((r) => r.data as Uint8Array),
    ]);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO doc_snapshots (doc, data, upto, at) VALUES (?, ?, ?, ?)
           ON CONFLICT(doc) DO UPDATE SET data = excluded.data, upto = excluded.upto, at = excluded.at`,
        )
        .run(name, merged, upto, new Date().toISOString());
      // Keep the recent raw updates a while for history; drop the old ones.
      this.db
        .prepare("DELETE FROM doc_updates WHERE doc = ? AND id <= ?")
        .run(name, upto - COMPACT_EVERY * 4);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    this.sinceCompact.set(name, 0);
  }

  bindings(): Binding[] {
    return (
      this.db
        .prepare("SELECT design, remote, path, branch FROM git_bindings ORDER BY design")
        .all() as Row[]
    ).map((r) => ({
      design: String(r.design),
      remote: String(r.remote),
      path: String(r.path),
      branch: String(r.branch),
    }));
  }

  dropBinding(design: string): void {
    this.db.prepare("DELETE FROM git_bindings WHERE design = ?").run(design);
  }

  setBinding(b: Binding): void {
    this.db
      .prepare(
        `INSERT INTO git_bindings (design, remote, path, branch, at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(design) DO UPDATE SET remote = excluded.remote, path = excluded.path, branch = excluded.branch, at = excluded.at`,
      )
      .run(b.design, b.remote, b.path, b.branch, new Date().toISOString());
  }

  forks(design: string, status: ForkStatus | null = "open"): ForkRow[] {
    const rows = (
      status
        ? this.db
            .prepare("SELECT * FROM forks WHERE design = ? AND status = ? ORDER BY created_at")
            .all(design, status)
        : this.db.prepare("SELECT * FROM forks WHERE design = ? ORDER BY created_at").all(design)
    ) as Row[];
    return rows.map((r) => ({
      doc: String(r.doc),
      design: String(r.design),
      name: String(r.name),
      base: (r.base as string | null) ?? null,
      head: (r.head as string | null) ?? null,
      status: r.status as ForkStatus,
      byId: (r.by_id as string | null) ?? null,
      byName: (r.by_name as string | null) ?? null,
      agent: Number(r.agent) === 1,
      createdAt: String(r.created_at),
      proposedAt: (r.proposed_at as string | null) ?? null,
      prNumber: r.pr_number == null ? null : Number(r.pr_number),
      parent: (r.parent as string | null) ?? null,
      branch: (r.branch as string | null) ?? null,
    }));
  }

  /** Every fork ever made of this design under `name`, open or not (names aren't reused). */
  forkNameTaken(design: string, name: string): boolean {
    return (
      !!this.db.prepare("SELECT 1 FROM forks WHERE design = ? AND name = ?").get(design, name) ||
      !this.isNew(`${design}@${name}`)
    );
  }

  addFork(f: ForkRow): void {
    this.db
      .prepare(
        "INSERT INTO forks (doc, design, name, base, head, status, by_id, by_name, agent, created_at, parent, branch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        f.doc,
        f.design,
        f.name,
        f.base,
        f.head,
        f.status,
        f.byId,
        f.byName,
        f.agent ? 1 : 0,
        f.createdAt,
        f.parent ?? null,
        f.branch ?? null,
      );
  }

  updateFork(
    doc: string,
    set: Partial<Pick<ForkRow, "base" | "head" | "status" | "proposedAt" | "prNumber">>,
  ): void {
    if (set.prNumber !== undefined)
      this.db.prepare("UPDATE forks SET pr_number = ? WHERE doc = ?").run(set.prNumber, doc);
    if (set.proposedAt !== undefined)
      this.db.prepare("UPDATE forks SET proposed_at = ? WHERE doc = ?").run(set.proposedAt, doc);
    if (set.base !== undefined)
      this.db.prepare("UPDATE forks SET base = ? WHERE doc = ?").run(set.base, doc);
    if (set.head !== undefined)
      this.db.prepare("UPDATE forks SET head = ? WHERE doc = ?").run(set.head, doc);
    if (set.status)
      this.db
        .prepare("UPDATE forks SET status = ?, closed_at = ? WHERE doc = ?")
        .run(set.status, set.status === "open" ? null : new Date().toISOString(), doc);
  }

  /** Small server settings (the GitHub App's credentials, people's GitHub sign-ins). */
  setting(key: string): string | null {
    const r = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      Row | undefined;
    return r ? String(r.value) : null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  deleteSetting(key: string): void {
    this.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  }

  /** Every setting whose key starts with `prefix`. */
  settings(prefix: string): { key: string; value: string }[] {
    return (
      this.db
        .prepare("SELECT key, value FROM settings WHERE substr(key, 1, length(?)) = ?")
        .all(prefix, prefix) as Row[]
    ).map((r) => ({ key: String(r.key), value: String(r.value) }));
  }

  /** Remove every setting whose key starts with `prefix`. */
  deleteSettings(prefix: string): void {
    this.db.prepare("DELETE FROM settings WHERE substr(key, 1, length(?)) = ?").run(prefix, prefix);
  }

  // --- share links (server/links.ts): only a hash of the token is kept -----------------------

  addLink(l: Omit<LinkRecord, "revokedAt" | "lastUsedAt">): void {
    this.db
      .prepare(
        "INSERT INTO share_links (id, hash, doc, by_id, by_name, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(l.id, l.hash, l.doc, l.byId, l.byName, l.createdAt, l.expiresAt);
  }

  linkRow(where: "hash" | "id", value: string): LinkRecord | null {
    const r = this.db.prepare(`SELECT * FROM share_links WHERE ${where} = ?`).get(value) as
      Row | undefined;
    return r ? linkOf(r) : null;
  }

  /** A document's links, newest first. */
  linksOf(doc: string): LinkRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM share_links WHERE doc = ? ORDER BY created_at DESC")
        .all(doc) as Row[]
    ).map(linkOf);
  }

  revokeLink(id: string, at: number): void {
    this.db
      .prepare("UPDATE share_links SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(at, id);
  }

  touchLink(id: string, at: number): void {
    this.db.prepare("UPDATE share_links SET last_used_at = ? WHERE id = ?").run(at, id);
  }

  /** Every link to a design and its forks goes (it was deleted, or the fork closed). */
  dropLinks(doc: string, withForks: boolean): void {
    this.db
      .prepare(
        withForks
          ? "DELETE FROM share_links WHERE doc = ? OR substr(doc, 1, length(?) + 1) = ? || '@'"
          : "DELETE FROM share_links WHERE doc = ?",
      )
      .run(...(withForks ? [doc, doc, doc] : [doc]));
  }

  /** The old table-per-record database, if this file has one with data in it. */
  legacyRows(): boolean {
    const t = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'objects'")
      .get();
    if (!t) return false;
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM objects").get() as Row).n) > 0;
  }
}
