// The left pane's model tree, like `lsd --tree`: every object under what it's in, folded
// until opened. One tree for every kind, so a code layer is just deeper rows.
import { isCodeKind, type ModelObject } from "./model.ts";
import { ancestors, type ModelIndex } from "./project.ts";

export interface NavRow {
  o: ModelObject;
  depth: number;
  /** It has something inside. */
  branch: boolean;
  open: boolean;
  /** Which way each guide column runs, for the depth before this row: is the ancestor at that depth the last of its siblings. */
  lastAt: boolean[];
  last: boolean;
  /** What the row's icon is: a folder or a file (modules), else the kind. */
  icon: "folder" | "file" | ModelObject["kind"];
  /**
   * Folders that each hold just one folder are shown as one row ("crates/evidence/src"),
   * the way an editor's file tree compacts them: the ones above `o`, top first. `o` is the
   * deepest, whose insides are listed under the row.
   */
  chain?: ModelObject[];
  /**
   * A library, listed under something that uses it: that thing's id. The same library is a
   * row under each of its users, so a row is told apart by this and its own id together.
   */
  usedBy?: string;
  /**
   * Not a box: a "Libraries" folder of `count` libraries. Under a box, the ones it uses
   * (usedBy is that box, `o`); at the end of the tree, the ones nothing uses (usedBy is "").
   * It folds on its own, as LIBS + usedBy in the open set.
   */
  group?: "libraries";
  count?: number;
}

/** A row's place in the open set when it's a box's Libraries folder. */
export const LIBS = "libs:";

/** What a row says: its name, or a compacted chain's joined with slashes. */
export const rowLabel = (r: NavRow) =>
  r.group
    ? "Libraries"
    : r.chain?.length
      ? [...r.chain, r.o].map((x) => x.name).join("/")
      : r.o.name;

const ORDER: Record<ModelObject["kind"], number> = {
  actor: 0,
  system: 1,
  app: 2,
  store: 3,
  component: 4,
  module: 5,
  function: 6,
  library: 7,
  table: 8,
};

/** Folders first, then by kind, then by name: the order a file tree reads in. */
function navOrder(a: ModelObject, b: ModelObject): number {
  const fa = iconOf(a) === "folder" ? 0 : 1;
  const fb = iconOf(b) === "folder" ? 0 : 1;
  return ORDER[a.kind] - ORDER[b.kind] || fa - fb || a.name.localeCompare(b.name);
}

/** A module with a path to a file (its last part has an extension) is a file; any other module a folder. */
export function iconOf(o: ModelObject): NavRow["icon"] {
  if (o.kind !== "module") return o.kind;
  const last = (o.path ?? o.name).split(/[:/]/).pop() ?? "";
  return /\.[A-Za-z0-9]+$/.test(last) ? "file" : "folder";
}

/**
 * The rows to show: roots, and the insides of whatever is open. `only`, when given, keeps
 * just those objects and what they're in. A filter that finds things (what's new, a search)
 * opens the way to them; one that only narrows the tree (just the code) folds like the tree,
 * so pass `unfold: false` for that.
 *
 * A library is listed under each thing that uses it (a connection to it, or a dependency
 * reference), after what's inside: the file, folder, app or component, with a function's
 * libraries shown on its file. One nothing uses is a row at the end of the roots.
 */
export function navRows(
  idx: ModelIndex,
  open: Set<string>,
  only?: Set<string>,
  opts: { unfold?: boolean; libraries?: boolean } = {},
): NavRow[] {
  const unfold = opts.unfold ?? true;
  // Only where the tree is the code (files and folders): on the tree of boxes and diagrams a
  // library is secondary to the box that uses it, and isn't listed.
  const withLibs = opts.libraries ?? false;
  let keep: Set<string> | null = null;
  if (only) {
    keep = new Set();
    for (const id of only) {
      if (!idx.objects.has(id)) continue;
      keep.add(id);
      for (const a of ancestors(idx, id)) keep.add(a);
    }
  }
  const out: NavRow[] = [];
  const listed = (o: ModelObject) => o.kind !== "library" && (!keep || keep.has(o.id));
  const roots = [...idx.objects.values()].filter(
    (o) => !o.parentId || !idx.objects.has(o.parentId),
  );
  const childrenOf = (o: ModelObject) => (idx.children.get(o.id) ?? []).filter(listed);
  // Who uses each library: the box at the other end, or for a function, the file it's in (a
  // row of libraries under every function would bury the functions).
  const libs = new Map<string, Map<string, ModelObject>>();
  const used = new Set<string>();
  const uses = (userId: string, libId: string) => {
    const lib = idx.objects.get(libId);
    let user = idx.objects.get(userId);
    if (user?.kind === "function" && user.parentId) user = idx.objects.get(user.parentId) ?? user;
    if (!withLibs || !user || lib?.kind !== "library" || lib.status === "removed") return;
    if (keep && !keep.has(lib.id)) return;
    used.add(lib.id);
    if (!libs.has(user.id)) libs.set(user.id, new Map());
    libs.get(user.id)!.set(lib.id, lib);
  };
  for (const c of idx.connections.values()) if (c.status !== "removed") uses(c.fromId, c.toId);
  for (const o of idx.objects.values())
    for (const r of o.references ?? []) if (r.kind === "dependency") uses(o.id, r.to);
  const libsOf = (o: ModelObject) =>
    [...(libs.get(o.id)?.values() ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const walk = (list: ModelObject[], depth: number, lastAt: boolean[], more = false) => {
    const shown = list.filter(listed).sort(navOrder);
    shown.forEach((top, i) => {
      let o = top;
      const chain: ModelObject[] = [];
      for (;;) {
        if (iconOf(o) !== "folder") break;
        const only1 = childrenOf(o);
        if (only1.length !== 1 || iconOf(only1[0]!) !== "folder" || libs.has(o.id)) break;
        chain.push(o);
        o = only1[0]!;
      }
      const kids = childrenOf(o);
      const mine = libsOf(o);
      const inside = kids.length + mine.length;
      // Finding opens the way to what it found.
      const isOpen = inside > 0 && (open.has(o.id) || (!!keep && unfold));
      const last = i === shown.length - 1 && !more;
      out.push({
        o,
        depth,
        branch: inside > 0,
        open: isOpen,
        lastAt,
        last,
        icon: iconOf(o),
        ...(chain.length ? { chain } : {}),
      });
      if (isOpen) {
        const under = [...lastAt, last];
        // What's inside, then one folder of the libraries it uses (folded, like any folder).
        walk(kids, depth + 1, under, mine.length > 0);
        if (mine.length) {
          const groupOpen = open.has(LIBS + o.id) || (!!keep && unfold);
          out.push({
            o,
            depth: depth + 1,
            branch: true,
            open: groupOpen,
            lastAt: under,
            last: true,
            icon: "folder",
            usedBy: o.id,
            group: "libraries",
            count: mine.length,
          });
          if (groupOpen)
            mine.forEach((lib, k) =>
              out.push({
                o: lib,
                depth: depth + 2,
                branch: false,
                open: false,
                lastAt: [...under, true],
                last: k === mine.length - 1,
                icon: "library",
                usedBy: o.id,
              }),
            );
        }
      }
    });
  };
  walk(roots, 0, []);
  // Libraries nothing uses yet: still findable, at the end.
  const loose = [...idx.objects.values()]
    .filter(
      (o) =>
        withLibs &&
        o.kind === "library" &&
        o.status !== "removed" &&
        !used.has(o.id) &&
        (!keep || keep.has(o.id)),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  // In a folder of their own at the end, folded: a repo's dev tools can be dozens.
  if (loose.length) {
    if (out.length) out[out.length - 1] = { ...out[out.length - 1]!, last: false };
    const groupOpen = open.has(LIBS) || (!!keep && unfold);
    out.push({
      o: loose[0]!,
      depth: 0,
      branch: true,
      open: groupOpen,
      lastAt: [],
      last: true,
      icon: "folder",
      usedBy: "",
      group: "libraries",
      count: loose.length,
    });
    if (groupOpen)
      loose.forEach((lib, k) =>
        out.push({
          o: lib,
          depth: 1,
          branch: false,
          open: false,
          lastAt: [true],
          last: k === loose.length - 1,
          icon: "library",
          usedBy: "",
        }),
      );
  }
  return out;
}

/** Whether a tree of this design has a code layer at all (for the hint under it). */
export const hasCode = (idx: ModelIndex) =>
  [...idx.objects.values()].some((o) => isCodeKind(o.kind));
