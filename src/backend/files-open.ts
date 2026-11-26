// The browser side of files: save a .zip, and pick a .zip or a folder of a design's files.
// A folder comes through the File System Access API where the browser has it, and through a
// folder-picking <input> where it doesn't. Nothing is read until the person has picked, and
// only a design's own files are ever read (the rest of a folder is never opened).
import { designFolders, filesUnder, isOurs } from "../../shared/ours.ts";
import { BackendError } from "./types.ts";

const MAX_WALK = 20000;
const MAX_DEPTH = 8;
const SKIP = new Set(["node_modules", ".git"]);

/** Hand the person a file (a download). */
export function saveBytes(name: string, bytes: Uint8Array, type: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.style.display = "none";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Show a file picker through an <input>; null when it's closed without a choice. */
function pickWith(configure: (input: HTMLInputElement) => void): Promise<File[] | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.style.display = "none";
    configure(input);
    input.addEventListener("change", () => (resolve([...(input.files ?? [])]), input.remove()));
    input.addEventListener("cancel", () => (resolve(null), input.remove()));
    document.body.append(input);
    input.click();
  });
}

/** A .zip the person picks (its bytes), or null. */
export async function pickZip(): Promise<Uint8Array | null> {
  const [file] = (await pickWith((i) => (i.accept = ".zip,application/zip"))) ?? [];
  return file ? new Uint8Array(await file.arrayBuffer()) : null;
}

interface DirHandle {
  kind: "directory";
  name: string;
  values(): AsyncIterable<DirHandle | FileEntry>;
}
interface FileEntry {
  kind: "file";
  name: string;
  getFile(): Promise<File>;
}
type Picker = () => Promise<DirHandle>;

async function walk(
  dir: DirHandle,
  prefix: string,
  depth: number,
  into: Map<string, File | FileEntry>,
): Promise<void> {
  for await (const e of dir.values()) {
    if (into.size > MAX_WALK) return;
    if (e.kind === "directory") {
      if (depth < MAX_DEPTH && !SKIP.has(e.name))
        await walk(e, `${prefix}${e.name}/`, depth + 1, into);
    } else if (/\.(ya?ml|json|md)$/.test(e.name)) into.set(`${prefix}${e.name}`, e);
  }
}

async function readOf(f: File | FileEntry): Promise<string> {
  return "getFile" in f ? (await f.getFile()).text() : f.text();
}

/**
 * A folder the person picks, as the design's files in it (the design is the shallowest folder
 * with an archnm.yaml); null when nothing was picked.
 */
export async function pickFolder(): Promise<Map<string, string> | null> {
  const picker = (window as unknown as { showDirectoryPicker?: Picker }).showDirectoryPicker;
  const found = new Map<string, File | FileEntry>();
  if (picker) {
    let root: DirHandle;
    try {
      root = await picker.call(window);
    } catch {
      return null; // cancelled
    }
    await walk(root, "", 0, found);
  } else {
    const files = await pickWith((i) => (i.webkitdirectory = true));
    if (!files) return null;
    for (const f of files) {
      // "folder/sub/file": the picked folder's own name comes off.
      const rel = f.webkitRelativePath.split("/").slice(1).join("/");
      if (rel && !rel.split("/").some((p) => SKIP.has(p)) && /\.(ya?ml|json|md)$/.test(rel))
        found.set(rel, f);
    }
  }
  const folder = designFolders(found.keys())[0];
  if (folder === undefined)
    throw new BackendError("missing", "That folder has no design in it (no archnm.yaml).");
  const mine = filesUnder(found, folder);
  const out = new Map<string, string>();
  for (const [rel, f] of mine) if (isOurs(rel)) out.set(rel, await readOf(f));
  return out;
}
