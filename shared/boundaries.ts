// Boundaries: where things run (a project, a VPC, a subnet, the edge), drawn as dashed
// frames on the diagrams that ask for them. See Boundary in model.ts.
//
// Which boundary a box is drawn in:
//   1. its own: the deepest boundary whose rules pick the object;
//   2. else its nearest ancestor's own (put a system in a project and its insides are too);
//   3. else the deepest boundary that holds everything inside it that has one (app-service,
//      whose API runs in the prod project and whose database is in the prod VPC, is drawn
//      in the prod project on the landscape).
// They never add or remove boxes; frames are worked out from where the boxes already are.
import { makeBoundary, now, slug, type Boundary, type BoundaryKind, type Op } from "./model.ts";
import { ancestors, type ModelIndex } from "./project.ts";
import { describeSelector, matchSelector, type Selector } from "./views.ts";

/** A boundary's frame on a diagram. */
export interface BoundaryFrame {
  id: string;
  name: string;
  kind: Boundary["kind"];
  depth: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

const PAD = 24;
const LABEL = 30;

interface Memo {
  own: Map<string, string>;
  final: Map<string, string | null>;
  /** Objects picked by more than one unrelated boundary, for check. */
  clashes: { objectId: string; boundaries: [string, string] }[];
}
const memo = new WeakMap<ModelIndex, Memo>();

/** A boundary and everything it sits inside, innermost first. */
export function boundaryChain(idx: ModelIndex, id: string | null): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let cur = id;
  while (cur && !seen.has(cur) && idx.boundaries.has(cur)) {
    out.push(cur);
    seen.add(cur);
    cur = idx.boundaries.get(cur)!.parentId;
  }
  return out;
}

/** The objects a boundary's rules pick (no inheritance). */
export function boundaryMembers(idx: ModelIndex, b: Boundary): Set<string> {
  const ids = new Set<string>();
  for (const s of b.rules.include) for (const id of matchSelector(idx, s)) ids.add(id);
  for (const s of b.rules.exclude) for (const id of matchSelector(idx, s)) ids.delete(id);
  return ids;
}

function compute(idx: ModelIndex): Memo {
  const hit = memo.get(idx);
  if (hit) return hit;
  const own = new Map<string, string>();
  const clashes: Memo["clashes"] = [];
  const depth = (id: string) => boundaryChain(idx, id).length;
  const order = [...idx.boundaries.values()].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  for (const b of order) {
    for (const o of boundaryMembers(idx, b)) {
      const cur = own.get(o);
      if (!cur) own.set(o, b.id);
      else if (boundaryChain(idx, b.id).includes(cur))
        own.set(o, b.id); // b is inside cur: the deeper one wins
      else if (!boundaryChain(idx, cur).includes(b.id)) {
        clashes.push({ objectId: o, boundaries: [cur, b.id] });
        if (depth(b.id) > depth(cur)) own.set(o, b.id);
      }
    }
  }
  const m: Memo = { own, final: new Map(), clashes };
  memo.set(idx, m);
  return m;
}

/** The deepest boundary holding both (null if none does). */
function common(idx: ModelIndex, a: string, b: string): string | null {
  const ca = boundaryChain(idx, a);
  const cb = new Set(boundaryChain(idx, b));
  return ca.find((x) => cb.has(x)) ?? null;
}

/** Which boundary a box for this object is drawn in, or null. */
export function boundaryOf(idx: ModelIndex, objectId: string): string | null {
  const m = compute(idx);
  if (m.final.has(objectId)) return m.final.get(objectId)!;
  let found: string | null = m.own.get(objectId) ?? null;
  if (!found) for (const a of ancestors(idx, objectId)) if ((found = m.own.get(a) ?? null)) break;
  if (!found) found = fromInside(idx, objectId, m, new Set());
  m.final.set(objectId, found);
  return found;
}

/** Rule 3: the deepest boundary common to everything inside that has one. */
function fromInside(idx: ModelIndex, id: string, m: Memo, seen: Set<string>): string | null {
  if (seen.has(id)) return null;
  seen.add(id);
  let acc: string | null | undefined;
  for (const c of idx.children.get(id) ?? []) {
    const b = m.own.get(c.id) ?? fromInside(idx, c.id, m, seen);
    if (!b) continue;
    acc = acc === undefined ? b : acc && common(idx, acc, b);
    if (acc === null) return null;
  }
  return acc ?? null;
}

/** Objects two unrelated boundaries both pick (only one of them is drawn). */
export function boundaryClashes(idx: ModelIndex): Memo["clashes"] {
  return compute(idx).clashes;
}

/**
 * The frames on a diagram, outermost first (draw order), each around its boxes and the
 * frames inside it. Only boundaries that end up holding a box are drawn.
 */
export function boundaryFrames(
  idx: ModelIndex,
  nodes: { id: string; x: number; y: number; w: number; h: number }[],
): BoundaryFrame[] {
  if (!idx.boundaries.size) return [];
  const boxes = new Map<string, { x: number; y: number; w: number; h: number }[]>();
  const kids = new Map<string, Set<string>>();
  const roots = new Set<string>();
  for (const n of nodes) {
    const b = boundaryOf(idx, n.id);
    if (!b) continue;
    (boxes.get(b) ?? boxes.set(b, []).get(b)!).push(n);
    const chain = boundaryChain(idx, b);
    for (let i = 0; i < chain.length - 1; i++)
      (kids.get(chain[i + 1]!) ?? kids.set(chain[i + 1]!, new Set()).get(chain[i + 1]!)!).add(
        chain[i]!,
      );
    roots.add(chain[chain.length - 1]!);
  }
  const out: BoundaryFrame[] = [];
  const frame = (id: string, depth: number, seen: Set<string>): BoundaryFrame | null => {
    if (seen.has(id)) return null;
    seen.add(id);
    const inner = [...(kids.get(id) ?? [])]
      .map((k) => frame(k, depth + 1, seen))
      .filter((f): f is BoundaryFrame => !!f);
    const rects = [...(boxes.get(id) ?? []), ...inner];
    if (!rects.length) return null;
    const minX = Math.min(...rects.map((r) => r.x));
    const minY = Math.min(...rects.map((r) => r.y));
    const maxX = Math.max(...rects.map((r) => r.x + r.w));
    const maxY = Math.max(...rects.map((r) => r.y + r.h));
    const b = idx.boundaries.get(id)!;
    const f: BoundaryFrame = {
      id,
      name: b.name,
      kind: b.kind,
      depth,
      x: minX - PAD,
      y: minY - PAD - LABEL,
      w: maxX - minX + PAD * 2,
      h: maxY - minY + PAD * 2 + LABEL,
    };
    out.push(f);
    return f;
  };
  for (const r of roots) frame(r, 0, new Set());
  return out.sort((a, b) => a.depth - b.depth);
}

/** For layout: a box's boundary chain, outermost first (so ELK can nest them). */
export function boundaryPath(idx: ModelIndex, objectId: string): string[] {
  return boundaryChain(idx, boundaryOf(idx, objectId)).reverse();
}

/**
 * Ops that make an object run in `target` (null: in none of its own), by editing rules so
 * the files stay the truth: it's listed by id in the target, and taken out of (or excluded
 * from) any other boundary that picks it, except the target's own parents.
 */
export function moveToBoundaryOps(idx: ModelIndex, objectId: string, target: string | null): Op[] {
  const t = now();
  const keep = new Set(target ? boundaryChain(idx, target) : []);
  const ops: Op[] = [];
  const without = (list: Selector[]): Selector[] =>
    list.flatMap((s): Selector[] => {
      if (!("ids" in s) || !s.ids.includes(objectId)) return [s];
      const ids = s.ids.filter((x) => x !== objectId);
      return ids.length ? [{ ids }] : [];
    });
  for (const b of idx.boundaries.values()) {
    let include = b.rules.include;
    let exclude = b.rules.exclude;
    if (b.id === target) {
      exclude = without(exclude);
      if (!boundaryMembers(idx, { ...b, rules: { include, exclude } }).has(objectId)) {
        const i = include.findIndex((s) => "ids" in s);
        include =
          i >= 0
            ? include.map((s, j) => (j === i && "ids" in s ? { ids: [...s.ids, objectId] } : s))
            : [...include, { ids: [objectId] }];
      }
    } else if (!keep.has(b.id) && boundaryMembers(idx, b).has(objectId)) {
      include = without(include);
      // Still picked by a tag or kind rule: say it's not one of them.
      if (boundaryMembers(idx, { ...b, rules: { include, exclude } }).has(objectId)) {
        const i = exclude.findIndex((s) => "ids" in s);
        exclude =
          i >= 0
            ? exclude.map((s, j) => (j === i && "ids" in s ? { ids: [...s.ids, objectId] } : s))
            : [...exclude, { ids: [objectId] }];
      }
    }
    if (JSON.stringify({ include, exclude }) !== JSON.stringify(b.rules))
      ops.push({
        op: "boundary.put",
        boundary: { ...b, rules: { include, exclude }, updatedAt: t },
      });
  }
  return ops;
}

/** Why an object is drawn in a boundary: the rule that picks it, or where it inherits it from. */
export function whyIn(
  idx: ModelIndex,
  b: Boundary,
  objectId: string,
  name: (id: string) => string,
): string {
  const s = b.rules.include.find((x) => matchSelector(idx, x).has(objectId));
  if (s && boundaryMembers(idx, b).has(objectId)) return describeSelector(s, name);
  for (const a of ancestors(idx, objectId))
    if (boundaryOf(idx, a) === boundaryOf(idx, objectId) && compute(idx).own.get(a))
      return `inside ${name(a)}`;
  return "everything inside it runs here";
}

/** moveToBoundaryOps for several objects: each sees the rules as the ones before left them. */
export function moveManyToBoundaryOps(
  idx: ModelIndex,
  objectIds: string[],
  target: string | null,
): Op[] {
  let cur = idx;
  const latest = new Map<string, Boundary>();
  for (const id of objectIds) {
    for (const op of moveToBoundaryOps(cur, id, target))
      if (op.op === "boundary.put") latest.set(op.boundary.id, op.boundary);
    // A fresh index object, so boundaryOf's memo starts over with the edited rules.
    cur = { ...cur, boundaries: new Map([...cur.boundaries, ...latest]) };
  }
  return [...latest.values()].map((boundary) => ({ op: "boundary.put", boundary }));
}

/** A new boundary holding these objects (taken out of any unrelated boundary). */
export function newBoundaryOps(
  idx: ModelIndex,
  b: { name: string; kind: BoundaryKind; parentId: string | null },
  objectIds: string[],
): { id: string; ops: Op[] } {
  const taken = new Set([...idx.boundaries.values()].map((x) => x.key ?? x.id));
  let key = slug(b.name) || "boundary";
  for (let i = 2; taken.has(key); i++) key = `${slug(b.name) || "boundary"}-${i}`;
  const made = {
    ...makeBoundary({ id: key, key, name: b.name, kind: b.kind }),
    parentId: b.parentId,
  };
  const withIt = { ...idx, boundaries: new Map([...idx.boundaries, [made.id, made]]) };
  return {
    id: made.id,
    ops: [
      { op: "boundary.put", boundary: made },
      ...moveManyToBoundaryOps(withIt, objectIds, made.id),
    ],
  };
}

/** The region an object is in (the nearest region boundary around where it's drawn), or null. */
function regionOf(idx: ModelIndex, objectId: string): Boundary | null {
  for (const id of boundaryChain(idx, boundaryOf(idx, objectId))) {
    const x = idx.boundaries.get(id);
    if (x?.kind === "region") return x;
  }
  return null;
}

/** "us-central1 → europe-west2" when the two ends are in different regions; null otherwise
 * (same region, or either end in none). */
export function crossesRegions(idx: ModelIndex, fromId: string, toId: string): string | null {
  const a = regionOf(idx, fromId);
  const b = regionOf(idx, toId);
  return a && b && a.id !== b.id ? `${a.name} → ${b.name}` : null;
}

/** The same crossing, short, for a badge: the regions' keys ("US → UK"). */
export function crossesRegionsShort(idx: ModelIndex, fromId: string, toId: string): string | null {
  const a = regionOf(idx, fromId);
  const b = regionOf(idx, toId);
  const short = (r: Boundary) => (r.key ?? r.id).toUpperCase();
  return a && b && a.id !== b.id ? `${short(a)} → ${short(b)}` : null;
}
