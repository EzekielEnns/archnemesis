// What a shared design needs of its files: a name that is safe to show, files read with their
// problems said plainly, a model put into a document, and a document written back as files.
import * as Y from "yjs";
import { applyOps, emptyState, mirror, readState, type Actor } from "../../shared/doc.ts";
import {
  keyOps,
  readFiles,
  toOps,
  writeFiles,
  type FConfig,
  type FileModel,
} from "../../shared/files.ts";

const SYSTEM: Actor = { id: "archnm", name: "archnm", kind: "system" };
const NAME_MAX = 80;

/** A name as a plain, bounded line. */
export function cleanName(raw: string): string {
  const plain = [...raw].filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127).join("");
  return plain.trim().slice(0, NAME_MAX);
}

export function readWithProblems(files: Map<string, string>): {
  model: FileModel;
  error: string | null;
} {
  const { model, problems } = readFiles(files);
  const errors = problems.filter((p) => p.level === "error");
  if (!errors.length) return { model, error: null };
  const first = errors
    .slice(0, 3)
    .map((p) => `${p.file}: ${p.message}`)
    .join("; ");
  return {
    model,
    error: `This design's files have ${errors.length} problem${errors.length > 1 ? "s" : ""}, so it can't be opened. ${first}${errors.length > 3 ? "; and more" : ""}`,
  };
}

/** Put a design's model into a document: its name, settings, and everything in it. */
export function loadModel(ydoc: Y.Doc, model: FileModel, id: string, name: string): void {
  const { name: _, ...config } = model.config;
  const state = emptyState();
  const stop = mirror(ydoc, state, () => {});
  try {
    const meta = ydoc.getMap<string>("meta");
    ydoc.transact(() => {
      meta.set("id", id);
      meta.set("name", name);
      meta.set("config", JSON.stringify(config));
    }, SYSTEM);
    applyOps(ydoc, state, toOps(state, model), SYSTEM, "opened a shared design", SYSTEM, {
      pin: false,
    });
  } finally {
    stop();
  }
}

/** Give every box a key in the document itself (files match boxes by key): before a pull or a push. */
export function giveKeys(ydoc: Y.Doc): void {
  const state = readState(ydoc);
  const keys = keyOps(state);
  if (keys.length) applyOps(ydoc, state, keys, SYSTEM, "keys", SYSTEM, { pin: false });
}

/** Make a document match a model read from files (a pull): what the files don't have goes. */
export function applyModel(ydoc: Y.Doc, model: FileModel, label: string): void {
  const state = readState(ydoc);
  const { name: _, ...config } = model.config;
  ydoc.transact(() => ydoc.getMap<string>("meta").set("config", JSON.stringify(config)), SYSTEM);
  applyOps(ydoc, state, toOps(state, model), SYSTEM, label, SYSTEM, { pin: false });
}

/** A design's files, as they go in git (keys given, layout included). */
export function filesOfDoc(ydoc: Y.Doc): Map<string, string> {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(ydoc));
  const keys = keyOps(readState(copy));
  if (keys.length) applyOps(copy, readState(copy), keys, SYSTEM, "keys", SYSTEM, { pin: false });
  const meta = copy.getMap<string>("meta");
  let config: FConfig = {};
  try {
    config = JSON.parse(meta.get("config") ?? "{}") as FConfig;
  } catch {
    // settings that don't read are left out
  }
  const name = meta.get("name");
  return writeFiles(readState(copy), name ? { ...config, name } : config);
}
