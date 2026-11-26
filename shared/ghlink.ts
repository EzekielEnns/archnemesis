// What a link to a design in a public GitHub repository says, and how it is written:
// `owner/repo[@ref][:folder]`, e.g. `acme/designs@archnm/shop/zeek-11-26:shop`. Pure text; the
// loader that fetches it is src/backend/github-public.ts. Everything here is untrusted input
// from a link, so each part is checked against what GitHub itself allows.

/** What a link names: owner/repo, a branch or tag (the default branch when left out), a folder. */
export interface GhSpec {
  owner: string;
  repo: string;
  ref: string | null;
  /** The design's folder in the repository ("" for the top); null: find it. */
  path: string | null;
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const REF = /^[A-Za-z0-9._/-]{1,200}$/;
const FOLDER = /^[A-Za-z0-9._ -]{1,100}(?:\/[A-Za-z0-9._ -]{1,100}){0,12}$/;

/** `owner/repo[@ref][:folder]` as a spec (null when it isn't one). */
export function parseGhSpec(text: string): GhSpec | null {
  let t = text.trim();
  try {
    t = decodeURIComponent(t);
  } catch {
    return null;
  }
  const colon = t.indexOf(":");
  const folder = colon < 0 ? null : t.slice(colon + 1).replace(/^\/+|\/+$/g, "");
  const head = colon < 0 ? t : t.slice(0, colon);
  const at = head.indexOf("@");
  const repoPart = at < 0 ? head : head.slice(0, at);
  const ref = at < 0 ? null : head.slice(at + 1);
  const [owner, repo, ...extra] = repoPart.split("/");
  if (!owner || !repo || extra.length || !OWNER.test(owner) || !REPO.test(repo)) return null;
  if (repo === "." || repo === "..") return null;
  if (ref !== null && (!REF.test(ref) || ref.includes("..") || ref.endsWith("/"))) return null;
  if (
    folder !== null &&
    folder !== "" &&
    (!FOLDER.test(folder) || /(^|\/)\.\.?(\/|$)/.test(folder))
  )
    return null;
  return { owner, repo: repo.replace(/\.git$/, ""), ref, path: folder };
}

/** A spec as the fragment text that opens it (without `#~gh=`). */
export function ghText(s: GhSpec): string {
  return `${s.owner}/${s.repo}${s.ref ? `@${s.ref}` : ""}${s.path !== null ? `:${s.path}` : ""}`;
}

/** A fork's branch is `archnm/<design>/<fork>` (or `atlas/...`, from before the rename). */
export function forkOf(ref: string | null): { design: string; fork: string } | null {
  const m = /^(?:archnm|atlas)\/([^/]+)\/(.+)$/.exec(ref ?? "");
  return m ? { design: m[1]!, fork: m[2]! } : null;
}
