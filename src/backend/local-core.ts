// What the static build's forks and history share: the fork records, reading a document's
// files, and keeping a version of main (see local-git.ts for what is built on this).
import type * as Y from "yjs";
import type { LogEntry } from "../../shared/doc.ts";
import type { DesignRecord, ListStore } from "./local.ts";
import { filesOfDoc } from "./portable-files.ts";
import type { Files, VersionMeta, VersionStore } from "./local-versions.ts";
import { BackendError, type DocHandlers } from "./types.ts";

/** A fork of a design's main. */
export interface ForkRecord {
  /** Its document's id: the IndexedDB database is named after it. */
  doc: string;
  design: string;
  name: string;
  by: string;
  createdAt: string;
  /** The version of main it started from. */
  base: string | null;
  proposedAt: string | null;
}

/** What this needs of the local backend: the designs, their documents, and storage. */
export interface GitHost {
  designs: {
    all(): DesignRecord[];
    find(key: string): DesignRecord | undefined;
    save(next: DesignRecord[]): void;
  };
  open: Map<string, { ydoc: Y.Doc; handlers: DocHandlers }>;
  /** A document for a moment (the open one, or loaded from storage); `fn` must not be async. */
  withDoc<T>(at: { key: string; doc: string }, fn: (ydoc: Y.Doc) => T): Promise<T>;
  /** A new document, started as a copy of another's state. */
  clone(from: { key: string; doc: string }, to: string): Promise<void>;
  /** Delete a document's stored data. */
  wipe(doc: string): Promise<void>;
  who(): string;
}

export interface GitDeps {
  forks: ListStore;
  versions: VersionStore;
  fetch?: typeof fetch;
  /** How long edits to main settle before a version is kept, and the longest wait (tests shorten them). */
  idleMs?: number;
  maxMs?: number;
}

/** The forks of every design, kept in `where` (and in memory). */
function createForks(where: ListStore) {
  let cache: ForkRecord[] | null = null;
  const all = (): ForkRecord[] => {
    if (!cache) {
      try {
        const v: unknown = JSON.parse(where.read() ?? "[]");
        cache = Array.isArray(v) ? (v as ForkRecord[]) : [];
      } catch {
        cache = [];
      }
    }
    return cache;
  };
  return {
    all,
    of: (design: string) => all().filter((f) => f.design === design),
    byDoc: (doc: string): ForkRecord | null => all().find((f) => forkKey(f) === doc) ?? null,
    save(next: ForkRecord[]) {
      cache = next;
      where.write(JSON.stringify(next));
    },
  };
}
type Forks = ReturnType<typeof createForks>;

/** What the git side shares: finding a design, reading files, keeping versions, telling tabs. */
export interface GitCore {
  host: GitHost;
  deps: GitDeps;
  forks: Forks;
  find(key: string): DesignRecord;
  patch(key: string, change: Partial<DesignRecord>): void;
  files(at: { key: string; doc: string }): Promise<Files>;
  /** Keep main's files as a version (skipped when nothing changed since the last, unless `force`). */
  record(rec: DesignRecord, subject: string, force?: boolean): Promise<VersionMeta | null>;
  /** Tell the tabs open on a design (and its forks) that git changed: they look again. */
  ping(design: string): void;
}

/** A fork's document name. */
export const forkKey = (f: Pick<ForkRecord, "design" | "name">) => `${f.design}@${f.name}`;

export const toFiles = (m: Map<string, string>): Files => Object.fromEntries(m);
export const sameFiles = (a: Files, b: Files) => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
};
export const filesKey = (f: Files) =>
  JSON.stringify(Object.entries(f).sort(([a], [b]) => a.localeCompare(b)));

async function sha1(text: string): Promise<string> {
  const b = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** What a stretch of edits is called in the history: its first label, and how many more. */
export function subjectOf(entries: LogEntry[]): string {
  const labels = [...new Set(entries.map((e) => e.label.trim()).filter(Boolean))];
  if (!labels.length) return "Edits";
  const first = labels[0]!.charAt(0).toUpperCase() + labels[0]!.slice(1);
  return labels.length === 1 ? first : `${first}, and ${labels.length - 1} more`;
}

const KEEP = 60;

export function createCore(host: GitHost, deps: GitDeps): GitCore {
  const forks = createForks(deps.forks);

  /** Old versions go, except those a fork or the upstream still stands on. */
  async function prune(design: string): Promise<void> {
    const list = await deps.versions.list(design);
    if (list.length <= KEEP) return;
    const keep = new Set<string>(forks.of(design).flatMap((f) => (f.base ? [f.base] : [])));
    const pulled = host.designs.find(design)?.upstream?.pulledSha;
    if (pulled) keep.add(pulled);
    for (const v of list.slice(KEEP).reverse())
      if (!keep.has(v.sha)) await deps.versions.remove(design, v.sha);
  }

  return {
    host,
    deps,
    forks,
    find(key) {
      const r = host.designs.find(key);
      if (!r) throw new BackendError("missing", `no design "${key}"`, 404);
      return r;
    },
    patch: (key, change) =>
      host.designs.save(host.designs.all().map((r) => (r.key === key ? { ...r, ...change } : r))),
    files: async (at) => toFiles(await host.withDoc(at, filesOfDoc)),
    ping(design) {
      for (const k of [design, ...forks.of(design).map(forkKey)])
        host.open.get(k)?.handlers.onEvent({ type: "git" });
    },
    async record(rec, subject, force = false) {
      const files = toFiles(await host.withDoc(rec, filesOfDoc));
      const latest = (await deps.versions.list(rec.key))[0];
      if (latest && !force) {
        const was = await deps.versions.files(rec.key, latest.sha);
        if (was && sameFiles(was, files)) return null;
      }
      const date = new Date().toISOString();
      const sha = await sha1(`${latest?.sha ?? ""}\n${date}\n${filesKey(files)}`);
      const meta: VersionMeta = { sha, date, author: host.who(), subject };
      await deps.versions.add(rec.key, meta, files);
      await prune(rec.key);
      return meta;
    },
  };
}
