// Diagrams as rules: a diagram can say what belongs on it ("Shop's children and whatever
// they talk to, minus the warehouse") instead of listing boxes. When the model changes,
// the boxes follow: a new app inside Shop shows up on Shop's diagram with no edit to it.
//
// Rules are a closed set of selectors, structured data rather than a mini-language, so a
// schema can check them and an agent can't mistype a grammar:
//
//   { ids: [a, b] }       exactly these
//   { children: x }       what's directly inside x
//   { descendants: x }    everything inside x, at any depth
//   { neighbours: x }     whatever connects to x or anything in it, rolled up to the
//                         highest box outside x's own line (around a table: the table at
//                         the other end of a key or pointer)
//   { tag: t } { kind: k } { status: s }   every object with that tag / kind / status
//   { uses: k }           whatever connects to something of kind k, itself (not rolled up),
//                         with a function's file: { uses: library } is everything that
//                         calls a library, for a dependency graph
//
// The boxes on the diagram are: every include, minus every exclude, minus the frame (the
// diagram's scope and its ancestors, drawn around it rather than on it). Placements
// remain the record of where boxes sit; the rules decide which boxes there are.
//
// A diagram without rules is a hand-picked one: its placements are the whole story.
import { outwardSide, sideSpot } from "./actions.ts";
import {
  boxSize,
  CARD_H,
  CARD_W,
  OBJECT_KINDS,
  STATUSES,
  type Diagram,
  type ModelObject,
  type ObjectKind,
  type Op,
  type Placement,
  type Status,
} from "./model.ts";
import { ancestors, descendants, type ModelIndex } from "./project.ts";

export type Selector =
  | { ids: string[] }
  | { children: string }
  | { descendants: string }
  | { neighbours: string }
  | { tag: string }
  | { kind: ObjectKind }
  | { status: Status }
  | { uses: ObjectKind }
  /** Guesses: guessed boxes in include/exclude; in hide_lines, guessed lines too. */
  | { guess: true }
  /** Outside services (external: true), and what's inside them. */
  | { external: true }
  /** Whatever is at the top level (in nothing), of any kind: what a landscape shows. */
  | { top: true }
  /** In hide_lines: lines between two boxes outside the view's scope (neighbour to neighbour). */
  | { between: "neighbours" };

export interface Rules {
  include: Selector[];
  exclude: Selector[];
}

const SELECTOR_KEYS = [
  "ids",
  "children",
  "descendants",
  "neighbours",
  "tag",
  "kind",
  "status",
  "uses",
  "guess",
  "external",
  "top",
  "between",
] as const;

/** Rules whose only value is true, and what to say when it's anything else. */
const TRUE_ONLY: Record<string, string | undefined> = {
  guess: "guess takes true ({guess: true}: guessed lines, in hide_lines)",
  external:
    "external takes true ({external: true}: outside services; in hide_lines, the lines to them)",
  top: "top takes true ({top: true}: every box at the top level, in nothing)",
};

/** Why a selector is malformed, or null. */
export function selectorError(s: unknown): string | null {
  if (!s || typeof s !== "object" || Array.isArray(s))
    return "a rule must be a mapping like { children: shop }";
  const keys = Object.keys(s);
  if (keys.length !== 1)
    return `a rule has exactly one key (one of ${SELECTOR_KEYS.join(", ")}), not ${keys.join(", ") || "none"}`;
  const [k] = keys as [string];
  const v = (s as Record<string, unknown>)[k];
  if (!(SELECTOR_KEYS as readonly string[]).includes(k)) {
    const near =
      k === "id"
        ? "ids"
        : (SELECTOR_KEYS as readonly string[]).find((x) => x.startsWith(k.slice(0, 3)));
    return `unknown rule "${k}"${near ? ` (did you mean ${near}?)` : ""}; a rule is one of {ids: [a, b]}, {children: box}, {descendants: box}, {neighbours: box}, {tag: t}, {kind: k}, {status: s}, {uses: kind}, {guess: true}, {external: true}, {top: true}, {between: neighbours}`;
  }
  if (k === "ids")
    return Array.isArray(v) && v.every((x) => typeof x === "string")
      ? null
      : "ids takes a list of ids";
  const mustBeTrue = TRUE_ONLY[k];
  if (mustBeTrue) return v === true ? null : mustBeTrue;
  if (k === "between")
    return v === "neighbours"
      ? null
      : "between takes neighbours ({between: neighbours}: in hide_lines, the lines between two boxes outside the scope)";
  if (typeof v !== "string" || !v) return `${k} takes one value`;
  if ((k === "kind" || k === "uses") && !(OBJECT_KINDS as readonly string[]).includes(v))
    return `unknown kind "${v}"`;
  if (k === "status" && !(STATUSES as readonly string[]).includes(v))
    return `unknown status "${v}"`;
  return null;
}

export function describeSelector(s: Selector, name: (id: string) => string): string {
  if ("ids" in s) return "listed by name";
  if ("children" in s) return `inside ${name(s.children)}`;
  if ("descendants" in s) return `anywhere inside ${name(s.descendants)}`;
  if ("neighbours" in s) return `connected to ${name(s.neighbours)}`;
  if ("tag" in s) return `tagged ${s.tag}`;
  if ("kind" in s) return `every ${s.kind}`;
  if ("uses" in s) return `whatever uses a ${s.uses} (with its file)`;
  if ("guess" in s) return "guesses (lines matched by name)";
  if ("external" in s) return "outside services";
  if ("top" in s) return "at the top level";
  if ("between" in s) return "lines between neighbours (outside the scope)";
  return `status ${s.status}`;
}

/** The highest ancestor of `id` that isn't on `scopeId`'s own line (itself or an ancestor). */
function topmostOutside(idx: ModelIndex, id: string, scopeId: string): string | null {
  const line = new Set<string>([scopeId, ...ancestors(idx, scopeId)]);
  let best = id;
  let cur = idx.objects.get(id)?.parentId ?? null;
  while (cur && !line.has(cur)) {
    best = cur;
    cur = idx.objects.get(cur)?.parentId ?? null;
  }
  return line.has(best) ? null : best;
}

/** The id, if it's a table. */
function tableOf(idx: ModelIndex, id: string): string | null {
  return idx.objects.get(id)?.kind === "table" ? id : null;
}

export function matchSelector(idx: ModelIndex, s: Selector): Set<string> {
  const out = new Set<string>();
  if ("ids" in s) {
    for (const id of s.ids) if (idx.objects.has(id)) out.add(id);
  } else if ("children" in s) {
    for (const c of idx.children.get(s.children) ?? []) out.add(c.id);
  } else if ("descendants" in s) {
    for (const d of descendants(idx, s.descendants)) out.add(d);
  } else if ("neighbours" in s) {
    const x = s.neighbours;
    if (!idx.objects.has(x)) return out;
    const inside = new Set([x, ...descendants(idx, x)]);
    for (const c of idx.connections.values()) {
      const a = inside.has(c.fromId);
      const b = inside.has(c.toId);
      if (a === b) continue;
      const other = a ? c.toId : c.fromId;
      // Around a table, what it links to is a table too, not the store or system it's in:
      // a key or pointer shows the table at its other end (code that uses it rolls up as usual).
      const table = idx.objects.get(x)?.kind === "table" ? tableOf(idx, other) : null;
      const top = table && table !== x ? table : topmostOutside(idx, other, x);
      if (top) out.add(top);
    }
  } else if ("tag" in s) {
    const t = s.tag.toLowerCase();
    for (const o of idx.objects.values()) if (o.tags?.includes(t)) out.add(o.id);
  } else if ("kind" in s) {
    for (const o of idx.objects.values()) if (o.kind === s.kind) out.add(o.id);
  } else if ("status" in s) {
    for (const o of idx.objects.values()) if (o.status === s.status) out.add(o.id);
  } else if ("guess" in s) {
    for (const o of idx.objects.values()) if (o.guess) out.add(o.id);
  } else if ("external" in s) {
    // Trial 22: a manager tagged 30 vendors by hand to hide the lines to them.
    for (const o of idx.objects.values())
      if (o.external || ancestors(idx, o.id).some((a) => idx.objects.get(a)?.external))
        out.add(o.id);
  } else if ("top" in s) {
    for (const o of idx.objects.values()) if (!o.parentId) out.add(o.id);
  } else if ("uses" in s) {
    const kindOf = (id: string) => idx.objects.get(id)?.kind;
    for (const c of idx.connections.values()) {
      if (c.status === "removed") continue;
      if (kindOf(c.toId) !== s.uses || kindOf(c.fromId) === s.uses) continue;
      out.add(c.fromId);
      // A function comes with its file, drawn as the frame around it.
      const parent = idx.objects.get(c.fromId)?.parentId;
      if (kindOf(c.fromId) === "function" && parent && kindOf(parent) === "module") out.add(parent);
    }
  }
  return out;
}

export interface Resolved {
  /** Every box the rules put on the diagram. */
  ids: Set<string>;
  /** For each box, the include rules that matched it. */
  why: Map<string, Selector[]>;
  /** Boxes an include matched but an exclude took off, with the excluding rule. */
  excluded: Map<string, Selector>;
  /** Rules that matched nothing (worth a warning). */
  empty: Selector[];
}

/** The frame: a scoped diagram's scope and its ancestors, which are never boxes on it. */
function frameIds(idx: ModelIndex, d: Diagram): Set<string> {
  return d.scopeId ? new Set([d.scopeId, ...ancestors(idx, d.scopeId)]) : new Set();
}

export function resolve(idx: ModelIndex, d: Diagram): Resolved {
  const rules = d.rules ?? { include: [], exclude: [] };
  const frame = frameIds(idx, d);
  const why = new Map<string, Selector[]>();
  const empty: Selector[] = [];
  for (const s of rules.include) {
    const hit = matchSelector(idx, s);
    if (!hit.size) empty.push(s);
    for (const id of hit) {
      if (frame.has(id)) continue;
      // Removed things only come in when a rule asks for them by status.
      if (idx.objects.get(id)?.status === "removed" && !("status" in s && s.status === "removed"))
        continue;
      const list = why.get(id);
      if (list) list.push(s);
      else why.set(id, [s]);
    }
  }
  const excluded = new Map<string, Selector>();
  for (const s of rules.exclude) {
    const hit = matchSelector(idx, s);
    if (!hit.size) empty.push(s);
    for (const id of hit) {
      if (!why.has(id)) continue;
      why.delete(id);
      excluded.set(id, s);
    }
  }
  return { ids: new Set(why.keys()), why, excluded, empty };
}

/**
 * Placements to add or remove so a ruled diagram shows exactly what its rules say. New
 * boxes go next to something they connect to, or to the right of what's there.
 */
/**
 * `recall`: where this view last had a box it dropped, so one that comes back (an undone move
 * out of its scope) goes back where it was instead of to a new spot.
 */
export function viewOps(
  idx: ModelIndex,
  diagramId: string,
  recall?: (diagramId: string, objectId: string) => Placement | undefined,
): Op[] {
  const d = idx.diagrams.get(diagramId);
  if (!d?.rules) return [];
  const { ids } = resolve(idx, d);
  const placed = idx.placements.get(diagramId) ?? new Map();
  const ops: Op[] = [];
  for (const id of placed.keys())
    if (!ids.has(id)) ops.push({ op: "placement.delete", diagramId, objectId: id });
  const taken: { x: number; y: number; w: number; h: number }[] = [];
  const boxes = [...placed.values()].filter((p) => ids.has(p.objectId));
  // New boxes with no placed neighbour go in a grid to the right of everything there.
  const right = boxes.reduce((m, b) => Math.max(m, b.x + b.w), -Infinity);
  const top = boxes.reduce((m, b) => Math.min(m, b.y), Infinity);
  const origin = Number.isFinite(right) ? { x: right + 120, y: top } : { x: 0, y: 0 };
  let n = 0;
  for (const id of ids) {
    if (placed.has(id)) continue;
    const was = recall?.(diagramId, id);
    if (was) {
      const box = { x: was.x, y: was.y, w: was.w, h: was.h };
      taken.push(box);
      ops.push({ op: "placement.put", placement: { diagramId, objectId: id, ...box } });
      continue;
    }
    const near = nearestPlacedNeighbour(idx, diagramId, id);
    let spot: { x: number; y: number };
    // Beside what it connects to, on the side facing out of the drawing: in the middle it
    // lands on top of lines somebody arranged.
    if (near) {
      const all = [...placed.values(), ...taken];
      spot = sideSpot(
        all,
        near,
        outwardSide(boxes, near),
        boxSize(idx.objects.get(id)?.kind ?? "app"),
      );
    } else {
      // Grid cells are right of every box already there, so free unless a neighbour-placed
      // box took one: then step on.
      do {
        spot = {
          x: origin.x + (n % 8) * (CARD_W + 72),
          y: origin.y + Math.floor(n / 8) * (CARD_H + 56),
        };
        n++;
      } while (
        taken.some(
          (b) =>
            spot.x < b.x + b.w + 12 &&
            b.x < spot.x + CARD_W + 12 &&
            spot.y < b.y + b.h + 12 &&
            b.y < spot.y + CARD_H + 12,
        )
      );
    }
    const box = { x: spot.x, y: spot.y, ...boxSize(idx.objects.get(id)?.kind ?? "app") };
    taken.push(box);
    ops.push({ op: "placement.put", placement: { diagramId, objectId: id, ...box } });
  }
  return ops;
}

/**
 * New things whose parent is drawn as a frame (a file around its functions) join that frame
 * on every diagram that draws it: under the last of their siblings, the same width. Only for
 * new objects, so hiding one by hand stays hidden.
 */
export function frameOps(
  idx: ModelIndex,
  added: Pick<ModelObject, "id" | "parentId" | "kind">[],
  skip: Set<string> = new Set(),
): Op[] {
  const ops: Op[] = [];
  const bottom = new Map<string, number>();
  // Boxes pushed down to make room, per diagram: where each one is now.
  const moved = new Map<string, Map<string, { x: number; y: number; w: number; h: number }>>();
  for (const o of added) {
    if (!o.parentId || idx.objects.get(o.parentId)?.kind !== "module") continue;
    for (const d of idx.placedOn.get(o.parentId) ?? []) {
      const placed = idx.placements.get(d)!;
      if (placed.has(o.id) || skip.has(`${d}|${o.id}`)) continue;
      const sibs = (idx.children.get(o.parentId) ?? []).flatMap(
        (c) => (c.id !== o.id && placed.get(c.id)) || [],
      );
      if (!sibs.length) continue;
      const k = `${d}|${o.parentId}`;
      const low = sibs.reduce((a, b) => (b.y + b.h > a.y + a.h ? b : a));
      const y = (bottom.get(k) ?? low.y + low.h) + 10;
      const size = boxSize(o.kind);
      ops.push({
        op: "placement.put",
        placement: { diagramId: d, objectId: o.id, x: low.x, y, w: low.w, h: size.h },
      });
      bottom.set(k, y + size.h);
      // The frame grew by a row: whatever sits under it, across its width, moves down as much.
      const left = Math.min(...sibs.map((b) => b.x)) - 24;
      const right = Math.max(...sibs.map((b) => b.x + b.w)) + 24;
      const mine = new Set([o.parentId, ...(idx.children.get(o.parentId) ?? []).map((c) => c.id)]);
      const now = moved.get(d) ?? new Map();
      moved.set(d, now);
      for (const p of placed.values()) {
        if (mine.has(p.objectId)) continue;
        const at = now.get(p.objectId) ?? p;
        if (at.y < low.y + low.h || at.x > right || at.x + at.w < left) continue;
        const next = { ...p, ...at, y: at.y + size.h + 10 };
        now.set(p.objectId, next);
        ops.push({ op: "placement.put", placement: next });
      }
    }
  }
  return ops;
}

export function nearestPlacedNeighbour(idx: ModelIndex, diagramId: string, id: string) {
  const placed = idx.placements.get(diagramId);
  if (!placed) return null;
  const inside = new Set([id, ...descendants(idx, id)]);
  for (const c of idx.connections.values()) {
    for (const [mine, other] of [
      [c.fromId, c.toId],
      [c.toId, c.fromId],
    ] as const) {
      if (!inside.has(mine)) continue;
      // Roll the other end up until it's a placed box.
      let cur: string | null = other;
      while (cur && !placed.has(cur)) cur = idx.objects.get(cur)?.parentId ?? null;
      if (cur && cur !== id) return placed.get(cur)!;
    }
  }
  return null;
}

/**
 * Keep a ruled diagram's rules in step with hand edits: placing a box the rules don't
 * cover adds it to an `ids` rule; taking off a box the rules put there adds an exclude.
 * Returns the diagram with updated rules, or null if nothing needs to change.
 */
export function pinEdits(
  idx: ModelIndex,
  d: Diagram,
  added: string[],
  removed: string[],
): Diagram | null {
  if (!d.rules || (!added.length && !removed.length)) return null;
  const include = d.rules.include.map((s) => ("ids" in s ? { ids: [...s.ids] } : s));
  const exclude = d.rules.exclude.map((s) => ("ids" in s ? { ids: [...s.ids] } : s));
  const { ids } = resolve(idx, { ...d, rules: { include, exclude } });
  let changed = false;
  const listOf = (list: Selector[]): { ids: string[] } => {
    let s = list.find((x): x is { ids: string[] } => "ids" in x);
    if (!s) {
      s = { ids: [] };
      list.push(s);
    }
    return s;
  };
  for (const id of added) {
    if (ids.has(id)) continue;
    // Excluded by name: just drop that.
    for (const s of exclude)
      if ("ids" in s && s.ids.includes(id)) s.ids.splice(s.ids.indexOf(id), 1);
    const again = resolve(idx, { ...d, rules: { include, exclude } });
    if (!again.ids.has(id)) listOf(include).ids.push(id);
    changed = true;
  }
  for (const id of removed) {
    const pinned = include.find((s): s is { ids: string[] } => "ids" in s && s.ids.includes(id));
    if (pinned) pinned.ids.splice(pinned.ids.indexOf(id), 1);
    const again = resolve(idx, { ...d, rules: { include, exclude } });
    if (again.ids.has(id)) listOf(exclude).ids.push(id);
    changed = true;
  }
  if (!changed) return null;
  const clean = (l: Selector[]) => l.filter((s) => !("ids" in s) || s.ids.length > 0);
  return { ...d, rules: { include: clean(include), exclude: clean(exclude) } };
}

/** Rules for "the inside of x": its children and whatever they talk to. */
export const insideRules = (scopeId: string): Rules => ({
  include: [{ children: scopeId }, { neighbours: scopeId }],
  exclude: [],
});

/**
 * Start following rules without changing what's on the diagram today: base rules (the
 * inside of the scope, or nothing for a landscape), plus a pin for each extra box and an
 * exclude for each box the rules would add.
 */
export function adoptRules(idx: ModelIndex, d: Diagram): Diagram {
  const base: Diagram = {
    ...d,
    rules: d.scopeId ? insideRules(d.scopeId) : { include: [], exclude: [] },
  };
  const placed = new Set(idx.placements.get(d.id)?.keys() ?? []);
  const { ids } = resolve(idx, base);
  const added = [...placed].filter((id) => !ids.has(id));
  const removed = [...ids].filter((id) => !placed.has(id));
  // pinEdits treats `removed` as "currently on, being taken off"; that's what we want here.
  return pinEdits(idx, base, added, removed) ?? base;
}
