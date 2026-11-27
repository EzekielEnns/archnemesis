// From the model to one diagram: which boxes, which arrows, which boundary.
//
// The rule that makes one model serve many diagrams: a connection is drawn between the
// nearest placed ancestor-or-self of each end. Draw a system on the landscape and every
// connection of its apps and components shows up as an arrow on the system; open the
// system and the same connections land on the apps. Several connections that land on the
// same pair of boxes become one arrow with a count.
import { boundaryChain, boundaryFrames, boundaryOf, crossesRegions } from "./boundaries.ts";
import { matchSelector } from "./views.ts";

type Rect = { x: number; y: number; w: number; h: number };
import {
  KIND_LABEL,
  type Boundary,
  type BoundaryKind,
  type Decision,
  type Entity,
  type Note,
  type Reply,
  type ArrowShape,
  type Connection,
  type Diagram,
  type Flow,
  type ModelObject,
  type ObjectKind,
  type Placement,
  type Status,
} from "./model.ts";

export interface CanvasNode {
  id: string;
  kind: ObjectKind;
  name: string;
  subtitle: string;
  x: number;
  y: number;
  w: number;
  h: number;
  external: boolean;
  status: Status;
  /** Objects inside it: shown as a badge, and it can be opened. */
  childCount: number;
  /** For its logo. */
  technology: string;
  /** The logo chosen by hand, over the one guessed from technology ("none": no logo). */
  icon?: string;
  /** Connections to things that aren't on this diagram at all. */
  hidden: number;
  /** Written out at the bottom right: its status (future, deprecated), external, then its own tags. */
  tags: string[];
  /** #rrggbb when the view colours by a tag group (colorGraph). */
  color?: string;
  /** This box stands for several folded together (the externals on a landscape): their ids. */
  folded?: string[];
  /** The group: tag value it folds, when it's a group ("human-signals"); opening it opens that group. */
  group?: string;
  /** A table's columns, drawn on its box when the box is tall enough for them (else folded). */
  columns?: CanvasColumn[];
  /** Believed, not confirmed: drawn fainter. */
  guess?: true;
}

/** A column as a table's box shows it: name, type, and its mark (pk, fk, unique, personal). */
interface CanvasColumn {
  name: string;
  type: string;
  mark: "pk" | "fk" | "uq" | "pii" | "";
  nullable: boolean;
}

/** A table's box shows its columns once it's at least this tall; shorter, they're folded away. */
export const TABLE_HEAD = 58;
export const TABLE_ROW = 22;
export const tableOpenHeight = (cols: number): number =>
  TABLE_HEAD + Math.max(1, cols) * TABLE_ROW + 8;
export const tableShowsColumns = (h: number): boolean => h >= TABLE_HEAD + TABLE_ROW + 8;

function canvasColumns(idx: ModelIndex, o: ModelObject): CanvasColumn[] | undefined {
  if (o.kind !== "table" || !o.columns?.length) return undefined;
  const keys = new Set<string>();
  for (const c of idx.connections.values())
    if (c.fromId === o.id && c.column && c.status !== "removed") keys.add(c.column);
  return o.columns.map((c) => ({
    name: c.name,
    type: c.type ?? "",
    mark: c.pk ? "pk" : keys.has(c.name) ? "fk" : c.unique ? "uq" : c.personal ? "pii" : "",
    nullable: !!c.nullable,
  }));
}

export interface CanvasEdge {
  id: string;
  from: string;
  to: string;
  label: string;
  /** Several connections merged into one arrow: each one's name, for a hover to list. */
  merged?: string[];
  /** Merged: each one's own label (blank ones left out), for a picture that has no hover. */
  labels?: string[];
  /** It crosses from one process to another (a socket, HTTP): drawn dashed, named by its tech. */
  hop?: boolean;
  /** To or from a library: drawn faint until something on it is selected. */
  quiet?: boolean;
  /** Every connection on it is a guess (a call matched by name). */
  guess?: true;
  /** A connection on it goes both ways: a head at each end. */
  both?: true;
  /** One of several arrows from the same box with the same label (publishes → three services):
   * drawn as one line that splits, named once. The same on each of them. */
  fan?: string;
  /** The one of a fan that carries its label. */
  fanLead?: true;
  /** It runs through a split point (shape.split) with the others from its box that share it: which group. */
  split?: string;
  /** The first arrow of its split group, or of its join group: the one the others were drawn off, or onto. */
  splitLead?: boolean;
  joinLead?: boolean;
  /** It runs through a join point (shape.join) with the others into its box that share it: which group. */
  join?: string;
  /** Every connection on it is a call between code (functions, files): a call graph, tangled by nature. */
  code?: true;
  /** Its ends are in different regions ("us-central1 → europe-west2"): a pointer or call that
   * reaches across a residency line. Worked out from the boundaries, never stored. */
  crosses?: string;
  /** A key between tables: the column holding it and the one it points at. An open table's
   * box takes the line at that column's row. */
  fromColumn?: string;
  toColumn?: string;
  connectionIds: string[];
  status: Status;
  /** Shaped by hand on this diagram, if it has been. */
  shape?: ArrowShape;
}

/**
 * Mark the arrows that are drawn as one line that parts. Arrows from one box with the same split
 * point run as one to it, then each to its own box. Arrows that leave one box under one name
 * for different boxes are a fan: one start, named once.
 */
function markFans(edges: CanvasEdge[]): void {
  const by = new Map<string, CanvasEdge[]>();
  const same = (a: CanvasEdge, b: CanvasEdge) =>
    a.label.trim().toLowerCase() === b.label.trim().toLowerCase();
  for (const e of edges) {
    const sp = e.shape?.split;
    const label = e.label.trim().toLowerCase();
    if (!sp && (!label || e.labels?.length || e.fromColumn)) continue;
    const k = sp ? `${e.from}|${sp.x},${sp.y}` : `${e.from}|${label}`;
    by.set(k, [...(by.get(k) ?? []), e]);
  }
  // Into one box through the same join point: they meet there and go in as one.
  const joined = new Set<string>();
  for (const e of edges) {
    const jp = e.shape?.join;
    if (!jp) continue;
    e.join = `${e.to}|join|${jp.x},${jp.y}`;
    // The first of them is the one the others were drawn onto.
    if (!joined.has(e.join)) e.joinLead = true;
    joined.add(e.join);
  }
  for (const [k, list] of by) {
    const lead = list[0]!;
    if (lead.shape?.split) {
      // Each branch keeps its own name; when they all say the same, it's said once, before they part.
      const one = list.length > 1 && list.every((e) => same(e, lead));
      for (const e of list) {
        e.split = k;
        if (one) e.fan = k;
      }
      lead.fanLead = true;
      lead.splitLead = true;
    } else if (list.length > 1) {
      for (const e of list) e.fan = k;
      lead.fanLead = true;
    }
  }
}

/** A frame: the object a diagram looks inside, or a boundary (dashed, with its kind). */
export interface CanvasGroup {
  id: string;
  name: string;
  /** Set for a boundary (project, network…); absent for the scope's frame. */
  boundary?: BoundaryKind;
  /** A box opened in place: its inside view drawn here, framed like a diagram (its tab is HTML). */
  inset?: boolean;
  /** An opened box's kind, to colour its panel like the box. */
  kind?: ObjectKind;
  /** A lane: one value of the view's lanes tag group. */
  lane?: boolean;
  /** A module whose insides are on the diagram, drawn as a frame around them; id is the module's. */
  container?: ObjectKind;
  depth?: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where each line can end: the boxes, and the frames drawn for boxes (a box whose insides are on
 * the diagram, and the view's scope). Lanes, boundaries and opened boxes aren't line ends.
 */
export function lineEnds(g: { nodes: CanvasNode[]; groups: CanvasGroup[] }): Map<string, Rect> {
  const out = new Map<string, Rect>();
  for (const f of g.groups) if (!f.boundary && !f.lane && !f.inset) out.set(f.id, f);
  for (const n of g.nodes) out.set(n.id, n);
  return out;
}

export interface CanvasGraph {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  groups: CanvasGroup[];
}

export interface ModelIndex {
  objects: Map<string, ModelObject>;
  connections: Map<string, Connection>;
  diagrams: Map<string, Diagram>;
  /** diagramId → objectId → placement */
  placements: Map<string, Map<string, Placement>>;
  /** objectId → the diagrams it's placed on */
  placedOn: Map<string, Set<string>>;
  children: Map<string, ModelObject[]>;
  flows: Map<string, Flow>;
  /** "diagramId|from>to" → the arrow's hand-made shape */
  arrows: Map<string, ArrowShape>;
  /** Notes and links, by id. */
  notes: Map<string, Note>;
  /** A note's replies, oldest first. */
  replies: Map<string, Reply[]>;
  /** Where things run: projects, networks (shared/boundaries.ts). */
  boundaries: Map<string, Boundary>;
  decisions: Map<string, Decision>;
  /** Shapes nodes point at: DTOs, interfaces, enums (shared/entities.ts). */
  entities: Map<string, Entity>;
}

export function buildIndex(m: {
  objects: Iterable<ModelObject>;
  connections: Iterable<Connection>;
  diagrams: Iterable<Diagram>;
  placements: Iterable<Placement>;
  flows?: Iterable<Flow>;
  arrows?: Iterable<ArrowShape>;
  notes?: Iterable<Note>;
  replies?: Iterable<Reply>;
  boundaries?: Iterable<Boundary>;
  decisions?: Iterable<Decision>;
  entities?: Iterable<Entity>;
}): ModelIndex {
  const idx: ModelIndex = {
    objects: new Map(),
    connections: new Map(),
    diagrams: new Map(),
    placements: new Map(),
    placedOn: new Map(),
    children: new Map(),
    flows: new Map(),
    arrows: new Map(),
    notes: new Map(),
    replies: new Map(),
    boundaries: new Map(),
    decisions: new Map(),
    entities: new Map(),
  };
  for (const e of m.entities ?? []) idx.entities.set(e.id, e);
  for (const b of m.boundaries ?? []) idx.boundaries.set(b.id, b);
  for (const d of m.decisions ?? []) idx.decisions.set(d.id, d);
  for (const n of m.notes ?? []) idx.notes.set(n.id, n);
  for (const r of m.replies ?? []) {
    if (!idx.notes.has(r.noteId)) continue;
    const list = idx.replies.get(r.noteId);
    if (list) list.push(r);
    else idx.replies.set(r.noteId, [r]);
  }
  for (const list of idx.replies.values())
    list.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  for (const a of m.arrows ?? []) idx.arrows.set(`${a.diagramId}|${a.from}>${a.to}`, a);
  for (const f of m.flows ?? []) idx.flows.set(f.id, f);
  for (const o of m.objects) idx.objects.set(o.id, o);
  for (const o of idx.objects.values()) {
    if (!o.parentId) continue;
    const list = idx.children.get(o.parentId);
    if (list) list.push(o);
    else idx.children.set(o.parentId, [o]);
  }
  // Skip references a concurrent edit left dangling; the server tidies them shortly.
  for (const c of m.connections) {
    if (idx.objects.has(c.fromId) && idx.objects.has(c.toId)) idx.connections.set(c.id, c);
  }
  for (const d of m.diagrams) idx.diagrams.set(d.id, d);
  for (const p of m.placements) {
    if (!idx.objects.has(p.objectId) || !idx.diagrams.has(p.diagramId)) continue;
    let byObject = idx.placements.get(p.diagramId);
    if (!byObject) idx.placements.set(p.diagramId, (byObject = new Map()));
    byObject.set(p.objectId, p);
    let on = idx.placedOn.get(p.objectId);
    if (!on) idx.placedOn.set(p.objectId, (on = new Set()));
    on.add(p.diagramId);
  }
  return idx;
}

/** Parent, grandparent, ... up to the top. */
export function ancestors(idx: ModelIndex, id: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([id]);
  let cur = idx.objects.get(id)?.parentId ?? null;
  while (cur && !seen.has(cur)) {
    out.push(cur);
    seen.add(cur);
    cur = idx.objects.get(cur)?.parentId ?? null;
  }
  return out;
}

export function isInside(idx: ModelIndex, id: string, ancestorId: string): boolean {
  return ancestors(idx, id).includes(ancestorId);
}

/** Every object inside `id`, at any depth. */
export function descendants(idx: ModelIndex, id: string): string[] {
  const out: string[] = [];
  const stack = [...(idx.children.get(id) ?? [])];
  while (stack.length) {
    const o = stack.pop() as ModelObject;
    out.push(o.id);
    stack.push(...(idx.children.get(o.id) ?? []));
  }
  return out;
}

export function diagramForScope(idx: ModelIndex, scopeId: string | null): Diagram | undefined {
  // At the top, the view called the landscape wins over side views like Deployment: dates
  // aren't kept in the files, so "the oldest" can be any of them after a load.
  const rank = (d: Diagram) =>
    scopeId === null && (d.key === "landscape" || d.name.toLowerCase() === "landscape") ? 0 : 1;
  let best: Diagram | undefined;
  for (const d of idx.diagrams.values()) {
    if (d.scopeId !== scopeId) continue;
    if (!best || rank(d) < rank(best) || (rank(d) === rank(best) && d.createdAt < best.createdAt))
      best = d;
  }
  return best;
}

/** The trail from the landscape down to a diagram's scope, for breadcrumbs. */
export function scopeTrail(
  idx: ModelIndex,
  diagramId: string,
): { objectId: string | null; name: string; diagramId?: string }[] {
  const d = idx.diagrams.get(diagramId);
  if (!d?.scopeId) return [];
  const chain = [d.scopeId, ...ancestors(idx, d.scopeId)].reverse();
  return chain.map((id) => ({
    objectId: id,
    name: idx.objects.get(id)?.name ?? "?",
    diagramId: diagramForScope(idx, id)?.id,
  }));
}

/** What a box spells out at its bottom right. Status shows as a tag; the model keeps it a field. */
function tagsOf(o: ModelObject): string[] {
  return [
    ...(o.status !== "live" ? [o.status] : []),
    ...(o.external ? ["external"] : []),
    ...o.tags,
  ];
}

function subtitleOf(o: ModelObject): string {
  const kind = o.external ? `External ${KIND_LABEL[o.kind].toLowerCase()}` : KIND_LABEL[o.kind];
  // A table says how many columns it has: "Table · 5 cols".
  const cols =
    o.kind === "table" && o.columns?.length
      ? ` · ${o.columns.length} col${o.columns.length === 1 ? "" : "s"}`
      : "";
  return o.technology ? `${kind} · ${o.technology}${cols}` : `${kind}${cols}`;
}

const GROUP_PAD = 32;
const GROUP_LABEL = 36;

/** A diagram shows removed things only when one of its rules asks for them by status. */
const showsRemoved = (idx: ModelIndex, diagramId: string): boolean =>
  !!idx.diagrams
    .get(diagramId)
    ?.rules?.include.some((s) => "status" in s && s.status === "removed");

export function projectDiagram(
  idx: ModelIndex,
  diagramId: string,
  opts: {
    frames?: boolean;
    removedToo?: boolean;
    /** Never folded: boxes someone just made here, so they don't vanish from where they put them. */ loose?: ReadonlySet<string>;
  } = {},
): CanvasGraph {
  // Removed things too: when the view asks for them, or a diff draws what main still has.
  const removedToo = opts.removedToo || showsRemoved(idx, diagramId);
  const all = idx.placements.get(diagramId) ?? new Map<string, Placement>();
  const placed = removedToo
    ? all
    : new Map([...all].filter(([id]) => idx.objects.get(id)?.status !== "removed"));
  const nodes: CanvasNode[] = [];
  for (const p of placed.values()) {
    const o = idx.objects.get(p.objectId);
    if (!o) continue;
    nodes.push({
      id: o.id,
      kind: o.kind,
      name: o.name,
      subtitle: subtitleOf(o),
      x: p.x,
      y: p.y,
      w: p.w,
      h: p.h,
      external: o.external,
      status: o.status,
      childCount: idx.children.get(o.id)?.length ?? 0,
      technology: o.technology,
      ...(o.icon ? { icon: o.icon } : {}),
      ...(o.kind === "table" && o.columns?.length ? { columns: canvasColumns(idx, o) } : {}),
      ...(o.guess ? { guess: true as const } : {}),
      hidden: 0,
      tags: tagsOf(o),
    });
  }
  // Two files of one name on a view (server/store.ts, src/store.ts): each says as much of its
  // folder as tells them apart (two store.ts read alike on a flow view).
  {
    const byName = new Map<string, CanvasNode[]>();
    for (const n of nodes)
      if (idx.objects.get(n.id)?.path)
        (byName.get(n.name) ?? byName.set(n.name, []).get(n.name)!).push(n);
    for (const same of byName.values()) {
      if (same.length < 2) continue;
      const parts = same.map((n) =>
        idx.objects
          .get(n.id)!
          .path!.replace(/^[^:]*:/, "")
          .split("/"),
      );
      for (let k = 2; k <= Math.max(...parts.map((p) => p.length)); k++) {
        const tails = parts.map((p) => p.slice(-k).join("/"));
        if (new Set(tails).size === tails.length || k === Math.max(...parts.map((p) => p.length))) {
          same.forEach((n, i) => {
            if (tails[i] !== n.name && tails[i]!.endsWith(n.name)) n.name = tails[i]!;
          });
          break;
        }
      }
    }
  }
  // Fold the externals (vendors, other companies' systems): on a landscape by default.
  // groups: one box per group: tag ("AWS", "Third-party services"), the ungrouped together;
  // externals: all in one box. A folded box takes its first member's place and id, so moving
  // it, tidying it and its arrows' shapes all work as for any box.
  const d = idx.diagrams.get(diagramId);
  const foldTo = new Map<string, string>();
  const unfoldedFrames: { key: string; name: string; members: string[] }[] = [];
  const mode = foldMode(d);
  if (mode !== "none") {
    // fold: groups set on the view folds our own grouped boxes too (a system's inside), but
    // never the group the view is about: that's what it's there to show.
    const ours = d?.fold === "groups";
    const about = new Set(
      (d?.rules?.include ?? []).flatMap((s) =>
        "tag" in s && s.tag.startsWith("group:") ? [s.tag.slice(6)] : [],
      ),
    );
    const groupOf = (n: CanvasNode) =>
      mode === "groups" ? (n.tags.find((t) => t.startsWith("group:"))?.slice(6) ?? "") : "";
    // With boundaries drawn, a box inside one never folds: its frame would lose it.
    const framed = (n: CanvasNode) => !!d?.boundaries && boundaryOf(idx, n.id) !== null;
    const foldable = nodes
      .filter(
        (n) =>
          n.kind !== "actor" &&
          !opts.loose?.has(n.id) &&
          !about.has(groupOf(n)) &&
          (n.external || (ours && groupOf(n))) &&
          !framed(n),
      )
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const buckets = new Map<string, CanvasNode[]>();
    for (const n of foldable) {
      const g = groupOf(n);
      buckets.set(g, [...(buckets.get(g) ?? []), n]);
    }
    // One bucket (no groups at all) folds from three, like before; a named group from two.
    const heads = new Map<string, CanvasNode>();
    const opened = new Set(d?.unfolded ?? []);
    for (const [g, members] of buckets) {
      if (members.length < (g ? 2 : buckets.size > 1 ? 2 : FOLD_MIN)) continue;
      // Unfolded here: each member drawn, with a frame around them that folds back.
      if (opened.has(g || UNGROUPED)) {
        unfoldedFrames.push({
          key: g || UNGROUPED,
          name: g ? groupLabel(g) : "Externals",
          members: members.map((n) => n.id),
        });
        continue;
      }
      const head = members[0]!;
      for (const n of members) foldTo.set(n.id, head.id);
      heads.set(head.id, {
        ...head,
        name: g
          ? `${groupLabel(g)} · ${members.length}`
          : buckets.size > 1
            ? `${members.length} other externals`
            : `${members.length} externals`,
        subtitle: members.map((n) => n.name).join(", "),
        technology: "",
        tags: [],
        // A group reads as a system of its own, not as its first member, and opens into its
        // own view: the badge says so.
        ...(g ? { kind: "system" as const } : {}),
        childCount: g ? members.length : 0,
        external: members.every((n) => n.external),
        status: "live",
        folded: members.map((n) => n.id),
        ...(g ? { group: g } : {}),
      });
    }
    if (heads.size)
      nodes.splice(
        0,
        nodes.length,
        ...nodes
          .filter((n) => !foldTo.has(n.id) || heads.has(n.id))
          .map((n) => heads.get(n.id) ?? n),
      );
  }
  // A box whose insides are on this diagram is a frame around them, not a box: a file around
  // its functions, a crate around its files, a group made from a selection around its parts.
  // Without frames (simple mode), a box stays a box and what's inside it isn't drawn here:
  // open the box to see it. The only frames are groups (boundaries).
  const containers = new Map<string, CanvasNode>();
  const inside = new Set<string>();
  {
    const onIt = new Set(nodes.map((n) => n.id));
    if (opts.frames === false) {
      // Code is the exception: a file (module) is still a frame around its functions.
      for (const n of nodes) {
        const placedAbove = ancestors(idx, n.id).filter((x) => onIt.has(x));
        if (placedAbove.some((a) => idx.objects.get(a)?.kind !== "module")) inside.add(n.id);
        else
          for (const a of placedAbove)
            containers.set(
              a,
              nodes.find((x) => x.id === a)!,
            );
      }
      for (const c of [...containers.keys()]) if (inside.has(c)) containers.delete(c);
      if (inside.size || containers.size)
        nodes.splice(
          0,
          nodes.length,
          ...nodes.filter((n) => !inside.has(n.id) && !containers.has(n.id)),
        );
    } else {
      // Lines of its own (a service's calls, made at the service) end on its frame.
      const frames = (a: string) => {
        const o = idx.objects.get(a);
        return !!o && o.kind !== "actor";
      };
      for (const n of nodes)
        for (const a of ancestors(idx, n.id))
          if (onIt.has(a) && frames(a))
            containers.set(
              a,
              nodes.find((x) => x.id === a)!,
            );
      if (containers.size)
        nodes.splice(0, nodes.length, ...nodes.filter((n) => !containers.has(n.id)));
    }
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // hide_lines: connections touching what these pick (or anything inside it) aren't drawn.
  // A kind ({kind: function}) means lines drawn to a box of that kind: calls between functions
  // rolled up into lines between their files stay (four views of files lost every
  // line). Other rules (ids, tags) take every line touching what they pick, drawn or inside.
  const kinds = new Set(
    (d?.hideLines ?? []).flatMap((s) =>
      "kind" in s && Object.keys(s).length === 1 ? [s.kind as string] : [],
    ),
  );
  const quiet = new Set(
    (d?.hideLines ?? [])
      .filter((s) => !("kind" in s && Object.keys(s).length === 1))
      .flatMap((s) => [...matchSelector(idx, s)]),
  );
  const silenced = (id: string) => {
    if (quiet.size > 0 && [id, ...ancestors(idx, id)].some((x) => quiet.has(x))) return true;
    if (!kinds.size) return false;
    const drawn = representative(id);
    return !!drawn && kinds.has(idx.objects.get(drawn)?.kind ?? "");
  };
  // A flow's steps run along lines: hide_lines never takes those (a flow of code
  // calls lost every line to {kind: function}). A step covers the calls between what it joins.
  const steps = (d?.hideLines?.length ? flowsOf(idx, diagramId).flatMap((f) => f.steps) : []).map(
    (s) => [s.fromId, s.toId] as const,
  );
  const stepLine = (c: Connection) =>
    steps.length > 0 &&
    steps.some(
      ([f, t]) =>
        [c.fromId, ...ancestors(idx, c.fromId)].includes(f) &&
        [c.toId, ...ancestors(idx, c.toId)].includes(t),
    );
  const noGuesses = (d?.hideLines ?? []).some((s) => "guess" in s);
  // {between: neighbours}: on a view of a box, only the lines that touch what's in it.
  const scoped =
    d?.scopeId && (d?.hideLines ?? []).some((s) => "between" in s)
      ? new Set([d.scopeId, ...descendants(idx, d.scopeId)])
      : null;

  // The scope's frame, when it's drawn (it has insides here): its own lines end on it.
  const scopeOf = idx.diagrams.get(diagramId)?.scopeId;
  const scopeFramed =
    !!scopeOf &&
    !byId.has(scopeOf) &&
    opts.frames !== false &&
    nodes.some((n) => isInside(idx, n.id, scopeOf));
  const rep = new Map<string, string | null>();
  const representative = (id: string): string | null => {
    const hit = rep.get(id);
    if (hit !== undefined) return hit;
    let found: string | null = null;
    for (const cur of [id, ...ancestors(idx, id)]) {
      // A frame holds the lines of its own box; something inside it that isn't drawn is off
      // the diagram (counted on the other end), not the frame's.
      if (containers.has(cur) || (scopeFramed && cur === scopeOf)) {
        if (cur === id) found = cur;
        break;
      }
      if (placed.has(cur) && !inside.has(cur)) {
        found = cur;
        break;
      }
    }
    if (found && foldTo.has(found)) found = foldTo.get(found)!;
    rep.set(id, found);
    return found;
  };

  // The diagram's scope and what's above it are the frame, not something missing from it.
  const frame = frameOf(idx, diagramId);
  const edges = new Map<string, CanvasEdge>();
  // A dependency graph (a view of libraries and what uses them: { uses: library } with the
  // libraries) draws only the lines to libraries. Libraries picked alongside other kinds of
  // code are just more boxes: every line between what's on it is drawn (s-chan round 7).
  const inc = idx.diagrams.get(diagramId)?.rules?.include ?? [];
  const depGraph =
    inc.some((r) => "uses" in r) &&
    inc.every((r) => "uses" in r || ("kind" in r && r.kind === "library"));
  for (const c of idx.connections.values()) {
    if (c.status === "removed" && !removedToo) continue;
    if (
      depGraph &&
      idx.objects.get(c.toId)?.kind !== "library" &&
      idx.objects.get(c.fromId)?.kind !== "library"
    )
      continue;
    if (!stepLine(c)) {
      if (silenced(c.fromId) || silenced(c.toId)) continue;
      if (noGuesses && c.guess) continue;
      if (scoped && !scoped.has(c.fromId) && !scoped.has(c.toId)) continue;
    }
    const a = representative(c.fromId);
    const b = representative(c.toId);
    // (A frame doesn't count what's off the diagram: its box, opened, shows that.)
    if (a && !b && !frame.has(c.toId) && byId.has(a)) byId.get(a)!.hidden++;
    if (b && !a && !frame.has(c.fromId) && byId.has(b)) byId.get(b)!.hidden++;
    if (!a || !b || a === b) continue;
    // A frame and what's inside it: the line would run from the frame's edge into itself.
    if (isInside(idx, a, b) || isInside(idx, b, a)) continue;
    const key = `${a}>${b}`;
    let e = edges.get(key);
    if (!e)
      edges.set(
        key,
        (e = { id: key, from: a, to: b, label: "", connectionIds: [], status: "live" }),
      );
    e.connectionIds.push(c.id);
  }
  // Lines both ways between the same two boxes are one line with a head at each end (two
  // lines side by side say nothing more, and every such pair is one more thing to route).
  // The one kept is the one somebody shaped, else the one with more on it.
  const twoWay = new Set<string>();
  for (const e of [...edges.values()]) {
    const back = edges.get(`${e.to}>${e.from}`);
    if (!back || !edges.has(e.id)) continue;
    const weight = (x: CanvasEdge) => {
      const sh = idx.arrows.get(`${diagramId}|${x.id}`);
      return (
        (sh?.split || sh?.join || sh?.bends?.length ? 1000 : sh ? 500 : 0) + x.connectionIds.length
      );
    };
    const [keep, drop] = weight(back) > weight(e) ? [back, e] : [e, back];
    keep.connectionIds.push(...drop.connectionIds);
    edges.delete(drop.id);
    twoWay.add(keep.id);
  }
  for (const e of edges.values()) {
    const shape = idx.arrows.get(`${diagramId}|${e.id}`);
    if (shape) e.shape = shape;
    const conns = e.connectionIds.map((id) => idx.connections.get(id) as Connection);
    const via =
      conns.length === 1 && conns[0]?.viaId ? idx.objects.get(conns[0].viaId)?.name : undefined;
    // A key between tables is named by its column when nothing else names it ("customer_id").
    e.label =
      conns.length === 1
        ? `${conns[0]?.name || conns[0]?.column || ""}${via ? `${conns[0]?.name ? " " : ""}(via ${via})` : ""}`
        : `${conns.length} connections`;
    if (conns.length > 1) {
      // Each with its real ends ("Search → Board database: reads"): they're often inside the boxes.
      const nm = (id: string) => idx.objects.get(id)?.name ?? id;
      e.merged = conns.map((c) => `${nm(c.fromId)} → ${nm(c.toId)}: ${c.name || "(no label)"}`);
      e.labels = [...new Set(conns.map((c) => c.name).filter(Boolean))];
      // A line drawn between the two boxes themselves says what the rest add up to: it's the
      // label, with how many more lie inside (an app-to-app line joined every child
      // call's label, with no way to give it one).
      const own = conns.filter(
        (c) =>
          c.name &&
          ((c.fromId === e.from && c.toId === e.to) || (c.fromId === e.to && c.toId === e.from)),
      );
      if (own.length === 1) {
        e.label = `${own[0]!.name} (+${conns.length - 1} inside)`;
        e.labels = [e.label];
      }
    }
    // Between two processes: the line says how it travels when nothing else names it.
    const proc = (id: string) => processOf(idx, id);
    const pa = proc(e.from);
    const pb = proc(e.to);
    if (pa && pb && pa !== pb) {
      e.hop = true;
      if (!e.label && conns.length === 1 && conns[0]?.technology) e.label = conns[0].technology;
    }
    // A key drawn between the two tables themselves: which rows its ends belong to.
    const key = conns.length === 1 ? conns[0] : undefined;
    if (key?.column && key.fromId === e.from && key.toId === e.to) {
      e.fromColumn = key.column;
      e.toColumn =
        key.toColumn || idx.objects.get(key.toId)?.columns?.find((c) => c.pk)?.name || "id";
    }
    // Between two regions: said on the line, whatever else it says.
    const across = conns
      .map((c) => crossesRegions(idx, c.fromId, c.toId))
      .filter((x): x is string => !!x);
    if (across.length === conns.length && across.length) {
      e.crosses = [...new Set(across)].join(", ");
      // A key's line stays its column (the colour says it crosses); a call says the regions.
      if (!conns.every((c) => c.column))
        e.label = e.label ? `${e.label} · ${e.crosses}` : e.crosses;
    }
    // Library lines, and calls only guessed by name, stay in the background, except on a
    // dependency graph, where library lines are the point.
    const toLib =
      idx.objects.get(e.from)?.kind === "library" || idx.objects.get(e.to)?.kind === "library";
    if ((toLib && !depGraph) || conns.every((c) => c.guess)) e.quiet = true;
    if (conns.every((c) => c.guess)) e.guess = true;
    if (twoWay.has(e.id) || conns.some((c) => c.both)) e.both = true;
    const isCode = (id: string) => ["function", "module"].includes(idx.objects.get(id)?.kind ?? "");
    if (conns.every((c) => isCode(c.fromId) && isCode(c.toId))) e.code = true;
    e.status = conns.every((c) => c.status === "future")
      ? "future"
      : conns.every((c) => c.status === "deprecated")
        ? "deprecated"
        : conns.every((c) => c.status === "removed")
          ? "removed"
          : "live";
  }

  const groups: CanvasGroup[] = [];
  const scopeId = idx.diagrams.get(diagramId)?.scopeId;
  const frames = containerFrames(idx, nodes, containers);
  // Boundaries, where the diagram asks for them: under the scope's frame, outermost first,
  // and around the file frames too.
  if (idx.diagrams.get(diagramId)?.boundaries)
    for (const f of boundaryFrames(idx, [...nodes, ...frames]))
      groups.push({
        id: `boundary:${f.id}`,
        name: f.name,
        boundary: f.kind,
        depth: f.depth,
        x: f.x,
        y: f.y,
        w: f.w,
        h: f.h,
      });

  // The scope's own frame, first (under everything): around its insides, and around the
  // file frames and boundaries drawn over them, so a process never pokes out of its app.
  if (scopeId && !byId.has(scopeId)) {
    const inside = nodes.filter((n) => isInside(idx, n.id, scopeId));
    if (inside.length) {
      const holds = (r: Rect) =>
        inside.some(
          (n) => n.x >= r.x && n.y >= r.y && n.x + n.w <= r.x + r.w && n.y + n.h <= r.y + r.h,
        );
      const rects: Rect[] = [
        ...inside,
        ...frames.filter((f) => isInside(idx, f.id, scopeId)),
        ...groups.filter((g) => g.boundary && holds(g)),
      ];
      const minX = Math.min(...rects.map((n) => n.x));
      const minY = Math.min(...rects.map((n) => n.y));
      const maxX = Math.max(...rects.map((n) => n.x + n.w));
      const maxY = Math.max(...rects.map((n) => n.y + n.h));
      groups.unshift({
        id: scopeId,
        name: idx.objects.get(scopeId)?.name ?? "",
        x: minX - GROUP_PAD,
        y: minY - GROUP_PAD - GROUP_LABEL,
        w: maxX - minX + GROUP_PAD * 2,
        h: maxY - minY + GROUP_PAD * 2 + GROUP_LABEL,
      });
    }
  }

  // Lanes: a frame per value of the tag group, around its boxes (tidy puts them in columns).
  if (d?.lanes) {
    const prefix = `${d.lanes}:`;
    const by = new Map<string, CanvasNode[]>();
    for (const n of nodes) {
      const v = idx.objects
        .get(n.id)
        ?.tags.find((t) => t.startsWith(prefix))
        ?.slice(prefix.length);
      if (v) by.set(v, [...(by.get(v) ?? []), n]);
    }
    // Over the scope's frame (or they'd be hidden under it), under the boundaries.
    let laneAt = groups.findIndex((g) => g.boundary);
    if (laneAt < 0) laneAt = groups.length;
    for (const [v, list] of by) {
      const minX = Math.min(...list.map((n) => n.x));
      const minY = Math.min(...list.map((n) => n.y));
      const maxX = Math.max(...list.map((n) => n.x + n.w));
      const maxY = Math.max(...list.map((n) => n.y + n.h));
      groups.splice(laneAt++, 0, {
        id: `lane:${v}`,
        name: v,
        lane: true,
        x: minX - LANE_PAD,
        y: minY - LANE_PAD - GROUP_LABEL,
        w: maxX - minX + LANE_PAD * 2,
        h: maxY - minY + LANE_PAD * 2 + GROUP_LABEL,
      });
    }
  }

  // Groups unfolded here: a frame around each one's boxes, selected like a boundary
  // ("boundary:fold:<group>"), so clicking it picks the group and it can fold back.
  for (const u of unfoldedFrames) {
    const list = nodes.filter((n) => u.members.includes(n.id));
    if (!list.length) continue;
    const minX = Math.min(...list.map((n) => n.x));
    const minY = Math.min(...list.map((n) => n.y));
    const maxX = Math.max(...list.map((n) => n.x + n.w));
    const maxY = Math.max(...list.map((n) => n.y + n.h));
    groups.push({
      id: `boundary:${FOLD_FRAME}${u.key}`,
      name: u.name,
      boundary: "group",
      depth: 0,
      x: minX - GROUP_PAD,
      y: minY - GROUP_PAD - GROUP_LABEL,
      w: maxX - minX + GROUP_PAD * 2,
      h: maxY - minY + GROUP_PAD * 2 + GROUP_LABEL,
    });
  }

  groups.push(...frames);
  markFans([...edges.values()]);
  return { nodes, edges: [...edges.values()], groups };
}

const FRAME_PAD = 12;
const FRAME_LABEL = 24;

/** The process a box runs in: the nearest boundary of kind process around it, if any. */
export function processOf(idx: ModelIndex, id: string): string | null {
  return (
    boundaryChain(idx, boundaryOf(idx, id)).find(
      (b) => idx.boundaries.get(b)?.kind === "process",
    ) ?? null
  );
}

/** Each container's frame around what's inside it on the diagram, outermost first. */
function containerFrames(
  idx: ModelIndex,
  nodes: CanvasNode[],
  containers: Map<string, CanvasNode>,
): CanvasGroup[] {
  if (!containers.size) return [];
  const nearest = (id: string) => ancestors(idx, id).find((a) => containers.has(a)) ?? null;
  const members = new Map<string, { x: number; y: number; w: number; h: number }[]>();
  const inner = new Map<string, string[]>();
  for (const n of nodes) {
    const c = nearest(n.id);
    if (c) members.set(c, [...(members.get(c) ?? []), n]);
  }
  for (const k of containers.keys()) {
    const c = nearest(k);
    if (c) inner.set(c, [...(inner.get(c) ?? []), k]);
  }
  const rect = new Map<string, { x: number; y: number; w: number; h: number } | null>();
  const frameOf = (
    k: string,
    seen: Set<string>,
  ): { x: number; y: number; w: number; h: number } | null => {
    if (rect.has(k)) return rect.get(k)!;
    if (seen.has(k)) return null;
    seen.add(k);
    const parts = [
      ...(members.get(k) ?? []),
      ...(inner.get(k) ?? []).flatMap((c) => frameOf(c, seen) ?? []),
    ];
    let r: { x: number; y: number; w: number; h: number } | null = null;
    if (parts.length) {
      const minX = Math.min(...parts.map((p) => p.x));
      const minY = Math.min(...parts.map((p) => p.y));
      const maxX = Math.max(...parts.map((p) => p.x + p.w));
      const maxY = Math.max(...parts.map((p) => p.y + p.h));
      r = {
        x: minX - FRAME_PAD,
        y: minY - FRAME_PAD - FRAME_LABEL,
        w: maxX - minX + FRAME_PAD * 2,
        h: maxY - minY + FRAME_PAD * 2 + FRAME_LABEL,
      };
    }
    rect.set(k, r);
    return r;
  };
  const depth = (k: string) => ancestors(idx, k).filter((a) => containers.has(a)).length;
  return [...containers.keys()]
    .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))
    .flatMap((k) => {
      const r = frameOf(k, new Set());
      const o = idx.objects.get(k);
      return r && o ? [{ id: k, name: o.name, container: o.kind, depth: depth(k), ...r }] : [];
    });
}

/** Fewer externals than this stay as they are. */
const FOLD_MIN = 3;

/** How a diagram folds: as set, else externals by group on a landscape, nothing inside. */
/** An unfolded group's frame is selected as the boundary "fold:<group>". */
export const FOLD_FRAME = "fold:";
/** The key of the externals with no group: tag, when they're unfolded. */
const UNGROUPED = "externals";

/** The group a folded box stands for: its group: value, or "externals". */
export const foldKey = (n: { group?: string }): string => n.group || UNGROUPED;

export function foldMode(
  d: { fold?: string | null; scopeId: string | null; boundaries?: boolean } | undefined,
): "groups" | "externals" | "none" {
  // A deployment view (boundaries drawn) is about where each thing runs: folding hides that.
  const f = d?.fold ?? (d?.scopeId || d?.boundaries ? "none" : "groups");
  return f === "externals" || f === "none" ? f : "groups";
}

/** A group tag's value as a name: "third-party-services" → "Third party services", "aws" → "AWS". */
export function groupLabel(v: string): string {
  if (/^[a-z]{2,4}$/.test(v)) return v.toUpperCase();
  const s = v.replace(/-s-/g, "'s ").replace(/-/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}
const LANE_PAD = 28;

/** The value of a lanes tag group an object has, or null. */
export const laneOf = (idx: ModelIndex, id: string, group: string): string | null =>
  idx.objects
    .get(id)
    ?.tags.find((t) => t.startsWith(`${group}:`))
    ?.slice(group.length + 1) ?? null;

export function flowsOf(idx: ModelIndex, diagramId: string): Flow[] {
  return [...idx.flows.values()]
    .filter((f) => f.diagramId === diagramId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** The nearest box on a diagram that stands for an object: itself or its closest placed ancestor. */
export function placedFor(idx: ModelIndex, diagramId: string, id: string): string | null {
  const placed = idx.placements.get(diagramId);
  if (!placed) return null;
  for (const cur of [id, ...ancestors(idx, id)]) if (placed.has(cur)) return cur;
  return null;
}

/**
 * What would show an object on a diagram: the highest ancestor-or-self that isn't the
 * diagram's scope or above it (a system on the landscape; an app inside the scope).
 */
function addableFor(idx: ModelIndex, diagramId: string, id: string): string {
  const scopeId = idx.diagrams.get(diagramId)?.scopeId ?? null;
  const line = new Set(scopeId ? [scopeId, ...ancestors(idx, scopeId)] : []);
  let best = id;
  for (const cur of ancestors(idx, id)) {
    if (line.has(cur)) break;
    best = cur;
  }
  return best;
}

export interface HiddenLink {
  connection: Connection;
  /** The end of the connection that is on the diagram (or inside a box that is). */
  near: string;
  /** The other end, which isn't. */
  far: string;
  /** The box to add to show it. */
  add: string;
  outgoing: boolean;
}

/** Connections of a box (and what's inside it) to things not on the diagram. */
export function hiddenLinks(idx: ModelIndex, diagramId: string, boxId: string): HiddenLink[] {
  const out: HiddenLink[] = [];
  const frame = frameOf(idx, diagramId);
  for (const c of idx.connections.values()) {
    const a = placedFor(idx, diagramId, c.fromId);
    const b = placedFor(idx, diagramId, c.toId);
    if (frame.has(c.fromId) || frame.has(c.toId)) continue;
    if (a === boxId && !b)
      out.push({
        connection: c,
        near: c.fromId,
        far: c.toId,
        add: addableFor(idx, diagramId, c.toId),
        outgoing: true,
      });
    if (b === boxId && !a)
      out.push({
        connection: c,
        near: c.toId,
        far: c.fromId,
        add: addableFor(idx, diagramId, c.fromId),
        outgoing: false,
      });
  }
  return out;
}

/** Objects with a tag, and the boxes on a diagram that stand for them. */
export function boxesWithTag(idx: ModelIndex, diagramId: string, tag: string): string[] {
  const out = new Set<string>();
  for (const o of idx.objects.values()) {
    if (!o.tags?.includes(tag)) continue;
    const box = placedFor(idx, diagramId, o.id);
    if (box) out.add(box);
  }
  return [...out];
}

export function allTags(idx: ModelIndex): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const o of idx.objects.values())
    for (const t of o.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => a.tag.localeCompare(b.tag));
}

/** A scoped diagram's scope and its ancestors: the frame the diagram is drawn inside. */
function frameOf(idx: ModelIndex, diagramId: string): Set<string> {
  const scopeId = idx.diagrams.get(diagramId)?.scopeId;
  return new Set(scopeId ? [scopeId, ...ancestors(idx, scopeId)] : []);
}

/** A note or link as drawn: where it is on the diagram right now (a pinned one follows its box). */
export interface PlacedNote {
  note: Note;
  x: number;
  y: number;
  replies: number;
}

/** The notes and links on one diagram, oldest first; resolved notes only if asked for. */
export function notesOn(
  idx: ModelIndex,
  diagramId: string,
  opts: { resolved?: boolean } = {},
): PlacedNote[] {
  const placed = idx.placements.get(diagramId);
  const out: PlacedNote[] = [];
  for (const n of idx.notes.values()) {
    if (n.diagramId !== diagramId || (n.resolved && !opts.resolved)) continue;
    const box = n.objectId ? placed?.get(n.objectId) : undefined;
    out.push({
      note: n,
      x: n.x + (box?.x ?? 0),
      y: n.y + (box?.y ?? 0),
      replies: idx.replies.get(n.id)?.length ?? 0,
    });
  }
  return out.sort((a, b) => a.note.createdAt.localeCompare(b.note.createdAt));
}

/** Colours for a group's values that archnm.yaml doesn't colour: distinct in both themes. */
const PALETTE = [
  "#5b8def",
  "#e0a03c",
  "#4fb286",
  "#d0679d",
  "#8f7ae5",
  "#3fb4c6",
  "#c9734e",
  "#9aa83d",
];
/** Boxes with no value in the group. */
export const NO_VALUE_COLOR = "#7a7f87";

/** A tag group value's colour: archnm.yaml's own, else the palette by its place in the group. */
export function tagColor(
  group: { values: string[]; colors?: Record<string, string> } | undefined,
  value: string,
): string {
  if (!group) return NO_VALUE_COLOR;
  const i = group.values.indexOf(value);
  return group.colors?.[value] ?? (i < 0 ? NO_VALUE_COLOR : PALETTE[i % PALETTE.length]!);
}

export interface LegendRow {
  value: string | null;
  color: string;
  count: number;
}

/**
 * A view's boxes coloured by one tag group (personal-data:holds → its colour), and the
 * legend for it. A box with no value in the group is grey. Unchanged without a group.
 */
export function colorGraph(
  graph: CanvasGraph,
  idx: ModelIndex,
  group: string | null | undefined,
  groups:
    | Record<string, { values: string[]; colors?: Record<string, string>; description?: string }>
    | undefined,
): { graph: CanvasGraph; legend: LegendRow[] } {
  const g = group ? groups?.[group] : undefined;
  if (!group || !g) return { graph, legend: [] };
  const colorOf = (v: string) => g.colors?.[v] ?? PALETTE[g.values.indexOf(v) % PALETTE.length]!;
  const counts = new Map<string | null, number>();
  const nodes = graph.nodes.map((n) => {
    const tag = idx.objects.get(n.id)?.tags.find((t) => t.startsWith(`${group}:`));
    const v =
      tag && g.values.includes(tag.slice(group.length + 1)) ? tag.slice(group.length + 1) : null;
    counts.set(v, (counts.get(v) ?? 0) + 1);
    return { ...n, color: v ? colorOf(v) : NO_VALUE_COLOR };
  });
  const legend: LegendRow[] = g.values
    .filter((v) => counts.has(v))
    .map((v) => ({ value: v, color: colorOf(v), count: counts.get(v)! }));
  if (counts.has(null))
    legend.push({ value: null, color: NO_VALUE_COLOR, count: counts.get(null)! });
  return { graph: { ...graph, nodes }, legend };
}

/** What a box's logo is looked up by: the one picked by hand, else its technology. "" for none. */
export function logoOf(n: { technology: string; icon?: string }): string {
  if (n.icon) return n.icon.trim().toLowerCase() === "none" ? "" : n.icon;
  return n.technology;
}

/**
 * What would help a view whose lines cross, from what it has now: lines between two
 * neighbours (on a view of a box), externals not yet folded, arrows not yet elbow. Never
 * advice it has already taken (tidy kept suggesting elbow on elbow views).
 */
// What tidy saw lanes do on each view: its crossings laid out without them, and whether a
// layout with lanes crossed more (lanes took one view from 19 to 25, and the advice
// kept coming). In memory, by view id: advice, not the model.
const lanesWorse = new Map<string, { without?: number; worse?: boolean }>();

/** A tidy's result, for crossingHelp to stop suggesting lanes where they made a view worse. */
export function noteLanes(diagramId: string, lanes: boolean, crossings: number): void {
  const m = lanesWorse.get(diagramId) ?? {};
  if (!lanes) m.without = crossings;
  else if (m.without !== undefined && crossings > m.without) m.worse = true;
  lanesWorse.set(diagramId, m);
}

export function crossingHelp(idx: ModelIndex, diagramId: string): string[] {
  const d = idx.diagrams.get(diagramId);
  if (!d) return [];
  const p = projectDiagram(idx, diagramId);
  const out: string[] = [];
  const key = d.key ?? d.id;
  if (d.scopeId && !(d.hideLines ?? []).some((s) => "between" in s)) {
    const mine = new Set([d.scopeId, ...descendants(idx, d.scopeId)]);
    const between = p.edges.filter((e) => !mine.has(e.from) && !mine.has(e.to)).length;
    if (between)
      out.push(
        `${between} of its lines run between two neighbours, not to ${idx.objects.get(d.scopeId)?.name ?? d.scopeId}: hide_lines: [{between: neighbours}] draws only the lines that touch it`,
      );
  }
  if (
    p.nodes.filter((n) => !n.folded && idx.objects.get(n.id)?.external).length >= 2 &&
    d.fold !== "externals"
  )
    out.push("fold: externals gathers its external boxes into one");
  if (d.arrows !== "elbow")
    out.push(`elbow arrows (views: {${key}: {arrows: elbow}}) route around boxes`);
  if (!d.lanes && !lanesWorse.get(diagramId)?.worse)
    out.push(
      `lanes put callers, doors and vendors in columns (write tags: {lane: {values: [callers, doors, domain, vendors]}}, tag each box lane:<value>, then views: {${key}: {lanes: lane}})`,
    );
  return out;
}
