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
}

/** What a row says: its name, or a compacted chain's joined with slashes. */
export const rowLabel = (r: NavRow) =>
  r.chain?.length ? [...r.chain, r.o].map((x) => x.name).join("/") : r.o.name;

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
 * Libraries aren't rows: they're references on the code that uses them (shown on its card
 * and on the canvas), not things of their own to find your way by.
 */
export function navRows(
  idx: ModelIndex,
  open: Set<string>,
  only?: Set<string>,
  opts: { unfold?: boolean } = {},
): NavRow[] {
  const unfold = opts.unfold ?? true;
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
  const walk = (list: ModelObject[], depth: number, lastAt: boolean[]) => {
    const shown = list.filter(listed).sort(navOrder);
    shown.forEach((top, i) => {
      let o = top;
      const chain: ModelObject[] = [];
      for (;;) {
        if (iconOf(o) !== "folder") break;
        const only1 = childrenOf(o);
        if (only1.length !== 1 || iconOf(only1[0]!) !== "folder") break;
        chain.push(o);
        o = only1[0]!;
      }
      const kids = childrenOf(o);
      // Finding opens the way to what it found.
      const isOpen = kids.length > 0 && (open.has(o.id) || (!!keep && unfold));
      const last = i === shown.length - 1;
      out.push({
        o,
        depth,
        branch: kids.length > 0,
        open: isOpen,
        lastAt,
        last,
        icon: iconOf(o),
        ...(chain.length ? { chain } : {}),
      });
      if (isOpen) walk(kids, depth + 1, [...lastAt, last]);
    });
  };
  walk(roots, 0, []);
  return out;
}

/** Whether a tree of this design has a code layer at all (for the hint under it). */
export const hasCode = (idx: ModelIndex) =>
  [...idx.objects.values()].some((o) => isCodeKind(o.kind));
