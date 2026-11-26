// Designs that travel, for the backend with no server: in a link (`#~d=...`), as a .zip or a
// folder, or read from a public GitHub repository (`#~gh=...`, see portable-remote.ts). A link,
// a zip or a repository only ever gives you a copy: it becomes a new design in this browser,
// and what you change there is yours alone. What arrives is untrusted: it goes through
// readFiles, and nothing in it is run or shown as HTML.
import type * as Y from "yjs";
import type { StateJson } from "../../shared/api.ts";
import { tables } from "../../shared/doc.ts";
import { slug } from "../../shared/model.ts";
import { decodeDesign, encodeDesign, fingerprint, ShareLinkError } from "../../shared/sharelink.ts";
import { unzipDesign, zipFiles, ZipError } from "../../shared/zip.ts";
import { pickFolder, pickZip, saveBytes } from "./files-open.ts";
import type { DesignRecord, ListStore } from "./local.ts";
import { cleanName, filesOfDoc, loadModel, readWithProblems } from "./portable-files.ts";
import { createRemotes } from "./portable-remote.ts";
import {
  BackendError,
  type DesignDoc,
  type DocConnection,
  type DocHandlers,
  type PortableCapability,
  type SharedOpen,
} from "./types.ts";

/** A link longer than this isn't made: chat and mail apps cut long links. */
export const MAX_LINK = 30_000;

/** What this needs of the local backend: its list of designs and a way to open one's document. */
export interface PortableHost {
  records: {
    all(): DesignRecord[];
    save(next: DesignRecord[]): void;
    find(key: string): DesignRecord | undefined;
  };
  open: Map<string, { ydoc: Y.Doc }>;
  /** Add a design to the list (a free key made from its name). */
  add(name: string, extra?: Partial<DesignRecord>): DesignRecord;
  /** The design's document: the open one, or one loaded from storage for a moment. */
  withDoc<T>(rec: DesignRecord, fn: (ydoc: Y.Doc) => T): Promise<T>;
}

export interface PortableDeps {
  fetch?: typeof fetch;
  /** Where the links to designs read from GitHub are kept, so a reload can read them again. */
  remotes: ListStore;
}

const here = () =>
  typeof location === "undefined" ? "http://localhost/" : `${location.origin}${location.pathname}`;

export function createPortable(
  host: PortableHost,
  deps: PortableDeps,
): PortableCapability & {
  /** Used by the backend that holds this: the read-only designs from GitHub. */
  info(key: string): DesignDoc | null;
  openRemote(info: DesignDoc, ydoc: Y.Doc, handlers: DocHandlers): DocConnection;
  state(key: string): StateJson | null;
} {
  const remotes = createRemotes(host.open, deps.remotes, deps.fetch);
  const pending = new Map<string, Promise<SharedOpen>>();

  /** Make a design of your own from files: a new record, its document filled. */
  async function makeCopy(
    files: Map<string, string>,
    o: { fallback: string; suffix: string; shared?: string },
  ): Promise<{ key: string }> {
    const { model, error } = readWithProblems(files);
    if (error) throw new BackendError("refused", error);
    const base = cleanName(model.config.name ?? "") || o.fallback;
    const taken = host.records.all().some((r) => r.name === base);
    const name = taken ? cleanName(`${base} ${o.suffix}`) : base;
    const rec = host.add(name, o.shared ? { shared: o.shared } : {});
    try {
      const counts = await host.withDoc(rec, (ydoc) => {
        loadModel(ydoc, model, rec.doc, name);
        const t = tables(ydoc);
        return { objects: t.objects.size, diagrams: t.diagrams.size };
      });
      host.records.save(
        host.records.all().map((r) => (r.key === rec.key ? { ...r, ...counts } : r)),
      );
    } catch (e) {
      host.records.save(host.records.all().filter((r) => r.key !== rec.key));
      throw new BackendError(
        "failed",
        `This design couldn't be opened: ${e instanceof Error ? e.message : "its files don't fit together"}.`,
      );
    }
    return { key: rec.key };
  }

  async function filesFor(key: string): Promise<{ files: Map<string, string>; name: string }> {
    const remote = remotes.get(key);
    if (remote) return { files: remote.files, name: remote.name };
    const rec = host.records.find(key);
    if (!rec) throw new BackendError("missing", `no design "${key}"`, 404);
    return { files: await host.withDoc(rec, filesOfDoc), name: rec.name };
  }

  async function openLink(text: string, again: boolean) {
    const fp = fingerprint(text);
    const had = host.records.all().find((r) => r.shared === fp);
    if (had && !again) return { key: had.key, readOnly: false, existing: true };
    const files = await decodeDesign(text).catch((e: unknown) => {
      throw new BackendError(
        "refused",
        e instanceof ShareLinkError ? e.message : "That link can't be opened.",
      );
    });
    const { key } = await makeCopy(files, {
      fallback: "Shared design",
      suffix: "(shared)",
      shared: fp,
    });
    return { key, readOnly: false };
  }

  return {
    async link(key) {
      const { files } = await filesFor(key);
      let text: string;
      try {
        text = await encodeDesign(files);
      } catch {
        return { tooBig: true };
      }
      const url = `${here()}#~d=${text}`;
      return url.length > MAX_LINK ? { tooBig: true } : { url, length: url.length };
    },

    async download(key) {
      const { files, name } = await filesFor(key);
      saveBytes(`${slug(name)}.zip`, zipFiles(files), "application/zip");
    },

    async openFiles(kind) {
      let files: Map<string, string> | null;
      try {
        if (kind === "zip") {
          const bytes = await pickZip();
          files = bytes ? await unzipDesign(bytes) : null;
        } else files = await pickFolder();
      } catch (e) {
        if (e instanceof BackendError) throw e;
        throw new BackendError(
          "refused",
          e instanceof ZipError ? e.message : "Those files couldn't be read.",
        );
      }
      return files ? makeCopy(files, { fallback: "Opened design", suffix: "(opened)" }) : null;
    },

    openShared(fragment, o) {
      // Opening the same thing twice at once (a double click, a development double render) is one open.
      const id = `${o?.again ? "again:" : ""}${fragment}`;
      const going = pending.get(id);
      if (going) return going;
      const p = (async () => {
        if (fragment.startsWith("~d=")) return openLink(fragment.slice(3), o?.again === true);
        if (fragment.startsWith("~gh=")) return remotes.openGithub(fragment.slice(4));
        throw new BackendError("refused", "That link isn't one Archnemesis can open.");
      })().finally(() => pending.delete(id));
      pending.set(id, p);
      return p;
    },

    async copy(key) {
      const remote = remotes.get(key);
      if (remote) return makeCopy(remote.files, { fallback: remote.name, suffix: "(shared)" });
      const { files, name } = await filesFor(key);
      return makeCopy(files, { fallback: name, suffix: "(copy)" });
    },

    fragmentOf: (key) => remotes.fragmentOf(key),
    whatsNew: (doc) => remotes.whatsNew(doc),
    info: (key) => remotes.info(key),
    openRemote: (info, ydoc, handlers) => remotes.openRemote(info, ydoc, handlers),
    state: (key) => remotes.state(key),
  };
}
