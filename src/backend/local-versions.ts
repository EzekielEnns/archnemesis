// Main's history in the static build: each version is the design's files as they were, kept in
// this browser's IndexedDB (the list in one store, the files in another so listing is cheap).
// Forks remember the version they started from, and the diff against main reads it back.
import type { StateJson } from "../../shared/api.ts";
import { stateFromFiles } from "../../shared/diff.ts";

export interface VersionMeta {
  sha: string;
  date: string;
  author: string;
  subject: string;
}

export type Files = Record<string, string>;

export interface VersionStore {
  /** A design's versions, newest first. */
  list(design: string): Promise<VersionMeta[]>;
  files(design: string, sha: string): Promise<Files | null>;
  add(design: string, v: VersionMeta, files: Files): Promise<void>;
  remove(design: string, sha: string): Promise<void>;
  removeDesign(design: string): Promise<void>;
}

/** Versions kept in memory only (a test, or a browser without IndexedDB). */
export function memoryVersions(): VersionStore {
  const all = new Map<string, { meta: VersionMeta; files: Files }[]>();
  const of = (d: string) => all.get(d) ?? [];
  return {
    list: async (d) => of(d).map((v) => v.meta),
    files: async (d, sha) => of(d).find((v) => v.meta.sha === sha)?.files ?? null,
    add: async (d, meta, files) => void all.set(d, [{ meta, files }, ...of(d)]),
    remove: async (d, sha) =>
      void all.set(
        d,
        of(d).filter((v) => v.meta.sha !== sha),
      ),
    removeDesign: async (d) => void all.delete(d),
  };
}

const DB = "archnm-local-versions";
const META = "meta";
const FILES = "files";
const id = (design: string, sha: string) => `${design}\u0000${sha}`;

const wait = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((ok, no) => {
    r.onsuccess = () => ok(r.result);
    r.onerror = () => no(r.error ?? new Error("storage failed"));
  });
const done = (t: IDBTransaction): Promise<void> =>
  new Promise((ok, no) => {
    t.oncomplete = () => ok();
    t.onerror = () => no(t.error ?? new Error("storage failed"));
    t.onabort = () => no(t.error ?? new Error("storage failed"));
  });

/** Versions kept in this browser's IndexedDB. */
export function browserVersions(): VersionStore {
  let opened: Promise<IDBDatabase> | null = null;
  const db = (): Promise<IDBDatabase> => {
    opened ??= new Promise((ok, no) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore(META, { keyPath: "id" }).createIndex("design", "design");
        d.createObjectStore(FILES);
      };
      r.onsuccess = () => ok(r.result);
      r.onerror = () => no(r.error ?? new Error("storage failed"));
    });
    return opened;
  };
  return {
    async list(design) {
      const d = await db();
      const rows = await wait<(VersionMeta & { id: string; design: string; n: number })[]>(
        d.transaction(META).objectStore(META).index("design").getAll(design),
      );
      return rows
        .sort((a, b) => b.n - a.n)
        .map(({ sha, date, author, subject }) => ({ sha, date, author, subject }));
    },
    async files(design, sha) {
      const d = await db();
      return (
        (await wait<Files | undefined>(
          d.transaction(FILES).objectStore(FILES).get(id(design, sha)),
        )) ?? null
      );
    },
    async add(design, v, files) {
      const d = await db();
      const t = d.transaction([META, FILES], "readwrite");
      t.objectStore(META).put({ ...v, id: id(design, v.sha), design, n: Date.now() });
      t.objectStore(FILES).put(files, id(design, v.sha));
      await done(t);
    },
    async remove(design, sha) {
      const d = await db();
      const t = d.transaction([META, FILES], "readwrite");
      t.objectStore(META).delete(id(design, sha));
      t.objectStore(FILES).delete(id(design, sha));
      await done(t);
    },
    async removeDesign(design) {
      for (const v of await this.list(design)) await this.remove(design, v.sha);
    },
  };
}

/** A version's files as the model JSON Export gives. */
export function stateJsonOf(files: Files): StateJson {
  const s = stateFromFiles(new Map(Object.entries(files)));
  return {
    objects: [...s.objects.values()],
    connections: [...s.connections.values()],
    diagrams: [...s.diagrams.values()],
    placements: [...s.placements.values()],
    flows: [...s.flows.values()],
    entities: [...s.entities.values()],
  };
}
