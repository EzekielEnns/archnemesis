// Opening a design from a public GitHub repository, with no account and no server of ours.
// Requests go only to api.github.com (the list of files in the repository) and
// raw.githubusercontent.com (each file), only when someone opens a `#~gh=` link or asks to
// open from GitHub, and carry nothing about the visitor: no cookies, no token, no referrer,
// no identifier. Both hosts answer cross-origin browser requests (access-control-allow-origin: *).
// Without signing in, the API allows 60 requests an hour per network address; a design
// costs one (two for a fork, which is shown against the repository's main branch), and the
// files themselves come from raw.githubusercontent.com, which doesn't use that allowance.
import { forkOf, type GhSpec } from "../../shared/ghlink.ts";
import { designFolders, filesUnder } from "../../shared/ours.ts";
import { BackendError } from "./types.ts";

const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";

/** The most files, and bytes of them, one design may bring in. */
export const MAX_FILES = 400;
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const PARALLEL = 6;

type Fetch = typeof fetch;

const encodePath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

function resetWords(h: Headers): string {
  const at = Number(h.get("x-ratelimit-reset"));
  if (!at) return "Try again in a little while.";
  const when = new Date(at * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `It resets at ${when}; open the link again then.`;
}

/** A plain sentence for a response GitHub refused. */
function refused(r: Response, what: string): BackendError {
  if (r.status === 404)
    return new BackendError(
      "missing",
      `GitHub has no public ${what} there. Check the name; a private repository can't be opened here.`,
      404,
    );
  const out = r.headers.get("x-ratelimit-remaining") === "0";
  if (r.status === 429 || (r.status === 403 && out))
    return new BackendError(
      "refused",
      `GitHub has paused requests from this network (it allows 60 an hour without signing in). ${resetWords(r.headers)}`,
      r.status,
    );
  return new BackendError(
    "refused",
    `GitHub said no (${r.status}) when asked for ${what}. Try again in a little while.`,
    r.status,
  );
}
async function get(f: Fetch, url: string, accept: string): Promise<Response> {
  try {
    return await f(url, {
      headers: { accept },
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-cache",
    });
  } catch {
    throw new BackendError(
      "offline",
      "Couldn't reach GitHub. Check your connection and open the link again.",
    );
  }
}

interface TreeEntry {
  path: string;
  type: string;
  size?: number;
}

async function listTree(f: Fetch, s: GhSpec, ref: string): Promise<TreeEntry[]> {
  const r = await get(
    f,
    `${API}/repos/${s.owner}/${s.repo}/git/trees/${encodePath(ref)}?recursive=1`,
    "application/vnd.github+json",
  );
  if (!r.ok)
    throw refused(r, `repository or branch (${s.owner}/${s.repo}${s.ref ? `@${s.ref}` : ""})`);
  const body = (await r.json().catch(() => null)) as {
    tree?: TreeEntry[];
    truncated?: boolean;
  } | null;
  if (!body || !Array.isArray(body.tree))
    throw new BackendError("failed", "GitHub's answer wasn't a list of files. Try again later.");
  if (body.truncated)
    throw new BackendError(
      "refused",
      "That repository is too big to list from here. Download the design's files and use Open files instead.",
    );
  return body.tree.filter((e) => typeof e.path === "string" && e.type === "blob");
}

function chooseFolder(blobs: TreeEntry[], s: GhSpec): string {
  if (s.path !== null) return s.path;
  const found = designFolders(blobs.map((e) => e.path));
  if (!found.length)
    throw new BackendError(
      "missing",
      `There is no design in ${s.owner}/${s.repo} (no archnm.yaml). Check the name and branch.`,
    );
  if (found.length > 1)
    throw new BackendError(
      "refused",
      `${s.owner}/${s.repo} holds several designs (${found
        .slice(0, 5)
        .map((x) => x || "the top")
        .join(
          ", ",
        )}). Add the folder after a colon, like ${s.owner}/${s.repo}:${found[1] || found[0]}.`,
    );
  return found[0]!;
}

/** Fetch with a few at a time. */
async function inBatches<T, R>(items: T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await work(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, run));
  return out;
}

/** One design's files at one ref: listed, filtered to the design's own, capped, and read. */
async function filesAt(
  f: Fetch,
  s: GhSpec,
  ref: string,
  folder?: string,
): Promise<{ files: Map<string, string>; folder: string }> {
  const blobs = await listTree(f, s, ref);
  const dir = folder ?? chooseFolder(blobs, s);
  const mine = filesUnder(new Map(blobs.map((e) => [e.path, e])), dir);
  if (!mine.has("archnm.yaml") && !mine.has("atlas.yaml"))
    throw new BackendError(
      "missing",
      `There is no design in ${dir || "the top of the repository"} on ${ref} (no archnm.yaml).`,
    );
  const total = [...mine.values()].reduce((n, e) => n + (e.size ?? 0), 0);
  if (
    mine.size > MAX_FILES ||
    total > MAX_BYTES ||
    [...mine.values()].some((e) => (e.size ?? 0) > MAX_FILE_BYTES)
  )
    throw new BackendError(
      "refused",
      `This design is too big to open from GitHub here (${mine.size} files, ${(total / 1048576).toFixed(1)} MB; the limit is ${MAX_FILES} files and ${MAX_BYTES / 1048576} MB). Download its files and use Open files instead.`,
    );
  const prefix = dir ? `${dir}/` : "";
  const texts = await inBatches([...mine.keys()], async (rel) => {
    const r = await get(
      f,
      `${RAW}/${s.owner}/${s.repo}/${encodePath(ref)}/${encodePath(prefix + rel)}`,
      "text/plain",
    );
    if (!r.ok) throw refused(r, `file ${prefix + rel}`);
    return [rel, await r.text()] as const;
  });
  return { files: new Map(texts), folder: dir };
}

export interface GhDesign {
  files: Map<string, string>;
  /** For a fork: the same design on the repository's default branch, to show what changed. */
  base: Map<string, string> | null;
  /** The fork's name, when the ref is a fork's branch. */
  fork: string | null;
  design: string | null;
  folder: string;
}

/** The design a link names; for a fork's branch, also the design as it is on the default branch. */
export async function fetchGhDesign(
  s: GhSpec,
  f: Fetch = fetch.bind(globalThis),
): Promise<GhDesign> {
  const ref = s.ref ?? "HEAD";
  const head = await filesAt(f, s, ref);
  const fork = forkOf(s.ref);
  let base: Map<string, string> | null = null;
  if (fork) {
    // The design may not exist on main yet (a new one): then there is nothing to compare with.
    base = await filesAt(f, s, "HEAD", head.folder)
      .then((b) => b.files)
      .catch((e: unknown) => {
        if (e instanceof BackendError && e.code === "missing") return null;
        throw e;
      });
  }
  return {
    files: head.files,
    base,
    fork: fork?.fork ?? null,
    design: fork?.design ?? null,
    folder: head.folder,
  };
}
