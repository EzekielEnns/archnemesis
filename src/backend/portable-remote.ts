// Read-only designs from a public GitHub repository: fetched when a `#~gh=` link is opened,
// kept in memory (so a reload fetches them again), shown as they are there until the person
// makes a copy. A fork's branch also carries main's version of the design, for the diff.
import type * as Y from "yjs";
import type { StateJson } from "../../shared/api.ts";
import { stateFromFiles } from "../../shared/diff.ts";
import { readState } from "../../shared/doc.ts";
import type { FileModel } from "../../shared/files.ts";
import { ghText, parseGhSpec, type GhSpec } from "../../shared/ghlink.ts";
import { slug } from "../../shared/model.ts";
import { fingerprint } from "../../shared/sharelink.ts";
import { changedWithContext, type WhatsNew } from "../../shared/whatsnew.ts";
import { fetchGhDesign } from "./github-public.ts";
import type { ListStore } from "./local.ts";
import { cleanName, loadModel, readWithProblems } from "./portable-files.ts";
import {
  BackendError,
  type DesignDoc,
  type DocConnection,
  type DocHandlers,
  type SharedOpen,
} from "./types.ts";

const REMOTES_MAX = 20;

function readJson(text: string | null): Record<string, string> {
  try {
    const v: unknown = JSON.parse(text ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** A design read from GitHub: shown read-only, in memory only. */
interface Remote {
  model: FileModel;
  files: Map<string, string>;
  base: Map<string, string> | null;
  from: string;
  name: string;
  /** What the link named, and the folder it turned out to be in: a copy remembers them. */
  spec: GhSpec;
  folder: string;
}

export function createRemotes(
  open: Map<string, { ydoc: Y.Doc }>,
  where: ListStore,
  fetcher?: typeof fetch,
) {
  const remotes = new Map<string, Remote>();
  const specs = (): Record<string, string> => readJson(where.read());
  const remember = (key: string, text: string) => {
    const all = { ...specs(), [key]: text };
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - REMOTES_MAX))) delete all[k];
    where.write(JSON.stringify(all));
  };

  return {
    /** The files of a design read from GitHub (null: not one). */
    get: (key: string) => remotes.get(key) ?? null,

    async openGithub(text: string): Promise<SharedOpen> {
      const spec = parseGhSpec(text);
      if (!spec)
        throw new BackendError(
          "refused",
          "That isn't a link to a design on GitHub. It should look like owner/repo, with a branch after @ and a folder after a colon if needed.",
        );
      const found = await fetchGhDesign(spec, fetcher);
      const { model, error } = readWithProblems(found.files);
      if (error) throw new BackendError("refused", error);
      const norm = ghText(spec);
      const main = `gh-${slug(`${spec.owner}-${spec.repo}`).slice(0, 30)}-${fingerprint(norm).slice(0, 6)}`;
      const key = found.fork ? `${main}@${slug(found.fork).slice(0, 40)}` : main;
      const from = `${spec.owner}/${spec.repo}${spec.ref ? `@${spec.ref}` : ""}`;
      const name = cleanName(model.config.name ?? "") || found.design || spec.repo;
      remotes.set(key, {
        model,
        files: found.files,
        base: found.base,
        from,
        name,
        spec,
        folder: found.folder,
      });
      remember(key, norm);
      return { key, readOnly: true, from };
    },

    fragmentOf(key: string): string | null {
      const text = specs()[key];
      return text ? `~gh=${text}` : null;
    },

    async whatsNew(doc: string): Promise<WhatsNew | null> {
      const remote = remotes.get(doc);
      const live = open.get(doc);
      if (!remote?.base || !live) return null;
      return changedWithContext(stateFromFiles(remote.base), readState(live.ydoc));
    },

    info(key: string): DesignDoc | null {
      const r = remotes.get(key);
      return r
        ? {
            key,
            name: r.name,
            doc: `gh:${key}`,
            mode: "edit",
            git: false,
            canEdit: false,
            from: r.from,
          }
        : null;
    },

    openRemote(info: DesignDoc, ydoc: Y.Doc, handlers: DocHandlers): DocConnection {
      const r = remotes.get(info.key);
      open.set(info.key, { ydoc });
      let closed = false;
      // Loaded a moment later, like a document that has to be read from somewhere.
      setTimeout(() => {
        if (closed || !r) return;
        loadModel(ydoc, r.model, info.doc, r.name);
        handlers.onStatus("live");
      }, 0);
      return {
        awareness: null,
        close() {
          closed = true;
          if (open.get(info.key)?.ydoc === ydoc) open.delete(info.key);
        },
      };
    },

    state(key: string): StateJson | null {
      const r = remotes.get(key);
      if (!r) return null;
      const s = stateFromFiles(r.files);
      return {
        objects: [...s.objects.values()],
        connections: [...s.connections.values()],
        diagrams: [...s.diagrams.values()],
        placements: [...s.placements.values()],
        flows: [...s.flows.values()],
        entities: [...s.entities.values()],
      };
    },
  };
}
