// The architecture as files: what goes in git, what agents edit in a pull request, what
// people review. The live document is written out to these a moment after edits settle,
// and edits to the files (a pull, a merged PR, an agent) are read back in as ordinary edits.
//
//   archnm.yaml              name, and what `archnm check` refuses (forbid: [regex...])
//   model/<system>.yaml     a top-level object with an inside, everything in it, and the
//                           entities those define (a scope: one agent can own the file)
//   model/_top.yaml         every other top-level object (actors, external systems), and
//                           entities nothing owns yet
//   code/<repo>/<path>.yaml a source file's module, its functions and their calls, at the
//                           source file's own path (code/<repo>/<dir>/_.yaml for a folder or
//                           package), so a pull request shows the code and its map together
//   libraries.yaml          third-party packages the code uses
//   boundaries.yaml         where things run (projects, networks, subnets, the edge): each
//                           with its kind, what it's `in`, and rules for what's inside
//   views/<view>.yaml       a diagram: its scope, what's on it (rules or a list), its flows,
//                           its links (RFCs, runbooks; `on` a box or loose)
//   layout/<view>.json      where each box (and link) sits; written by Archnemesis, safe to delete
//
// Comment threads are not in the files: they're conversation, kept in Archnemesis's database.
//
// Objects are keyed by id: a readable slug given once ("shop-api") that doesn't change when
// the thing is renamed. Entities are keyed by their type name ("PaidOrder"), and everything
// points at them by it. Strict about the graph (ids, kinds, ends, entity names are checked),
// free about the prose (context, notes). Loose in, tidy out: the reader takes the natural
// forms an agent writes (one word for a list, "Rust, Axum", any case for kind), the writer
// puts back one canonical form (fixed key order, defaults and what a signature already says
// left out), so writing what was read gives the same bytes. See docs/grammar-v2.md.
import YAML from "yaml";
import { FIELDS } from "./spec.ts";

/** The design's settings file, and the name it had before the rename (still read, never written). */
export const DESIGN_FILE = "archnm.yaml";
export const OLD_DESIGN_FILE = "atlas.yaml";

/** Reads the old name: a folder's atlas.yaml counts as archnm.yaml (the new name wins if both exist). */
export function normalizeDesignFile(files: Map<string, string>): Map<string, string> {
  const old = files.get(OLD_DESIGN_FILE);
  if (old === undefined) return files;
  const out = new Map(files);
  out.delete(OLD_DESIGN_FILE);
  if (!out.has(DESIGN_FILE)) out.set(DESIGN_FILE, old);
  return out;
}

/** Does this folder (or tree listing) have a design file, under either name? */
export const hasDesignFile = (files: { has(path: string): boolean }): boolean =>
  files.has(DESIGN_FILE) || files.has(OLD_DESIGN_FILE);

/** A tag group's name: what comes before the colon. */
const TAG_GROUP = /^[a-z][a-z0-9-]{0,31}$/;
/** The fields archnm.yaml's protect can name. */
const PROTECTABLE = /^(refs\.[a-z][a-z0-9_-]{0,31}|name|in|status|kind)$/;

function readRefs(
  file: string,
  where: string,
  v: unknown,
  err: (file: string, message: string) => void,
): Record<string, string> | undefined {
  if (v === undefined) return undefined;
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    err(file, `${where}: refs is a map of name to value (sys: SYS-5)`);
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(k))
      err(file, `${where}: refs.${k}: names are lowercase (sys, key, linear)`);
    else if (x === null || typeof x === "object")
      err(file, `${where}: refs.${k}: a value, not a list or map`);
    else out[k] = String(x);
  }
  return Object.keys(out).length ? out : undefined;
}

type Err = (file: string, message: string) => void;

/** How many single-letter edits turn a into b (case ignored). */
export function editDistance(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++)
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1),
      );
    prev = cur;
  }
  return prev[y.length]!;
}

/** The one of `among` that `word` is a typo of (a letter or two off, or another case), if any. */
function closest(word: string, among: Iterable<string>): string | undefined {
  const most = word.length <= 4 ? 1 : 2;
  let best: string | undefined;
  let bestD = Infinity;
  for (const c of among) {
    if (c === word) continue;
    const d = editDistance(word, c);
    if (d <= most && d < bestD) ((best = c), (bestD = d));
  }
  return best;
}

/** The first line with a comment that isn't the file's heading (the comment block it opens with). */
export function commentLine(text: string): number {
  let line = 1;
  let started = false;
  for (const tok of new YAML.Lexer().lex(text)) {
    const type = YAML.CST.tokenType(tok);
    if (type === "comment" && started) return line;
    if (
      type !== "comment" &&
      type !== "newline" &&
      type !== "space" &&
      type !== "doc-mode" &&
      type !== "doc-start" &&
      type !== "byte-order-mark"
    )
      started = true;
    // The lexer's markers (doc-mode, scalar, flow error) aren't in the text.
    if (tok !== "\x02" && tok !== "\x18" && tok !== "\x1f")
      for (const ch of tok) if (ch === "\n") line++;
  }
  return 0;
}

/** One of `values`, in any case: Kind: App reads as app. A near miss says what was meant. */
function readEnum(
  file: string,
  where: string,
  field: string,
  v: unknown,
  values: readonly string[],
  err: Err,
): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim().toLowerCase();
  if (values.includes(s)) return s;
  const near = closest(s, values);
  err(
    file,
    `${where}: ${field} "${String(v)}" isn't one of ${values.join(", ")}${near ? ` (did you mean ${near}?)` : ""}`,
  );
  return undefined;
}

/** A list of words; one on its own, or "a, b", reads as the list. */
function readWords(
  file: string,
  where: string,
  field: string,
  v: unknown,
  err: Err,
): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return techList(v);
  if (
    Array.isArray(v) &&
    v.every((x) => typeof x === "string" || typeof x === "number" || typeof x === "boolean")
  )
    return v.map((x) => String(x).trim()).filter(Boolean);
  err(file, `${where}: ${field} is a list of words: [a, b]`);
  return undefined;
}

/** Entity names: a list of type names (one on its own is the list). */
function readNames(
  file: string,
  where: string,
  field: string,
  v: unknown,
  err: Err,
): string[] | undefined {
  const words = readWords(file, where, field, v, err);
  if (!words) return undefined;
  const ok = words.filter((w) => {
    if (TYPE_NAME.test(w)) return true;
    err(file, `${where}: ${field}: "${w}": ${TYPE_NAME_RULE}`);
    return false;
  });
  return ok.length ? [...new Set(ok)] : undefined;
}

/** true, or left out. */
function readFlag(
  file: string,
  where: string,
  field: string,
  v: unknown,
  err: Err,
): true | undefined {
  if (v === undefined || v === null || v === false || (typeof v === "string" && /^false$/i.test(v)))
    return undefined;
  if (v === true || (typeof v === "string" && /^true$/i.test(v))) return true;
  err(file, `${where}: ${field} is true or left out (got ${JSON.stringify(v)})`);
  return undefined;
}

/** An entity's fields: a map name → type (a key with ( ) is a method), or older "name type" lines. */
function readFields(file: string, where: string, v: unknown, err: Err): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v) && v.every((x) => typeof x === "string"))
    return v.map((x) => x.trim()).filter(Boolean);
  if (typeof v === "object" && !Array.isArray(v)) {
    const out: string[] = [];
    for (const [k, t] of Object.entries(v as Record<string, unknown>)) {
      if (t !== null && typeof t === "object")
        err(
          file,
          `${where}: fields.${k}: a field's type is one word or a short text ("[OrderItem]", text?), not a list or map`,
        );
      else out.push(fieldLine(k, t === null ? "" : String(t)));
    }
    return out;
  }
  err(file, `${where}: fields is a map of name to type: { id: uuid, total: Money }`);
  return undefined;
}

/** A box in a layout file, or null when it isn't one. */
function readBox(v: unknown): Box | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const b = v as Record<string, unknown>;
  const num = (x: unknown) => typeof x === "number" && Number.isFinite(x);
  if (
    !Object.keys(b).every((k) => ["x", "y", "w", "h", "parts"].includes(k)) ||
    !num(b.x) ||
    !num(b.y)
  )
    return null;
  if (b.w !== undefined && !(num(b.w) && (b.w as number) > 0)) return null;
  if (b.h !== undefined && !(num(b.h) && (b.h as number) > 0)) return null;
  if (
    b.parts !== undefined &&
    !(Array.isArray(b.parts) && b.parts.length === 2 && b.parts.every(num))
  )
    return null;
  return {
    x: b.x as number,
    y: b.y as number,
    ...(b.w !== undefined ? { w: b.w as number } : {}),
    ...(b.h !== undefined ? { h: b.h as number } : {}),
    ...(b.parts ? { parts: b.parts as [number, number] } : {}),
  };
}

/** code/<repo>/<path>.yaml for a source file, code/<repo>/<path>/_.yaml for a folder or package. */
export function codeFile(path: string): string {
  const i = path.indexOf(":");
  const repo = path.slice(0, i);
  const rest = path.slice(i + 1).replace(/\/+$/, "");
  const last = rest.split("/").pop() ?? "";
  return /\.[A-Za-z0-9]+$/.test(last) && !path.endsWith("/")
    ? `code/${repo}/${rest}.yaml`
    : `code/${repo}/${rest}/_.yaml`;
}

function readPath(
  file: string,
  where: string,
  kind: string,
  v: unknown,
  err: (file: string, message: string) => void,
): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v.length > 500 || !CODE_PATH.test(v)) {
    err(
      file,
      `${where}: path is repo:path/in/the/repo (a slug, a colon, a relative path without ..)`,
    );
    return undefined;
  }
  if (!PATH_KINDS.includes(kind))
    err(
      file,
      `${where}: only a module, app or component has a path (where its code lives); a ${kind} doesn't`,
    );
  return v;
}

function readPackage(
  file: string,
  where: string,
  kind: string,
  v: unknown,
  err: (file: string, message: string) => void,
): Package | undefined {
  if (v === undefined) return undefined;
  const p = (v ?? {}) as Record<string, unknown>;
  if (
    typeof v !== "object" ||
    Array.isArray(v) ||
    !ECOSYSTEMS.includes(p.ecosystem as never) ||
    typeof p.name !== "string" ||
    !p.name.trim()
  ) {
    err(
      file,
      `${where}: package is { ecosystem: one of ${ECOSYSTEMS.join(", ")}, name, version? }`,
    );
    return undefined;
  }
  for (const k of Object.keys(p))
    if (!["ecosystem", "name", "version"].includes(k))
      err(file, `${where}: package has no field "${k}"`);
  if (kind !== "library") err(file, `${where}: only a library has a package`);
  return {
    ecosystem: p.ecosystem as Package["ecosystem"],
    name: p.name,
    ...(p.version !== undefined ? { version: String(p.version) } : {}),
  };
}

function readSources(
  file: string,
  where: string,
  v: unknown,
  err: (file: string, message: string) => void,
): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) {
    err(file, `${where}: sources is a list ("repo@sha:path:line" or an address)`);
    return undefined;
  }
  const out = v.map(String).filter((s) => s.trim());
  for (const s of out)
    if (!sourceLink("x", s))
      err(
        file,
        `${where}: source "${s.slice(0, 80)}" should be repo@ref:path[:line], repo:path (not written yet) or an http(s) address`,
      );
  return out.length ? out : undefined;
}

/** Where a source points: an address as is, or repo@sha:path:line on GitHub under `owner`. */
export function sourceLink(owner: string | undefined, s: string): string | null {
  if (/^https?:\/\//.test(s)) return safeUrl(s) ?? null;
  // repo:path (no ref) is a file that isn't written yet: it links to where it will be.
  const m = /^([A-Za-z0-9._-]+)(?:@([A-Za-z0-9._/-]+))?:([^:\s]+)(?::(\d+)(?:-(\d+))?)?$/.exec(s);
  if (!m) return null;
  if (!owner) return "";
  const [, repo, ref, path, from, to] = m;
  return `https://github.com/${owner}/${repo}/blob/${ref ?? "HEAD"}/${path}${from ? `#L${from}${to ? `-L${to}` : ""}` : ""}`;
}
import { agentsGuide } from "./agentsmd.ts";
import { PATH_KINDS, akey, pkey, type ModelState } from "./doc.ts";
import type { Decision, Entity } from "./model.ts";
import {
  ARROW_STYLES,
  BOUNDARY_KINDS,
  DECISION_STATUSES,
  CODE_PATH,
  ECOSYSTEMS,
  FLOW_KINDS,
  type FlowKind,
  type Package,
  FOLD_MODES,
  type FoldMode,
  type DecisionStatus,
  type Boundary,
  type BoundaryKind,
  LAYOUT_DIRECTIONS,
  OBJECT_KINDS,
  SIDES,
  type ArrowShape,
  type BoxSide,
  STATUSES,
  isPlaceholderName,
  makeStep,
  slug,
  type ArrowStyle,
  type LayoutDirection,
  type Column,
  type Connection,
  type Diagram,
  type Flow,
  type ModelObject,
  type ObjectKind,
  type Op,
  type Status,
  safeUrl,
  REFERENCE_KINDS,
  type ReferenceKind,
  type Reference,
  type DocLink,
  mergedContext,
  boxSize,
  isTbd,
  SAFE_KEY,
  TYPE_NAME,
  TYPE_NAME_RULE,
} from "./model.ts";
import { titleFromUrl } from "./notes.ts";
import { signatureTypes } from "./entities.ts";
import { selectorError, type Rules, type Selector } from "./views.ts";

const FORMAT_VERSION = 2;

// --- the shapes in the files --------------------------------------------------------------

interface FObject {
  id: string;
  kind: ObjectKind;
  name: string;
  in?: string;
  /** For agents (markdown): the detail behind it. */
  context?: string;
  /** Comma separated here ("Rust, Axum"); a list in the file. */
  tech?: string;
  icon?: string;
  path?: string;
  package?: Package;
  signature?: string;
  /** A table's columns, in order. */
  columns?: Column[];
  status?: Status;
  external?: boolean;
  tags?: string[];
  refs?: Record<string, string>;
  sources?: string[];
  references?: FReference[];
  /** Every entity it points at, by name: the ones its signature names (not written: worked
   * out when read) and the rest (written as uses). */
  uses?: string[];
  notes?: string;
  guess?: true;
}

/** A reference in the files: one of link, image, doc, code, dependency, with an optional title. Entities are `uses`/`carries`. */
type FReference = { title?: string } & (
  { link: string } | { image: string } | { doc: string } | { code: string } | { dependency: string }
);
const REF_KEYS = ["link", ...REFERENCE_KINDS.filter((k) => k !== "entity")] as const;

/** A reference's kind and target, from its one key. */
function refTarget(r: FReference): { kind: "link" | ReferenceKind; to: string } {
  for (const k of REF_KEYS)
    if (k in r) return { kind: k, to: String((r as Record<string, unknown>)[k]) };
  return { kind: "link", to: "" };
}

export interface FEntity {
  /** Its name, which is its id ("PaidOrder"). */
  id: string;
  /** The box it's defined in (an object's id). */
  in?: string;
  /** Other entities, by name. */
  extends?: string[];
  context?: string;
  /** One line each, as the model keeps them: "id uuid", "items [OrderItem]", "charge(amount: money) -> Receipt". */
  fields?: string[];
  /** An enum's values. */
  values?: string[];
  /** Not defined in any file: named in a uses, carries or extends, so it's a TBD entity. */
  implicit?: true;
}

interface FDecision {
  /** Its file name under decisions/, without .yaml. */
  id: string;
  title: string;
  status: DecisionStatus;
  date?: string;
  affects?: string[];
  superseded_by?: string;
  text?: string;
}

interface FBoundary {
  id: string;
  name: string;
  kind: BoundaryKind;
  in?: string;
  description?: string;
  include?: Selector[];
  exclude?: Selector[];
}

/** A connection's label is drawn on its line: past this many characters it reads as a sentence. */
const LABEL_MAX = 32;

export interface FConnection {
  from: string;
  to: string;
  label?: string;
  description?: string;
  /** For agents (markdown): what travels over it. */
  context?: string;
  tech?: string;
  status?: Status;
  via?: string;
  sources?: string[];
  guess?: true;
  both?: true;
  /** A key between tables: the column holding it, and the one it points at. */
  column?: string;
  to_column?: string;
  /** The entities that travel over it, by name. */
  carries?: string[];
  /** What it points at: links, docs, code, images (as an object's). */
  references?: FReference[];
  /** Its running doc (markdown), as an object's. */
  notes?: string;
}

interface FStep {
  from: string;
  to: string;
  text?: string;
}

interface FView {
  key: string;
  name: string;
  scope?: string;
  /** A hand-picked diagram lists its boxes; one that follows the model has rules. */
  boxes?: string[];
  include?: Selector[];
  exclude?: Selector[];
  flows?: { name: string; kind?: FlowKind; steps: FStep[] }[];
  /** How arrows are drawn on it; left out for curved. */
  arrows?: ArrowStyle;
  /** Which way Tidy lays it out (right or down). On its own it moves nothing. */
  tidy?: LayoutDirection;
  /** Lay it out again on its own whenever boxes or arrows come or go; left out for off. */
  keep_tidy?: boolean;
  /** Links on it (an RFC, a runbook): pinned under a box (`on`), or loose. */
  links?: FLink[];
  /** Draw boundaries (projects, networks) around its boxes; left out for off. */
  boundaries?: true;
  /** Colour boxes by this tag group. */
  color_by?: string;
  /** How to read it (markdown), shown as a caption. */
  story?: string;
  /** For agents (markdown): the brief behind it. */
  context?: string;
  /** Fold externals into one box (externals), or don't (none); left out for the default. */
  fold?: FoldMode;
  /** Folded groups opened here, each framed (a group: value, or externals). */
  unfolded?: string[];
  /** Connections touching what these pick aren't drawn. */
  hide_lines?: Selector[];
  /** Columns by this tag group's values. */
  lanes?: string;
}

interface FLink {
  title: string;
  url: string;
}

/** A box in a layout file: where it is, its size when it isn't its kind's default, and where its layer nodes were dragged to (from its corner). */
interface Box {
  x: number;
  y: number;
  w?: number;
  h?: number;
  parts?: [number, number];
}

/** An arrow shaped by hand, in a layout file under "@arrows", keyed "from>to". */
export interface FArrow {
  from?: BoxSide;
  to?: BoxSide;
  /** Where along that side, 0 to 1, when put there by hand. */
  from_at?: number;
  to_at?: number;
  /** A split point: arrows from the same box with the same one run as one line to it. */
  split?: [number, number];
  /** A join point: arrows into the same box with the same one meet there and go in as one line. */
  join?: [number, number];
  bends?: [number, number][];
  label?: number;
  /** Where what it carries was dragged to, from its label's corner. */
  parts?: [number, number];
}

/** The key in a layout file that holds arrow shapes ("@" can't start an object key). */
const ARROWS_KEY = "@arrows";
/** The key in a layout file that holds where links sit, keyed by address. */
const LINKS_KEY = "@links";

export interface FConfig {
  name?: string;
  version?: number;
  /** Patterns `archnm check` refuses anywhere in the model (case-insensitive regexes). */
  forbid?: string[];
  /** Tag groups: tags written group:value, with the values allowed and their colours. */
  tags?: Record<string, FTagGroup>;
  /** Fields only a person changes ("refs.sys"): apply refuses agents, a PR summary flags them. */
  protect?: string[];
  /** When a diagram is too busy to read: check warns past these. */
  limits?: { boxes?: number; lines?: number };
  /** The GitHub owner that repo@sha:path sources link to. */
  github?: string;
}

interface FTagGroup {
  description?: string;
  values: string[];
  /** value → colour (#rrggbb). */
  colors?: Record<string, string>;
}

export const DEFAULT_LIMITS = { boxes: 15, lines: 20 };
/** Top-level objects with nothing inside, and entities nothing defines. */
const TOP_FILE = "model/_top.yaml";

export interface FileModel {
  config: FConfig;
  objects: FObject[];
  connections: FConnection[];
  boundaries: FBoundary[];
  entities: FEntity[];
  decisions: FDecision[];
  views: FView[];
  layouts: Map<string, Record<string, Box>>;
  /** view key → "from>to" → its arrow's hand-made shape */
  arrows: Map<string, Record<string, FArrow>>;
  /** view key → link address → [x, y] (under its box, if it's on one) */
  linkSpots: Map<string, Record<string, [number, number]>>;
  /** Which file each object and view came from, for messages ("object:<id>"; a field's own line as "object:<id>#in"). */
  origin: Map<string, string>;
  /** Objects that didn't read (a kind that isn't one, not a map): what points at them still finds them, so one mistake is one error. */
  stubs?: Set<string>;
}

export interface Problem {
  level: "error" | "warning";
  file: string;
  message: string;
}

// --- writing --------------------------------------------------------------------------------

const keyOf = (o: { id: string; key?: string }): string => o.key ?? o.id;

/** Keys for objects and diagrams that don't have one yet (and have a real name). */
export function keyOps(state: ModelState): Op[] {
  const ops: Op[] = [];
  const used = new Set<string>();
  for (const o of state.objects.values()) if (o.key) used.add(o.key);
  const fresh = (name: string): string => {
    const base = slug(name);
    let k = base;
    for (let i = 2; used.has(k); i++) k = `${base}-${i}`;
    used.add(k);
    return k;
  };
  for (const o of state.objects.values()) {
    if (o.key || isPlaceholderName(o.name)) continue;
    ops.push({ op: "object.put", object: { ...o, key: fresh(o.name) } });
  }
  used.clear();
  for (const b of state.boundaries.values()) if (b.key) used.add(b.key);
  for (const b of state.boundaries.values())
    if (!b.key) ops.push({ op: "boundary.put", boundary: { ...b, key: fresh(b.name) } });
  // An entity's key in the files is its name.
  for (const e of state.entities.values())
    if (e.key !== e.name && TYPE_NAME.test(e.name))
      ops.push({ op: "entity.put", entity: { ...e, key: e.name } });
  used.clear();
  for (const d of state.diagrams.values()) if (d.key) used.add(d.key);
  for (const d of state.diagrams.values()) {
    if (d.key || d.name === "Untitled diagram") continue;
    ops.push({ op: "diagram.put", diagram: { ...d, key: fresh(d.name) } });
  }
  return ops;
}

/** Lists of words written on one line: tags: [pci, team:orders]. */
const INLINE_LISTS = new Set(["tags", "ids", "tech", "uses", "carries", "extends", "values"]);
/** A connection or a field map is written on one line when it's about this long or less. */
const ONE_LINE = 150;

/** Files written before, by what's in them (a write changes a few of a design's thousands). */
const written = new Map<string, string>();
function yaml(header: string, value: unknown): string {
  const k = `${header}\0${JSON.stringify(value)}`;
  const hit = written.get(k);
  if (hit !== undefined) return hit;
  const out = yamlFresh(header, value);
  if (written.size >= PARSED_MAX) written.delete(written.keys().next().value!);
  written.set(k, out);
  return out;
}
function yamlFresh(header: string, value: unknown): string {
  const comment = header
    .split("\n")
    .map((l) => `# ${l}`.trimEnd())
    .join("\n");
  return `${comment}\n${yamlBody(value)}`;
}

/** Short enough, and with no text that needs lines of its own, to sit on one line. */
const fitsOneLine = (v: unknown, max: number) => {
  const s = JSON.stringify(v);
  return s.length <= max && !s.includes("\\n");
};

function yamlBody(value: unknown): string {
  const doc = new YAML.Document(value, { aliasDuplicateObjects: false });
  const keyIs = (n: unknown, k: string) =>
    YAML.isPair(n) && YAML.isScalar(n.key) && String(n.key.value) === k;
  YAML.visit(doc, {
    Pair: (_, pair, path) => {
      if (!YAML.isScalar(pair.key)) return;
      const k = String(pair.key.value);
      // Short lists of words read better inline: tags: [pci, team:orders].
      if (INLINE_LISTS.has(k) && YAML.isSeq(pair.value)) pair.value.flow = true;
      // An entity's fields (entities: → its name → fields:) on one line while there are a few short ones.
      if (
        k === "fields" &&
        keyIs(path[path.length - 4], "entities") &&
        YAML.isMap(pair.value) &&
        pair.value.items.length <= 4 &&
        fitsOneLine(pair.value.toJSON(), 90)
      )
        pair.value.flow = true;
      // A connection a line (the file's own connections: list): a diff shows which one changed.
      if (k === "connections" && path.length === 2 && YAML.isSeq(pair.value))
        for (const item of pair.value.items)
          if (YAML.isMap(item) && fitsOneLine(item.toJSON(), ONE_LINE)) item.flow = true;
    },
  });
  return doc.toString({ lineWidth: 0, indent: 2, flowCollectionPadding: false });
}

/** One object as it's written in the design's files (for showing it, or diffing two versions); entities by name (one `entityName` doesn't know is left out). */
export function objectYaml(
  o: ModelObject,
  key: (id: string) => string,
  entityName: (id: string) => string | undefined = () => undefined,
): string {
  const f = fObject(o, key, entityName);
  return yamlBody({ [f.id]: diskObject(f) });
}

/** One connection as it's written in the design's files. */
export function connectionYaml(
  c: Connection,
  key: (id: string) => string,
  entityName: (id: string) => string | undefined = () => undefined,
): string {
  return yamlBody(diskConnection(fConnection(c, key, entityName)));
}

/** Prose (context, notes, a description) as the files keep it: trimmed, and ending in a newline when it has lines of its own (a block). */
function prose(s: string | undefined): string | undefined {
  const t = s?.trim();
  return t ? (t.includes("\n") ? `${t}\n` : t) : undefined;
}

/** "Rust, Axum" ↔ [Rust, Axum]: split at commas that aren't inside brackets ("TypeScript (browser, server)" is one). */
export function techList(tech: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of tech) {
    if ("([{<".includes(ch)) depth++;
    else if (")]}>".includes(ch)) depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) (out.push(cur.trim()), (cur = ""));
    else cur += ch;
  }
  out.push(cur.trim());
  return out.filter(Boolean);
}

/** A field line as its key and type in an entity's fields map: "items [OrderItem]" → ["items", "[OrderItem]"]; "charge(a: Money) -> Receipt" → ["charge(a: Money)", "Receipt"]. A method is name( with no space: "pair (int, int)?" is a field named pair. */
function fieldPair(line: string): [string, string] {
  const t = line.trim();
  const m = /^[\w$]+\(/.exec(t);
  if (m) {
    let depth = 0;
    for (let i = m[0].length - 1; i < t.length; i++) {
      if (t[i] === "(") depth++;
      else if (t[i] === ")" && --depth === 0)
        return [t.slice(0, i + 1), t.slice(i + 1).replace(/^\s*(?:->|→|:)?\s*/, "")];
    }
    return [t, ""];
  }
  const s = /^(\S+)\s+(.*)$/.exec(t);
  return s ? [s[1]!, s[2]!.trim()] : [t, ""];
}

/** Back to the line the model keeps: a method "charge(a: Money) -> Receipt", a field "items [OrderItem]". */
function fieldLine(key: string, type: string): string {
  const k = key.trim();
  const t = type.trim();
  if (!t) return k;
  return /^[\w$]+\(.*\)$/.test(k) ? `${k} -> ${t}` : `${k} ${t}`;
}

/** An object as its file has it: keyed by id, its name only when that differs, what its signature names left to the signature. */
function diskObject(f: FObject): Record<string, unknown> {
  const named = new Set(signatureTypes(f.signature));
  const uses = (f.uses ?? []).filter((n) => !named.has(n));
  return {
    kind: f.kind,
    ...(f.name !== f.id ? { name: f.name } : {}),
    ...(f.in ? { in: f.in } : {}),
    ...(f.context ? { context: f.context } : {}),
    ...(f.tech ? { tech: techList(f.tech) } : {}),
    ...(f.icon ? { icon: f.icon } : {}),
    ...(f.path ? { path: f.path } : {}),
    ...(f.package ? { package: f.package } : {}),
    ...(f.signature ? { signature: f.signature } : {}),
    ...(f.columns ? { columns: f.columns } : {}),
    ...(f.status ? { status: f.status } : {}),
    ...(f.external ? { external: true } : {}),
    ...(f.tags ? { tags: f.tags } : {}),
    ...(f.refs ? { refs: f.refs } : {}),
    ...(f.sources ? { sources: f.sources } : {}),
    ...(uses.length ? { uses } : {}),
    ...(f.references ? { references: f.references } : {}),
    ...(f.notes ? { notes: f.notes } : {}),
    ...(f.guess ? { guess: true } : {}),
  };
}

function diskConnection(f: FConnection): Record<string, unknown> {
  return Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined));
}

/** An entity as its file has it: keyed by name, its fields as name → type. */
function diskEntity(f: FEntity): Record<string, unknown> | null {
  const pairs = (f.fields ?? []).map(fieldPair);
  // Two fields with one name can't be keys of a map: then the lines as they are.
  const fields =
    new Set(pairs.map(([k]) => k)).size === pairs.length ? Object.fromEntries(pairs) : f.fields;
  const out = {
    ...(f.in ? { in: f.in } : {}),
    ...(f.extends?.length ? { extends: f.extends } : {}),
    ...(f.context ? { context: f.context } : {}),
    ...(f.values?.length ? { values: f.values } : {}),
    ...(pairs.length ? { fields } : {}),
  };
  return Object.keys(out).length ? out : null;
}

const byKey =
  <T>(get: (x: T) => string) =>
  (a: T, b: T) =>
    get(a) < get(b) ? -1 : get(a) > get(b) ? 1 : 0;

function fObject(
  o: ModelObject,
  key: (id: string) => string,
  entityName: (id: string) => string | undefined,
): FObject {
  const f: FObject = { id: keyOf(o), kind: o.kind, name: o.name };
  if (o.parentId) f.in = key(o.parentId);
  const text = prose(mergedContext(o.description, o.context));
  if (text) f.context = text;
  if (o.technology) f.tech = o.technology;
  if (o.icon) f.icon = o.icon;
  if (o.path) f.path = o.path;
  if (o.package)
    f.package = {
      ecosystem: o.package.ecosystem,
      name: o.package.name,
      ...(o.package.version ? { version: o.package.version } : {}),
    };
  if (o.signature) f.signature = o.signature;
  if (o.columns?.length) f.columns = o.columns.map(fColumn);
  if (o.status !== "live") f.status = o.status;
  if (o.external) f.external = true;
  if (o.tags?.length) f.tags = [...o.tags].sort();
  if (o.refs && Object.keys(o.refs).length)
    f.refs = Object.fromEntries(Object.entries(o.refs).sort(([a], [b]) => (a < b ? -1 : 1)));
  if (o.sources?.length) f.sources = [...o.sources];
  const refs = fReferences(o, key);
  if (refs.length) f.references = refs;
  const uses = entityRefs(o, entityName);
  if (uses.length) f.uses = uses;
  const notes = prose(o.notes);
  if (notes) f.notes = notes;
  if (o.guess) f.guess = true;
  return f;
}

/** A box's or a connection's links and references (not its entities), as one list for its file. */
function fReferences(
  o: { links?: DocLink[]; references?: Reference[] },
  key: (id: string) => string,
): FReference[] {
  return [
    ...(o.links ?? []).map((l) => ({
      link: l.url,
      ...(l.title && l.title !== titleFromUrl(l.url) ? { title: l.title } : {}),
    })),
    ...(o.references ?? [])
      .filter((r) => r.kind !== "entity")
      .map(
        (r) =>
          ({
            [r.kind]: r.kind === "dependency" ? key(r.to) : r.to,
            ...(r.title ? { title: r.title } : {}),
          }) as FReference,
      ),
  ];
}

/** The entities a box or a connection points at, by name, once each (never an id: one that isn't known is left out). */
function entityRefs(
  o: { references?: Reference[] },
  entityName: (id: string) => string | undefined,
): string[] {
  return [
    ...new Set(
      (o.references ?? []).flatMap((r) => (r.kind === "entity" ? (entityName(r.to) ?? []) : [])),
    ),
  ];
}

function fConnection(
  c: Connection,
  key: (id: string) => string,
  entityName: (id: string) => string | undefined,
): FConnection {
  const f: FConnection = { from: key(c.fromId), to: key(c.toId) };
  if (c.name) f.label = c.name;
  const description = prose(c.description);
  if (description) f.description = description;
  // Always a block: what travels over it reads as its own paragraph.
  const context = prose(c.context);
  if (context) f.context = context.endsWith("\n") ? context : `${context}\n`;
  if (c.technology) f.tech = c.technology;
  if (c.status !== "live") f.status = c.status;
  if (c.viaId) f.via = key(c.viaId);
  if (c.sources?.length) f.sources = [...c.sources];
  if (c.guess) f.guess = true;
  if (c.both) f.both = true;
  if (c.column) f.column = c.column;
  if (c.toColumn) f.to_column = c.toColumn;
  const carries = entityRefs(c, entityName);
  if (carries.length) f.carries = carries;
  const refs = fReferences(c, key);
  if (refs.length) f.references = refs;
  const notes = prose(c.notes);
  if (notes) f.notes = notes;
  return f;
}

/** A column with only what it says, flags after the type. */
function fColumn(c: Column): Column {
  return {
    name: c.name,
    type: c.type,
    ...(c.pk ? { pk: true } : {}),
    ...(c.unique ? { unique: true } : {}),
    ...(c.nullable ? { nullable: true } : {}),
    ...(c.personal ? { personal: true } : {}),
    ...(c.description ? { description: c.description } : {}),
  };
}

const COLUMN_FIELDS = ["name", "type", "pk", "unique", "nullable", "personal", "description"];

/** A column written as a line ("id uuid pk") or a one-key map ({id: uuid}), as the map it should be. */
function columnFix(raw: unknown): string | null {
  const flags = (ws: string[]) =>
    ws
      .filter((w) => ["pk", "unique", "nullable", "personal"].includes(w.toLowerCase()))
      .map((w) => `, ${w.toLowerCase()}: true`)
      .join("");
  if (typeof raw === "string") {
    const [name, type, ...rest] = raw.trim().split(/\s+/);
    return name
      ? `{name: ${name}${type && !flags([type]) ? `, type: ${type}` : ""}${flags(type && flags([type]) ? [type, ...rest] : rest)}}`
      : null;
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const ks = Object.entries(raw as Record<string, unknown>);
    if (ks.length === 1 && (typeof ks[0]![1] === "string" || ks[0]![1] === null)) {
      const [name, val] = ks[0]!;
      const [type, ...rest] = String(val ?? "")
        .split(/\s+/)
        .filter(Boolean);
      return `{name: ${name}${type ? `, type: ${type}` : ""}${flags(rest)}}`;
    }
  }
  return null;
}

function readColumns(
  file: string,
  where: string,
  kind: string,
  v: unknown,
  err: (file: string, message: string) => void,
): Column[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) {
    err(
      file,
      `${where}: columns is a list of { name, type, pk?, unique?, nullable?, personal?, description? }`,
    );
    return undefined;
  }
  if (kind !== "table") err(file, `${where}: only a table has columns`);
  const out: Column[] = [];
  const seen = new Set<string>();
  // Columns written another way ("id uuid pk", {id: uuid}): one error for the list, with the shape and the first one rewritten.
  const shapeless: [number, unknown][] = [];
  for (const [i, raw] of v.entries()) {
    const c = (raw ?? {}) as Record<string, unknown>;
    const at = `${where}.columns[${i}]`;
    if (
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      raw === null ||
      typeof c.name !== "string" ||
      !c.name.trim()
    ) {
      shapeless.push([i, raw]);
      continue;
    }
    for (const k of Object.keys(c))
      if (!COLUMN_FIELDS.includes(k))
        err(file, `${at}: a column has no field "${k}" (${COLUMN_FIELDS.join(", ")})`);
    for (const k of ["pk", "unique", "nullable", "personal"])
      if (c[k] !== undefined && typeof c[k] !== "boolean")
        err(file, `${at}: ${k} is true or false`);
    const name = c.name.trim();
    if (seen.has(name)) err(file, `${at}: two columns are named ${name}`);
    seen.add(name);
    out.push(
      fColumn({
        name,
        type: c.type === undefined || c.type === null ? "" : String(c.type),
        pk: c.pk === true,
        unique: c.unique === true,
        nullable: c.nullable === true,
        personal: c.personal === true,
        ...(typeof c.description === "string" ? { description: c.description.trim() } : {}),
      }),
    );
  }
  if (shapeless.length) {
    const [i, raw] = shapeless[0]!;
    const fix = columnFix(raw);
    err(
      file,
      `${where}.columns: each column is a map {name, type, pk?, unique?, nullable?, personal?, description?}; ${shapeless.length === v.length ? "none of them is" : `${shapeless.length} of ${v.length} aren't`} (columns[${i}]: ${JSON.stringify(raw)}${fix ? ` → ${fix}` : ""}). guide {topic: "tables"}`,
    );
  }
  return out;
}

const mapSelector = (s: Selector, key: (id: string) => string): Selector => {
  if ("ids" in s) return { ids: s.ids.map(key).sort() };
  if ("children" in s) return { children: key(s.children) };
  if ("descendants" in s) return { descendants: key(s.descendants) };
  if ("neighbours" in s) return { neighbours: key(s.neighbours) };
  return s;
};

/** The whole model as files: path -> contents. */
export function writeFiles(state: ModelState, config: FConfig = {}): Map<string, string> {
  const out = new Map<string, string>();
  const key = (id: string) => {
    const o = state.objects.get(id);
    return o ? keyOf(o) : id;
  };
  // Entities are written, and pointed at, by name: never by id.
  const entityName = (id: string) => state.entities.get(id)?.name;
  const objects = [...state.objects.values()];
  const children = new Map<string, ModelObject[]>();
  for (const o of objects)
    if (o.parentId) children.set(o.parentId, [...(children.get(o.parentId) ?? []), o]);
  const top = (o: ModelObject): ModelObject => {
    let cur = o;
    const seen = new Set<string>();
    while (cur.parentId && state.objects.has(cur.parentId) && !seen.has(cur.id)) {
      seen.add(cur.id);
      cur = state.objects.get(cur.parentId)!;
    }
    return cur;
  };
  // Code lives at its source's own path: the nearest module (itself, or what it's in) with a path.
  // A path that isn't a place on disk (a pattern, repo:server/{git,forks}*.ts, grouping files)
  // names no file of its own: that module is written with what it's in, like a component.
  const onDisk = (path: string) =>
    /^[^:]+:[A-Za-z0-9._/-]*$/.test(path) &&
    !/(^|\/)\.\.?(\/|$)/.test(path.slice(path.indexOf(":") + 1));
  const codeHome = (o: ModelObject): string | null => {
    let cur: ModelObject | undefined = o;
    for (
      let n = 0;
      cur && n < 64;
      n++, cur = cur.parentId ? state.objects.get(cur.parentId) : undefined
    )
      if (cur.kind === "module" && cur.path && onDisk(cur.path)) return codeFile(cur.path);
    return null;
  };
  const fileOf = (o: ModelObject): string => {
    if (o.kind === "library") return "libraries.yaml";
    if (o.kind === "module" || o.kind === "function") {
      const home = codeHome(o);
      if (home) return home;
    }
    const t = top(o);
    return children.has(t.id) ? `model/${keyOf(t)}.yaml` : TOP_FILE;
  };

  out.set("AGENTS.md", agentsGuide(config));
  out.set(
    "archnm.yaml",
    yaml(
      "Archnemesis: architecture as files. See README for the format; `archnm check` validates.",
      {
        name: config.name ?? "architecture",
        version: FORMAT_VERSION,
        ...(config.forbid?.length ? { forbid: config.forbid } : {}),
        ...(config.tags && Object.keys(config.tags).length
          ? {
              tags: Object.fromEntries(
                Object.entries(config.tags).map(([g, t]) => [
                  g,
                  {
                    ...(t.description ? { description: t.description } : {}),
                    values: t.values,
                    ...(t.colors && Object.keys(t.colors).length ? { colors: t.colors } : {}),
                  },
                ]),
              ),
            }
          : {}),
        ...(config.protect?.length ? { protect: config.protect } : {}),
        ...(config.limits && Object.keys(config.limits).length ? { limits: config.limits } : {}),
        ...(config.github ? { github: config.github } : {}),
      },
    ),
  );

  // Decisions: one file each, named by id.
  for (const dc of state.decisions.values()) {
    const f: Omit<FDecision, "id"> = { title: dc.title, status: dc.status };
    if (dc.date) f.date = dc.date;
    const affects = dc.affects
      .filter((id) => state.objects.has(id))
      .map(key)
      .sort();
    if (affects.length) f.affects = affects;
    if (dc.supersededBy) f.superseded_by = dc.supersededBy;
    if (dc.text) f.text = dc.text.endsWith("\n") ? dc.text : `${dc.text}\n`;
    out.set(
      `decisions/${dc.id}.yaml`,
      yaml("An architecture decision: what was decided, why, and what it changes.", f),
    );
  }

  const groups = new Map<
    string,
    { objects: FObject[]; connections: FConnection[]; entities: FEntity[] }
  >();
  const group = (file: string) => {
    let g = groups.get(file);
    if (!g) groups.set(file, (g = { objects: [], connections: [], entities: [] }));
    return g;
  };
  // Depth-first from each top, so a parent always comes before what's inside it.
  const depths = new Map<string, number>();
  const depth = (o: ModelObject): number => {
    let d = depths.get(o.id);
    if (d !== undefined) return d;
    d = 0;
    for (let cur = o; cur.parentId && state.objects.has(cur.parentId) && d < 64; d++)
      cur = state.objects.get(cur.parentId)!;
    depths.set(o.id, d);
    return d;
  };
  for (const o of [...objects].sort((a, b) => depth(a) - depth(b) || byKey(keyOf)(a, b)))
    group(fileOf(o)).objects.push(fObject(o, key, entityName));
  // A connection lives with its caller.
  for (const c of state.connections.values()) {
    const from = state.objects.get(c.fromId);
    if (!from || !state.objects.has(c.toId)) continue;
    group(fileOf(from)).connections.push(fConnection(c, key, entityName));
  }
  // A TBD entity with no home that a uses, carries or extends names is made again from that
  // name when the files are read: it isn't written.
  const named = new Set<string>();
  for (const g of groups.values()) {
    for (const o of g.objects)
      for (const n of (diskObject(o).uses as string[] | undefined) ?? []) named.add(n);
    for (const c of g.connections) for (const n of c.carries ?? []) named.add(n);
  }
  for (const e of state.entities.values())
    for (const x of e.extends ?? []) if (state.entities.has(x)) named.add(entityName(x)!);
  const allNames = [...state.entities.values()].map((e) => e.name);
  const implied = (e: Entity) =>
    !e.sourceId &&
    isTbd(e) &&
    !e.description &&
    !e.extends?.length &&
    named.has(e.name) &&
    !closest(e.name, allNames);
  // An entity lives with the box that defines it; one nothing owns, in _top.yaml.
  for (const e of [...state.entities.values()].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    if (implied(e)) continue;
    const owner = e.sourceId ? state.objects.get(e.sourceId) : undefined;
    const f: FEntity = { id: e.name };
    if (owner) f.in = keyOf(owner);
    const ext = (e.extends ?? []).filter((x) => state.entities.has(x)).map((x) => entityName(x)!);
    if (ext.length) f.extends = ext;
    const context = prose(e.description);
    if (context) f.context = context;
    if (e.values?.length) f.values = [...e.values];
    if (e.fields.length) f.fields = [...e.fields];
    group(owner ? fileOf(owner) : TOP_FILE).entities.push(f);
  }
  for (const [file, g] of [...groups].sort(byKey(([f]) => f))) {
    g.connections.sort((a, b) =>
      byKey<FConnection>((c) => `${c.from}\u0000${c.to}\u0000${c.label ?? ""}`)(a, b),
    );
    const t =
      file === TOP_FILE
        ? "Top-level objects with nothing inside them, and entities nothing defines yet."
        : file === "libraries.yaml"
          ? "Third-party packages the code uses."
          : file.startsWith("code/")
            ? `${g.objects[0]?.path ?? ""}: the module, what's inside it, and their calls.`
            : `${g.objects[0]?.name ?? ""} and everything inside it.`;
    // An entity with nothing but its name is TBD: written with no body (Ledger: {}).
    const entities = Object.fromEntries(g.entities.map((e) => [e.id, diskEntity(e) ?? {}]));
    out.set(
      file,
      yaml(
        `${t}\nObjects by id, entities by name; connections live with their caller. See AGENTS.md.`,
        {
          ...(g.objects.length
            ? { objects: Object.fromEntries(g.objects.map((o) => [o.id, diskObject(o)])) }
            : {}),
          ...(g.entities.length ? { entities } : {}),
          ...(g.connections.length ? { connections: g.connections.map(diskConnection) } : {}),
        },
      ),
    );
  }

  // Boundaries: one file, parents before what's inside them.
  const bounds = [...state.boundaries.values()];
  if (bounds.length) {
    const bkey = (id: string) => {
      const b = state.boundaries.get(id);
      return b ? keyOf(b) : id;
    };
    const bdepth = (b: Boundary) => {
      let d = 0;
      for (let cur = b.parentId; cur && state.boundaries.has(cur) && d < 32; d++)
        cur = state.boundaries.get(cur)!.parentId;
      return d;
    };
    const list = bounds
      .sort((a, b) => bdepth(a) - bdepth(b) || byKey(keyOf)(a, b))
      .map((b) => {
        const f: FBoundary = { id: keyOf(b), name: b.name, kind: b.kind };
        if (b.parentId) f.in = bkey(b.parentId);
        if (b.description) f.description = b.description;
        if (b.rules.include.length) f.include = b.rules.include.map((s) => mapSelector(s, key));
        if (b.rules.exclude.length) f.exclude = b.rules.exclude.map((s) => mapSelector(s, key));
        return f;
      });
    out.set(
      "boundaries.yaml",
      yaml(
        "Where things run: projects, networks, subnets, the edge. Each holds what its rules pick (and what's inside those),\ndrawn as frames on views that ask for them (boundaries: true).",
        { boundaries: list },
      ),
    );
  }

  const flowsBy = new Map<string, Flow[]>();
  for (const f of state.flows.values())
    flowsBy.set(f.diagramId, [...(flowsBy.get(f.diagramId) ?? []), f]);
  for (const d of state.diagrams.values()) {
    const k = keyOf(d);
    const v: Omit<FView, "key"> = { name: d.name };
    if (d.scopeId) v.scope = key(d.scopeId);
    if (d.story) v.story = d.story.endsWith("\n") ? d.story : `${d.story}\n`;
    if (d.context) v.context = d.context.endsWith("\n") ? d.context : `${d.context}\n`;
    if (d.arrows && d.arrows !== "curved") v.arrows = d.arrows;
    if (d.tidy) v.tidy = d.tidy;
    if (d.keepTidy) v.keep_tidy = true;
    if (d.boundaries) v.boundaries = true;
    if (d.colorBy) v.color_by = d.colorBy;
    if (d.lanes) v.lanes = d.lanes;
    if (d.fold) v.fold = d.fold;
    if (d.unfolded?.length) v.unfolded = d.unfolded;
    if (d.hideLines?.length) v.hide_lines = d.hideLines.map((s) => mapSelector(s, key));
    const placed = [...state.placements.values()].filter(
      (p) => p.diagramId === d.id && state.objects.has(p.objectId),
    );
    if (d.rules) {
      v.include = d.rules.include.map((s) => mapSelector(s, key));
      if (d.rules.exclude.length) v.exclude = d.rules.exclude.map((s) => mapSelector(s, key));
    } else {
      v.boxes = placed.map((p) => key(p.objectId)).sort();
    }
    const flows = (flowsBy.get(d.id) ?? []).sort(byKey((f) => f.name));
    if (flows.length) {
      v.flows = flows.map((f) => ({
        name: f.name,
        ...(f.kind && f.kind !== "story" ? { kind: f.kind } : {}),
        steps: f.steps.map((s) => ({
          from: key(s.fromId),
          to: key(s.toId),
          ...(s.text ? { text: s.text } : {}),
        })),
      }));
    }
    if (d.links?.length) v.links = d.links.map((l) => ({ title: l.title, url: l.url }));
    out.set(
      `views/${k}.yaml`,
      yaml(
        d.rules
          ? "A diagram that follows the model: its boxes are whatever these rules match."
          : "A hand-picked diagram: exactly these boxes.",
        v,
      ),
    );
    const layout: Record<string, Box> = {};
    for (const p of placed.sort(byKey((p) => key(p.objectId)))) {
      const size = boxSize(state.objects.get(p.objectId)!.kind);
      const w = Math.max(1, Math.round(p.w));
      const h = Math.max(1, Math.round(p.h));
      // Its size only when it isn't its kind's.
      layout[key(p.objectId)] = {
        x: Math.round(p.x),
        y: Math.round(p.y),
        ...(w !== size.w ? { w } : {}),
        ...(h !== size.h ? { h } : {}),
        ...(p.parts
          ? { parts: [Math.round(p.parts.x), Math.round(p.parts.y)] as [number, number] }
          : {}),
      };
    }
    const arrows: Record<string, FArrow> = {};
    const shaped = [...state.arrows.values()].filter(
      (a) => a.diagramId === d.id && state.objects.has(a.from) && state.objects.has(a.to),
    );
    for (const a of shaped.sort(byKey((a) => `${key(a.from)}>${key(a.to)}`))) {
      const f: FArrow = {};
      if (a.fromSide) f.from = a.fromSide;
      if (a.toSide) f.to = a.toSide;
      if (a.fromSide && a.fromAt !== undefined) f.from_at = a.fromAt;
      if (a.toSide && a.toAt !== undefined) f.to_at = a.toAt;
      if (a.split) f.split = [Math.round(a.split.x), Math.round(a.split.y)];
      if (a.join) f.join = [Math.round(a.join.x), Math.round(a.join.y)];
      if (a.bends?.length) f.bends = a.bends.map((p) => [Math.round(p.x), Math.round(p.y)]);
      if (a.label !== undefined) f.label = a.label;
      if (a.parts) f.parts = [Math.round(a.parts.x), Math.round(a.parts.y)];
      arrows[`${key(a.from)}>${key(a.to)}`] = f;
    }
    out.set(`layout/${k}.json`, layoutJson(layout, arrows));
  }
  return out;
}

/** {"x": 1, "y": 2}: JSON on one line, spaced to read. */
const oneLineJson = (v: unknown) =>
  JSON.stringify(v)
    .replace(/,"/g, ', "')
    .replace(/":/g, '": ')
    .replace(/,(?=-?\d)/g, ", ");

/** One box per line: easy to read in a diff, and only moved boxes change. */
function layoutJson(
  layout: Record<string, Box>,
  arrows: Record<string, FArrow> = {},
  links: Record<string, [number, number]> = {},
): string {
  const lines = Object.entries(layout).map(([k, b]) => `  ${JSON.stringify(k)}: ${oneLineJson(b)}`);
  const shaped = Object.entries(arrows);
  // One line per arrow, so a diff shows which arrow changed.
  if (shaped.length)
    lines.push(
      `  ${JSON.stringify(ARROWS_KEY)}: {\n${shaped.map(([k, a]) => `    ${JSON.stringify(k)}: ${oneLineJson(a)}`).join(",\n")}\n  }`,
    );
  const spots = Object.entries(links);
  if (spots.length)
    lines.push(
      `  ${JSON.stringify(LINKS_KEY)}: {\n${spots.map(([u, p]) => `    ${JSON.stringify(u)}: [${p.join(", ")}]`).join(",\n")}\n  }`,
    );
  return lines.length ? `{\n${lines.join(",\n")}\n}\n` : "{}\n";
}

// --- reading --------------------------------------------------------------------------------

function readArrows(
  file: string,
  raw: unknown,
  err: (file: string, message: string) => void,
): Record<string, FArrow> {
  const out: Record<string, FArrow> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    err(file, `${ARROWS_KEY}: a map of "from>to" to an arrow's shape`);
    return out;
  }
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const where = `${ARROWS_KEY} ${k}`;
    if (!/^[^>]+>[^>]+$/.test(k)) {
      err(file, `${where}: an arrow is keyed "from>to"`);
      continue;
    }
    if (!v || typeof v !== "object" || Array.isArray(v)) {
      err(file, `${where}: a shape is { from, to, bends, label }`);
      continue;
    }
    const a = v as Record<string, unknown>;
    const f: FArrow = {};
    let ok = true;
    for (const extra of Object.keys(a))
      if (
        ![
          "from",
          "to",
          "from_at",
          "to_at",
          "split",
          "join",
          // Read and dropped: forks as they were first written (0.4.1), before split points.
          "fork_of",
          "fork_at",
          "bends",
          "label",
          "parts",
        ].includes(extra)
      )
        (err(file, `${where}: unknown field "${extra}"`), (ok = false));
    for (const end of ["from", "to"] as const) {
      if (a[end] === undefined) continue;
      if (SIDES.includes(a[end] as BoxSide)) f[end] = a[end] as BoxSide;
      else (err(file, `${where}: ${end} is one of ${SIDES.join(", ")}`), (ok = false));
    }
    for (const end of ["from_at", "to_at"] as const) {
      const t = a[end];
      if (t === undefined) continue;
      if (typeof t === "number" && t >= 0 && t <= 1) f[end] = t;
      else {
        err(file, `${where}: ${end} is a number from 0 to 1 along that side`);
        ok = false;
      }
    }
    for (const k of ["split", "join"] as const) {
      const sp = a[k];
      if (sp === undefined) continue;
      if (Array.isArray(sp) && sp.length === 2 && sp.every((n) => Number.isFinite(n)))
        f[k] = sp as [number, number];
      else {
        err(file, `${where}: ${k} is a point, [x, y]`);
        ok = false;
      }
    }
    if (a.bends !== undefined) {
      const bends = a.bends;
      if (
        Array.isArray(bends) &&
        bends.length <= 50 &&
        bends.every((p) => Array.isArray(p) && p.length === 2 && p.every((n) => Number.isFinite(n)))
      )
        f.bends = bends as [number, number][];
      else (err(file, `${where}: bends is a list of up to 50 [x, y] points`), (ok = false));
    }
    if (a.label !== undefined) {
      if (typeof a.label === "number" && a.label >= 0 && a.label <= 1) f.label = a.label;
      else (err(file, `${where}: label is a number from 0 (start) to 1 (end)`), (ok = false));
    }
    if (a.parts !== undefined) {
      if (
        Array.isArray(a.parts) &&
        a.parts.length === 2 &&
        a.parts.every((n) => Number.isFinite(n))
      )
        f.parts = a.parts as [number, number];
      else
        (err(file, `${where}: parts is where what it carries sits, [x, y] from its label`),
          (ok = false));
    }
    if (ok) out[k] = f;
  }
  return out;
}

const OBJECT_FIELDS = FIELDS.object;
const CONNECTION_FIELDS = FIELDS.connection;
const VIEW_FIELDS = FIELDS.view;
const BOUNDARY_FIELDS = FIELDS.boundary;

/** Two rule sets alike but for the order of ids in an ids rule. */
function sameRules(a: Boundary["rules"], b: Boundary["rules"]): boolean {
  const norm = (r: Boundary["rules"]) =>
    JSON.stringify({
      include: r.include.map((x) => ("ids" in x ? { ids: [...x.ids].sort() } : x)),
      exclude: r.exclude.map((x) => ("ids" in x ? { ids: [...x.ids].sort() } : x)),
    });
  return norm(a) === norm(b);
}
const LINK_FIELDS = FIELDS.link;

/** Files parsed before, by path and text, most recently used last. */
const parsed = new Map<
  string,
  { doc: YAML.Document.Parsed; lc: YAML.LineCounter; problems: Problem[] }
>();
const PARSED_MAX = 20_000;

/** "file:line" for a path into a document: where each thing starts (a list item, a map entry). */
function lineOfDoc(
  file: string,
  doc: YAML.Document.Parsed,
  lc: YAML.LineCounter,
): (...path: (string | number)[]) => string {
  // Each map's entries by key, made on first use: a file of thousands of objects asks thousands of times.
  const keys = new WeakMap<YAML.YAMLMap, Map<string, YAML.Pair>>();
  const entry = (m: YAML.YAMLMap, k: string) => {
    let byKey = keys.get(m);
    if (!byKey) {
      byKey = new Map();
      for (const it of m.items as YAML.Pair[])
        if (YAML.isScalar(it.key) && !byKey.has(String(it.key.value)))
          byKey.set(String(it.key.value), it);
      keys.set(m, byKey);
    }
    return byKey.get(k);
  };
  return (...path) => {
    let node: unknown = doc.contents;
    let at: unknown = node;
    for (const [i, seg] of path.entries()) {
      if (YAML.isMap(node)) {
        const pair = entry(node, String(seg));
        if (!pair) break;
        at = i === path.length - 1 ? pair.key : pair.value;
        node = pair.value;
      } else if (YAML.isSeq(node) && typeof seg === "number") {
        node = node.items[seg];
        at = node;
      } else break;
    }
    const line = YAML.isNode(at) && at.range ? lc.linePos(at.range[0]).line : 0;
    return line ? `${file}:${line}` : file;
  };
}

/** Parse a folder's files (path -> text). Problems come back rather than being thrown. */
export function readFiles(raw: Map<string, string>): { model: FileModel; problems: Problem[] } {
  const files = normalizeDesignFile(raw);
  const problems: Problem[] = [];
  const model: FileModel = {
    config: {},
    objects: [],
    connections: [],
    boundaries: [],
    entities: [],
    decisions: [],
    views: [],
    layouts: new Map(),
    arrows: new Map(),
    linkSpots: new Map(),
    origin: new Map(),
  };
  const err = (file: string, message: string) => problems.push({ level: "error", file, message });

  const warn = (file: string, message: string) =>
    problems.push({ level: "warning", file, message });

  // Where each thing starts (a list item, a map entry), so problems can say file:line.
  let lineOf: (...path: (string | number)[]) => string = () => "";
  const parse = (file: string, text: string): unknown => {
    // A file read before, unchanged: its document and problems as they were (every
    // write re-read all 3,800 files of a mapped repo, two seconds a write).
    const k = `${file}\0${text}`;
    const hit = parsed.get(k);
    if (hit) {
      parsed.delete(k);
      parsed.set(k, hit);
      lineOf = lineOfDoc(file, hit.doc, hit.lc);
      problems.push(...hit.problems.map((p) => ({ ...p })));
      return hit.doc.toJS();
    }
    const from = problems.length;
    const got = parseFresh(file, text);
    if (parsed.size >= PARSED_MAX) parsed.delete(parsed.keys().next().value!);
    parsed.set(k, { ...got, problems: problems.slice(from) });
    return got.doc.toJS();
  };
  const parseFresh = (
    file: string,
    text: string,
  ): { doc: YAML.Document.Parsed; lc: YAML.LineCounter } => {
    const lc = new YAML.LineCounter();
    // Duplicate keys are found below, so the message can say which key and where.
    const doc = YAML.parseDocument(text, { merge: false, uniqueKeys: false, lineCounter: lc });
    lineOf = lineOfDoc(file, doc, lc);
    for (const e of doc.errors) {
      const line = e.linePos?.[0]?.line;
      err(
        line ? `${file}:${line}` : file,
        e.message.split("\n")[0]!.replace(/ at line \d+, column \d+:?$/, ""),
      );
    }
    // One way to write each thing: no directives (%YAML 1.1 would read yes as true), anchors, aliases or tags.
    let line = 1;
    for (const tok of new YAML.Lexer().lex(text)) {
      if (YAML.CST.tokenType(tok) === "directive-line")
        err(
          `${file}:${line}`,
          `directives (${tok.split(/\s/)[0]}) aren't allowed: Archnemesis reads YAML 1.2; take the line out`,
        );
      if (tok !== "\x02" && tok !== "\x18" && tok !== "\x1f")
        for (const ch of tok) if (ch === "\n") line++;
    }
    const at = (n: YAML.Node) => (n.range ? `${file}:${lc.linePos(n.range[0]).line}` : file);
    const plain = (n: YAML.Node) => {
      if (n.anchor)
        err(at(n), `anchors (&${n.anchor}) aren't allowed; write the value out each time`);
      if (n.tag)
        err(
          at(n),
          `tags (${n.tag.replace(/^tag:yaml\.org,2002:/, "!!")}) aren't allowed; write the plain value`,
        );
    };
    // What a map is (for messages): the key it's under, or the list it's in.
    const owner = (path: readonly unknown[]): string => {
      const up = path[path.length - 1];
      if (YAML.isPair(up) && YAML.isScalar(up.key)) return String(up.key.value);
      if (YAML.isSeq(up)) {
        const pair = path[path.length - 2];
        return YAML.isPair(pair) && YAML.isScalar(pair.key)
          ? `one of the ${String(pair.key.value)}`
          : "a list item";
      }
      return "the file";
    };
    YAML.visit(doc, {
      Alias: (_, n) =>
        void err(at(n), `aliases (*${n.source}) aren't allowed; write the value out`),
      Map: (_, n, path) => {
        plain(n);
        const seen = new Set<string>();
        for (const it of n.items) {
          if (!YAML.isScalar(it.key)) continue;
          const k = String(it.key.value);
          if (seen.has(k)) err(at(it.key), `\`${k}\` appears twice in ${owner(path)}; keep one`);
          seen.add(k);
        }
      },
      Seq: (_, n) => plain(n),
      Scalar: (_, n) => {
        plain(n);
        // The schema types a value, not YAML: 1.10 in a string field is "1.10", null is "null", True is "True".
        if (typeof n.value === "number" && n.source !== undefined) n.value = n.source;
        else if (n.value === null && n.source && n.source !== "~") n.value = n.source;
        else if (
          typeof n.value === "boolean" &&
          n.source !== undefined &&
          n.source !== String(n.value)
        )
          n.value = n.source;
      },
    });
    const comment = commentLine(text);
    if (comment)
      warn(
        `${file}:${comment}`,
        "comments aren't kept (Archnemesis rewrites its files): put what it says in a context or notes field",
      );
    return { doc, lc };
  };
  /** Fields that aren't allowed, each at its own line when `file` is a function of the field. */
  const unknownKeys = (
    file: string | ((k: string) => string),
    what: string,
    v: Record<string, unknown>,
    allowed: string[],
  ) => {
    for (const k of Object.keys(v)) {
      if (allowed.includes(k)) continue;
      // The word other sections use for it (a decision written with context and about).
      const near =
        (allowed.includes("text") && /^(context|description|body)$/.test(k)
          ? "text"
          : allowed.includes("affects") && /^(about|for|objects|boxes)$/.test(k)
            ? "affects"
            : undefined) ?? closest(k, allowed);
      err(
        typeof file === "string" ? file : file(k),
        `${what}: unknown field "${k}"${near ? ` (did you mean ${near}?)` : ""}; allowed: ${allowed.join(", ")}`,
      );
    }
  };
  const str = (v: unknown) =>
    typeof v === "string" ? v : v === undefined || v === null ? undefined : String(v);
  /** A text field: one value. A list or a map where text goes is an error, not text made of it. */
  const textOf = (file: string, where: string, field: string, v: unknown): string | undefined => {
    if (v === undefined || v === null) return undefined;
    if (typeof v === "object" && !(v instanceof Date)) {
      err(
        file,
        `${where}: ${field} is text, not a ${Array.isArray(v) ? "list" : "map"}${Array.isArray(v) ? ` (quote it if it's one: "a, b")` : ""}`,
      );
      return undefined;
    }
    return String(v);
  };
  /** references: each exactly one of link, image, doc, code, dependency, and maybe a title. */
  const readReferences = (file: string, where: string, v: unknown): FReference[] | undefined => {
    if (v === undefined || v === null) return undefined;
    if (!Array.isArray(v)) {
      err(
        file,
        `${where} must be a list (each one of link, image, doc, code, dependency, with an optional title)`,
      );
      return undefined;
    }
    const out: FReference[] = [];
    const seen = new Set<string>();
    for (const [i, raw] of v.entries()) {
      const r = (raw ?? {}) as Record<string, unknown>;
      unknownKeys(file, `${where}[${i}]`, r, [...REF_KEYS, "title"]);
      const keys = REF_KEYS.filter((k) => r[k] !== undefined);
      if (keys.length !== 1) {
        err(file, `${where}[${i}]: needs exactly one of ${REF_KEYS.join(", ")}`);
        continue;
      }
      const kind = keys[0]!;
      let to = str(r[kind])?.trim() ?? "";
      if (kind === "link" || (kind === "image" && /^[a-z]+:/i.test(to))) {
        const url = safeUrl(to);
        if (!url) {
          err(
            file,
            `${where}[${i}]: ${kind} must be an http or https address${kind === "image" ? " or a file in the design" : ""}`,
          );
          continue;
        }
        to = url;
      } else if (
        (kind === "image" || kind === "doc") &&
        (to.startsWith("/") || to.split("/").includes(".."))
      ) {
        err(
          file,
          `${where}[${i}]: ${kind} "${to}" must be a path inside the design (assets/x.png, docs/x.md)`,
        );
        continue;
      }
      if (!to) {
        err(file, `${where}[${i}]: ${kind} is empty`);
        continue;
      }
      if (seen.has(`${kind}:${to}`)) {
        err(file, `${where}[${i}]: ${to} is listed twice`);
        continue;
      }
      seen.add(`${kind}:${to}`);
      const title = str(r.title)?.trim().slice(0, 200);
      out.push({ [kind]: to.slice(0, 500), ...(title ? { title } : {}) } as FReference);
    }
    return out.length ? out : undefined;
  };
  /** notes: one markdown text; the older list of { text, by?, at? } reads in as its lines. */
  const readNotes = (file: string, where: string, v: unknown): string | undefined => {
    if (v === undefined || v === null) return undefined;
    if (typeof v === "string") return v.replace(/\n$/, "").slice(0, 50_000) || undefined;
    if (!Array.isArray(v)) {
      err(file, `${where} is markdown text`);
      return undefined;
    }
    const lines = v.flatMap((raw) => {
      const n = (typeof raw === "string" ? { text: raw } : (raw ?? {})) as Record<string, unknown>;
      const text = str(n.text)?.trim();
      const at = n.at instanceof Date ? n.at.toISOString().slice(0, 10) : str(n.at);
      const who = [str(n.by), at].filter(Boolean).join(", ");
      return text ? [`- ${text}${who ? ` (${who})` : ""}`] : [];
    });
    return lines.join("\n").slice(0, 50_000) || undefined;
  };
  /** A list of { title, url }: http(s) only, one per address. `on` is the older view form. */
  const readLinks = (file: string, where: string, v: unknown): FLink[] | undefined => {
    if (v === undefined) return undefined;
    if (!Array.isArray(v)) {
      err(file, `${where} must be a list of { title, url }`);
      return undefined;
    }
    const out: FLink[] = [];
    const seen = new Set<string>();
    for (const [i, raw] of v.entries()) {
      const l = (raw ?? {}) as Record<string, unknown>;
      unknownKeys(file, `${where}[${i}]`, l, LINK_FIELDS);
      const url = safeUrl(l.url);
      if (!url) {
        err(file, `${where}[${i}]: url must be an http or https address`);
        continue;
      }
      if (seen.has(url)) {
        err(file, `${where}[${i}]: ${url} is listed twice`);
        continue;
      }
      seen.add(url);
      const title = (str(l.title) ?? titleFromUrl(url)).slice(0, 200);
      out.push({ title, url });
    }
    return out.length ? out : undefined;
  };

  // Every file is a mapping at the top. An empty one (or a stray number) would otherwise
  // read as "no objects here" and delete them.
  const mapping = (file: string, v: unknown): Record<string, unknown> => {
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    if (file !== "archnm.yaml" || (v !== null && v !== undefined))
      err(
        file,
        v === null || v === undefined
          ? "the file is empty"
          : "should be a mapping (name: value lines) at the top",
      );
    return {};
  };

  for (const [file, text] of [...files].sort(byKey(([f]) => f))) {
    if (file === "archnm.yaml") {
      const v = mapping(file, parse(file, text));
      unknownKeys(file, "archnm.yaml", v, FIELDS.config);
      if (v.version !== undefined && String(v.version) !== String(FORMAT_VERSION))
        err(
          file,
          String(v.version) === "1"
            ? "version 1 files aren't read any more: convert the folder once with `archnm convert <dir>`"
            : `version ${String(v.version)} isn't one this Archnemesis reads (${FORMAT_VERSION})`,
        );
      model.config = {
        name: str(v.name),
        version: Number(v.version ?? FORMAT_VERSION),
        forbid: Array.isArray(v.forbid) ? v.forbid.map(String) : undefined,
      };
      if (v.tags !== undefined) {
        if (!v.tags || typeof v.tags !== "object" || Array.isArray(v.tags))
          err(file, "tags: a map of group name to { values, colors, description }");
        else {
          const groups: Record<string, FTagGroup> = {};
          for (const [g, raw] of Object.entries(v.tags as Record<string, unknown>)) {
            const t = (raw ?? {}) as Record<string, unknown>;
            if (!TAG_GROUP.test(g))
              err(
                file,
                `tags: group "${g}" should be lowercase letters, digits and - (it's written before the colon: ${g}:value)`,
              );
            unknownKeys(file, `tags.${g}`, t, FIELDS.tagGroup);
            const values = Array.isArray(t.values)
              ? t.values.map((x) => String(x).trim().toLowerCase())
              : [];
            if (!values.length)
              err(file, `tags.${g}: needs values (the list allowed after "${g}:")`);
            const colors: Record<string, string> = {};
            if (t.colors !== undefined) {
              if (!t.colors || typeof t.colors !== "object" || Array.isArray(t.colors))
                err(file, `tags.${g}.colors: a map of value to #rrggbb`);
              else
                for (const [k, c] of Object.entries(t.colors as Record<string, unknown>)) {
                  if (!values.includes(k))
                    err(file, `tags.${g}.colors: "${k}" isn't one of its values`);
                  else if (typeof c !== "string" || !/^#[0-9a-f]{6}$/i.test(c))
                    err(file, `tags.${g}.colors.${k}: a colour is #rrggbb`);
                  else colors[k] = c.toLowerCase();
                }
            }
            groups[g] = {
              values,
              ...(str(t.description) ? { description: str(t.description) } : {}),
              ...(Object.keys(colors).length ? { colors } : {}),
            };
          }
          model.config.tags = groups;
        }
      }
      if (v.protect !== undefined) {
        const list = Array.isArray(v.protect) ? v.protect.map(String) : [];
        for (const p of list)
          if (!PROTECTABLE.test(p))
            err(
              file,
              `protect: "${p}" isn't a field Archnemesis can protect (refs.<name>, name, in, status, kind)`,
            );
        if (!Array.isArray(v.protect)) err(file, "protect: a list of fields (refs.sys)");
        model.config.protect = list;
      }
      if (v.limits !== undefined) {
        const l = (v.limits ?? {}) as Record<string, unknown>;
        unknownKeys(file, "limits", l, ["boxes", "lines"]);
        const n = (x: unknown) => {
          const v = typeof x === "string" && /^\d+$/.test(x) ? Number(x) : x;
          return typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 500 ? v : undefined;
        };
        for (const k of ["boxes", "lines"])
          if (l[k] !== undefined && !n(l[k]))
            err(file, `limits.${k}: a whole number from 1 to 500`);
        model.config.limits = {
          ...(n(l.boxes) ? { boxes: n(l.boxes) } : {}),
          ...(n(l.lines) ? { lines: n(l.lines) } : {}),
        };
      }
      if (v.github !== undefined) {
        if (typeof v.github !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(v.github))
          err(file, "github: the GitHub owner (an organisation or user name)");
        else model.config.github = v.github;
      }
      for (const p of model.config.forbid ?? []) {
        const e = forbidError(p);
        if (e) err(file, `forbid: "${p.slice(0, 80)}" ${e}`);
      }
    } else if (file === "boundaries.yaml") {
      const v = mapping(file, parse(file, text));
      unknownKeys(file, "file", v, FIELDS.boundaries);
      if (v.boundaries !== undefined && !Array.isArray(v.boundaries))
        err(file, "boundaries must be a list");
      for (const [i, raw] of (Array.isArray(v.boundaries) ? v.boundaries : []).entries()) {
        const b = (raw ?? {}) as Record<string, unknown>;
        const where = `boundaries[${i}]${b.id ? ` (${String(b.id)})` : ""}`;
        const here = lineOf("boundaries", i);
        unknownKeys(here, where, b, BOUNDARY_FIELDS);
        const id = str(b.id);
        const name = str(b.name);
        const kind = str(b.kind) as BoundaryKind;
        if (!id || !/^[a-z0-9][a-z0-9._-]*$/i.test(id))
          err(here, `${where}: needs an id (a slug: letters, digits, - _ .)`);
        if (!name?.trim()) err(here, `${where}: needs a name`);
        if (!BOUNDARY_KINDS.includes(kind))
          err(here, `${where}: kind must be one of ${BOUNDARY_KINDS.join(", ")}`);
        for (const part of ["include", "exclude"] as const) {
          const list = b[part];
          if (list === undefined) continue;
          if (!Array.isArray(list)) err(here, `${where}: ${part} must be a list of rules`);
          else
            for (const [j, s] of list.entries()) {
              const e = selectorError(s);
              if (e) err(here, `${where}: ${part}[${j}]: ${e}`);
            }
        }
        if (!id || !name || !BOUNDARY_KINDS.includes(kind)) continue;
        model.boundaries.push({
          id,
          name,
          kind,
          in: textOf(here, where, "in", b.in),
          description: textOf(here, where, "description", b.description),
          include: Array.isArray(b.include) ? (b.include as Selector[]) : undefined,
          exclude: Array.isArray(b.exclude) ? (b.exclude as Selector[]) : undefined,
        });
        model.origin.set(`boundary:${id}`, here);
      }
    } else if (file === "entities.yaml") {
      err(
        file,
        "entities.yaml isn't read any more: each entity goes under entities: in the file of the box that defines it (model/_top.yaml when nothing does); `archnm convert` moves them",
      );
    } else if (/^decisions\/[^/]+\.ya?ml$/.test(file)) {
      const id = file.replace(/^decisions\//, "").replace(/\.ya?ml$/, "");
      const v = mapping(file, parse(file, text));
      unknownKeys(file, "decision", v, FIELDS.decision);
      if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id))
        err(file, "a decision's file name should be a slug (0001-short-title.yaml)");
      const title = str(v.title);
      if (!title?.trim()) err(file, "a decision needs a title");
      const status = str(v.status) as DecisionStatus;
      if (!DECISION_STATUSES.includes(status))
        err(file, `status must be one of ${DECISION_STATUSES.join(", ")}`);
      // YAML reads an unquoted date as a date; either way it's written back as YYYY-MM-DD.
      const date = v.date instanceof Date ? v.date.toISOString().slice(0, 10) : str(v.date);
      if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) err(file, "date is YYYY-MM-DD");
      if (v.affects !== undefined && !Array.isArray(v.affects))
        err(file, "affects: a list of object ids");
      if (title && DECISION_STATUSES.includes(status)) {
        model.decisions.push({
          id,
          title,
          status,
          date,
          affects: Array.isArray(v.affects) ? v.affects.map(String) : undefined,
          superseded_by: str(v.superseded_by),
          text: textOf(file, "decision", "text", v.text),
        });
        model.origin.set(`decision:${id}`, file);
      }
    } else if (file === "model/landscape.yaml") {
      err(file, "model/landscape.yaml is model/_top.yaml now: rename it");
    } else if (
      /^model\/[^/]+\.ya?ml$/.test(file) ||
      /^code\/.+\.ya?ml$/.test(file) ||
      file === "libraries.yaml"
    ) {
      const v = mapping(file, parse(file, text));
      unknownKeys(file, "file", v, FIELDS.model);
      const byId = (part: string, example: string): [string, unknown][] => {
        const x = v[part];
        if (x === undefined || x === null) return [];
        if (typeof x === "object" && !Array.isArray(x))
          return Object.entries(x as Record<string, unknown>);
        err(
          lineOf(part),
          Array.isArray(x)
            ? `${part} is a map keyed by ${part === "objects" ? "id" : "name"} (${example}), not a list`
            : `${part} is a map (${example})`,
        );
        return [];
      };
      for (const [id, raw] of byId("objects", "shop-api: { kind: app }")) {
        const here = lineOf("objects", id);
        const at = (field: string) => lineOf("objects", id, field);
        // One id in two files: check names both.
        if (model.origin.has(`object:${id}`)) model.origin.set(`again:object:${id}`, here);
        else model.origin.set(`object:${id}`, here);
        if (!SAFE_KEY.test(id))
          err(
            here,
            `${id}: an id is letters, digits, - . and _, starting with a letter or digit${slug(id) ? ` (${slug(id)})` : ""}`,
          );
        // One that doesn't read is still there for what points at it: its own error, not one per reference.
        const stub = () => (model.stubs ??= new Set()).add(id);
        if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
          err(here, `${id}: an object is a map of its fields ({ kind: app, … })`);
          stub();
          continue;
        }
        const o = raw as Record<string, unknown>;
        for (const k of Object.keys(o)) model.origin.set(`object:${id}#${k}`, at(k));
        unknownKeys(at, id, o, OBJECT_FIELDS);
        const kind = readEnum(at("kind"), id, "kind", o.kind, OBJECT_KINDS, err) as
          ObjectKind | undefined;
        if (o.kind === undefined || o.kind === null)
          err(here, `${id}: needs a kind (${OBJECT_KINDS.join(", ")})`);
        const status = readEnum(at("status"), id, "status", o.status, STATUSES, err) as
          Status | undefined;
        const name = textOf(at("name"), id, "name", o.name)?.trim() || id;
        if (!kind) {
          stub();
          continue;
        }
        const tech = readWords(at("tech"), id, "tech", o.tech, err);
        const uses = readNames(at("uses"), id, "uses", o.uses, err);
        model.objects.push({
          id,
          kind,
          name,
          in: textOf(at("in"), id, "in", o.in),
          context: textOf(at("context"), id, "context", o.context),
          ...(tech?.length ? { tech: tech.join(", ") } : {}),
          icon: textOf(at("icon"), id, "icon", o.icon),
          path: readPath(at("path"), id, kind, o.path, err),
          package: readPackage(at("package"), id, kind, o.package, err),
          signature: textOf(at("signature"), id, "signature", o.signature),
          columns: readColumns(at("columns"), id, kind, o.columns, err),
          status,
          external: readFlag(at("external"), id, "external", o.external, err),
          tags: readWords(at("tags"), id, "tags", o.tags, err)?.map((t) => t.toLowerCase()),
          refs: readRefs(at("refs"), id, o.refs, err),
          sources: readSources(at("sources"), id, o.sources, err),
          references: readReferences(at("references"), `${id}.references`, o.references),
          ...(uses?.length ? { uses } : {}),
          notes: readNotes(at("notes"), `${id}.notes`, o.notes),
          ...(readFlag(at("guess"), id, "guess", o.guess, err) ? { guess: true as const } : {}),
        });
      }
      for (const [name, raw] of byId("entities", "PaidOrder: { fields: { id: uuid } }")) {
        const here = lineOf("entities", name);
        const at = (field: string) => lineOf("entities", name, field);
        if (!TYPE_NAME.test(name)) err(here, `entity ${name}: ${TYPE_NAME_RULE}`);
        if (raw !== null && (typeof raw !== "object" || Array.isArray(raw))) {
          err(
            here,
            `${name}: an entity is a map ({ in, extends, fields, values, context }), or {} for one that's only a name so far`,
          );
          continue;
        }
        const e = (raw ?? {}) as Record<string, unknown>;
        for (const k of Object.keys(e)) model.origin.set(`entity:${name}#${k}`, at(k));
        unknownKeys(at, name, e, FIELDS.entity);
        const fields = readFields(at("fields"), name, e.fields, err);
        const values = readWords(at("values"), name, "values", e.values, err);
        if (fields?.length && values?.length)
          err(here, `${name}: an enum has values, a type has fields: not both`);
        const was = model.origin.get(`entity:${name}`);
        if (was) {
          err(here, `${name} is defined twice (also at ${was}): one entity, one place`);
          continue;
        }
        model.entities.push({
          id: name,
          in: textOf(at("in"), name, "in", e.in),
          extends: readNames(at("extends"), name, "extends", e.extends, err),
          context: textOf(at("context"), name, "context", e.context),
          fields,
          values: values?.length ? values : undefined,
        });
        model.origin.set(`entity:${name}`, here);
      }
      const conns = v.connections;
      if (conns !== undefined && conns !== null && !Array.isArray(conns))
        err(lineOf("connections"), "connections is a list: - { from: a, to: b, label: … }");
      for (const [i, raw] of (Array.isArray(conns) ? conns : []).entries()) {
        const here = lineOf("connections", i);
        if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
          err(here, `connections[${i}]: a connection is { from, to, label, … }`);
          continue;
        }
        const c = raw as Record<string, unknown>;
        // A field's line (a connection written as a block has one per field).
        const at = (field: string) => lineOf("connections", i, field);
        const from = textOf(at("from"), `connections[${i}]`, "from", c.from);
        const to = textOf(at("to"), `connections[${i}]`, "to", c.to);
        const where = from && to ? `${from} → ${to}` : `connections[${i}]`;
        unknownKeys(at, where, c, CONNECTION_FIELDS);
        if (!from || !to) {
          err(here, `${where}: needs from and to (object ids)`);
          continue;
        }
        const tech = readWords(at("tech"), where, "tech", c.tech, err);
        const carries = readNames(at("carries"), where, "carries", c.carries, err);
        const label = textOf(at("label"), where, "label", c.label);
        const column = textOf(at("column"), where, "column", c.column);
        const toColumn = textOf(at("to_column"), where, "to_column", c.to_column);
        model.connections.push({
          from,
          to,
          label,
          description: textOf(at("description"), where, "description", c.description),
          context: textOf(at("context"), where, "context", c.context),
          ...(tech?.length ? { tech: tech.join(", ") } : {}),
          status: readEnum(at("status"), where, "status", c.status, STATUSES, err) as
            Status | undefined,
          via: textOf(at("via"), where, "via", c.via),
          sources: readSources(at("sources"), where, c.sources, err),
          ...(readFlag(at("guess"), where, "guess", c.guess, err) ? { guess: true as const } : {}),
          ...(readFlag(at("both"), where, "both", c.both, err) ? { both: true as const } : {}),
          ...(column ? { column } : {}),
          ...(toColumn ? { to_column: toColumn } : {}),
          ...(carries?.length ? { carries } : {}),
          ...(c.references !== undefined
            ? { references: readReferences(at("references"), `${where}.references`, c.references) }
            : {}),
          ...(c.notes !== undefined
            ? { notes: readNotes(at("notes"), `${where}.notes`, c.notes) }
            : {}),
        });
        // The same connection twice: check names both.
        const ck = `connection:${from}>${to}>${label ?? ""}`;
        if (model.origin.has(ck)) model.origin.set(`again:${ck}`, here);
        else model.origin.set(ck, here);
      }
    } else if (/^views\/[^/]+\.ya?ml$/.test(file)) {
      const key = file.replace(/^views\//, "").replace(/\.ya?ml$/, "");
      const v = mapping(file, parse(file, text));
      unknownKeys(file, "view", v, VIEW_FIELDS);
      if (!str(v.name)) err(file, "a view needs a name");
      const rules = v.include !== undefined || v.exclude !== undefined;
      if (rules && v.boxes !== undefined)
        err(file, "a view has either boxes (hand-picked) or include/exclude rules, not both");
      for (const part of ["include", "exclude", "hide_lines"] as const) {
        const list = v[part];
        if (list === undefined) continue;
        if (!Array.isArray(list)) err(file, `${part} must be a list of rules`);
        else
          for (const [i, s] of list.entries()) {
            const e = selectorError(s);
            if (e) err(file, `${part}[${i}]: ${e}`);
          }
      }
      const links: FLink[] = readLinks(file, "links", v.links) ?? [];
      const flows = Array.isArray(v.flows) ? v.flows : [];
      for (const [i, f] of flows.entries()) {
        const fl = (f ?? {}) as Record<string, unknown>;
        if (!str(fl.name)) err(file, `flows[${i}]: needs a name`);
        if (!Array.isArray(fl.steps)) err(file, `flows[${i}]: steps must be a list`);
        if (fl.kind !== undefined && !(FLOW_KINDS as readonly unknown[]).includes(fl.kind))
          err(file, `flows[${i}]: kind is one of ${FLOW_KINDS.join(", ")}`);
      }
      model.views.push({
        key,
        name: textOf(file, "view", "name", v.name) ?? key,
        scope: textOf(file, "view", "scope", v.scope),
        arrows:
          v.arrows === undefined
            ? undefined
            : (ARROW_STYLES as readonly unknown[]).includes(v.arrows)
              ? (v.arrows as ArrowStyle)
              : (err(file, `arrows must be one of ${ARROW_STYLES.join(", ")}`), undefined),
        tidy:
          v.tidy === undefined
            ? undefined
            : (LAYOUT_DIRECTIONS as readonly unknown[]).includes(v.tidy)
              ? (v.tidy as LayoutDirection)
              : (err(file, `tidy must be one of ${LAYOUT_DIRECTIONS.join(", ")}`), undefined),
        keep_tidy:
          v.keep_tidy === undefined || v.keep_tidy === false
            ? undefined
            : v.keep_tidy === true
              ? true
              : (err(file, "keep_tidy is true or left out"), undefined),
        boundaries:
          v.boundaries === undefined || v.boundaries === false
            ? undefined
            : v.boundaries === true
              ? true
              : (err(file, "boundaries is true or left out"), undefined),
        color_by:
          v.color_by === undefined
            ? undefined
            : typeof v.color_by === "string" && TAG_GROUP.test(v.color_by)
              ? v.color_by
              : (err(file, "color_by: the name of a tag group in archnm.yaml"), undefined),
        lanes:
          v.lanes === undefined
            ? undefined
            : typeof v.lanes === "string" && TAG_GROUP.test(v.lanes)
              ? v.lanes
              : (err(file, "lanes: the name of a tag group in archnm.yaml"), undefined),
        fold:
          v.fold === undefined
            ? undefined
            : (FOLD_MODES as readonly unknown[]).includes(v.fold)
              ? (v.fold as FoldMode)
              : (err(file, `fold is one of ${FOLD_MODES.join(", ")}`), undefined),
        unfolded:
          v.unfolded === undefined
            ? undefined
            : Array.isArray(v.unfolded) && v.unfolded.every((x) => typeof x === "string")
              ? (v.unfolded as string[])
              : (err(file, "unfolded: a list of group names"), undefined),
        hide_lines:
          Array.isArray(v.hide_lines) && v.hide_lines.length
            ? (v.hide_lines as Selector[])
            : undefined,
        story: textOf(file, "view", "story", v.story),
        context: textOf(file, "view", "context", v.context),
        boxes: Array.isArray(v.boxes) ? v.boxes.map(String) : undefined,
        links: links.length ? links : undefined,
        // A scope and no include (nor boxes): the scope's children and neighbours, less any
        // exclude (exclude alone emptied the view). boxes: [] is an empty hand-picked view.
        include: Array.isArray(v.include)
          ? (v.include as Selector[])
          : typeof v.scope === "string" && v.scope && v.boxes === undefined
            ? [{ children: v.scope }, { neighbours: v.scope }]
            : rules
              ? []
              : undefined,
        exclude: Array.isArray(v.exclude) ? (v.exclude as Selector[]) : undefined,
        flows: flows.map((f) => {
          const fl = (f ?? {}) as Record<string, unknown>;
          return {
            name: str(fl.name) ?? "",
            ...((FLOW_KINDS as readonly unknown[]).includes(fl.kind) && fl.kind !== "story"
              ? { kind: fl.kind as FlowKind }
              : {}),
            steps: (Array.isArray(fl.steps) ? fl.steps : []).map((s) => {
              const st = (s ?? {}) as Record<string, unknown>;
              return { from: str(st.from) ?? "", to: str(st.to) ?? "", text: str(st.text) };
            }),
          };
        }),
      });
      model.origin.set(`view:${key}`, file);
    } else if (/^layout\/[^/]+\.json$/.test(file)) {
      const key = file.replace(/^layout\//, "").replace(/\.json$/, "");
      try {
        const v = JSON.parse(text) as Record<string, unknown>;
        const boxes: Record<string, Box> = {};
        for (const [k, b] of Object.entries(v)) {
          if (k === ARROWS_KEY) {
            model.arrows.set(key, readArrows(file, b, err));
            continue;
          }
          if (k === LINKS_KEY) {
            const spots: Record<string, [number, number]> = {};
            if (b && typeof b === "object" && !Array.isArray(b)) {
              for (const [u, p] of Object.entries(b as Record<string, unknown>)) {
                if (Array.isArray(p) && p.length === 2 && p.every((n) => Number.isFinite(n)))
                  spots[u] = p as [number, number];
                else err(file, `${LINKS_KEY} ${u}: a link's spot is [x, y]`);
              }
            } else err(file, `${LINKS_KEY}: a map of address to [x, y]`);
            model.linkSpots.set(key, spots);
            continue;
          }
          if (!SAFE_KEY.test(k)) {
            err(file, `${JSON.stringify(k).slice(0, 80)} isn't an object's id`);
            continue;
          }
          const box = readBox(b);
          if (box) boxes[k] = box;
          else
            err(
              file,
              `${k}: a box is {"x": 0, "y": 0} with "w" and "h" (above 0) when it isn't its kind's size, and "parts": [x, y] where its layer nodes were dragged`,
            );
        }
        model.layouts.set(key, boxes);
      } catch (e) {
        err(file, `not valid JSON: ${(e as Error).message}`);
      }
    }
  }
  return { model, problems };
}

// --- checking -------------------------------------------------------------------------------

/**
 * Why a forbid pattern won't be used, or null. Patterns run over every name and description
 * on every check, so one that can take forever (a repeated group that repeats, like (a+)+)
 * would freeze the server: refused, along with very long ones.
 */
export function forbidError(p: string): string | null {
  if (p.length > 200) return "is too long (200 characters at most)";
  if (/\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{?]/.test(p))
    return "repeats a group that repeats itself, which can take forever; simplify it";
  try {
    new RegExp(p, "i");
  } catch {
    return "isn't a valid pattern";
  }
  return null;
}

const DEFAULT_FORBID = [
  // IPv4 addresses. Not the ones that name no machine (any address, loopback, broadcast):
  // "binds 127.0.0.1, never 0.0.0.0" is prose about a design, not a leak.
  "\\b(?!0\\.0\\.0\\.0\\b|127\\.|255\\.255\\.255\\.255\\b)(?:\\d{1,3}\\.){3}\\d{1,3}\\b",
  "-----BEGIN [A-Z ]*PRIVATE KEY-----",
  "\\bAKIA[0-9A-Z]{16}\\b", // AWS access key ids
  "\\b(?:sk|pk)_(?:live|test)_[0-9a-zA-Z]{8,}", // payment / API keys
];

/**
 * Every entity: the ones the files define, then a TBD one for each name that's used (in uses,
 * carries, extends) and defined nowhere, unless it's a typo of one that is (check says which).
 */
export function allEntities(model: FileModel): FEntity[] {
  const defined = new Set(model.entities.map((e) => e.id));
  const names = new Set(defined);
  const out = [...model.entities];
  const add = (n: string) => {
    if (names.has(n) || closest(n, defined)) return;
    names.add(n);
    out.push({ id: n, implicit: true });
  };
  for (const o of model.objects) for (const n of o.uses ?? []) add(n);
  for (const c of model.connections) for (const n of c.carries ?? []) add(n);
  for (const e of model.entities) for (const n of e.extends ?? []) add(n);
  return out;
}

/** The entities a box points at, by name: its uses, and the ones its signature names that exist. */
function usesOf(o: FObject, entityNames: Set<string>): string[] {
  return [
    ...new Set([
      ...(o.uses ?? []),
      ...signatureTypes(o.signature).filter((n) => entityNames.has(n)),
    ]),
  ];
}

/** An object's links and references from its file. */
function objectRefs(
  f: { references?: FReference[] },
  id: (key: string) => string,
): { links?: DocLink[]; references?: Reference[] } {
  const links: DocLink[] = [];
  const references: Reference[] = [];
  for (const r of f.references ?? []) {
    const { kind, to } = refTarget(r);
    if (kind === "link") {
      if (!links.some((l) => l.url === to))
        links.push({ title: r.title || titleFromUrl(to), url: to });
    } else
      references.push({
        kind,
        to: kind === "dependency" ? id(to) : to,
        ...(r.title ? { title: r.title } : {}),
      });
  }
  return { ...(links.length ? { links } : {}), ...(references.length ? { references } : {}) };
}

/** Everything that's wrong with a model, beyond what reading it found: the graph (ids, ends, entities resolve) as errors, then what's still to do (TBD, guesses, gaps) as warnings. */
export function check(model: FileModel): Problem[] {
  const out: Problem[] = [];
  const at = (k: string) => model.origin.get(k) ?? "?";
  /** A field's own line ("object:<id>", "in"), else its object's. */
  const atf = (k: string, field: string) => model.origin.get(`${k}#${field}`) ?? at(k);
  const objects = new Map<string, FObject>();
  // What didn't read is still there for what points at it (its own error says what's wrong with it).
  const stubs = model.stubs ?? new Set<string>();
  const exists = (id: string) => objects.has(id) || stubs.has(id);
  const firstAt = new Map<string, string>();
  for (const o of model.objects) {
    if (objects.has(o.id))
      out.push({
        level: "error",
        file: model.origin.get(`again:object:${o.id}`) ?? at(`object:${o.id}`),
        message: `id "${o.id}" is used twice (also at ${firstAt.get(o.id)}): one id, one object`,
      });
    else firstAt.set(o.id, at(`object:${o.id}`));
    objects.set(o.id, o);
  }
  // An id that isn't there: the one it's a typo of, or where to define it.
  const ids = [...objects.keys(), ...stubs];
  const missing = (id: string) => {
    const near = closest(id, ids);
    return `no object "${id}"${near ? ` (did you mean ${near}?)` : ` (define it under objects: in the file of the box it's in, or ${TOP_FILE} at the top level)`}`;
  };
  for (const o of model.objects) {
    const file = at(`object:${o.id}`);
    if (o.in && !exists(o.in))
      out.push({
        level: "error",
        file: atf(`object:${o.id}`, "in"),
        message: `${o.id}: in: ${missing(o.in)}`,
      });
    for (const r of o.references ?? []) {
      if (!("dependency" in r) || stubs.has(r.dependency)) continue;
      const lib = objects.get(r.dependency);
      const where = atf(`object:${o.id}`, "references");
      if (!lib)
        out.push({
          level: "error",
          file: where,
          message: `${o.id}: dependency: ${missing(r.dependency)}`,
        });
      else if (lib.kind !== "library")
        out.push({
          level: "error",
          file: where,
          message: `${o.id}: dependency "${r.dependency}" is a ${lib.kind}, not a library`,
        });
    }
    const seen = new Set<string>([o.id]);
    for (let cur = o.in; cur; cur = objects.get(cur)?.in) {
      if (seen.has(cur)) {
        out.push({
          level: "error",
          file,
          message: `${o.id}: "in" goes round in a circle (${[...seen, cur].join(" → ")})`,
        });
        break;
      }
      seen.add(cur);
    }
    if (o.kind === "function" && !o.in)
      out.push({
        level: "warning",
        file,
        message: `${o.id}: a function belongs in its file's module (in: …)`,
      });
    const home = o.in ? objects.get(o.in)?.kind : undefined;
    if (o.kind === "table" && home !== "store" && !(o.in && stubs.has(o.in)))
      out.push({
        level: "warning",
        file,
        message: `${o.id}: a table belongs in its store (in: the database, bucket or dataset that holds it)`,
      });
    if (o.kind === "library" && !o.package)
      out.push({
        level: "warning",
        file,
        message: `${o.id}: a library needs its package (ecosystem, name) for its stats and links. A library is a third-party package; your own shared code is a module (kind: module, path: repo:path)`,
      });
  }
  // Functions written straight into a component or app (no file between): one warning per box.
  // A plan too: the file can be the one it'll be (a module with no path yet is fine).
  const loose = new Map<string, string[]>();
  for (const o of model.objects) {
    if (o.kind !== "function" || !o.in) continue;
    const k = objects.get(o.in)?.kind;
    if (k && k !== "module" && k !== "function" && !stubs.has(o.in))
      loose.set(o.in, [...(loose.get(o.in) ?? []), o.id]);
  }
  for (const [box, fns] of loose)
    out.push({
      level: "warning",
      file: at(`object:${fns[0]}`),
      message: `${box}: functions written directly in it (${fns.join(", ")}): functions live in a file module: add one (kind: module, in: ${box}, path: repo:path, or no path yet in a plan) and put them in it`,
    });

  const paths = new Map<string, string>();
  // A box whose path is a file holds that file as a module just inside it (import makes it):
  // the two share the path, as a component and its one file do.
  const holds = (a: FObject | undefined, b: FObject | undefined) =>
    !!a &&
    !!b &&
    ((b.kind === "module" && b.in === a.id && a.kind !== "module") ||
      (a.kind === "module" && a.in === b.id && b.kind !== "module"));
  for (const o of model.objects) {
    if (!o.path) continue;
    if (paths.has(o.path) && holds(objects.get(paths.get(o.path)!), o)) continue;
    if (paths.has(o.path)) {
      // One is the folder the import made: it goes inside the other (agents moved
      // folders by hand, not knowing which way round).
      const other = objects.get(paths.get(o.path)!);
      const [folder, box] =
        o.kind === "module" && o.tags?.includes("generated")
          ? [o, other]
          : other?.kind === "module" && other.tags?.includes("generated")
            ? [other, o]
            : [undefined, undefined];
      const fix =
        folder && box
          ? `: ${folder.id} is the folder the import made for it; put it inside ${box.id} (objects: {${folder.id}: {in: ${box.id}}}) and both keep the path`
          : "";
      out.push({
        level: "error",
        file: at(`object:${o.id}`),
        message: `${o.id} and ${paths.get(o.path)} both have the path ${o.path}${fix}`,
      });
    } else paths.set(o.path, o.id);
  }
  const siblings = new Map<string, string>();
  for (const o of model.objects) {
    const k = `${o.in ?? ""}\u0000${o.name.toLowerCase()}`;
    // Functions of the same name in one file are ordinary (a new() per type).
    if (o.kind === "function") continue;
    if (siblings.has(k))
      out.push({
        level: "warning",
        file: at(`object:${o.id}`),
        message: `${o.id} and ${siblings.get(k)} are both called "${o.name}" in the same place: rename one so people can tell them apart (the same app on two hosts or in two regions: put that in the name, "${o.name} (desktop)")`,
      });
    else siblings.set(k, o.id);
  }
  const seenConns = new Set<string>();
  for (const c of model.connections) {
    const k = `connection:${c.from}>${c.to}>${c.label ?? ""}`;
    const file = at(k);
    for (const end of new Set([c.from, c.to]))
      if (!exists(end))
        out.push({
          level: "error",
          file,
          message: `connection ${c.from} → ${c.to}: ${missing(end)}`,
        });
    if (c.from === c.to)
      out.push({
        level: "error",
        file,
        message: `connection ${c.from} → ${c.to}: needs two different ends`,
      });
    // The same ends and label twice would be one line drawn twice: give one a label, or keep one.
    if (seenConns.has(k))
      out.push({
        level: "error",
        file: model.origin.get(`again:${k}`) ?? file,
        message: `connection ${c.from} → ${c.to}${c.label ? ` "${c.label}"` : ""} is listed twice (also at ${file}): keep one, or label each`,
      });
    seenConns.add(k);
  }
  // Entities: a name used and defined nowhere is TBD (a warning below), unless it's a typo of one that's defined.
  const ents = new Map(allEntities(model).map((e) => [e.id, e]));
  const defined = model.entities.map((e) => e.id);
  const entity = (file: string, where: string, n: string) => {
    if (ents.has(n)) return;
    out.push({
      level: "error",
      file,
      message: `${where}: no entity ${n} (did you mean ${closest(n, defined)}?)`,
    });
  };
  for (const o of model.objects)
    for (const n of o.uses ?? []) entity(atf(`object:${o.id}`, "uses"), `${o.id}: uses`, n);
  for (const c of model.connections)
    for (const n of c.carries ?? [])
      entity(
        at(`connection:${c.from}>${c.to}>${c.label ?? ""}`),
        `connection ${c.from} → ${c.to}: carries`,
        n,
      );
  for (const e of model.entities) {
    const k = `entity:${e.id}`;
    if (e.in && !exists(e.in))
      out.push({ level: "error", file: atf(k, "in"), message: `${e.id}: in: ${missing(e.in)}` });
    for (const x of e.extends ?? []) {
      if (x === e.id)
        out.push({ level: "error", file: atf(k, "extends"), message: `${e.id}: extends itself` });
      else entity(atf(k, "extends"), `${e.id}: extends`, x);
    }
  }
  const bounds = new Map<string, FBoundary>();
  for (const b of model.boundaries) {
    const file = at(`boundary:${b.id}`);
    if (bounds.has(b.id))
      out.push({ level: "error", file, message: `boundary id "${b.id}" is used twice` });
    bounds.set(b.id, b);
  }
  for (const b of model.boundaries) {
    const file = at(`boundary:${b.id}`);
    if (b.in && !bounds.has(b.in))
      out.push({
        level: "error",
        file,
        message: `boundary ${b.id}: in "${b.in}", which isn't a boundary`,
      });
    const seen = new Set<string>([b.id]);
    for (let cur = b.in; cur; cur = bounds.get(cur)?.in) {
      if (seen.has(cur)) {
        out.push({
          level: "error",
          file,
          message: `boundary ${b.id}: "in" goes round in a circle`,
        });
        break;
      }
      seen.add(cur);
    }
    for (const s of [...(b.include ?? []), ...(b.exclude ?? [])]) {
      if (selectorError(s)) continue;
      if (!("ids" in s || "children" in s || "descendants" in s || "neighbours" in s)) continue;
      for (const r of Object.values(s).flat())
        if (!exists(String(r)))
          out.push({
            level: "error",
            file,
            message: `boundary ${b.id}: rule ${JSON.stringify(s)}: ${missing(String(r))}`,
          });
    }
  }
  const viewKeys = new Set<string>();
  for (const v of model.views) {
    const file = at(`view:${v.key}`);
    viewKeys.add(v.key);
    if (v.scope && !exists(v.scope))
      out.push({ level: "error", file, message: `scope: ${missing(v.scope)}` });
    for (const b of v.boxes ?? [])
      if (!exists(b)) out.push({ level: "error", file, message: `boxes: ${missing(b)}` });
    if (v.lanes && !Object.hasOwn(model.config.tags ?? {}, v.lanes))
      out.push({
        level: "error",
        file,
        message: `lanes: "${v.lanes}" isn't a tag group in archnm.yaml (${Object.keys(model.config.tags ?? {}).join(", ") || "none declared"}); declare it in the same write: tags: {${v.lanes}: {values: [<one per column>]}}`,
      });
    for (const s of [...(v.include ?? []), ...(v.exclude ?? []), ...(v.hide_lines ?? [])]) {
      if (selectorError(s)) continue;
      for (const r of Object.values(s).flat()) {
        if (
          ("ids" in s || "children" in s || "descendants" in s || "neighbours" in s) &&
          !exists(String(r))
        ) {
          out.push({
            level: "error",
            file,
            message: `rule ${JSON.stringify(s)}: ${missing(String(r))}`,
          });
        }
      }
    }
    for (const f of v.flows ?? []) {
      for (const [i, st] of f.steps.entries()) {
        for (const end of new Set([st.from, st.to]))
          if (!exists(end))
            out.push({
              level: "error",
              file,
              message: `flow "${f.name}" step ${i + 1}: ${missing(end)}`,
            });
        // A step goes between any two boxes, either way: a flow is a guide through the design,
        // not a walk of its connections, so a step with no connection under it is fine.
      }
    }
  }
  for (const [k, arrows] of model.arrows) {
    const file = `layout/${k}.json`;
    for (const ends of Object.keys(arrows)) {
      for (const end of ends.split(">"))
        if (!exists(end))
          out.push({
            level: "warning",
            file,
            message: `arrow ${ends}: "${end}" isn't in the model; its shape is ignored`,
          });
    }
  }
  for (const [k, boxes] of model.layouts) {
    const file = `layout/${k}.json`;
    if (!viewKeys.has(k))
      out.push({
        level: "warning",
        file,
        message: `there's no views/${k}.yaml; this layout is unused`,
      });
    for (const id of Object.keys(boxes))
      if (!exists(id))
        out.push({
          level: "warning",
          file,
          message: `"${id}" isn't in the model; its position is ignored`,
        });
    const list = Object.entries(boxes).flatMap(([id, b]) => {
      const o = objects.get(id);
      return o ? [[id, boxRect(b, o.kind)] as const] : [];
    });
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const [a, ra] = list[i]!;
        const [b, rb] = list[j]!;
        if (ra.x < rb.x + rb.w && rb.x < ra.x + ra.w && ra.y < rb.y + rb.h && rb.y < ra.y + ra.h) {
          out.push({ level: "warning", file, message: `${a} and ${b} overlap` });
        }
      }
    }
  }
  // via: the middle exists and isn't an end.
  for (const c of model.connections) {
    if (!c.via) continue;
    const file = at(`connection:${c.from}>${c.to}>${c.label ?? ""}`);
    if (!exists(c.via))
      out.push({
        level: "error",
        file,
        message: `connection ${c.from} → ${c.to}: via: ${missing(c.via)}`,
      });
    else if (c.via === c.from || c.via === c.to)
      out.push({
        level: "error",
        file,
        message: `connection ${c.from} → ${c.to}: via can't be one of its own ends`,
      });
  }
  // Tag groups: a tag in a declared group uses one of its values.
  const groups = model.config.tags ?? {};
  for (const o of model.objects) {
    for (const t of o.tags ?? []) {
      const i = t.indexOf(":");
      if (i < 0) continue;
      const g = Object.hasOwn(groups, t.slice(0, i)) ? groups[t.slice(0, i)] : undefined;
      if (g && !g.values.includes(t.slice(i + 1)))
        out.push({
          level: "error",
          file: atf(`object:${o.id}`, "tags"),
          message: `${o.id}: tag "${t}": ${t.slice(0, i)} is one of ${g.values.map((v) => `${t.slice(0, i)}:${v}`).join(", ")}`,
        });
    }
  }
  for (const v of model.views) {
    if (v.color_by && !Object.hasOwn(groups, v.color_by))
      out.push({
        level: "error",
        file: at(`view:${v.key}`),
        message: `color_by: "${v.color_by}" isn't a tag group in archnm.yaml (${Object.keys(groups).join(", ") || "none declared"})`,
      });
  }
  // Sources on GitHub need to know whose GitHub.
  if (!model.config.github) {
    const repoStyle = [...model.objects, ...model.connections].some((x) =>
      x.sources?.some((s) => !/^https?:/.test(s)),
    );
    if (repoStyle)
      out.push({
        level: "warning",
        file: "archnm.yaml",
        message:
          "sources use repo@sha:path (as import writes them), and with no github: owner in archnm.yaml they don't link anywhere; a person sets it when the repo is on GitHub, and for one that isn't, this is expected",
      });
  }
  // Decisions point at things that exist.
  const decisionIds = new Set(model.decisions.map((d) => d.id));
  for (const d of model.decisions) {
    const file = at(`decision:${d.id}`);
    for (const a of d.affects ?? [])
      if (!exists(a)) out.push({ level: "error", file, message: `affects: ${missing(a)}` });
    if (d.superseded_by && !decisionIds.has(d.superseded_by))
      out.push({
        level: "error",
        file,
        message: `superseded_by: no decision "${d.superseded_by}" (decisions/${d.superseded_by}.yaml)`,
      });
    if (d.superseded_by && d.status !== "superseded")
      out.push({
        level: "warning",
        file,
        message: "superseded_by is set, so status should be superseded",
      });
  }

  const patterns = [
    ...DEFAULT_FORBID,
    ...(model.config.forbid ?? []).filter((p) => !forbidError(p)),
  ].flatMap((p) => {
    try {
      return [new RegExp(p, "i")];
    } catch {
      return [];
    }
  });
  const scan = (file: string, what: string, text: string | undefined) => {
    if (!text) return;
    for (const re of patterns)
      if (re.test(text))
        out.push({
          level: "error",
          file,
          message: `${what} contains something archnm.yaml forbids (${re.source})`,
        });
  };
  for (const o of model.objects) {
    const file = at(`object:${o.id}`);
    for (const [f, v] of Object.entries({ name: o.name, context: o.context, tech: o.tech }))
      scan(file, `${o.id}.${f}`, v);
  }
  for (const c of model.connections)
    scan(
      at(`connection:${c.from}>${c.to}>${c.label ?? ""}`),
      `${c.from} → ${c.to}`,
      [c.label, c.description, c.context, c.tech].join(" "),
    );
  // The rest of the text: ids, tags, views, flows and their steps, the design's name.
  for (const o of model.objects)
    scan(at(`object:${o.id}`), `${o.id}`, [o.id, ...(o.tags ?? [])].join(" "));
  for (const v of model.views) {
    const file = at(`view:${v.key}`);
    scan(file, `view ${v.key}`, [v.key, v.name, v.story ?? "", v.context ?? ""].join(" "));
    for (const f of v.flows ?? [])
      scan(file, `flow ${f.name}`, [f.name, ...f.steps.map((s) => s.text ?? "")].join(" "));
  }
  for (const b of model.boundaries)
    scan(at(`boundary:${b.id}`), `boundary ${b.id}`, [b.id, b.name, b.description].join(" "));
  for (const d of model.decisions)
    scan(at(`decision:${d.id}`), `decision ${d.id}`, [d.id, d.title, d.text].join(" "));
  for (const o of model.objects)
    scan(
      at(`object:${o.id}`),
      `${o.id}.refs`,
      [...Object.values(o.refs ?? {}), ...(o.sources ?? [])].join(" "),
    );
  scan("archnm.yaml", "name", model.config.name);
  for (const e of model.entities)
    scan(
      at(`entity:${e.id}`),
      e.id,
      [e.context, ...(e.fields ?? []), ...(e.values ?? [])].join(" "),
    );

  // What's still to do: warnings, never blocking.
  const used = new Set<string>();
  const names = new Set(ents.keys());
  for (const o of model.objects) for (const n of usesOf(o, names)) used.add(n);
  for (const c of model.connections) for (const n of c.carries ?? []) used.add(n);
  for (const e of ents.values()) {
    for (const n of e.extends ?? []) used.add(n);
    for (const f of e.fields ?? [])
      for (const w of f.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])
        if (w !== e.id && names.has(w)) used.add(w);
  }
  const firstUser = (n: string) => {
    const o = model.objects.find((x) => x.uses?.includes(n));
    if (o) return atf(`object:${o.id}`, "uses");
    const c = model.connections.find((x) => x.carries?.includes(n));
    if (c) return at(`connection:${c.from}>${c.to}>${c.label ?? ""}`);
    const e = model.entities.find((x) => x.extends?.includes(n));
    return e ? at(`entity:${e.id}`) : "?";
  };
  for (const e of ents.values()) {
    if (e.implicit)
      out.push({
        level: "warning",
        file: firstUser(e.id),
        message: `${e.id} is TBD: a uses, carries or extends names it, and nothing defines it yet (add it under entities:, with in: the box that defines it, and its fields or values). Only those make a TBD: a signature's types link to entities that are defined, and the rest stay plain text`,
      });
    else if (!e.fields?.length && !e.values?.length)
      out.push({
        level: "warning",
        file: at(`entity:${e.id}`),
        message: `${e.id} is TBD: give it fields or values`,
      });
    else if (!used.has(e.id))
      out.push({
        level: "warning",
        file: at(`entity:${e.id}`),
        message: `${e.id}: nothing uses it (a box's uses or signature, a connection's carries, another entity)`,
      });
  }
  const guesses = new Map<string, number>();
  const guessed = (file: string) =>
    guesses.set(file.replace(/:\d+$/, ""), (guesses.get(file.replace(/:\d+$/, "")) ?? 0) + 1);
  for (const o of model.objects) if (o.guess) guessed(at(`object:${o.id}`));
  for (const c of model.connections)
    if (c.guess) guessed(at(`connection:${c.from}>${c.to}>${c.label ?? ""}`));
  for (const [file, n] of guesses)
    out.push({
      level: "warning",
      file,
      message: `${n} guess${n === 1 ? "" : "es"} (guess: true): confirm each in the code and drop guess, or remove it`,
    });
  // A label is drawn on the line: a few words. A sentence there covers the picture.
  const long = new Map<string, string[]>();
  for (const c of model.connections) {
    if ((c.label?.length ?? 0) <= LABEL_MAX) continue;
    const file = at(`connection:${c.from}>${c.to}>${c.label ?? ""}`).replace(/:\d+$/, "");
    long.set(file, [...(long.get(file) ?? []), `${c.from}>${c.to}`]);
  }
  for (const [file, ids] of long)
    out.push({
      level: "warning",
      file,
      message: `${ids.length} long label${ids.length === 1 ? "" : "s"} (${ids.slice(0, 4).join(", ")}${ids.length > 4 ? "…" : ""}): a label is drawn on the line, so keep it to a few words ("Session signals"); topic names, caveats and how it works go in description`,
    });
  for (const o of model.objects) {
    if (o.status === "removed" || o.external) continue;
    const file = at(`object:${o.id}`);
    if ((o.kind === "app" || o.kind === "store") && !o.tech)
      out.push({
        level: "warning",
        file,
        message: `${o.id}: no tech (what it's built with or runs on)`,
      });
    if (["system", "app", "store", "component"].includes(o.kind) && !o.context?.trim())
      out.push({
        level: "warning",
        file,
        message: `${o.id}: no context (what it does and why, in a sentence or two)`,
      });
  }
  return out;
}

/** A layout box with its size filled in: its kind's when the file leaves it out. */
function boxRect(
  b: Box,
  kind: ObjectKind,
): { x: number; y: number; w: number; h: number; parts?: { x: number; y: number } } {
  const size = boxSize(kind);
  return {
    x: b.x,
    y: b.y,
    w: b.w ?? size.w,
    h: b.h ?? size.h,
    ...(b.parts ? { parts: { x: b.parts[0], y: b.parts[1] } } : {}),
  };
}

/** JSON with keys sorted and undefined (or empty text) dropped, for comparing records whatever their field order. */
function canonical(v: unknown): string {
  return JSON.stringify(v, (_, x: unknown) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.entries(x as Record<string, unknown>)
            .filter(([, y]) => y !== undefined && y !== "")
            .sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : x,
  );
}

// --- files -> edits -------------------------------------------------------------------------

/**
 * The edits that make the live document match the files. Everything the files don't
 * mention is removed; anything unchanged produces no edit at all.
 */
export function toOps(state: ModelState, model: FileModel): Op[] {
  const ops: Op[] = [];
  const now = new Date().toISOString();
  // key -> id for what exists; new keys become ids as they are.
  const idOf = new Map<string, string>();
  for (const o of state.objects.values()) idOf.set(keyOf(o), o.id);
  const id = (k: string) => idOf.get(k) ?? k;
  const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
  // Entities by name -> id; a new one's id is its name, unless an entity has that id already
  // (one made from the files as Order and renamed Purchase in the app keeps the id Order).
  const eIdOf = new Map<string, string>();
  for (const e of state.entities.values()) eIdOf.set(e.name, e.id);
  const eTaken = new Set(state.entities.keys());
  const eid = (n: string) => {
    let id = eIdOf.get(n);
    if (id) return id;
    id = SAFE_KEY.test(n) ? n : `e_${slug(n)}`;
    for (let i = 2; eTaken.has(id); i++) id = `${SAFE_KEY.test(n) ? n : `e_${slug(n)}`}_${i}`;
    eTaken.add(id);
    eIdOf.set(n, id);
    return id;
  };
  const entities = allEntities(model);
  const entityNames = new Set(entities.map((e) => e.id));
  const entityRef = (n: string): Reference => ({ kind: "entity", to: eid(n) });
  // References are a set: the file can't keep the order of ones it doesn't write (what a
  // signature names), so the same ones in another order are no change.
  const sameSet = (a: Reference[] | undefined, b: Reference[] | undefined) => {
    const x = (a ?? []).map(canonical).sort();
    const y = (b ?? []).map(canonical).sort();
    return x.length === y.length && x.every((r, i) => r === y[i]);
  };
  const withRefs = <T extends { references?: Reference[] }>(
    next: T,
    refs: Reference[],
    cur: { references?: Reference[] } | undefined,
  ): T => {
    const references =
      cur?.references?.length && sameSet(cur.references, refs) ? cur.references : refs;
    const { references: _, ...rest } = next;
    return (references.length ? { ...rest, references } : rest) as T;
  };

  // Objects, parents first so each one's parent exists when it's written.
  const wanted = new Map(model.objects.map((o) => [o.id, o]));
  const depth = (o: FObject) => {
    let d = 0;
    for (let cur = o.in; cur && d < 64; d++) cur = wanted.get(cur)?.in;
    return d;
  };
  for (const f of [...model.objects].sort((a, b) => depth(a) - depth(b))) {
    const cur = state.objects.get(id(f.id));
    const next: ModelObject = {
      id: id(f.id),
      key: f.id,
      kind: f.kind,
      name: f.name,
      description: mergedContext(undefined, f.context),
      technology: f.tech ?? "",
      ...(f.icon ? { icon: f.icon } : {}),
      ...(f.path ? { path: f.path } : {}),
      ...(f.package ? { package: f.package } : {}),
      ...(f.signature ? { signature: f.signature } : {}),
      ...(f.columns?.length ? { columns: f.columns } : {}),
      status: f.status ?? "live",
      parentId: f.in ? id(f.in) : null,
      external: f.external ?? false,
      tags: f.tags ? [...new Set(f.tags)].sort() : [],
      ...(f.refs ? { refs: f.refs } : {}),
      ...(f.sources ? { sources: f.sources } : {}),
      ...objectRefs(f, id),
      ...(f.notes?.trim() ? { notes: f.notes.trim() } : {}),
      ...(f.guess ? { guess: true as const } : {}),
      createdAt: cur?.createdAt ?? now,
      updatedAt: cur?.updatedAt ?? now,
    };
    let fixed = withRefs(
      next,
      [...(next.references ?? []), ...usesOf(f, entityNames).map(entityRef)],
      cur,
    );
    // What its signature names isn't written, so the file can't say whether it pointed at
    // those: with the rest alike, the references it has stand (writing, then reading, is no change).
    if (cur) {
      const derived = new Set(
        signatureTypes(f.signature)
          .filter((n) => entityNames.has(n))
          .map(eid),
      );
      const rest = (refs: Reference[] | undefined) =>
        (refs ?? []).filter((r) => !(r.kind === "entity" && derived.has(r.to)));
      if (sameSet(rest(cur.references), rest(fixed.references)))
        fixed = withRefs(fixed, cur.references ?? [], cur);
    }
    // Compared as the files have it: prose trimmed, context folded into the description.
    const was = cur && {
      ...cur,
      tags: [...(cur.tags ?? [])].sort(),
      references: cur.references?.length ? cur.references : undefined,
      description: mergedContext(cur.description, cur.context),
      context: undefined,
      notes: cur.notes?.trim() || undefined,
    };
    if (!was || !same(was, fixed))
      ops.push({ op: "object.put", object: { ...fixed, updatedAt: cur ? now : fixed.updatedAt } });
  }
  const keep = new Set(model.objects.map((o) => id(o.id)));
  for (const o of state.objects.values())
    if (!keep.has(o.id)) ops.push({ op: "object.delete", id: o.id });

  // Connections: matched per (from, to) by label, then in order.
  const existing = new Map<string, Connection[]>();
  for (const c of state.connections.values()) {
    const k = `${c.fromId}>${c.toId}`;
    existing.set(k, [...(existing.get(k) ?? []), c]);
  }
  const used = new Set<string>();
  const pending: [FConnection, Connection | undefined][] = [];
  for (const f of model.connections) {
    const list = existing.get(`${id(f.from)}>${id(f.to)}`) ?? [];
    const match = list.find(
      (c) => !used.has(c.id) && c.name === (f.label ?? "") && (c.column ?? "") === (f.column ?? ""),
    );
    if (match) used.add(match.id);
    pending.push([f, match]);
  }
  for (const [f, m] of pending) {
    const match =
      m ?? (existing.get(`${id(f.from)}>${id(f.to)}`) ?? []).find((c) => !used.has(c.id));
    if (match) used.add(match.id);
    const next: Connection = {
      id: match?.id ?? `c_${slug(`${f.from}-${f.to}`)}_${Math.random().toString(16).slice(2, 8)}`,
      fromId: id(f.from),
      toId: id(f.to),
      name: f.label ?? "",
      description: f.description?.trim() ?? "",
      ...(f.context?.trim() ? { context: f.context.trim() } : {}),
      technology: f.tech ?? "",
      status: f.status ?? "live",
      ...(f.via ? { viaId: id(f.via) } : {}),
      ...(f.sources ? { sources: f.sources } : {}),
      ...(f.guess ? { guess: true as const } : {}),
      ...(f.both ? { both: true as const } : {}),
      ...(f.column ? { column: f.column } : {}),
      ...(f.to_column ? { toColumn: f.to_column } : {}),
      ...(f.notes?.trim() ? { notes: f.notes.trim() } : {}),
      ...objectRefs(f, id),
    };
    const fixed = withRefs(
      next,
      [...(next.references ?? []), ...(f.carries ?? []).map(entityRef)],
      match,
    );
    if (
      !match ||
      !same(
        {
          ...match,
          viaId: match.viaId ?? undefined,
          links: match.links?.length ? match.links : undefined,
          references: match.references?.length ? match.references : undefined,
          description: match.description.trim(),
          context: match.context?.trim() || undefined,
          notes: match.notes?.trim() || undefined,
        },
        fixed,
      )
    )
      ops.push({ op: "connection.put", connection: fixed });
  }
  for (const c of state.connections.values())
    if (!used.has(c.id)) ops.push({ op: "connection.delete", id: c.id });

  // Entities. What one extends may come later in the file, so those links go in a second pass.
  const eLater: Op[] = [];
  const known = new Set(state.entities.keys());
  for (const f of entities) {
    const cur = state.entities.get(eid(f.id));
    const full: Entity = {
      id: eid(f.id),
      key: f.id,
      name: f.id,
      fields: f.fields ?? [],
      ...(f.values?.length ? { values: f.values } : {}),
      ...(f.extends?.length ? { extends: f.extends.map(eid) } : {}),
      sourceId: f.in ? id(f.in) : null,
      description: f.context?.trim() ?? "",
      createdAt: cur?.createdAt ?? now,
      updatedAt: cur?.updatedAt ?? now,
    };
    if (
      cur &&
      same(
        {
          ...cur,
          extends: cur.extends?.length ? cur.extends : undefined,
          values: cur.values?.length ? cur.values : undefined,
          description: cur.description.trim(),
        },
        full,
      )
    )
      continue;
    const first = full.extends?.every((x) => known.has(x)) ? full : { ...full, extends: undefined };
    ops.push({ op: "entity.put", entity: { ...first, updatedAt: cur ? now : full.updatedAt } });
    if (first !== full)
      eLater.push({ op: "entity.put", entity: { ...full, updatedAt: cur ? now : full.updatedAt } });
    known.add(full.id);
  }
  ops.push(...eLater);
  const keepE = new Set(entities.map((e) => eid(e.id)));
  for (const e of state.entities.values())
    if (!keepE.has(e.id)) ops.push({ op: "entity.delete", id: e.id });

  // Boundaries, parents first.
  const bIdOf = new Map<string, string>();
  for (const b of state.boundaries.values()) bIdOf.set(keyOf(b), b.id);
  const bid = (k: string) => bIdOf.get(k) ?? k;
  const bWanted = new Map(model.boundaries.map((b) => [b.id, b]));
  const bdepth = (b: FBoundary) => {
    let d = 0;
    for (let cur = b.in; cur && d < 32; d++) cur = bWanted.get(cur)?.in;
    return d;
  };
  const selOf = (s: Selector): Selector =>
    "ids" in s
      ? { ids: s.ids.map(id) }
      : "children" in s
        ? { children: id(s.children) }
        : "descendants" in s
          ? { descendants: id(s.descendants) }
          : "neighbours" in s
            ? { neighbours: id(s.neighbours) }
            : s;
  for (const f of [...model.boundaries].sort((a, b) => bdepth(a) - bdepth(b))) {
    const cur = state.boundaries.get(bid(f.id));
    const next: Boundary = {
      id: bid(f.id),
      key: f.id,
      name: f.name,
      kind: f.kind,
      description: f.description ?? "",
      parentId: f.in ? bid(f.in) : null,
      rules: { include: (f.include ?? []).map(selOf), exclude: (f.exclude ?? []).map(selOf) },
      createdAt: cur?.createdAt ?? now,
      updatedAt: cur?.updatedAt ?? now,
    };
    // The file lists a rule's ids sorted: the same ids in another order are no change.
    if (cur && sameRules(cur.rules, next.rules)) next.rules = cur.rules;
    if (!cur || !same(cur, next))
      ops.push({
        op: "boundary.put",
        boundary: { ...next, updatedAt: cur ? now : next.updatedAt },
      });
  }
  const keepB = new Set(model.boundaries.map((b) => bid(b.id)));
  for (const b of state.boundaries.values())
    if (!keepB.has(b.id)) ops.push({ op: "boundary.delete", id: b.id });

  // Decisions (after objects, which they point at). superseded_by may name one written
  // later in the batch, so those go in a second pass.
  const later: Op[] = [];
  for (const f of model.decisions) {
    const cur = state.decisions.get(f.id);
    const next: Decision = {
      id: f.id,
      title: f.title,
      status: f.status,
      ...(f.date ? { date: f.date } : {}),
      affects: [...new Set((f.affects ?? []).map(id))],
      text: f.text ?? "",
      createdAt: cur?.createdAt ?? now,
      updatedAt: cur?.updatedAt ?? now,
    };
    const full = f.superseded_by ? { ...next, supersededBy: f.superseded_by } : next;
    if (
      cur &&
      same(
        { ...cur, text: cur.text.replace(/\n$/, "") },
        { ...full, text: full.text.replace(/\n$/, "") },
      )
    )
      continue;
    ops.push({ op: "decision.put", decision: { ...next, updatedAt: cur ? now : next.updatedAt } });
    if (f.superseded_by)
      later.push({
        op: "decision.put",
        decision: { ...full, updatedAt: cur ? now : next.updatedAt },
      });
  }
  ops.push(...later);
  const keepDec = new Set(model.decisions.map((d) => d.id));
  for (const dc of state.decisions.values())
    if (!keepDec.has(dc.id)) ops.push({ op: "decision.delete", id: dc.id });

  // Views, their flows, and where their boxes sit.
  const diagramByKey = new Map<string, Diagram>();
  for (const d of state.diagrams.values())
    if (!diagramByKey.has(keyOf(d))) diagramByKey.set(keyOf(d), d);
  // Views the files don't have go first, so a file's view can take a key one of them held
  // (a new design's blank "landscape", or two views that ended up with one key).
  const wantedViews = new Set(model.views.map((v) => diagramByKey.get(v.key)?.id ?? `d_${v.key}`));
  for (const d of state.diagrams.values())
    if (!wantedViews.has(d.id)) ops.push({ op: "diagram.delete", id: d.id });
  const mapSel = (s: Selector): Selector => {
    // In the order the files write them (by key), so reading back what was written changes nothing.
    if ("ids" in s) return { ids: [...s.ids].map(String).sort().map(id) };
    if ("children" in s) return { children: id(s.children) };
    if ("descendants" in s) return { descendants: id(s.descendants) };
    if ("neighbours" in s) return { neighbours: id(s.neighbours) };
    return s;
  };
  for (const v of model.views) {
    const cur = diagramByKey.get(v.key);
    const diagramId = cur?.id ?? `d_${v.key}`;
    const rules: Rules | null =
      v.include || v.exclude
        ? { include: (v.include ?? []).map(mapSel), exclude: (v.exclude ?? []).map(mapSel) }
        : null;
    const next: Diagram = {
      id: diagramId,
      key: v.key,
      name: v.name,
      scopeId: v.scope ? id(v.scope) : null,
      rules,
      // Always set, so taking it out of the file takes it off the diagram.
      arrows: v.arrows ?? "curved",
      tidy: v.tidy ?? null,
      keepTidy: !!v.keep_tidy,
      boundaries: !!v.boundaries,
      colorBy: v.color_by ?? null,
      story: (v.story ?? "").replace(/\n$/, ""),
      ...(v.context ? { context: v.context.replace(/\n$/, "") } : {}),
      links: (v.links ?? []).map((l) => ({ title: l.title, url: l.url })),
      fold: v.fold ?? null,
      unfolded: v.unfolded?.length ? v.unfolded : null,
      hideLines: v.hide_lines?.map(mapSel) ?? null,
      lanes: v.lanes ?? null,
      createdAt: cur?.createdAt ?? now,
      updatedAt: cur?.updatedAt ?? now,
    };
    const was = {
      ...cur,
      rules: cur?.rules ?? null,
      arrows: cur?.arrows ?? "curved",
      tidy: cur?.tidy ?? null,
      keepTidy: !!cur?.keepTidy,
      boundaries: !!cur?.boundaries,
      colorBy: cur?.colorBy ?? null,
      story: (cur?.story ?? "").replace(/\n$/, ""),
      ...(cur?.context ? { context: cur.context.replace(/\n$/, "") } : {}),
      links: cur?.links ?? [],
      fold: cur?.fold ?? null,
      unfolded: cur?.unfolded?.length ? cur.unfolded : null,
      hideLines: cur?.hideLines?.length ? cur.hideLines : null,
      lanes: cur?.lanes ?? null,
    };
    if (cur?.rules && next.rules && sameRules(cur.rules, next.rules)) next.rules = cur.rules;
    if (!cur || !same(was, next))
      ops.push({ op: "diagram.put", diagram: { ...next, updatedAt: cur ? now : next.updatedAt } });

    // Boxes: the hand-picked list, or (for rules) whatever is placed now; the server's
    // rules pass adds and removes the rest.
    const layout = model.layouts.get(v.key) ?? {};
    const boxOf = (k: string): Box | undefined =>
      Object.hasOwn(layout, k) ? layout[k] : undefined;
    const placedNow = new Map(
      [...state.placements.values()]
        .filter((p) => p.diagramId === diagramId)
        .map((p) => [p.objectId, p]),
    );
    const boxes = v.boxes ? v.boxes.map(id) : [...placedNow.keys()];
    const boxSet = new Set(boxes);
    const sized = (k: string, b: Box) =>
      boxRect(b, wanted.get(k)?.kind ?? state.objects.get(id(k))?.kind ?? "component");
    let nx =
      Math.max(
        0,
        ...[...placedNow.values()].map((p) => p.x + p.w),
        ...Object.entries(layout).map(([k, b]) => b.x + sized(k, b).w),
      ) + 120;
    for (const objectId of boxes) {
      const k = keyOf(state.objects.get(objectId) ?? { id: objectId });
      const b = boxOf(k);
      const cur = placedNow.get(objectId);
      // Not in the layout: its kind's size, in a row to the right of what's there.
      const size = boxSize(wanted.get(k)?.kind ?? state.objects.get(objectId)?.kind ?? "component");
      const box: { x: number; y: number; w: number; h: number; parts?: { x: number; y: number } } =
        b ? sized(k, b) : cur ? { ...cur } : { x: nx, y: 0, ...size };
      if (!b && !cur) nx += size.w + 72;
      if (
        !cur ||
        cur.x !== box.x ||
        cur.y !== box.y ||
        cur.w !== box.w ||
        cur.h !== box.h ||
        cur.parts?.x !== box.parts?.x ||
        cur.parts?.y !== box.parts?.y
      ) {
        ops.push({ op: "placement.put", placement: { diagramId, objectId, ...box } });
      }
    }
    if (v.boxes)
      for (const objectId of placedNow.keys())
        if (!boxSet.has(objectId)) ops.push({ op: "placement.delete", diagramId, objectId });
    // Rules diagrams: positions for boxes the rules will add come from the layout too.
    if (!v.boxes) {
      for (const [k, b] of Object.entries(layout)) {
        const objectId = id(k);
        if (placedNow.has(objectId) || !keep.has(objectId)) continue;
        ops.push({ op: "placement.put", placement: { diagramId, objectId, ...sized(k, b) } });
      }
    }

    // Arrows shaped by hand: what the file says, and none that it doesn't.
    const shapedNow = new Map(
      [...state.arrows.values()]
        .filter((a) => a.diagramId === diagramId)
        .map((a) => [akey(a.diagramId, a.from, a.to), a]),
    );
    const keepShapes = new Set<string>();
    for (const [ends, f] of Object.entries(model.arrows.get(v.key) ?? {})) {
      const [fk, tk] = ends.split(">") as [string, string];
      const from = id(fk);
      const to = id(tk);
      if (!keep.has(from) || !keep.has(to) || from === to) continue;
      const next: ArrowShape = { diagramId, from, to };
      if (f.from) next.fromSide = f.from;
      if (f.to) next.toSide = f.to;
      if (f.from && f.from_at !== undefined) next.fromAt = f.from_at;
      if (f.to && f.to_at !== undefined) next.toAt = f.to_at;
      if (f.split) next.split = { x: Math.round(f.split[0]), y: Math.round(f.split[1]) };
      if (f.join) next.join = { x: Math.round(f.join[0]), y: Math.round(f.join[1]) };
      if (f.bends?.length)
        next.bends = f.bends.map(([x, y]) => ({ x: Math.round(x), y: Math.round(y) }));
      if (f.label !== undefined) next.label = Math.round(f.label * 1000) / 1000;
      if (f.parts) next.parts = { x: Math.round(f.parts[0]), y: Math.round(f.parts[1]) };
      const empty =
        !next.fromSide && !next.toSide && !next.bends && !next.parts && !next.split && !next.join;
      if (empty && next.label === undefined) continue;
      const k = akey(diagramId, from, to);
      keepShapes.add(k);
      if (!same(shapedNow.get(k), next)) ops.push({ op: "arrow.put", arrow: next });
    }
    for (const [k, a] of shapedNow)
      if (!keepShapes.has(k))
        ops.push({ op: "arrow.delete", diagramId: a.diagramId, from: a.from, to: a.to });

    // Links used to be notes on the canvas; they're on the diagram and its boxes now.
    for (const n of state.notes.values())
      if (n.diagramId === diagramId && n.kind === "link") ops.push({ op: "note.delete", id: n.id });

    const flowsNow = [...state.flows.values()].filter((f) => f.diagramId === diagramId);
    const keepFlows = new Set<string>();
    const flowIds = new Set([...state.flows.keys()]);
    // Two flow names can slug to the same id ("Place order", "Place-order!"): number them.
    const fresh = (base: string) => {
      let fid = base;
      for (let i = 2; flowIds.has(fid); i++) fid = `${base}-${i}`;
      flowIds.add(fid);
      return fid;
    };
    for (const fv of v.flows ?? []) {
      const curFlow = flowsNow.find((f) => f.name === fv.name && !keepFlows.has(f.id));
      const steps = fv.steps.map((s, i) => {
        const old = curFlow?.steps[i];
        const from = id(s.from);
        const to = id(s.to);
        return old && old.fromId === from && old.toId === to
          ? { ...old, text: s.text ?? "" }
          : makeStep({ fromId: from, toId: to, text: s.text ?? "" });
      });
      const flow: Flow = {
        id: curFlow?.id ?? fresh(`f_${slug(`${v.key}-${fv.name}`)}`),
        diagramId,
        name: fv.name,
        ...(fv.kind ? { kind: fv.kind } : {}),
        steps,
        createdAt: curFlow?.createdAt ?? now,
        updatedAt: curFlow?.updatedAt ?? now,
      };
      keepFlows.add(flow.id);
      if (!curFlow || !same(curFlow, flow))
        ops.push({ op: "flow.put", flow: { ...flow, updatedAt: curFlow ? now : flow.updatedAt } });
    }
    for (const f of flowsNow) if (!keepFlows.has(f.id)) ops.push({ op: "flow.delete", id: f.id });
  }
  // Don't place what's being deleted.
  return ops
    .filter((op) => op.op !== "placement.put" || keep.has(op.placement.objectId))
    .filter((op, i, all) => {
      // A placement removed and re-put in one batch: keep only the last word.
      if (op.op !== "placement.delete") return true;
      const k = pkey(op.diagramId, op.objectId);
      return !all
        .slice(i + 1)
        .some(
          (o) =>
            o.op === "placement.put" && pkey(o.placement.diagramId, o.placement.objectId) === k,
        );
    });
}

/**
 * The entities once `written` is laid over `base`: one written replaces the one with its name;
 * the ones defined in a box that was written again are exactly the ones written with it (the
 * file owns them, as it owns its connections); the ones defined in a box that's gone stay, with
 * no home, as when the app deletes a box. Entities are named apart from objects: an object id
 * never removes an entity.
 */
function laidEntities(
  base: FEntity[],
  written: FEntity[],
  rewritten: Set<string>,
  gone: Set<string>,
): FEntity[] {
  const names = new Set(written.map((e) => e.id));
  const kept = base.filter((e) => !names.has(e.id) && !(e.in && rewritten.has(e.in)));
  return [...kept.map((e) => (e.in && gone.has(e.in) ? { ...e, in: undefined } : e)), ...written];
}

/**
 * Files that are the whole design (write's replace): their objects and connections are all
 * there is; views, boundaries and decisions too when they were sent. Entities by name, as
 * `laidEntities` lays them: the ones in a box written again are the ones written with it, and
 * the ones in a box the rewrite leaves out stay, with no home.
 */
export function replaced(
  base: FileModel,
  mine: FileModel,
  sent: { views: boolean; boundaries: boolean; decisions: boolean },
): FileModel {
  const ids = new Set(mine.objects.map((o) => o.id));
  return {
    ...base,
    objects: mine.objects,
    connections: mine.connections,
    entities: laidEntities(
      base.entities,
      mine.entities,
      ids,
      new Set(base.objects.map((o) => o.id).filter((id) => !ids.has(id))),
    ),
    views: sent.views ? mine.views : base.views,
    boundaries: sent.boundaries ? mine.boundaries : base.boundaries,
    decisions: sent.decisions ? mine.decisions : base.decisions,
    origin: new Map([...base.origin, ...mine.origin]),
    ...(mine.stubs ? { stubs: mine.stubs } : {}),
  };
}

/**
 * Lay files written by an agent over a design, by id rather than by file: each object,
 * boundary, decision and view in them replaces the one with the same id wherever it lives,
 * and the connections from an object they define are exactly the ones they list (as are the
 * entities defined in it: an entity is replaced by name). So an
 * agent can keep rewriting its own file (Archnemesis files things back into their system's file),
 * and agents working in parallel, each with its own file, never collide. Removing is
 * explicit: `remove` names ids (objects take what's inside them along, as in the app; the
 * entities they define stay, with no home).
 */
export function overlay(base: FileModel, written: FileModel, remove: string[] = []): FileModel {
  const objIds = new Set(written.objects.map((o) => o.id));
  const gone = new Set(remove);
  // What's inside a removed object goes with it.
  for (let grew = true; grew;) {
    grew = false;
    for (const o of base.objects)
      if (o.in && gone.has(o.in) && !gone.has(o.id) && !objIds.has(o.id))
        (gone.add(o.id), (grew = true));
  }
  const keep = <T>(xs: T[], idOf: (x: T) => string, mine: Set<string>) =>
    xs.filter((x) => !mine.has(idOf(x)) && !gone.has(idOf(x)));
  const origin = new Map(base.origin);
  for (const [k, v] of written.origin) origin.set(k, v);
  const goneObjects = new Set(
    base.objects.filter((o) => gone.has(o.id) && !objIds.has(o.id)).map((o) => o.id),
  );
  return {
    ...base,
    objects: [...keep(base.objects, (o) => o.id, objIds), ...written.objects],
    // An object's connections live with it: the written file's list is the whole list.
    connections: [
      ...base.connections.filter(
        (c) => !objIds.has(c.from) && !gone.has(c.from) && !gone.has(c.to),
      ),
      ...written.connections,
    ],
    entities: laidEntities(base.entities, written.entities, objIds, goneObjects),
    boundaries: [
      ...keep(base.boundaries, (b) => b.id, new Set(written.boundaries.map((b) => b.id))),
      ...written.boundaries,
    ],
    decisions: [
      ...keep(base.decisions, (d) => d.id, new Set(written.decisions.map((d) => d.id))),
      ...written.decisions,
    ],
    views: [
      ...keep(base.views, (v) => v.key, new Set(written.views.map((v) => v.key))),
      ...written.views,
    ],
    origin,
    ...(base.stubs || written.stubs
      ? { stubs: new Set([...(base.stubs ?? []), ...(written.stubs ?? [])]) }
      : {}),
  };
}
