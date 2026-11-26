// The backend with no server: every design lives in this browser. Each design's document is
// kept in IndexedDB (y-indexeddb), the list of designs in localStorage, and there is one
// person, you, who can edit everything. There's no git, GitHub, sign-in, sharing, telemetry or
// other people: those parts of the Backend are simply absent, and the app hides what needs them.
import { IndexeddbPersistence } from "y-indexeddb";
import * as Y from "yjs";
import type { DesignInfo, StateJson } from "../../shared/api.ts";
import { applyOps, emptyState, readState, tables } from "../../shared/doc.ts";
import { makeDiagram, slug, type Op } from "../../shared/model.ts";
import { seedOps } from "../../shared/seed.ts";
import { NAME_KEY, setStored, stored } from "../storage";
import { createPortable } from "./portable.ts";
import { followRules, SYSTEM } from "./rules.ts";
import {
  BackendError,
  type Backend,
  type DesignDoc,
  type DocConnection,
  type DocHandlers,
} from "./types.ts";

const LIST_KEY = "archnm.local.designs";
const FIRST_NAME = "My design";
const KEY_MAX = 48;
const REMOTES_KEY = "archnm.local.remotes";

/** Where the list of designs is kept (localStorage by default; a test passes its own). */
export interface ListStore {
  read(): string | null;
  write(value: string): void;
}

const browserList: ListStore = {
  read: () => stored(LIST_KEY),
  write: (v) => setStored(LIST_KEY, v),
};
const browserRemotes: ListStore = {
  read: () => stored(REMOTES_KEY),
  write: (v) => setStored(REMOTES_KEY, v),
};

export interface DesignRecord {
  key: string;
  name: string;
  /** The id of its document: the IndexedDB database is named after it. */
  doc: string;
  objects: number;
  diagrams: number;
  /** Made from a link: its fingerprint, so opening the same link again finds this copy. */
  shared?: string;
  /** Starts from the example shop: applied when its document first opens. */
  example?: boolean;
}

const dbName = (doc: string) => `archnm-local-${doc}`;

/** A new design starts with one view that follows the model, so what's written shows up. */
const startOps = (): Op[] => [
  {
    op: "diagram.put",
    diagram: makeDiagram({
      name: "Landscape",
      key: "landscape",
      rules: {
        include: [{ kind: "actor" }, { kind: "system" }],
        exclude: [{ status: "removed" }],
      },
    }),
  },
];

/** Tabs on the same design share edits as they happen (IndexedDB alone only merges on load). */
function shareBetweenTabs(doc: string, ydoc: Y.Doc): () => void {
  if (typeof BroadcastChannel === "undefined") return () => {};
  const channel = new BroadcastChannel(dbName(doc));
  const BROADCAST = "broadcast";
  const onUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin !== BROADCAST) channel.postMessage(update);
  };
  channel.onmessage = (e: MessageEvent<Uint8Array>) => Y.applyUpdate(ydoc, e.data, BROADCAST);
  ydoc.on("update", onUpdate);
  return () => {
    ydoc.off("update", onUpdate);
    channel.close();
  };
}

/** The list of designs, kept in `list` (and in memory, where that can't keep it). */
function designList(list: ListStore) {
  let records: DesignRecord[] | null = null;
  const all = (): DesignRecord[] => {
    if (!records) {
      try {
        records = JSON.parse(list.read() ?? "[]") as DesignRecord[];
      } catch {
        records = [];
      }
      // A new install starts with one empty design, not an example.
      if (!records.length) {
        const doc = crypto.randomUUID();
        records = [{ key: slug(FIRST_NAME), name: FIRST_NAME, doc, objects: 0, diagrams: 1 }];
        list.write(JSON.stringify(records));
      }
    }
    return records;
  };
  const save = (next: DesignRecord[]) => {
    records = next;
    list.write(JSON.stringify(next));
  };
  return { all, save, find: (key: string) => all().find((r) => r.key === key) };
}
type DesignList = ReturnType<typeof designList>;

/** A document open in this tab, by design key: what Export reads, and who hears a delete. */
type OpenDocs = Map<string, { ydoc: Y.Doc; handlers: DocHandlers }>;

/** Open a design's document: cached in IndexedDB, shared with other tabs, kept tidy. */
function openDocument(
  info: DesignDoc,
  ydoc: Y.Doc,
  handlers: DocHandlers,
  designs: DesignList,
  open: OpenDocs,
): DocConnection {
  const cache = new IndexeddbPersistence(dbName(info.doc), ydoc);
  const unshare = shareBetweenTabs(info.doc, ydoc);
  open.set(info.key, { ydoc, handlers });
  let stopRules = () => {};
  let closed = false;
  const meta = ydoc.getMap<string>("meta");
  // What the list shows (its name and size) follows the document.
  let counted: ReturnType<typeof setTimeout> | null = null;
  const recount = () => {
    counted = null;
    const rec = designs.find(info.key);
    if (!rec) return;
    const t = tables(ydoc);
    const name = meta.get("name") || rec.name;
    if (rec.objects === t.objects.size && rec.diagrams === t.diagrams.size && rec.name === name)
      return;
    const next = { ...rec, name, objects: t.objects.size, diagrams: t.diagrams.size };
    designs.save(designs.all().map((r) => (r.key === info.key ? next : r)));
  };
  const onUpdate = () => {
    if (!counted) counted = setTimeout(recount, 1000);
  };
  void cache.whenSynced.then(() => {
    if (closed) return;
    // First time this design opens: its id and name, and its first view.
    if (!meta.get("id")) {
      ydoc.transact(() => {
        meta.set("id", info.doc);
        meta.set("name", info.name);
      }, SYSTEM);
      const example = designs.find(info.key)?.example;
      applyOps(
        ydoc,
        emptyState(),
        example ? seedOps() : startOps(),
        SYSTEM,
        example ? "example landscape" : "new design",
      );
    }
    stopRules = followRules(ydoc);
    ydoc.on("update", onUpdate);
    handlers.onStatus("live");
  });
  return {
    awareness: null,
    close() {
      closed = true;
      stopRules();
      unshare();
      ydoc.off("update", onUpdate);
      if (counted) clearTimeout(counted);
      if (open.get(info.key)?.ydoc === ydoc) open.delete(info.key);
      void cache.destroy();
    },
  };
}

/** The design's model as JSON: from the open document, else loaded for a moment. */
async function stateOf(key: string, designs: DesignList, open: OpenDocs): Promise<StateJson> {
  const rec = designs.find(key);
  if (!rec) throw new BackendError("missing", `no design "${key}"`, 404);
  const json = (ydoc: Y.Doc): StateJson => {
    const s = readState(ydoc);
    return {
      objects: [...s.objects.values()],
      connections: [...s.connections.values()],
      diagrams: [...s.diagrams.values()],
      placements: [...s.placements.values()],
      flows: [...s.flows.values()],
      entities: [...s.entities.values()],
    };
  };
  return withDoc(rec, open, json);
}

/** A design's document for a moment: the open one, or one read from (and written back to) storage. */
async function withDoc<T>(rec: DesignRecord, open: OpenDocs, fn: (ydoc: Y.Doc) => T): Promise<T> {
  const live = open.get(rec.key);
  if (live) return fn(live.ydoc);
  const ydoc = new Y.Doc();
  const cache = new IndexeddbPersistence(dbName(rec.doc), ydoc);
  await cache.whenSynced;
  try {
    return fn(ydoc);
  } finally {
    await cache.destroy();
  }
}

/** A key for a new design: its name as a slug, with a number when that's taken. */
function freeKey(designs: DesignList, name: string): string {
  const base = slug(name).slice(0, KEY_MAX);
  let key = base;
  for (let i = 2; designs.find(key); i++) key = `${base.slice(0, KEY_MAX - 3)}-${i}`;
  return key;
}

/** What a test can replace: the network, and where read-only GitHub designs are remembered. */
export interface LocalDeps {
  fetch?: typeof fetch;
  remotes?: ListStore;
}

export function createLocalBackend(
  listStore: ListStore = browserList,
  deps: LocalDeps = {},
): Backend {
  const designs = designList(listStore);
  const open: OpenDocs = new Map();
  const portable = createPortable(
    {
      records: designs,
      open,
      add(name, extra) {
        const rec = {
          key: freeKey(designs, name),
          name,
          doc: crypto.randomUUID(),
          objects: 0,
          diagrams: 1,
          ...extra,
        };
        designs.save([...designs.all(), rec]);
        return rec;
      },
      withDoc: (rec, fn) => withDoc(rec, open, fn),
    },
    { fetch: deps.fetch, remotes: deps.remotes ?? browserRemotes },
  );
  const missing = (key: string) => new BackendError("missing", `no design "${key}"`, 404);

  return {
    config: async () => ({
      auth: "local",
      signin: { kind: "none" },
      mcp: null,
      localRepos: false,
    }),
    me: async () => ({
      id: "local:You",
      name: stored(NAME_KEY) || "You",
      kind: "human",
      admin: true,
    }),

    designs: {
      list: async () =>
        designs.all().map((r): DesignInfo => ({
          key: r.key,
          name: r.name,
          objects: r.objects,
          diagrams: r.diagrams,
          present: 0,
          forks: 0,
          git: false,
          private: false,
          mine: true,
        })),

      async info(doc) {
        const r = designs.find(doc);
        if (!r) {
          const remote = portable.info(doc);
          if (remote) return remote;
          throw missing(doc);
        }
        return { key: r.key, name: r.name, doc: r.doc, mode: "edit", git: false, canEdit: true };
      },

      async create(name, opts) {
        const n = name.trim().slice(0, 80);
        if (!n) throw new BackendError("refused", "a design needs a name");
        const key = freeKey(designs, n);
        const doc = crypto.randomUUID();
        const rec: DesignRecord = { key, name: n, doc, objects: 0, diagrams: 1 };
        if (opts?.example) rec.example = true;
        designs.save([...designs.all(), rec]);
        return { key };
      },

      async remove(key) {
        const rec = designs.find(key);
        if (!rec) throw missing(key);
        designs.save(designs.all().filter((r) => r.key !== key));
        open.get(key)?.handlers.onEvent({ type: "deleted", why: "That design was deleted" });
        await new IndexeddbPersistence(dbName(rec.doc), new Y.Doc()).clearData();
      },

      open: (info, ydoc, handlers) =>
        info.from
          ? portable.openRemote(info, ydoc, handlers)
          : openDocument(info, ydoc, handlers, designs, open),
      state: async (key) => portable.state(key) ?? stateOf(key, designs, open),
    },

    portable,

    icons: {
      async search(q) {
        const { searchIcons } = await import("../../shared/icons.ts");
        return searchIcons(q.trim().slice(0, 40)).map((r) => r.title);
      },
      async svg(technology, color) {
        const { iconSvg } = await import("../../shared/icons.ts");
        return iconSvg(technology.slice(0, 80), color) ?? null;
      },
    },
  };
}
