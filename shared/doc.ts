// The live model is a Yjs document, shared by every open tab, the server and the agents.
//
// Layout of the document (one top-level Y.Map per kind of record):
//   objects      id -> Y.Map of fields      (field-level merge: two people editing the
//   connections  id -> Y.Map of fields       name and the description of one box both win)
//   diagrams     id -> Y.Map of fields
//   flows        id -> Y.Map of fields
//   boundaries   id -> Y.Map of fields      where things run (projects, networks): frames
//   entities     id -> Y.Map of fields      shapes (DTOs, interfaces, enums) nodes point at
//   placements   "diagramId|objectId" -> { diagramId, objectId, x, y, w, h }  (one value)
//   arrows       "diagramId|from>to" -> ArrowShape: an arrow shaped by hand (one value)
//   notes        id -> Y.Map of fields      notes (comment threads) and links on a diagram
//   replies      id -> Y.Map of fields      answers in a note's thread, one record each
//   log          Y.Array of { actor, label, at, ids }: who changed what, newest last
//
// Every edit is still a batch of Ops (shared/model.ts). applyOps() checks the whole batch
// against the current state first, expands cascades (deleting a box deletes its arrows,
// its inside, its placements), and only then writes, in one transaction tagged with the
// editor. A rejected batch changes nothing.
//
// Concurrent edits can still leave a dangling reference (one person deletes a box while
// another draws an arrow to it). Readers skip those, and danglingOps() lists the deletes
// that tidy them; the server runs it after edits settle.
import * as Y from "yjs";
import {
  ARROW_STYLES,
  type FlowStep,
  LAYOUT_DIRECTIONS,
  NOTE_KINDS,
  NOTE_MAX,
  OBJECT_KINDS,
  CODE_PATH,
  ECOSYSTEMS,
  FLOW_KINDS,
  type Package,
  safeUrl,
  type Author,
  BOUNDARY_KINDS,
  FOLD_MODES,
  type Boundary,
  type Decision,
  type Entity,
  type DocLink,
  REFERENCE_KINDS,
  type Reference,
  DECISION_STATUSES,
  type Note,
  type Reply,
  SIDES,
  type ArrowShape,
  STATUSES,
  type Connection,
  type Diagram,
  type Flow,
  type ModelObject,
  type Op,
  type Placement,
  SAFE_KEY,
  TYPE_NAME,
  TYPE_NAME_RULE,
  typeName,
} from "./model.ts";
import { buildIndex } from "./project.ts";
import { pinEdits, selectorError } from "./views.ts";

export class ModelError extends Error {}

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new ModelError(message);
}

/** Who made a change: a person or an agent. Stamped on every log entry. */
export interface Actor {
  id: string;
  name: string;
  kind: "human" | "agent" | "system";
  /** An agent's MCP session (short id, "s-1a2b"), when one agent identity runs several: who did what. */
  session?: string;
}

export interface LogEntry {
  actor: Actor;
  label: string;
  at: string;
  /** Ids of the records the batch touched (objects, connections, diagrams, flows). */
  ids: string[];
}

export const pkey = (diagramId: string, objectId: string): string => `${diagramId}|${objectId}`;
export const akey = (diagramId: string, from: string, to: string): string =>
  `${diagramId}|${from}>${to}`;

/** Plain copies of every record, kept current from the document. */
export interface ModelState {
  objects: Map<string, ModelObject>;
  connections: Map<string, Connection>;
  diagrams: Map<string, Diagram>;
  placements: Map<string, Placement>;
  flows: Map<string, Flow>;
  arrows: Map<string, ArrowShape>;
  notes: Map<string, Note>;
  replies: Map<string, Reply>;
  boundaries: Map<string, Boundary>;
  decisions: Map<string, Decision>;
  entities: Map<string, Entity>;
}

type Table = keyof ModelState;
const TABLES: Table[] = [
  "objects",
  "connections",
  "diagrams",
  "placements",
  "flows",
  "arrows",
  "notes",
  "replies",
  "boundaries",
  "decisions",
  "entities",
];

export const tables = (doc: Y.Doc): Record<Table, Y.Map<unknown>> => ({
  objects: doc.getMap("objects"),
  connections: doc.getMap("connections"),
  diagrams: doc.getMap("diagrams"),
  placements: doc.getMap("placements"),
  flows: doc.getMap("flows"),
  arrows: doc.getMap("arrows"),
  notes: doc.getMap("notes"),
  replies: doc.getMap("replies"),
  boundaries: doc.getMap("boundaries"),
  decisions: doc.getMap("decisions"),
  entities: doc.getMap("entities"),
});

export const logOf = (doc: Y.Doc): Y.Array<LogEntry> => doc.getArray<LogEntry>("log");

const LOG_KEEP = 1000;

function readValue(v: unknown): unknown {
  return v instanceof Y.Map ? v.toJSON() : v;
}

const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
/** A string of at most `max` characters. */
const text = (v: unknown, max: number) => typeof v === "string" && v.length <= max;
/** Absent, or a string of at most `max` characters. */
const optText = (v: unknown, max: number) => v === undefined || v === null || text(v, max);
const optIn = (v: unknown, list: readonly unknown[]) =>
  v === undefined || v === null || list.includes(v);
/** A module's repo:path: a slug, a colon, a relative path that never climbs out with "..". */
const pathOk = (v: unknown) =>
  v === undefined || (typeof v === "string" && v.length <= 500 && CODE_PATH.test(v));
/** What can say where its code lives (path: repo:path): a module (the code itself), and an app or component (its code root). */
export const PATH_KINDS: readonly string[] = ["module", "app", "component"];

/** A library's package: a known registry, a name there, maybe a version. */
const packageOk = (v: unknown) => {
  if (v === undefined) return true;
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const p = v as Partial<Package>;
  return (
    ECOSYSTEMS.includes(p.ecosystem as never) &&
    text(p.name, 200) &&
    optText(p.version, 100) &&
    Object.keys(p).every((k) => k === "ecosystem" || k === "name" || k === "version")
  );
};
/** A table's columns: each a name and a type, flags true or left out. */
const columnsOk = (v: unknown) =>
  v === undefined ||
  (Array.isArray(v) &&
    v.length <= 500 &&
    v.every((c) => {
      if (!c || typeof c !== "object" || Array.isArray(c)) return false;
      const r = c as Record<string, unknown>;
      return (
        text(r.name, 200) &&
        (r.name as string).length > 0 &&
        optText(r.type, 200) &&
        optText(r.description, 2000) &&
        ["pk", "unique", "nullable", "personal"].every(
          (k) => r[k] === undefined || typeof r[k] === "boolean",
        ) &&
        Object.keys(r).every((k) =>
          ["name", "type", "pk", "unique", "nullable", "personal", "description"].includes(k),
        )
      );
    }));
/** An id or key that may become a file name: letters, digits, - _ . only. */
const safeKey = (v: unknown) => typeof v === "string" && SAFE_KEY.test(v);
const optKey = (v: unknown) => v === undefined || safeKey(v);
const ref = (v: unknown) => text(v, 200) && (v as string).length > 0;
const optRef = (v: unknown) => v === undefined || v === null || ref(v);

/**
 * Can this entry be trusted at all? A document holds whatever any client sent over the
 * socket, which skips the checks ops get (plan()), so every entry is checked field by
 * field as it's read, here and in every browser, and a malformed one is ignored. This is
 * what stops a key like "../../x" from ever reaching a file name, or a javascript: link
 * from reaching the page. `key` is the entry's key in its table, which must match its id.
 */
function wellFormed(table: Table, r: Record<string, unknown>, key?: string): boolean {
  const idOk = (id: unknown) => key === undefined || id === key;
  switch (table) {
    case "objects":
      return (
        safeKey(r.id) &&
        idOk(r.id) &&
        optKey(r.key) &&
        OBJECT_KINDS.includes(r.kind as never) &&
        text(r.name, 200) &&
        optIn(r.status, STATUSES) &&
        optRef(r.parentId) &&
        optText(r.description, 20_000) &&
        optText(r.context, 50_000) &&
        optText(r.technology, 200) &&
        optText(r.icon, 60) &&
        pathOk(r.path) &&
        packageOk(r.package) &&
        optText(r.signature, 500) &&
        columnsOk(r.columns) &&
        (r.external === undefined || typeof r.external === "boolean") &&
        (r.tags === undefined ||
          (Array.isArray(r.tags) && r.tags.length <= 50 && r.tags.every((t) => text(t, 64)))) &&
        refsOk(r.refs) &&
        sourcesOk(r.sources) &&
        linksOk(r.links) &&
        referencesOk(r.references) &&
        notesOk(r.notes) &&
        (r.guess === undefined || r.guess === true)
      );
    case "connections":
      return (
        ref(r.id) &&
        idOk(r.id) &&
        ref(r.fromId) &&
        ref(r.toId) &&
        optText(r.name, 200) &&
        optText(r.description, 20_000) &&
        optText(r.context, 50_000) &&
        optText(r.technology, 200) &&
        optIn(r.status, STATUSES) &&
        optRef(r.viaId) &&
        sourcesOk(r.sources) &&
        (r.guess === undefined || r.guess === true) &&
        (r.both === undefined || r.both === true) &&
        optText(r.column, 200) &&
        optText(r.toColumn, 200) &&
        linksOk(r.links) &&
        referencesOk(r.references)
      );
    case "decisions":
      return (
        safeKey(r.id) &&
        idOk(r.id) &&
        text(r.title, 200) &&
        DECISION_STATUSES.includes(r.status as never) &&
        (r.date === undefined || (typeof r.date === "string" && DATE.test(r.date))) &&
        Array.isArray(r.affects) &&
        r.affects.length <= 200 &&
        r.affects.every(ref) &&
        optText(r.text, 100_000) &&
        optKey(r.supersededBy)
      );
    case "entities":
      return (
        safeKey(r.id) &&
        idOk(r.id) &&
        optKey(r.key) &&
        text(r.name, 200) &&
        lines(r.fields, 300) &&
        (r.values === undefined || r.values === null || lines(r.values, 300)) &&
        (r.extends === undefined ||
          r.extends === null ||
          (Array.isArray(r.extends) && r.extends.length <= 20 && r.extends.every(ref))) &&
        optRef(r.sourceId) &&
        optText(r.description, 20_000)
      );
    case "diagrams":
      return (
        safeKey(r.id) &&
        idOk(r.id) &&
        optKey(r.key) &&
        text(r.name, 200) &&
        optRef(r.scopeId) &&
        optIn(r.arrows, ARROW_STYLES) &&
        optIn(r.tidy, LAYOUT_DIRECTIONS) &&
        (r.boundaries === undefined || typeof r.boundaries === "boolean") &&
        optText(r.colorBy, 64) &&
        (r.rules === undefined || r.rules === null || rulesOk(r.rules)) &&
        optText(r.story, 20_000) &&
        optText(r.context, 50_000) &&
        linksOk(r.links) &&
        optIn(r.fold, FOLD_MODES) &&
        optText(r.lanes, 64) &&
        (r.hideLines === undefined ||
          r.hideLines === null ||
          (Array.isArray(r.hideLines) &&
            r.hideLines.length <= 50 &&
            rulesOk({ include: r.hideLines, exclude: [] })))
      );
    case "boundaries":
      return (
        safeKey(r.id) &&
        idOk(r.id) &&
        optKey(r.key) &&
        BOUNDARY_KINDS.includes(r.kind as never) &&
        text(r.name, 200) &&
        optRef(r.parentId) &&
        optText(r.description, 20_000) &&
        (r.rules === undefined || r.rules === null || rulesOk(r.rules))
      );
    case "flows":
      return (
        ref(r.id) &&
        idOk(r.id) &&
        text(r.name, 200) &&
        ref(r.diagramId) &&
        optIn(r.kind, FLOW_KINDS) &&
        (r.steps === undefined ||
          (Array.isArray(r.steps) &&
            r.steps.length <= 500 &&
            r.steps.every(
              (st) =>
                !!st &&
                typeof st === "object" &&
                ref((st as FlowStep).fromId) &&
                ref((st as FlowStep).toId) &&
                optText((st as FlowStep).text, 2000),
            )))
      );
    case "placements":
      return (
        ref(r.diagramId) &&
        ref(r.objectId) &&
        (key === undefined || key === pkey(r.diagramId as string, r.objectId as string)) &&
        num(r.x) &&
        num(r.y) &&
        num(r.w) &&
        num(r.h) &&
        (r.w as number) > 0 &&
        (r.h as number) > 0 &&
        (r.parts === undefined ||
          (!!r.parts &&
            typeof r.parts === "object" &&
            num((r.parts as { x: unknown }).x) &&
            num((r.parts as { y: unknown }).y)))
      );
    case "arrows":
      return (
        ref(r.diagramId) &&
        ref(r.from) &&
        ref(r.to) &&
        (key === undefined || key === akey(r.diagramId as string, r.from as string, r.to as string))
      );
    case "notes":
      return (
        ref(r.id) &&
        idOk(r.id) &&
        ref(r.diagramId) &&
        NOTE_KINDS.includes(r.kind as never) &&
        optRef(r.objectId) &&
        optRef(r.about) &&
        (r.forAgent === undefined || typeof r.forAgent === "boolean") &&
        num(r.x) &&
        num(r.y) &&
        text(r.text, NOTE_MAX) &&
        authorOk(r.author) &&
        // A link opens in the browser: http(s) only, exactly as safeUrl writes it.
        (r.kind !== "link" ||
          (typeof r.url === "string" && safeUrl(r.url) === r.url && text(r.text, 200)))
      );
    case "replies":
      return (
        ref(r.id) && idOk(r.id) && ref(r.noteId) && text(r.text, NOTE_MAX) && authorOk(r.author)
      );
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Identifiers elsewhere: a few short name → value pairs. */
function refsOk(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v !== "object" || Array.isArray(v)) return false;
  const e = Object.entries(v as Record<string, unknown>);
  return e.length <= 20 && e.every(([k, x]) => /^[a-z][a-z0-9_-]{0,31}$/.test(k) && text(x, 200));
}

/** Docs on a box or diagram: http(s) only, exactly as safeUrl writes it, one per address. */
const linksOk = (v: unknown) =>
  v === undefined ||
  v === null ||
  (Array.isArray(v) &&
    v.length <= 50 &&
    v.every(
      (l) =>
        !!l &&
        typeof l === "object" &&
        typeof l.url === "string" &&
        safeUrl(l.url) === l.url &&
        text(l.title, 200),
    ) &&
    new Set(v.map((l) => (l as DocLink).url)).size === v.length);
const LINKS_RULE = "links: up to 50, each a title and an http(s) address, no address twice";

/** References: an image is an http(s) address or a path in the design, a doc a path in it. */
const referencesOk = (v: unknown) =>
  v === undefined ||
  v === null ||
  (Array.isArray(v) &&
    v.length <= 100 &&
    v.every((r) => {
      const x = r as Reference;
      if (
        !x ||
        typeof x !== "object" ||
        !(REFERENCE_KINDS as readonly string[]).includes(x.kind) ||
        !text(x.to, 500) ||
        !optText(x.title, 200)
      )
        return false;
      if (x.kind === "image" && /^[a-z]+:/i.test(x.to)) return safeUrl(x.to) === x.to;
      if (x.kind === "image" || x.kind === "doc")
        return !x.to.startsWith("/") && !x.to.split("/").includes("..");
      return true;
    }));
const REFERENCES_RULE =
  "references: up to 100, each an image (http(s) or a path in the design), a doc (a path in the design), code or a dependency";
const notesOk = (v: unknown) => optText(v, 50_000);
/** A list of short lines (an entity's fields or values). */
const lines = (v: unknown, max: number) =>
  Array.isArray(v) && v.length <= max && v.every((x) => text(x, 300));

const sourcesOk = (v: unknown) =>
  v === undefined ||
  v === null ||
  (Array.isArray(v) && v.length <= 50 && v.every((x) => text(x, 500)));

function rulesOk(v: unknown): boolean {
  const r = v as { include?: unknown; exclude?: unknown };
  return (
    !!r &&
    typeof r === "object" &&
    [r.include, r.exclude].every(
      (l) => Array.isArray(l) && l.length <= 100 && l.every((s) => !selectorError(s)),
    )
  );
}

function authorOk(a: unknown): boolean {
  const r = a as Record<string, unknown> | null;
  return !!r && typeof r === "object" && ref(r.id) && text(r.name, 200);
}

/** Only who they are: an author is copied into every note, so nothing else rides along. */
function cleanAuthor(a: Author): Author {
  return {
    id: String(a.id).slice(0, 200),
    name: String(a.name).slice(0, 80),
    kind: a.kind === "agent" || a.kind === "system" ? a.kind : "human",
  };
}

/** An entry as the model type, defaults filled in (older or hand-made records have every field); null if it's malformed. */
function normalise(table: Table, raw: unknown, key?: string): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!wellFormed(table, r, key)) return null;
  switch (table) {
    case "objects":
      return {
        description: "",
        technology: "",
        status: "live",
        parentId: null,
        external: false,
        tags: [],
        createdAt: "",
        updatedAt: "",
        ...r,
      } as unknown as ModelObject;
    case "connections": {
      // Rows stored before guess: confidence "name" is a guess. Delete with cli/convert.ts.
      const { confidence, ...rest } = r;
      return {
        name: "",
        description: "",
        technology: "",
        status: "live",
        ...rest,
        ...(confidence === "name" && rest.guess === undefined ? { guess: true } : {}),
      } as Connection;
    }
    case "diagrams":
      return { scopeId: null, rules: null, createdAt: "", updatedAt: "", ...r } as Diagram;
    case "flows":
      return { steps: [], createdAt: "", updatedAt: "", ...r } as unknown as Flow;
    case "boundaries":
      return {
        description: "",
        parentId: null,
        createdAt: "",
        updatedAt: "",
        ...r,
        rules: (r.rules as Boundary["rules"] | null) ?? { include: [], exclude: [] },
      } as unknown as Boundary;
    case "decisions":
      return { text: "", affects: [], createdAt: "", updatedAt: "", ...r } as unknown as Decision;
    case "entities":
      // Named before names were checked ("Paid Order"): read as a type name (PaidOrder).
      return {
        fields: [],
        sourceId: null,
        description: "",
        createdAt: "",
        updatedAt: "",
        ...r,
        name: typeName(r.name as string),
      } as unknown as Entity;
    case "placements":
      return r as unknown as Placement;
    case "arrows":
      return cleanArrow(r);
    case "notes":
      return {
        objectId: null,
        resolved: false,
        createdAt: "",
        updatedAt: "",
        ...r,
        author: cleanAuthor(r.author as Author),
      } as unknown as Note;
    case "replies":
      return { at: "", ...r, author: cleanAuthor(r.author as Author) } as unknown as Reply;
  }
}

export function readState(doc: Y.Doc): ModelState {
  const t = tables(doc);
  const state = emptyState();
  for (const table of TABLES) {
    const into = state[table] as Map<string, unknown>;
    t[table].forEach((v, k) => {
      const n = normalise(table, readValue(v), k);
      if (n) into.set(k, n);
    });
  }
  return state;
}

export function emptyState(): ModelState {
  return {
    objects: new Map(),
    connections: new Map(),
    diagrams: new Map(),
    placements: new Map(),
    flows: new Map(),
    arrows: new Map(),
    notes: new Map(),
    replies: new Map(),
    boundaries: new Map(),
    decisions: new Map(),
    entities: new Map(),
  };
}

/** Copy `from` into `into`'s own maps (the mirror holds on to those). */
export function fill(into: ModelState, from: ModelState): void {
  for (const k of Object.keys(from) as (keyof ModelState)[]) {
    const m = into[k] as Map<string, unknown>;
    m.clear();
    for (const [id, v] of from[k] as Map<string, unknown>) m.set(id, v);
  }
}

/**
 * Keep `state` in step with `doc`. Calls `onChange` once per transaction with the
 * transaction itself, after the plain copies are updated.
 */
export function mirror(
  doc: Y.Doc,
  state: ModelState,
  onChange: (tr: Y.Transaction) => void,
): () => void {
  const t = tables(doc);
  const handlers = TABLES.map((table) => {
    const map = t[table];
    const into = state[table] as Map<string, unknown>;
    const fn = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
      const keys = new Set<string>();
      for (const ev of events) {
        if (ev.target === map)
          for (const k of (ev as Y.YMapEvent<unknown>).keysChanged) keys.add(k);
        else if (typeof ev.path[0] === "string") keys.add(ev.path[0]);
      }
      for (const k of keys) {
        const v = map.get(k);
        const n = v === undefined ? null : normalise(table, readValue(v), k);
        if (n) into.set(k, n);
        else into.delete(k);
      }
    };
    map.observeDeep(fn);
    return () => map.unobserveDeep(fn);
  });
  const after = (tr: Y.Transaction) => onChange(tr);
  doc.on("afterTransaction", after);
  return () => {
    for (const off of handlers) off();
    doc.off("afterTransaction", after);
  };
}

// --- edits ------------------------------------------------------------------------------

/** One record written or removed, after cascades: what actually goes into the document. */
type Write = { table: Table | "tagGroup"; key: string; value: unknown | null };

/** What a unique-name check looks up: a table, and the value each record is known by. */
const UNIQUE = {
  objectKey: { table: "objects", of: (x: { id: string; key?: string }) => x.key ?? x.id },
  viewKey: { table: "diagrams", of: (x: { id: string; key?: string }) => x.key ?? x.id },
  boundaryKey: { table: "boundaries", of: (x: { id: string; key?: string }) => x.key ?? x.id },
  entityKey: { table: "entities", of: (x: { id: string; key?: string }) => x.key ?? x.id },
  entityName: { table: "entities", of: (x: { name: string }) => x.name },
} as const satisfies Record<string, { table: Table; of: (x: never) => string }>;
type Unique = keyof typeof UNIQUE;

/**
 * A working copy of the state that a batch is checked against before anything is written.
 * Unique keys and names are looked up in indexes kept as it goes (built on first use), so a
 * batch of thousands checks in linear time. A step can be taken back (begin, rollback).
 */
class Draft {
  writes = new Map<string, Write>();
  private base: ModelState;
  private index = new Map<Unique, Map<string, Set<string>>>();
  /** Since begin(): each touched write as it was before (undefined: there was none). */
  private journal: Map<string, Write | undefined> | null = null;
  constructor(base: ModelState) {
    this.base = base;
  }

  get<T>(table: Table, key: string): T | undefined {
    const w = this.writes.get(`${table}:${key}`);
    if (w) return (w.value ?? undefined) as T | undefined;
    return (this.base[table] as Map<string, T>).get(key);
  }

  *all<T>(table: Table): Iterable<[string, T]> {
    for (const [k, v] of this.base[table] as Map<string, T>) {
      if (!this.writes.has(`${table}:${k}`)) yield [k, v];
    }
    for (const w of this.writes.values())
      if (w.table === table && w.value !== null) yield [w.key, w.value as T];
  }

  /** The ids of what's known by `value` (a key, an entity's name). */
  owners(u: Unique, value: string): ReadonlySet<string> {
    let m = this.index.get(u);
    if (!m) {
      m = new Map();
      const of = UNIQUE[u].of as (x: unknown) => string;
      for (const [k, v] of this.all(UNIQUE[u].table)) {
        const name = of(v);
        (m.get(name) ?? m.set(name, new Set()).get(name)!).add(k);
      }
      this.index.set(u, m);
    }
    return m.get(value) ?? new Set();
  }

  set(table: Table | "tagGroup", key: string, value: unknown | null): void {
    const full = `${table}:${key}`;
    if (this.journal && !this.journal.has(full)) this.journal.set(full, this.writes.get(full));
    if (table !== "tagGroup") {
      for (const [u, m] of this.index) {
        const { table: t, of } = UNIQUE[u] as { table: Table; of: (x: unknown) => string };
        if (t !== table) continue;
        const was = this.get(table, key);
        if (was) m.get(of(was))?.delete(key);
        if (value !== null) {
          const name = of(value);
          (m.get(name) ?? m.set(name, new Set()).get(name)!).add(key);
        }
      }
    }
    this.writes.set(full, { table, key, value });
  }

  begin(): void {
    this.journal = new Map();
  }
  commit(): void {
    this.journal = null;
  }
  /** Take back everything since begin() (the indexes are rebuilt when next needed). */
  rollback(): void {
    for (const [k, w] of this.journal ?? []) {
      if (w) this.writes.set(k, w);
      else this.writes.delete(k);
    }
    this.journal = null;
    this.index.clear();
  }
}

/** Is `value` free for record `id` (no other record is known by it)? */
const free = (d: Draft, u: Unique, value: string, id: string) =>
  [...d.owners(u, value)].every((k) => k === id);

/** Check a batch and expand its cascades. Throws ModelError, having written nothing. */
function plan(state: ModelState, ops: Op[]): Write[] {
  const d = new Draft(state);
  for (const op of ops) exec(d, op);
  return [...d.writes.values()];
}

/**
 * A batch checked a step at a time against one working copy: each step's ops on top of the
 * steps before it, a step that fails taken back whole. Linear, where planning the whole batch
 * so far again after every step was quadratic.
 */
export class Checker {
  private d: Draft;
  constructor(state: ModelState) {
    this.d = new Draft(state);
  }
  /** Check these ops on top of what's checked so far; throws (having taken them back) if they don't hold. */
  step(ops: Op[]): void {
    this.d.begin();
    try {
      for (const op of ops) exec(this.d, op);
      this.d.commit();
    } catch (e) {
      this.d.rollback();
      throw e;
    }
  }
}

function exec(d: Draft, op: Op): void {
  switch (op.op) {
    case "object.put": {
      const o = op.object;
      check(
        typeof o.id === "string" && SAFE_KEY.test(o.id),
        `object id "${o.id}" should be letters, digits, - _ or .`,
      );
      if (o.key !== undefined) {
        check(
          typeof o.key === "string" && SAFE_KEY.test(o.key),
          `key "${o.key}" should be letters, digits, - _ or .`,
        );
        check(free(d, "objectKey", o.key, o.id), `there's already an object with key "${o.key}"`);
      }
      check(OBJECT_KINDS.includes(o.kind), `unknown kind "${o.kind}"`);
      check(STATUSES.includes(o.status), `unknown status "${o.status}"`);
      check(typeof o.name === "string" && o.name.trim(), "object needs a name");
      if (o.parentId) {
        check(o.parentId !== o.id, "an object can't be inside itself");
        check(d.get("objects", o.parentId), `parent ${o.parentId} doesn't exist`);
        let cur: string | null = o.parentId;
        while (cur) {
          check(cur !== o.id, "that parent would put the object inside itself");
          cur = d.get<ModelObject>("objects", cur)?.parentId ?? null;
        }
      }
      check(refsOk(o.refs), "refs: up to 20 name: value pairs, names lowercase (sys, key, linear)");
      check(sourcesOk(o.sources), "sources: up to 50, each at most 500 characters");
      check(linksOk(o.links), LINKS_RULE);
      check(referencesOk(o.references), REFERENCES_RULE);
      check(notesOk(o.notes), "notes: markdown text, at most 50,000 characters");
      check(
        pathOk(o.path),
        `path "${o.path}": repo:path/in/the/repo (a slug, a colon, a relative path)`,
      );
      check(
        o.path === undefined || PATH_KINDS.includes(o.kind),
        `only a module, app or component has a path (${o.name} is a ${o.kind}): for a function, give where it is as sources (repo@ref:path:line) and put it in its module`,
      );
      check(
        packageOk(o.package),
        `package: { ecosystem: one of ${ECOSYSTEMS.join(", ")}, name, version? }`,
      );
      check(
        columnsOk(o.columns),
        "columns: a list of { name, type, pk?, unique?, nullable?, personal?, description? }",
      );
      check(o.columns === undefined || o.kind === "table", "only a table has columns");
      check(o.package === undefined || o.kind === "library", "only a library has a package");
      d.set("objects", o.id, { ...o, parentId: o.parentId ?? null, tags: o.tags ?? [] });
      return;
    }
    case "object.delete": {
      if (!d.get("objects", op.id)) return;
      // Gone first, so a cycle in the tree (two people's moves merged) can't recurse forever.
      d.set("objects", op.id, null);
      // Flow steps that went through it go too (the flow stays).
      for (const [k, f] of [...d.all<Flow>("flows")]) {
        const steps = f.steps.filter((st) => st.fromId !== op.id && st.toId !== op.id);
        if (steps.length !== f.steps.length) d.set("flows", k, { ...f, steps });
      }
      // Its notes go with it (pinned to it, or about it); write says how many went.
      for (const [k, n] of [...d.all<Note>("notes")])
        if (n.objectId === op.id || n.about === op.id) exec(d, { op: "note.delete", id: k });
      for (const [k, p] of [...d.all<Placement>("placements")])
        if (p.objectId === op.id) d.set("placements", k, null);
      for (const [k, a] of [...d.all<ArrowShape>("arrows")])
        if (a.from === op.id || a.to === op.id) d.set("arrows", k, null);
      for (const [k, c] of [...d.all<Connection>("connections")]) {
        if (c.fromId === op.id || c.toId === op.id) d.set("connections", k, null);
      }
      for (const [k, c] of [...d.all<Connection>("connections")])
        if (c.viaId === op.id) d.set("connections", k, { ...c, viaId: null });
      for (const [k, dc] of [...d.all<Decision>("decisions")])
        if (dc.affects.includes(op.id))
          d.set("decisions", k, { ...dc, affects: dc.affects.filter((x) => x !== op.id) });
      // Shapes defined in it stay, as the design's own.
      for (const [k, e] of [...d.all<Entity>("entities")])
        if (e.sourceId === op.id) d.set("entities", k, { ...e, sourceId: null });
      // Rules that name it let go of it: a view or boundary listing it never blocks the delete.
      for (const [k, dg] of [...d.all<Diagram>("diagrams")]) {
        const rules = dg.rules ? withoutId(dg.rules, op.id) : null;
        const hide = dg.hideLines ? dropSelectors(dg.hideLines, op.id) : null;
        if (rules !== dg.rules || hide !== dg.hideLines)
          d.set("diagrams", k, {
            ...dg,
            ...(dg.rules ? { rules } : {}),
            ...(dg.hideLines ? { hideLines: hide } : {}),
          });
      }
      for (const [k, b] of [...d.all<Boundary>("boundaries")]) {
        const rules = withoutId(b.rules, op.id);
        if (rules !== b.rules) d.set("boundaries", k, { ...b, rules: rules! });
      }
      for (const [k, o] of [...d.all<ModelObject>("objects")])
        if (o.parentId === op.id) exec(d, { op: "object.delete", id: k });
      for (const [k, dg] of [...d.all<Diagram>("diagrams")])
        if (dg.scopeId === op.id) exec(d, { op: "diagram.delete", id: k });
      return;
    }
    case "connection.put": {
      const c = op.connection;
      check(c.id, "connection needs an id");
      check(c.fromId !== c.toId, "a connection needs two different ends");
      check(d.get("objects", c.fromId), `object ${c.fromId} doesn't exist`);
      check(d.get("objects", c.toId), `object ${c.toId} doesn't exist`);
      check(STATUSES.includes(c.status), `unknown status "${c.status}"`);
      if (c.viaId) {
        check(
          c.viaId !== c.fromId && c.viaId !== c.toId,
          "a connection can't go via one of its own ends",
        );
        check(d.get("objects", c.viaId), `object ${c.viaId} (via) doesn't exist`);
      }
      check(
        refsOk((c as { refs?: unknown }).refs) && sourcesOk(c.sources),
        "sources: up to 50, each at most 500 characters",
      );
      check(linksOk(c.links), LINKS_RULE);
      check(referencesOk(c.references), REFERENCES_RULE);
      d.set("connections", c.id, c);
      return;
    }
    case "connection.delete":
      if (d.get("connections", op.id)) d.set("connections", op.id, null);
      // Comments pinned to its arrow stay on the diagram, loose.
      for (const [k, n] of [...d.all<Note>("notes")]) {
        if (n.connectionId !== op.id) continue;
        const { connectionId: _, ...loose } = n;
        d.set("notes", k, loose);
      }
      return;
    case "diagram.put": {
      const dg = op.diagram;
      check(
        typeof dg.id === "string" && SAFE_KEY.test(dg.id),
        `view id "${dg.id}" should be letters, digits, - _ or .`,
      );
      if (dg.key !== undefined) {
        check(
          typeof dg.key === "string" && SAFE_KEY.test(dg.key),
          `view key "${dg.key}" should be letters, digits, - _ or .`,
        );
        check(free(d, "viewKey", dg.key, dg.id), `there's already a view with key "${dg.key}"`);
      }
      check(typeof dg.name === "string" && dg.name.trim(), "diagram needs a name");
      check(
        dg.tidy === undefined || dg.tidy === null || LAYOUT_DIRECTIONS.includes(dg.tidy),
        `keep tidy is one of ${LAYOUT_DIRECTIONS.join(", ")}`,
      );
      if (dg.scopeId) check(d.get("objects", dg.scopeId), `object ${dg.scopeId} doesn't exist`);
      if (dg.rules) {
        check(
          Array.isArray(dg.rules.include) && Array.isArray(dg.rules.exclude),
          "rules need include and exclude lists",
        );
        for (const r of [...dg.rules.include, ...dg.rules.exclude]) {
          const err = selectorError(r);
          check(!err, `diagram ${dg.name}: ${err}`);
        }
      }
      check(
        dg.fold === undefined || dg.fold === null || FOLD_MODES.includes(dg.fold),
        `fold is one of ${FOLD_MODES.join(", ")}`,
      );
      check(linksOk(dg.links), LINKS_RULE);
      if (dg.hideLines) {
        check(Array.isArray(dg.hideLines), "hide_lines is a list of rules");
        for (const r of dg.hideLines) {
          const err = selectorError(r);
          check(!err, `diagram ${dg.name}: hide_lines: ${err}`);
        }
      }
      d.set("diagrams", dg.id, { ...dg, scopeId: dg.scopeId ?? null, rules: dg.rules ?? null });
      return;
    }
    case "diagram.delete": {
      if (!d.get("diagrams", op.id)) return;
      for (const [k, f] of [...d.all<Flow>("flows")])
        if (f.diagramId === op.id) d.set("flows", k, null);
      for (const [k, p] of [...d.all<Placement>("placements")])
        if (p.diagramId === op.id) d.set("placements", k, null);
      for (const [k, a] of [...d.all<ArrowShape>("arrows")])
        if (a.diagramId === op.id) d.set("arrows", k, null);
      // Its notes go with it; write says how many went.
      for (const [k, n] of [...d.all<Note>("notes")])
        if (n.diagramId === op.id) exec(d, { op: "note.delete", id: k });
      d.set("diagrams", op.id, null);
      return;
    }
    case "placement.put": {
      const p = op.placement;
      check(d.get("diagrams", p.diagramId), `diagram ${p.diagramId} doesn't exist`);
      check(d.get("objects", p.objectId), `object ${p.objectId} doesn't exist`);
      check(
        [p.x, p.y, p.w, p.h].every(Number.isFinite) && p.w > 0 && p.h > 0,
        "a placement needs a finite position and size",
      );
      check(
        !p.parts || (Number.isFinite(p.parts.x) && Number.isFinite(p.parts.y)),
        "where its parts sit is a finite x and y",
      );
      d.set("placements", pkey(p.diagramId, p.objectId), {
        diagramId: p.diagramId,
        objectId: p.objectId,
        x: p.x,
        y: p.y,
        w: p.w,
        h: p.h,
        ...(p.parts ? { parts: { x: Math.round(p.parts.x), y: Math.round(p.parts.y) } } : {}),
      });
      return;
    }
    case "placement.delete": {
      const k = pkey(op.diagramId, op.objectId);
      if (!d.get("placements", k)) return;
      unpinNotes(d, op.objectId, op.diagramId);
      d.set("placements", k, null);
      return;
    }
    case "flow.put": {
      const f = op.flow;
      check(f.id, "flow needs an id");
      check(typeof f.name === "string" && f.name.trim(), "flow needs a name");
      check(d.get("diagrams", f.diagramId), `diagram ${f.diagramId} doesn't exist`);
      check(Array.isArray(f.steps), "flow steps must be a list");
      check(optIn(f.kind, FLOW_KINDS), `a flow's kind is one of ${FLOW_KINDS.join(", ")}`);
      const ids = new Set<string>();
      for (const st of f.steps) {
        check(st.id && st.fromId && st.toId, "each step needs an id and two ends");
        check(!ids.has(st.id), `step id ${st.id} is used twice`);
        ids.add(st.id);
        check(
          d.get("objects", st.fromId) && d.get("objects", st.toId),
          `flow ${f.name}: a step goes from or to something that doesn't exist`,
        );
      }
      d.set("flows", f.id, f);
      return;
    }
    case "flow.delete":
      if (d.get("flows", op.id)) d.set("flows", op.id, null);
      return;
    case "boundary.put": {
      const b = op.boundary;
      check(
        typeof b.id === "string" && SAFE_KEY.test(b.id),
        `boundary id "${b.id}" should be letters, digits, - _ or .`,
      );
      if (b.key !== undefined) {
        check(
          typeof b.key === "string" && SAFE_KEY.test(b.key),
          `boundary key "${b.key}" should be letters, digits, - _ or .`,
        );
        check(
          free(d, "boundaryKey", b.key, b.id),
          `there's already a boundary with key "${b.key}"`,
        );
      }
      check(typeof b.name === "string" && b.name.trim(), "a boundary needs a name");
      check(
        BOUNDARY_KINDS.includes(b.kind),
        `a boundary's kind is one of ${BOUNDARY_KINDS.join(", ")}`,
      );
      if (b.parentId) {
        let cur: string | null = b.parentId;
        while (cur) {
          check(cur !== b.id, "that would put the boundary inside itself");
          const p: Boundary | undefined = d.get<Boundary>("boundaries", cur);
          check(p, `boundary ${cur} doesn't exist`);
          cur = p.parentId;
        }
      }
      const rules = b.rules ?? { include: [], exclude: [] };
      check(
        Array.isArray(rules.include) && Array.isArray(rules.exclude),
        "a boundary's rules need include and exclude lists",
      );
      for (const r of [...rules.include, ...rules.exclude]) {
        const err = selectorError(r);
        check(!err, `boundary ${b.name}: ${err}`);
      }
      d.set("boundaries", b.id, {
        ...b,
        parentId: b.parentId ?? null,
        rules,
        description: b.description ?? "",
      });
      return;
    }
    case "decision.put": {
      const dc = op.decision;
      check(
        typeof dc.id === "string" && SAFE_KEY.test(dc.id),
        `decision id "${dc.id}" should be letters, digits, - _ or . (it's the file name)`,
      );
      check(
        typeof dc.title === "string" && dc.title.trim() && dc.title.length <= 200,
        "a decision needs a title",
      );
      check(
        DECISION_STATUSES.includes(dc.status),
        `a decision's status is one of ${DECISION_STATUSES.join(", ")}`,
      );
      check(dc.date === undefined || DATE.test(dc.date), "date is YYYY-MM-DD");
      check(Array.isArray(dc.affects), "affects is a list of objects");
      for (const id of dc.affects) check(d.get("objects", id), `object ${id} doesn't exist`);
      if (dc.supersededBy)
        check(
          dc.supersededBy !== dc.id && d.get("decisions", dc.supersededBy),
          `decision ${dc.supersededBy} doesn't exist`,
        );
      d.set("decisions", dc.id, { ...dc, text: dc.text ?? "", affects: [...new Set(dc.affects)] });
      return;
    }
    case "decision.delete":
      if (d.get("decisions", op.id)) d.set("decisions", op.id, null);
      return;
    case "entity.put": {
      const e = op.entity;
      check(
        typeof e.id === "string" && SAFE_KEY.test(e.id),
        `entity id "${e.id}" should be letters, digits, - _ or .`,
      );
      if (e.key !== undefined) {
        check(
          typeof e.key === "string" && SAFE_KEY.test(e.key),
          `entity key "${e.key}" should be letters, digits, - _ or .`,
        );
        check(free(d, "entityKey", e.key, e.id), `there's already an entity with key "${e.key}"`);
      }
      check(
        typeof e.name === "string" && TYPE_NAME.test(e.name),
        `entity "${String(e.name)}": ${TYPE_NAME_RULE}`,
      );
      check(free(d, "entityName", e.name, e.id), `there's already an entity called ${e.name}`);
      check(lines(e.fields ?? [], 300), "fields: up to 300 lines of text");
      check(e.values === undefined || lines(e.values, 300), "values: up to 300 lines of text");
      for (const x of e.extends ?? [])
        check(x !== e.id && d.get("entities", x), `entity ${x} doesn't exist`);
      if (e.sourceId) check(d.get("objects", e.sourceId), `object ${e.sourceId} doesn't exist`);
      d.set("entities", e.id, {
        ...e,
        fields: e.fields ?? [],
        sourceId: e.sourceId ?? null,
        description: e.description ?? "",
        ...(e.extends?.length ? { extends: [...new Set(e.extends)] } : { extends: undefined }),
      });
      return;
    }
    case "entity.delete": {
      if (!d.get("entities", op.id)) return;
      d.set("entities", op.id, null);
      // Nothing points at it any more: the nodes' references, other entities' extends.
      for (const [k, o] of [...d.all<ModelObject>("objects")]) {
        const refs = o.references?.filter((r) => !(r.kind === "entity" && r.to === op.id));
        if (refs && refs.length !== o.references!.length)
          d.set("objects", k, { ...o, references: refs });
      }
      for (const [k, c] of [...d.all<Connection>("connections")]) {
        const refs = c.references?.filter((r) => !(r.kind === "entity" && r.to === op.id));
        if (refs && refs.length !== c.references!.length)
          d.set("connections", k, { ...c, references: refs });
      }
      for (const [k, e] of [...d.all<Entity>("entities")])
        if (e.extends?.includes(op.id))
          d.set("entities", k, { ...e, extends: e.extends.filter((x) => x !== op.id) });
      return;
    }
    case "taggroup.put": {
      // The same rules archnm.yaml is read with, so what the app writes reads back.
      check(
        typeof op.name === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(op.name),
        `a tag group's name is lowercase letters, digits and - (it's written before the colon: ${op.name}:value)`,
      );
      const g = op.group;
      const values = Array.isArray(g?.values)
        ? [...new Set(g.values.map((v) => String(v).trim().toLowerCase()).filter(Boolean))]
        : [];
      check(values.length > 0 && values.length <= 100, "a tag group needs 1 to 100 values");
      for (const v of values)
        check(
          /^[a-z0-9][a-z0-9._-]{0,63}$/.test(v),
          `tag value "${v}" should be lowercase letters, digits, - _ or .`,
        );
      const colors: Record<string, string> = {};
      for (const [k, c] of Object.entries(g.colors ?? {})) {
        check(values.includes(k), `colour for "${k}", which isn't one of the values`);
        check(typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c), "a colour is #rrggbb");
        colors[k] = c.toLowerCase();
      }
      check(
        g.description === undefined ||
          (typeof g.description === "string" && g.description.length <= 300),
        "a description is up to 300 characters",
      );
      d.set("tagGroup", op.name, {
        values,
        ...(g.description?.trim() ? { description: g.description.trim() } : {}),
        ...(Object.keys(colors).length ? { colors } : {}),
      });
      return;
    }
    case "taggroup.delete":
      d.set("tagGroup", op.name, null);
      return;
    case "boundary.delete": {
      const gone = d.get<Boundary>("boundaries", op.id);
      if (!gone) return;
      d.set("boundaries", op.id, null);
      // What was inside it moves up a level rather than vanishing.
      for (const [k, b] of [...d.all<Boundary>("boundaries")])
        if (b.parentId === op.id) d.set("boundaries", k, { ...b, parentId: gone.parentId });
      return;
    }
    case "arrow.put": {
      const a = op.arrow;
      check(d.get("diagrams", a.diagramId), `diagram ${a.diagramId} doesn't exist`);
      check(
        d.get("objects", a.from) && d.get("objects", a.to),
        "an arrow shape needs two boxes that exist",
      );
      check(a.from !== a.to, "an arrow needs two different ends");
      for (const s of [a.fromSide, a.toSide])
        check(s === undefined || SIDES.includes(s), `a side is one of ${SIDES.join(", ")}`);
      for (const t of [a.fromAt, a.toAt])
        check(t === undefined || (num(t) && t >= 0 && t <= 1), "where an end sits is 0 to 1");
      check(
        a.bends === undefined ||
          (Array.isArray(a.bends) &&
            a.bends.length <= 50 &&
            a.bends.every((p) => num(p?.x) && num(p?.y))),
        "bends are up to 50 points with x and y",
      );
      check(
        a.label === undefined || (num(a.label) && a.label >= 0 && a.label <= 1),
        "a label position is between 0 and 1",
      );
      check(
        a.parts === undefined || (num(a.parts?.x) && num(a.parts?.y)),
        "where its parts sit is a finite x and y",
      );
      const clean = cleanArrow(a as unknown as Record<string, unknown>);
      const k = akey(a.diagramId, a.from, a.to);
      // A shape with nothing in it is no shape: remove it rather than keep an empty record.
      if (
        clean.fromSide ||
        clean.toSide ||
        clean.bends ||
        clean.label !== undefined ||
        clean.parts ||
        clean.split ||
        clean.join
      )
        d.set("arrows", k, clean);
      else if (d.get("arrows", k)) d.set("arrows", k, null);
      return;
    }
    case "arrow.delete": {
      const k = akey(op.diagramId, op.from, op.to);
      if (d.get("arrows", k)) d.set("arrows", k, null);
      return;
    }
    case "note.put": {
      const n = op.note;
      check(typeof n.id === "string" && SAFE_KEY.test(n.id), "a note needs an id");
      check(d.get("diagrams", n.diagramId), `diagram ${n.diagramId} doesn't exist`);
      check(NOTE_KINDS.includes(n.kind), `a note is one of ${NOTE_KINDS.join(", ")}`);
      check(num(n.x) && num(n.y), "a note needs a finite position");
      check(
        typeof n.text === "string" && n.text.length <= NOTE_MAX,
        `a note is up to ${NOTE_MAX} characters`,
      );
      check(authorOk(n.author), "a note needs an author");
      if (n.objectId)
        check(
          d.get("placements", pkey(n.diagramId, n.objectId)),
          "a note can only be pinned to a box on its diagram",
        );
      if (n.connectionId)
        check(
          !n.objectId && typeof n.connectionId === "string" && d.get("connections", n.connectionId),
          "a note is pinned to a box or to a connection that exists, not both",
        );
      const was = d.get<Note>("notes", n.id);
      if (was) check(was.diagramId === n.diagramId, "a note stays on its diagram");
      const out: Note = {
        id: n.id,
        diagramId: n.diagramId,
        kind: n.kind,
        objectId: n.objectId ?? null,
        x: Math.round(n.x),
        y: Math.round(n.y),
        text: n.text,
        author: cleanAuthor(n.author),
        resolved: !!n.resolved,
        createdAt: n.createdAt,
        updatedAt: n.updatedAt,
      };
      if (n.about) {
        check(
          typeof n.about === "string" && d.get("objects", n.about),
          "a note is about an object that exists",
        );
        out.about = n.about;
      }
      if (n.forAgent) out.forAgent = true;
      if (n.connectionId) out.connectionId = n.connectionId;
      if (n.kind === "link") {
        const url = safeUrl(n.url);
        check(url, "a link needs an http or https address");
        out.url = url;
        check(n.text.length <= 200, "a link's title is up to 200 characters");
        // One per address on a view: the files key a link's position by its address.
        check(
          ![...d.all<Note>("notes")].some(
            ([k, o]) =>
              k !== n.id && o.kind === "link" && o.diagramId === n.diagramId && o.url === url,
          ),
          "that link is already on this view",
        );
      } else check(n.text.trim(), "a note needs something in it");
      d.set("notes", n.id, out);
      return;
    }
    case "note.delete": {
      if (!d.get("notes", op.id)) return;
      for (const [k, r] of [...d.all<Reply>("replies")])
        if (r.noteId === op.id) d.set("replies", k, null);
      d.set("notes", op.id, null);
      return;
    }
    case "reply.put": {
      const r = op.reply;
      check(typeof r.id === "string" && SAFE_KEY.test(r.id), "a reply needs an id");
      const note = d.get<Note>("notes", r.noteId);
      check(note, "that note doesn't exist (any more)");
      check(note.kind === "note", "only notes have replies");
      check(
        typeof r.text === "string" && r.text.trim() && r.text.length <= NOTE_MAX,
        `a reply is 1 to ${NOTE_MAX} characters`,
      );
      check(authorOk(r.author), "a reply needs an author");
      const was = d.get<Reply>("replies", r.id);
      if (was) check(was.noteId === r.noteId, "a reply stays in its thread");
      d.set("replies", r.id, {
        id: r.id,
        noteId: r.noteId,
        text: r.text,
        author: cleanAuthor(r.author),
        at: r.at,
      });
      return;
    }
    case "reply.delete":
      if (d.get("replies", op.id)) d.set("replies", op.id, null);
      return;
    default: {
      const never: never = op;
      throw new ModelError(`unknown op ${JSON.stringify(never)}`);
    }
  }
}

/**
 * A box is going from a diagram (or everywhere, diagramId null): notes pinned to it stay
 * where they are on the diagram, unpinned.
 */
/** A selector list with `id` let go: out of ids lists, and selectors about it dropped. Same list when untouched. */
function dropSelectors<S extends object>(list: S[], id: string): S[] {
  let changed = false;
  const out: S[] = [];
  for (const sel of list) {
    const r = sel as Record<string, unknown>;
    if (Array.isArray(r.ids)) {
      if (!r.ids.includes(id)) out.push(sel);
      else {
        changed = true;
        const ids = r.ids.filter((x) => x !== id);
        if (ids.length) out.push({ ...sel, ids } as S);
      }
    } else if (["children", "descendants", "neighbours"].some((k) => r[k] === id)) changed = true;
    else out.push(sel);
  }
  return changed ? out : list;
}
function withoutId<R extends { include: S[]; exclude: S[] }, S extends object>(
  rules: R,
  id: string,
): R {
  const include = dropSelectors(rules.include, id);
  const exclude = dropSelectors(rules.exclude, id);
  return include === rules.include && exclude === rules.exclude
    ? rules
    : { ...rules, include, exclude };
}

function unpinNotes(d: Draft, objectId: string, diagramId: string | null): void {
  for (const [k, n] of [...d.all<Note>("notes")]) {
    if (n.objectId !== objectId || (diagramId && n.diagramId !== diagramId)) continue;
    const p = d.get<Placement>("placements", pkey(n.diagramId, objectId));
    d.set("notes", k, { ...n, objectId: null, x: n.x + (p?.x ?? 0), y: n.y + (p?.y ?? 0) });
  }
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Write planned changes into the document, touching only fields that changed. */
function write(doc: Y.Doc, writes: Write[]): string[] {
  const t = tables(doc);
  const touched: string[] = [];
  for (const w of writes) {
    if (w.table === "tagGroup") {
      // archnm.yaml's settings live in meta as JSON (see live.config()).
      const meta = doc.getMap<string>("meta");
      let cfg: { tags?: Record<string, unknown> } = {};
      try {
        cfg = JSON.parse(meta.get("config") ?? "{}");
      } catch {
        /* start over */
      }
      const tags = { ...(cfg.tags ?? {}) };
      if (w.value === null) delete tags[w.key];
      else tags[w.key] = w.value;
      const next = JSON.stringify({ ...cfg, tags: Object.keys(tags).length ? tags : undefined });
      if (meta.get("config") !== next) meta.set("config", next);
      touched.push(`tags:${w.key}`);
      continue;
    }
    const map = t[w.table];
    // Placing a box on a view (or bending a line on it) is a change to the view, not the box:
    // read {diff, by} must not count a box someone only placed as theirs.
    if (w.table === "placements" || w.table === "arrows") touched.push(w.key.split("|")[0]!);
    else touched.push(w.key);
    if (w.value === null) {
      if (map.has(w.key)) map.delete(w.key);
      continue;
    }
    if (w.table === "placements" || w.table === "arrows") {
      if (!same(map.get(w.key), w.value)) map.set(w.key, w.value);
      continue;
    }
    const fields = w.value as Record<string, unknown>;
    let rec = map.get(w.key);
    if (!(rec instanceof Y.Map)) {
      rec = new Y.Map<unknown>();
      map.set(w.key, rec);
    }
    const ym = rec as Y.Map<unknown>;
    for (const [f, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      if (!same(ym.get(f), v)) ym.set(f, v);
    }
    for (const f of [...ym.keys()]) if (!(f in fields)) ym.delete(f);
  }
  return [...new Set(touched)];
}

/**
 * Check and apply a batch as one transaction, tagged with `origin` (so each editor's undo
 * only sees their own edits) and logged under `actor`. Returns the ids touched.
 */
export function applyOps(
  doc: Y.Doc,
  state: ModelState,
  ops: Op[],
  actor: Actor,
  label: string,
  origin: unknown = actor,
  opts: { pin?: boolean; log?: boolean } = {},
): string[] {
  const writes = plan(state, opts.pin === false ? ops : withPins(state, ops));
  if (!writes.length) return [];
  let ids: string[] = [];
  doc.transact(() => {
    ids = write(doc, writes);
    if (opts.log !== false)
      appendLog(doc, {
        actor,
        label,
        at: new Date().toISOString(),
        ids: [...new Set(ids)].slice(0, 5000),
      });
  }, origin);
  return ids;
}

/**
 * Placing or removing a box by hand on a diagram that follows rules updates its rules too,
 * so the next time the rules are applied the hand edit sticks.
 */
function withPins(state: ModelState, ops: Op[]): Op[] {
  const byDiagram = new Map<string, { added: string[]; removed: string[] }>();
  for (const op of ops) {
    if (op.op !== "placement.put" && op.op !== "placement.delete") continue;
    const diagramId = op.op === "placement.put" ? op.placement.diagramId : op.diagramId;
    const objectId = op.op === "placement.put" ? op.placement.objectId : op.objectId;
    const existed = state.placements.has(pkey(diagramId, objectId));
    let e = byDiagram.get(diagramId);
    if (!e) byDiagram.set(diagramId, (e = { added: [], removed: [] }));
    if (op.op === "placement.put" && !existed) e.added.push(objectId);
    if (op.op === "placement.delete" && existed) e.removed.push(objectId);
  }
  const ruled = [...byDiagram].filter(([id]) => state.diagrams.get(id)?.rules);
  if (!ruled.length || ops.some((op) => op.op === "diagram.put" && byDiagram.has(op.diagram.id)))
    return ops;
  // Judge the rules against the model as it will be after this batch.
  const objects = new Map(state.objects);
  const connections = new Map(state.connections);
  for (const op of ops) {
    if (op.op === "object.put") objects.set(op.object.id, op.object);
    else if (op.op === "object.delete") objects.delete(op.id);
    else if (op.op === "connection.put") connections.set(op.connection.id, op.connection);
    else if (op.op === "connection.delete") connections.delete(op.id);
  }
  const idx = buildIndex({
    objects: objects.values(),
    connections: connections.values(),
    diagrams: state.diagrams.values(),
    placements: [],
  });
  const extra: Op[] = [];
  for (const [id, e] of ruled) {
    const next = pinEdits(idx, state.diagrams.get(id)!, e.added, e.removed);
    if (next) extra.push({ op: "diagram.put", diagram: next });
  }
  return [...ops, ...extra];
}

/** Is this history entry well formed? Anything in the log came from some client. */
export function logEntryOk(e: unknown): e is LogEntry {
  const r = e as Record<string, unknown> | null;
  return (
    !!r &&
    typeof r === "object" &&
    authorOk(r.actor) &&
    text(r.label, 500) &&
    typeof r.at === "string" &&
    Array.isArray(r.ids) &&
    r.ids.length <= 10_000 &&
    r.ids.every((i) => typeof i === "string")
  );
}

export function appendLog(doc: Y.Doc, entry: LogEntry): void {
  const log = logOf(doc);
  log.push([entry]);
  if (log.length > LOG_KEEP + 100) log.delete(0, log.length - LOG_KEEP);
}

/** Deletes that clear references left dangling by concurrent edits. */
export function danglingOps(s: ModelState): Op[] {
  const ops: Op[] = [];
  const gone = new Set<string>();
  // Two moves merged into a cycle (A into B, B into A): break it, by taking the one with
  // the lowest id out to the top level. Nothing is deleted for it.
  const lifted = new Set<string>();
  for (const o of s.objects.values()) {
    const path: string[] = [];
    let id: string | null = o.id;
    while (id && !path.includes(id) && !lifted.has(id)) {
      path.push(id);
      id = s.objects.get(id)?.parentId ?? null;
    }
    if (id && path.includes(id) && !lifted.has(id)) {
      const ring = path.slice(path.indexOf(id)).sort();
      const top = s.objects.get(ring[0]!)!;
      lifted.add(top.id);
      ops.push({ op: "object.put", object: { ...top, parentId: null } });
    }
  }
  // Objects whose parent vanished: delete with their parent's fate.
  const alive = (id: string | null): boolean => {
    const seen = new Set<string>();
    while (id) {
      if (seen.has(id)) return true; // a cycle, broken above
      seen.add(id);
      if (lifted.has(id)) return true;
      const o = s.objects.get(id);
      if (!o) return false;
      id = o.parentId;
    }
    return true;
  };
  for (const o of s.objects.values()) {
    if (!alive(o.id)) {
      ops.push({ op: "object.delete", id: o.id });
      gone.add(o.id);
    }
  }
  const has = (id: string) => s.objects.has(id) && !gone.has(id);
  const goneConn = new Set<string>();
  for (const c of s.connections.values()) {
    if (!has(c.fromId) || !has(c.toId)) {
      ops.push({ op: "connection.delete", id: c.id });
      goneConn.add(c.id);
    }
  }
  for (const dg of s.diagrams.values()) {
    if (dg.scopeId && !has(dg.scopeId)) ops.push({ op: "diagram.delete", id: dg.id });
  }
  for (const p of s.placements.values()) {
    if (!has(p.objectId) || !s.diagrams.has(p.diagramId)) {
      ops.push({ op: "placement.delete", diagramId: p.diagramId, objectId: p.objectId });
    }
  }
  for (const a of s.arrows.values()) {
    if (!has(a.from) || !has(a.to) || !s.diagrams.has(a.diagramId))
      ops.push({ op: "arrow.delete", diagramId: a.diagramId, from: a.from, to: a.to });
  }
  for (const n of s.notes.values()) {
    if (!s.diagrams.has(n.diagramId) || (n.about && !has(n.about)))
      ops.push({ op: "note.delete", id: n.id });
    else if (n.objectId && !s.placements.has(pkey(n.diagramId, n.objectId)))
      ops.push({ op: "note.put", note: { ...n, objectId: null } });
    else if (
      n.connectionId &&
      (!s.connections.has(n.connectionId) || goneConn.has(n.connectionId))
    ) {
      const { connectionId: _, ...loose } = n;
      ops.push({ op: "note.put", note: loose });
    }
  }
  for (const r of s.replies.values()) {
    const n = s.notes.get(r.noteId);
    if (!n || !s.diagrams.has(n.diagramId)) ops.push({ op: "reply.delete", id: r.id });
  }
  for (const b of s.boundaries.values()) {
    if (b.parentId && !s.boundaries.has(b.parentId))
      ops.push({ op: "boundary.put", boundary: { ...b, parentId: null } });
  }
  for (const c of s.connections.values())
    if (c.viaId && !has(c.viaId) && has(c.fromId) && has(c.toId))
      ops.push({ op: "connection.put", connection: { ...c, viaId: null } });
  for (const dc of s.decisions.values()) {
    const affects = dc.affects.filter(has);
    if (affects.length !== dc.affects.length)
      ops.push({ op: "decision.put", decision: { ...dc, affects } });
  }
  for (const e of s.entities.values()) {
    const ext = e.extends?.filter((x) => s.entities.has(x));
    if ((e.sourceId && !has(e.sourceId)) || (ext && ext.length !== e.extends!.length))
      ops.push({
        op: "entity.put",
        entity: { ...e, sourceId: e.sourceId && has(e.sourceId) ? e.sourceId : null, extends: ext },
      });
  }
  for (const f of s.flows.values()) {
    if (!s.diagrams.has(f.diagramId)) ops.push({ op: "flow.delete", id: f.id });
    else {
      const steps = f.steps.filter((st) => has(st.fromId) && has(st.toId));
      if (steps.length !== f.steps.length) ops.push({ op: "flow.put", flow: { ...f, steps } });
    }
  }
  return ops;
}

/** Remove dangling records directly (no checks: the references are already broken). */
export function sweep(doc: Y.Doc, state: ModelState, actor: Actor): number {
  const ops = danglingOps(state);
  if (!ops.length) return 0;
  const t = tables(doc);
  doc.transact(() => {
    for (const op of ops) {
      if (op.op === "object.delete") t.objects.delete(op.id);
      else if (op.op === "connection.delete") t.connections.delete(op.id);
      else if (op.op === "diagram.delete") t.diagrams.delete(op.id);
      else if (op.op === "placement.delete") t.placements.delete(pkey(op.diagramId, op.objectId));
      else if (op.op === "flow.delete") t.flows.delete(op.id);
      else if (op.op === "arrow.delete") t.arrows.delete(akey(op.diagramId, op.from, op.to));
      else if (op.op === "note.delete") t.notes.delete(op.id);
      else if (op.op === "reply.delete") t.replies.delete(op.id);
      else if (op.op === "note.put")
        write(doc, [{ table: "notes", key: op.note.id, value: op.note }]);
      // Repairs that keep the record: a cycle broken, a flow's dead steps dropped.
      else if (op.op === "object.put")
        write(doc, [{ table: "objects", key: op.object.id, value: op.object }]);
      else if (op.op === "flow.put")
        write(doc, [{ table: "flows", key: op.flow.id, value: op.flow }]);
      else if (op.op === "boundary.put")
        write(doc, [{ table: "boundaries", key: op.boundary.id, value: op.boundary }]);
      else if (op.op === "connection.put")
        write(doc, [{ table: "connections", key: op.connection.id, value: op.connection }]);
      else if (op.op === "decision.put")
        write(doc, [{ table: "decisions", key: op.decision.id, value: op.decision }]);
      else if (op.op === "entity.put")
        write(doc, [{ table: "entities", key: op.entity.id, value: op.entity }]);
    }
    appendLog(doc, {
      actor,
      label: `tidied ${ops.length} broken reference${ops.length === 1 ? "" : "s"}`,
      at: new Date().toISOString(),
      ids: [],
    });
  }, actor);
  return ops.length;
}

/** Only the fields an arrow shape has, rounded, and only the ones that say something. */
function cleanArrow(r: Record<string, unknown>): ArrowShape {
  const out: ArrowShape = {
    diagramId: r.diagramId as string,
    from: r.from as string,
    to: r.to as string,
  };
  if (SIDES.includes(r.fromSide as never)) out.fromSide = r.fromSide as ArrowShape["fromSide"];
  if (SIDES.includes(r.toSide as never)) out.toSide = r.toSide as ArrowShape["toSide"];
  // A spot along a side means nothing without the side.
  const at = (v: unknown) =>
    num(v) && (v as number) >= 0 && (v as number) <= 1
      ? Math.round((v as number) * 100) / 100
      : undefined;
  if (out.fromSide && at(r.fromAt) !== undefined) out.fromAt = at(r.fromAt);
  if (out.toSide && at(r.toAt) !== undefined) out.toAt = at(r.toAt);
  const sp = r.split as { x?: unknown; y?: unknown } | undefined;
  if (sp && num(sp.x) && num(sp.y))
    out.split = { x: Math.round(sp.x as number), y: Math.round(sp.y as number) };
  const jp = r.join as { x?: unknown; y?: unknown } | undefined;
  if (jp && num(jp.x) && num(jp.y))
    out.join = { x: Math.round(jp.x as number), y: Math.round(jp.y as number) };
  if (Array.isArray(r.bends)) {
    const bends = (r.bends as { x: unknown; y: unknown }[])
      .filter((p) => num(p?.x) && num(p?.y))
      .map((p) => ({ x: Math.round(p.x as number), y: Math.round(p.y as number) }));
    if (bends.length) out.bends = bends;
  }
  if (num(r.label) && (r.label as number) >= 0 && (r.label as number) <= 1)
    out.label = Math.round((r.label as number) * 1000) / 1000;
  const pp = r.parts as { x: unknown; y: unknown } | undefined;
  if (pp && num(pp.x) && num(pp.y))
    out.parts = { x: Math.round(pp.x as number), y: Math.round(pp.y as number) };
  return out;
}

/** An undo stack for one editor: only their own transactions, one step per batch. */
export function undoManager(doc: Y.Doc, origin: unknown): Y.UndoManager {
  const t = tables(doc);
  return new Y.UndoManager(Object.values(t), {
    trackedOrigins: new Set([origin]),
    captureTimeout: 0,
  });
}

/** How a batch lands: as its own step (the default), as part of the last one (join: same undo, no history line of its own), or outside undo altogether (undo: false, e.g. a note). */
export interface CommitOpts {
  join?: boolean;
  undo?: boolean;
}

/** One actor's edits as steps that know what they were, so an undo can say what it took back. */
export class UndoSteps {
  readonly um: Y.UndoManager;
  private label = "";
  private doc: Y.Doc;
  private origin: object;
  constructor(doc: Y.Doc, origin: object) {
    this.doc = doc;
    this.origin = origin;
    this.um = undoManager(doc, origin);
    this.um.on(
      "stack-item-added",
      (e: { stackItem: { meta: Map<string, unknown> }; type: string }) => {
        if (e.type === "undo" && !e.stackItem.meta.has("label"))
          e.stackItem.meta.set("label", this.label);
      },
    );
  }
  apply(
    state: ModelState,
    ops: Op[],
    actor: Actor,
    label: string,
    opts: CommitOpts = {},
  ): string[] {
    if (opts.undo === false)
      return applyOps(this.doc, state, ops, actor, label, { untracked: actor.id });
    if (!opts.join) {
      this.label = label;
      this.um.stopCapturing();
      return applyOps(this.doc, state, ops, actor, label, this.origin);
    }
    // Merged into the step before it: Yjs joins a transaction that comes within captureTimeout.
    this.um.captureTimeout = Number.MAX_SAFE_INTEGER;
    try {
      return applyOps(this.doc, state, ops, actor, label, this.origin, { log: false });
    } finally {
      this.um.captureTimeout = 0;
    }
  }
  /** Take back the last step (dry: only say what it was). Null: nothing to take back. */
  undo(dry = false): string | null {
    const top = this.um.undoStack[this.um.undoStack.length - 1];
    if (!top) return null;
    const label = (top.meta.get("label") as string | undefined) || "your last change";
    if (!dry) this.um.undo();
    return label;
  }
}
