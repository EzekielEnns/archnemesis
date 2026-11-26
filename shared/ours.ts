// Which paths belong to a design's folder (the files Archnemesis reads and writes), and how to
// find the folders in a list of paths that hold a design. Pure: the server's git sync, the
// browser's "open files" and the public GitHub loader all use the same rule.
// code/ mirrors the source tree, so it goes as deep as the code does: each part a plain
// name, never "." or "..".
const SEG = "(?!\\.\\.?/)[A-Za-z0-9._-]+";
const OURS = new RegExp(
  `^((?:archnm|atlas)\\.yaml|AGENTS\\.md|boundaries\\.yaml|entities\\.yaml|libraries\\.yaml|decisions/[^/]+\\.ya?ml|model/[^/]+\\.ya?ml|views/[^/]+\\.ya?ml|layout/[^/]+\\.json|code/(?:${SEG}/){1,30}${SEG}\\.yaml)$`,
);

/** Is this path (relative to a design's folder) one Archnemesis reads and writes? */
export const isOurs = (rel: string): boolean => OURS.test(rel);

/** The folders ("" for the top) that hold a design file, shortest first. */
export function designFolders(paths: Iterable<string>): string[] {
  const all = new Set(paths);
  const out: string[] = [];
  for (const p of all) {
    const m = /^(?:(.*)\/)?(?:archnm|atlas)\.yaml$/.exec(p);
    if (m) out.push(m[1] ?? "");
  }
  return [...new Set(out)].sort((a, b) => a.length - b.length || a.localeCompare(b));
}

/** The files under `folder` that are a design's, with the folder taken off their paths. */
export function filesUnder<T>(all: Map<string, T>, folder: string): Map<string, T> {
  const prefix = folder ? `${folder}/` : "";
  const out = new Map<string, T>();
  for (const [path, v] of all)
    if (path.startsWith(prefix) && isOurs(path.slice(prefix.length)))
      out.set(path.slice(prefix.length), v);
  return out;
}
