// The model, shared by the server, the browser and the MCP. One set of objects and
// connections; diagrams are views of it (which objects, where). Every change is a batch
// of Ops, checked and applied to the live document in one go (shared/doc.ts).

import type { Rules, Selector } from "./views.ts";

/**
 * The architecture kinds, then the code kinds. module: a package, crate, folder or source
 * file. function: anything callable (a function, method, handler, job, script). library:
 * a third-party package the code uses. They're ordinary objects: any diagram can hold them.
 * table: a table, collection or dataset table, inside its store; its columns are a field on
 * it (one box per table, never one per column). A foreign key, or a pointer to a row in
 * another store or region, is a connection between tables that names its column.
 */
export const OBJECT_KINDS = [
  "actor",
  "system",
  "app",
  "store",
  "component",
  "module",
  "function",
  "library",
  "table",
] as const;
const CODE_KINDS = ["module", "function", "library"] as const;
export const isCodeKind = (k: string): boolean => (CODE_KINDS as readonly string[]).includes(k);

/** The package registries a library can come from (deps.dev's systems, and one for the rest). */
export const ECOSYSTEMS = [
  "cargo",
  "npm",
  "pypi",
  "go",
  "maven",
  "nuget",
  "rubygems",
  "other",
] as const;
export type Ecosystem = (typeof ECOSYSTEMS)[number];

/** Which package a library is: its registry, name there, and the version in use. */
export interface Package {
  ecosystem: Ecosystem;
  name: string;
  version?: string;
}

/** One column of a table: its name and type, and what it is. */
export interface Column {
  name: string;
  /** Its type as the database says it (uuid, text, timestamptz, vector(512)). */
  type: string;
  /** Part of the primary key. */
  pk?: boolean;
  unique?: boolean;
  nullable?: boolean;
  /** It holds data about a person: a pointer from it across regions is a residency problem. */
  personal?: boolean;
  /** A sentence about it, when the name doesn't say. */
  description?: string;
}

/** "repo:path/inside/it", a module's place in a repo: a slug, a colon, a relative path. */
export const CODE_PATH = /^[A-Za-z0-9._-]+:(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\s:\\]+$/;
export type ObjectKind = (typeof OBJECT_KINDS)[number];

/** live: running. future: decided, not built. deprecated: there, being retired. removed: gone (kept for history, drawn nowhere unless asked for). */
export const STATUSES = ["live", "future", "deprecated", "removed"] as const;
export type Status = (typeof STATUSES)[number];

export interface ModelObject {
  id: string;
  /** Readable, stable name in the files ("shop-api"); given once, never changes on rename. */
  key?: string;
  kind: ObjectKind;
  name: string;
  /** Its context, in markdown: what it does, why, and anything anyone wants to say about it.
   * Written to the files as `context` (older files' description and context read in here). */
  description: string;
  /** Older: detail kept apart from the description. New writes keep everything in description;
   * the files merge the two into one `context`. */
  context?: string;
  technology: string;
  /** The logo to show instead of the one guessed from technology: a technology, or "none". */
  icon?: string;
  /** A module's place in its repo ("s-chan:crates/board/src/main.rs"). It decides its file under code/. */
  path?: string;
  /** A library's package. */
  package?: Package;
  /** A function's inputs and what it returns: "(Cart, UserId) -> Order". Its types that are
   * entities are linked from it. */
  signature?: string;
  /** A table's columns, in order. */
  columns?: Column[];
  status: Status;
  /** The object it lives inside (an app inside a system, a component inside an app). */
  parentId: string | null;
  /** Someone else's system: drawn differently, never drilled into. */
  external: boolean;
  /** Free-form labels ("team:payments", "pci"); a tag lights up everything that has it. */
  tags: string[];
  /** Identifiers elsewhere, by system: { sys: "SYS-5", key: "P4" }. archnm.yaml can protect some. */
  refs?: Record<string, string>;
  /** Where the facts come from: "repo@sha:path:line" or an address. A drift job reads these. */
  sources?: string[];
  /** Docs about it (an RFC, a runbook, a dashboard): its link references. */
  links?: DocLink[];
  /** Its other references: an image, a markdown doc, a line of code, a dependency. */
  references?: Reference[];
  /** Its running doc, in markdown: what's still needed, open questions, a checklist. Not drawn. */
  notes?: string;
  /** Believed but not confirmed (an agent inferred it from the code, or a guess). Drawn fainter. */
  guess?: true;
  createdAt: string;
  updatedAt: string;
}

/**
 * What a node points at outside the model. A link is a DocLink (its own list, `links`); these
 * are the rest: an image (an http(s) address or a file in the design), a doc (a markdown file
 * in the design), code (repo:path#L12 or repo:path#function) or a dependency (a library
 * object's id: every node pointing at one is found from it) or an entity (an Entity's id: a
 * shape it uses, owns or implements; a function's signature makes these by itself).
 */
export const REFERENCE_KINDS = ["image", "doc", "code", "dependency", "entity"] as const;
export type ReferenceKind = (typeof REFERENCE_KINDS)[number];
export interface Reference {
  kind: ReferenceKind;
  to: string;
  title?: string;
}

/** A node's text, all of it: older files and agents kept a description and a context apart. */
export function mergedContext(description?: string, context?: string): string {
  return [description?.trim(), context?.replace(/\n$/, "").trim()].filter(Boolean).join("\n\n");
}

/** A document somewhere else: an http(s) address and what to call it. */
export interface DocLink {
  title: string;
  url: string;
}

export interface Connection {
  id: string;
  fromId: string;
  toId: string;
  name: string;
  description: string;
  /** For agents, in markdown: what travels over it (example requests and responses,
   * payload shapes, auth, errors, retries). Not drawn; show gives it in full. */
  context?: string;
  technology: string;
  status: Status;
  /** What the traffic passes through on the way (a load balancer, a gateway): an object id. */
  viaId?: string | null;
  sources?: string[];
  /** Believed but not confirmed (an importer matched a call by name, an agent inferred it). Drawn fainter. */
  guess?: true;
  /** It goes both ways (a socket, a sync): drawn with a head at each end. */
  both?: true;
  /** Between tables, a key: the column on the from table that holds it ("customer_id")… */
  column?: string;
  /** …and the column on the to table it points at (its primary key when left out). */
  toColumn?: string;
  /** Its running doc, in markdown, as a box has one: what's still needed, open questions. Not drawn. */
  notes?: string;
  /** Links, as a box has them. */
  links?: DocLink[];
  /** What it carries and points at, as a box has them: entities (what travels over it), docs, code, images. */
  references?: Reference[];
}

export const ARROW_STYLES = ["curved", "elbow", "straight"] as const;
/** Curved: our own curves between facing sides. Elbow and straight: routed around boxes by libavoid. */
export type ArrowStyle = (typeof ARROW_STYLES)[number];

/** Which way Lay out runs: callers left of what they call ("right") or above it ("down"). */
export const LAYOUT_DIRECTIONS = ["right", "down"] as const;
export type LayoutDirection = (typeof LAYOUT_DIRECTIONS)[number];

export interface Diagram {
  id: string;
  /** Its file name under views/ ("shop"); given once. */
  key?: string;
  name: string;
  /** The object whose inside this diagram shows; null for the top-level landscape. */
  scopeId: string | null;
  /** What belongs on it (shared/views.ts); absent for a hand-picked diagram. */
  rules?: Rules | null;
  /** How its arrows are drawn; absent means curved. Anyone can override it for themselves. */
  arrows?: ArrowStyle;
  /** Which way Tidy lays it out. Nothing moves on its own unless keepTidy is on too. */
  tidy?: LayoutDirection | null;
  /** Laid out again (the tidy way) whenever a box or arrow comes or goes. Off unless asked for. */
  keepTidy?: boolean;
  /** Draw boundaries (projects, networks…) around its boxes. Off unless asked for. */
  boundaries?: boolean;
  /** Colour boxes by this tag group (archnm.yaml tags:), with a legend. */
  colorBy?: string | null;
  /** How to read it, in markdown: shown as a caption on the diagram. */
  story?: string;
  /** For agents, in markdown: the brief behind it (goals, constraints, what's decided, what's
   * open, where the code is, what to do next). Not drawn; open and outline give it in full. */
  context?: string;
  /** Docs about the diagram as a whole; a box's own docs go on the box. */
  links?: DocLink[];
  /** Externals folded into one box: on by default for a landscape (no scope). */
  fold?: FoldMode | null;
  /** Folded groups opened on this view (Unfold here): each is drawn as a frame around its
   * members, which folds back. A group tag's value, or "externals" for those without one. */
  unfolded?: string[] | null;
  /** Connections touching what these pick aren't drawn here (the boxes still are). */
  hideLines?: Selector[] | null;
  /** Lay boxes out in columns by this tag group's values (tidy), framed. */
  lanes?: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Where things run, as opposed to what they're part of: a cloud project, a VPC and its
 * subnets, the network edge, a region, a trust zone. Separate from the logical tree
 * (`parentId`): app-service stays inside its system, and is also drawn inside "acme-prod ›
 * VPC" on the diagrams that show boundaries. Boundaries nest (parentId is another
 * boundary). Members are chosen by rules, like a view's, so new things fall in by tag.
 * A box inherits its ancestors' boundary unless it has its own. Not boxes: they never
 * change which boxes a diagram has, only the dashed frames drawn around them.
 */
export const FOLD_MODES = ["groups", "externals", "none"] as const;
export type FoldMode = (typeof FOLD_MODES)[number];

export const BOUNDARY_KINDS = [
  "cloud",
  "project",
  "host",
  "network",
  "subnet",
  "region",
  "edge",
  "trust",
  "process",
  "group",
] as const;
export type BoundaryKind = (typeof BOUNDARY_KINDS)[number];

export interface Boundary {
  id: string;
  /** Readable, stable name in the files ("prod-vpc"); given once. */
  key?: string;
  name: string;
  kind: BoundaryKind;
  description: string;
  /** The boundary it sits inside (a subnet in a network), or null. */
  parentId: string | null;
  /** Which objects are in it. */
  rules: Rules;
  createdAt: string;
  updatedAt: string;
}

/**
 * The shape of something that moves through a design or that code agrees on: a DTO (Order), an
 * interface (PaymentProvider), an enum (OrderStatus). In the files under `entities:` in the
 * file of the box that defines it, keyed by its name; nodes point at one by name. See docs/entities-plan.md.
 */
export interface Entity {
  id: string;
  /** Its id in the files: its name ("PaidOrder"). */
  key?: string;
  name: string;
  /** One line each, a table column's grammar: "id uuid", "items [OrderItem]", "note text?".
   * One with ( ) is a method ("charge(amount: money) -> Receipt"), which makes it an interface. */
  fields: string[];
  /** An enum: its values, instead of fields. */
  values?: string[];
  /** What it inherits (or, for an interface, implements): other entities' ids. */
  extends?: string[];
  /** The node it's defined in; null: the design's own (made by typing a type before anything owned it). */
  sourceId: string | null;
  /** What it is, in markdown. */
  description: string;
  createdAt: string;
  updatedAt: string;
}

/** An id or key (objects, views, boundaries, decisions): it may become a file name, so letters,
 * digits, - _ . only, as the files and the live document both take it. */
export const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** An entity's name, which is its key in the files: a type name as code writes it. */
export const TYPE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,99}$/;
export const TYPE_NAME_RULE =
  "an entity's name is a type name as code writes it: a letter, then letters, digits and _ (PaidOrder, order_line)";

/** A name made into a type name, for entities named before names were checked: "Paid Order" → PaidOrder, "order-status" → OrderStatus. */
export function typeName(raw: string): string {
  if (TYPE_NAME.test(raw)) return raw;
  const words = raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const name = words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join("");
  return (/^[A-Za-z]/.test(name) ? name : `T${name}`).slice(0, 100);
}

/** Just a name so far: drawn dashed, "TBD", until it gets a field or a value. */
export const isTbd = (e: Pick<Entity, "fields" | "values">): boolean =>
  !e.fields.length && !e.values?.length;

/**
 * An architecture decision: what was decided, why, and which things it changes. In the
 * files as decisions/<key>.yaml, so a pull request can carry the decision with the change.
 */
export const DECISION_STATUSES = ["proposed", "accepted", "rejected", "superseded"] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

export interface Decision {
  /** Its file name under decisions/ ("0001-hs-grants-config"); given once. */
  id: string;
  title: string;
  status: DecisionStatus;
  /** When it was decided (YYYY-MM-DD), if it has been. */
  date?: string;
  /** The objects it changes. */
  affects: string[];
  /** The record itself, in markdown: context, decision, consequences. */
  text: string;
  /** The decision that replaces this one. */
  supersededBy?: string;
  createdAt: string;
  updatedAt: string;
}

/** Where one object sits on one diagram. */
export interface Placement {
  diagramId: string;
  objectId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Where its layer nodes (references, entities) sit, from its top-left corner, when they've
   * been dragged there. Left out, they find room by themselves. */
  parts?: { x: number; y: number };
}

/** One step of a flow: something going from one object to another, in words. */
export interface FlowStep {
  id: string;
  fromId: string;
  toId: string;
  text: string;
}

/**
 * story: told step by step, with a panel ("a customer places an order").
 * path: a route through the graph, lit all at once (a request through the code).
 */
export const FLOW_KINDS = ["story", "path"] as const;
export type FlowKind = (typeof FLOW_KINDS)[number];

/** A story told over one diagram, step by step, or a path lit through it. */
export interface Flow {
  id: string;
  diagramId: string;
  name: string;
  /** Left out for a story. */
  kind?: FlowKind;
  steps: FlowStep[];
  createdAt: string;
  updatedAt: string;
}

/** The four sides of a box an arrow can leave or arrive at. */
export const SIDES = ["top", "right", "bottom", "left"] as const;
export type BoxSide = (typeof SIDES)[number];

/**
 * An arrow on one diagram, shaped by hand. Arrows are drawn per pair of boxes (from → to,
 * however many connections that stands for), so that's what a shape is for. Everything is
 * optional: what's left out is worked out as usual.
 */
export interface ArrowShape {
  diagramId: string;
  from: string;
  to: string;
  /** The side it leaves `from` by, and arrives at `to` on. */
  fromSide?: BoxSide;
  toSide?: BoxSide;
  /** Where along that side each end sits, when it was put there by hand: 0 at the side's start
   * (its left, or its top), 1 at its end. Left out, the ends on a side share it out between them. */
  fromAt?: number;
  toAt?: number;
  /** A split point on the diagram: the arrows from the same box with the same one leave as one
   * line to it, then each goes on to its own box (a bus, a fan-out). */
  split?: { x: number; y: number };
  /** A join point, the other way round: the arrows into the same box with the same one meet
   * there and go on into the box as one line. */
  join?: { x: number; y: number };
  /** Points it goes through, in order, on the diagram. */
  bends?: { x: number; y: number }[];
  /** Where its label sits: 0 at the start, 1 at the end. */
  label?: number;
  /** Where what its connections carry (its layer nodes) was dragged to, from its label's corner. */
  parts?: { x: number; y: number };
}

/** Who wrote a note or a reply. */
export interface Author {
  id: string;
  name: string;
  kind: "human" | "agent" | "system";
}

/**
 * Notes and links sit on one diagram, on top of the boxes: a note is a comment thread (a
 * pin, like Figma's), a link points somewhere else (an RFC in Notion, a runbook). Pinned
 * to a box, x and y are from the box's top-left and it moves with the box; otherwise
 * they're on the diagram. Not part of the architecture, so not in the files (yet).
 */
export const NOTE_KINDS = ["note", "link"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

export interface Note {
  id: string;
  diagramId: string;
  kind: NoteKind;
  /** The box it's pinned to, or null. */
  objectId: string | null;
  /** The connection it's pinned to (on its arrow here), instead of a box; x, y are then from the arrow's middle. */
  connectionId?: string;
  x: number;
  y: number;
  /** A note's first message; a link's title. */
  text: string;
  /** A link's address (http or https). */
  url?: string;
  /** What it's about, when that's inside the box it's pinned to (a function in a file). */
  about?: string;
  /** Left for agents to act on (a flag: something missing or wrong in the model). */
  forAgent?: boolean;
  author: Author;
  resolved: boolean;
  createdAt: string;
  updatedAt: string;
}

/** An answer in a note's thread. Its own record, so two people replying at once both land. */
export interface Reply {
  id: string;
  noteId: string;
  text: string;
  author: Author;
  at: string;
}

export const NOTE_MAX = 5000;
/** A link card's size on the diagram. */
export const LINK_W = 208;
export const LINK_H = 48;

export type Op =
  | { op: "object.put"; object: ModelObject }
  | { op: "object.delete"; id: string }
  | { op: "connection.put"; connection: Connection }
  | { op: "connection.delete"; id: string }
  | { op: "diagram.put"; diagram: Diagram }
  | { op: "diagram.delete"; id: string }
  | { op: "placement.put"; placement: Placement }
  | { op: "placement.delete"; diagramId: string; objectId: string }
  | { op: "boundary.put"; boundary: Boundary }
  | { op: "boundary.delete"; id: string }
  | { op: "decision.put"; decision: Decision }
  | { op: "decision.delete"; id: string }
  | { op: "entity.put"; entity: Entity }
  | { op: "entity.delete"; id: string }
  | { op: "flow.put"; flow: Flow }
  | { op: "flow.delete"; id: string }
  | { op: "arrow.put"; arrow: ArrowShape }
  | { op: "arrow.delete"; diagramId: string; from: string; to: string }
  | { op: "note.put"; note: Note }
  | { op: "note.delete"; id: string }
  | { op: "reply.put"; reply: Reply }
  | { op: "reply.delete"; id: string }
  /** A tag group in archnm.yaml (tags:), its values allowed after "name:". */
  | { op: "taggroup.put"; name: string; group: TagGroupDef }
  | { op: "taggroup.delete"; name: string };

/** A tag group as archnm.yaml holds it. */
export interface TagGroupDef {
  description?: string;
  values: string[];
  colors?: Record<string, string>;
}

/**
 * Ops on notes, links and replies only. They're about the diagram, not in its files, so on
 * a design that follows git they go straight onto main instead of opening a fork.
 */
/**
 * Is this op only about a comment thread (a note or a reply)? Threads live in Archnemesis's
 * database, not the files, so they're the one edit allowed on the main of a design that
 * follows git. Links are in the files (views/<view>.yaml), so they go through a fork.
 */
export const isThreadOp = (op: Op, notes: ReadonlyMap<string, Note>): boolean =>
  op.op === "reply.put" ||
  op.op === "reply.delete" ||
  (op.op === "note.put" && op.note.kind === "note") ||
  (op.op === "note.delete" && notes.get(op.id)?.kind !== "link");

export const CARD_W = 184;
export const CARD_H = 72;
/** A function is a slim box: there are many of them, and they sit inside their file's frame. */
export const FN_H = 40;
/** A new box's size, by kind. */
export const boxSize = (kind: ObjectKind): { w: number; h: number } =>
  kind === "function" ? { w: CARD_W, h: FN_H } : { w: CARD_W, h: CARD_H };

export const KIND_LABEL: Record<ObjectKind, string> = {
  actor: "Actor",
  system: "System",
  app: "App",
  // A store in the files (kind: store); to people, anything ready-made you run on: a database,
  // a queue, a bucket, a cluster.
  store: "Service",
  component: "Component",
  module: "Module",
  function: "Function",
  library: "Library",
  table: "Table",
};

export function newId(prefix: string): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function now(): string {
  return new Date().toISOString();
}

export function makeObject(
  fields: Partial<ModelObject> & Pick<ModelObject, "kind" | "name">,
): ModelObject {
  const t = now();
  return {
    id: newId("o"),
    description: "",
    technology: "",
    status: "live",
    parentId: null,
    external: false,
    tags: [],
    createdAt: t,
    updatedAt: t,
    ...fields,
  };
}

export function makeConnection(
  fields: Partial<Connection> & Pick<Connection, "fromId" | "toId">,
): Connection {
  return { id: newId("c"), name: "", description: "", technology: "", status: "live", ...fields };
}

export function makeDiagram(fields: Partial<Diagram> & Pick<Diagram, "name">): Diagram {
  const t = now();
  return { id: newId("d"), scopeId: null, createdAt: t, updatedAt: t, ...fields };
}

export function makeBoundary(
  fields: Partial<Boundary> & Pick<Boundary, "name" | "kind">,
): Boundary {
  const t = now();
  return {
    id: newId("b"),
    description: "",
    parentId: null,
    rules: { include: [], exclude: [] },
    createdAt: t,
    updatedAt: t,
    ...fields,
  };
}

export function makeFlow(fields: Partial<Flow> & Pick<Flow, "diagramId" | "name">): Flow {
  const t = now();
  return { id: newId("f"), steps: [], createdAt: t, updatedAt: t, ...fields };
}

export function makeNote(
  fields: Partial<Note> & Pick<Note, "diagramId" | "kind" | "author" | "text">,
): Note {
  const t = now();
  return {
    id: newId("n"),
    objectId: null,
    x: 0,
    y: 0,
    resolved: false,
    createdAt: t,
    updatedAt: t,
    ...fields,
  };
}

export function makeReply(fields: Pick<Reply, "noteId" | "text" | "author">): Reply {
  return { id: newId("r"), at: now(), ...fields };
}

/** A link's address, if it's one we'll open: http(s) only, nothing else (no javascript:). */
export function safeUrl(url: unknown): string | null {
  if (typeof url !== "string" || url.length > 2000) return null;
  try {
    const u = new URL(url.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

export function makeStep(fields: Partial<FlowStep> & Pick<FlowStep, "fromId" | "toId">): FlowStep {
  return { id: newId("s"), text: "", ...fields };
}

/** Tags as typed: trimmed, lower-cased, no blanks or repeats. */
export function cleanTags(tags: string[]): string[] {
  return [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))].sort();
}

/** "Shop API" -> "shop-api". */
/** A new decision's id: numbered in order, like ADRs (0003-short-title). */
export function nextDecisionId(existing: Iterable<{ id: string }>, title: string): string {
  const n = Math.max(0, ...[...existing].map((x) => Number(/^(\d+)-/.exec(x.id)?.[1] ?? 0))) + 1;
  return `${String(n).padStart(4, "0")}-${slug(title).slice(0, 48)}`;
}

export function slug(name: string): string {
  return (
    name
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "x"
  );
}

/** A name nobody has chosen yet ("New app"): too early to give it a key. */
export const isPlaceholderName = (name: string): boolean =>
  new RegExp(`^New (${OBJECT_KINDS.join("|")})$`).test(name);
