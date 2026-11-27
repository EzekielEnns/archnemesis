// write: a fragment in the file grammar, merged by id into the design (docs/mcp-v2.md).
//
// The fragment is merged into the design's own files, node by node: a box that exists gets the
// fields written (null takes one off) and keeps the rest; a new one is added; a connection is
// matched by its ends (and label); leaving something out never deletes it, `remove` does. Then
// the files are read and checked exactly as `archnm check` reads a folder, so the rules (and the
// messages) are the grammar's own. All problems at once; nothing is half-applied.
import YAML from "yaml";
import { globRe, isGlob } from "../codeindex.ts";
import {
  allEntities,
  check,
  overlay,
  readFiles,
  toOps,
  type FileModel,
  type Problem,
  type FArrow,
} from "../files.ts";
import {
  makeDiagram,
  type Diagram,
  type LayoutDirection,
  type ModelObject,
  type Op,
} from "../model.ts";
import { scoreView } from "../score.ts";
import { ancestors, descendants, projectDiagram, type ModelIndex } from "../project.ts";
import { arr, clip, fail, ok, plural, type Host, type Out } from "./host.ts";
import { offShelfNotes } from "./offshelf.ts";
import { filesOf } from "./problems.ts";
import { connRef, idOf, object, refOf, viewId } from "./refs.ts";
import { resolveRef } from "../context.ts";
import { measure, tidyView } from "./tidy.ts";
import { sideSpot, type Beside } from "../actions.ts";
import { boxSize, type BoxSide } from "../model.ts";
import * as Y from "yjs";
import { applyOps, emptyState, mirror } from "../doc.ts";
import { viewOps } from "../views.ts";
import { indexOf } from "./problems.ts";
import { findView } from "../agent.ts";
import { FIELDS } from "../spec.ts";

export interface WriteArgs {
  yaml?: string;
  /** Whole files (model/x.yaml, views/v.yaml…), as the folder has them: what read {file} gives, or a view exported to copy. */
  files?: Record<string, string>;
  remove?: string | string[];
  /** Arrows from one box drawn as one line to a point, where they part, on a view. at: null undoes it. */
  splits?: { view: string; from: string; to: string[]; at: [number, number] | null }[];
  /** Arrows into one box drawn meeting at a point and going in as one line, on a view. at: null undoes it. */
  joins?: { view: string; to: string; from: string[]; at: [number, number] | null }[];
  /** How one line runs on a view: the side it leaves its from box, the side it enters its to box, corners on the way. null clears one. */
  route?: {
    view: string;
    from: string;
    to: string;
    leaves?: BoxSide | null;
    enters?: BoxSide | null;
    bends?: [number, number][] | null;
  }[];
  /** Where a box goes on a view: beside another box (side, of), or at a spot. */
  place?: {
    view: string;
    box: string;
    side?: Beside;
    of?: string;
    at?: [number, number];
  }[];
  dry_run?: boolean;
  /** Only changes inside this box's subtree; anything else is refused with what to note instead. */
  scope?: string;
  /** Lay out these views after (or true: every view this changed). */
  tidy?: boolean | string | string[];
  direction?: LayoutDirection;
  /** Lay out again even a view somebody arranged by hand. */
  rearrange?: boolean;
  undo?: boolean;
  label?: string;
  /** A passing dry run's id: write exactly what it checked (refused if the design changed since). */
  apply?: string;
  /** A refused write's (or a dry run's) id: yaml here is only the corrections, merged into that write's fragment by key, then the whole is checked again. */
  onto?: string;
  /** With onto: exact text changes to that write's fragment ({old, new}; old must occur once), for what isn't YAML yet (a colon to quote, a bad indent). */
  edits?: { old: string; new: string }[];
}

/**
 * Passing dry runs, kept so the write can follow without sending it all again: what was asked,
 * which design, and the design as it was (a fingerprint of its files). In memory, a while.
 */
/** A view past this many boxes after a write gets a warning (the rule is about 12). */
const CROWDED = 14;
const DRY_KEEP_MS = 60 * 60_000;
const dryRuns = new Map<string, { design: string; args: WriteArgs; print: string; at: number }>();
const mainOf = (key: string) => key.split("@")[0]!;
function fingerprint(files: Map<string, string>): string {
  let h = 2166136261;
  for (const k of [...files.keys()].sort()) {
    const t = `${k}\u0000${files.get(k)}\u0001`;
    for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619);
  }
  return `${(h >>> 0).toString(36)}-${files.size}`;
}
function keepDryRun(design: string, args: WriteArgs, print: string): string {
  const now = Date.now();
  for (const [k, v] of dryRuns) if (now - v.at > DRY_KEEP_MS) dryRuns.delete(k);
  while (dryRuns.size >= 200) dryRuns.delete(dryRuns.keys().next().value!);
  const id = `dry-${Math.random().toString(36).slice(2, 8)}`;
  const { dry_run: _, as: _as, ...rest } = args as WriteArgs & { as?: string };
  dryRuns.set(id, { design, args: rest, print, at: now });
  return id;
}

/** Refused writes, kept so a fix can be sent alone (write {onto, yaml}). In memory, a while. */
const drafts = new Map<string, { design: string; args: WriteArgs; at: number }>();
function keepDraft(design: string, args: WriteArgs): string {
  const now = Date.now();
  for (const [k, v] of drafts) if (now - v.at > DRY_KEEP_MS) drafts.delete(k);
  while (drafts.size >= 200) drafts.delete(drafts.keys().next().value!);
  const id = `draft-${Math.random().toString(36).slice(2, 8)}`;
  const { dry_run: _, as: _as, onto: _o, apply: _a, ...rest } = args as WriteArgs & { as?: string };
  drafts.set(id, { design, args: rest, at: now });
  return id;
}

/**
 * A fragment with corrections merged in: a map section's entry (an object, entity, view…) is
 * merged with the correction's, field by field (null drops it); a connection replaces the one with the
 * same ends (and label, when both have one), else it's added. Undefined when either doesn't parse.
 */
function mergeFragment(base: string, fix: string): string | undefined {
  let a: Record<string, unknown>, b: Record<string, unknown>;
  try {
    a = (YAML.parse(base) ?? {}) as Record<string, unknown>;
    b = (YAML.parse(fix) ?? {}) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (typeof a !== "object" || typeof b !== "object" || Array.isArray(a) || Array.isArray(b))
    return undefined;
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const was = out[k];
    if (k === "connections" && Array.isArray(v)) {
      const list = Array.isArray(was) ? [...(was as Record<string, unknown>[])] : [];
      for (const c of v as Record<string, unknown>[]) {
        const i = list.findIndex(
          (x) =>
            x?.from === c?.from &&
            x?.to === c?.to &&
            (!x?.label || !c?.label || x.label === c.label),
        );
        if (i >= 0) list[i] = c;
        else list.push(c);
      }
      out[k] = list;
    } else if (
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      was &&
      typeof was === "object" &&
      !Array.isArray(was)
    ) {
      const m: Record<string, unknown> = { ...(was as Record<string, unknown>) };
      // An entry already in the fragment takes the fields sent, and keeps the rest (a
      // view sent with only its arrows lost its scope); a field sent as null is taken out.
      const isMap = (x: unknown): x is Record<string, unknown> =>
        !!x && typeof x === "object" && !Array.isArray(x);
      for (const [id, e] of Object.entries(v)) {
        if (e === null) delete m[id];
        else if (isMap(e) && isMap(m[id])) {
          const f: Record<string, unknown> = { ...m[id] };
          for (const [fk, fv] of Object.entries(e))
            if (fv === null) delete f[fk];
            else f[fk] = fv;
          m[id] = f;
        } else m[id] = e;
      }
      out[k] = m;
    } else out[k] = v;
  }
  return YAML.stringify(out, { lineWidth: 0 });
}

const SCRATCH = "model/_write.yaml";
const TOP_KEYS = ["objects", "entities", "connections", "views", "boundaries", "decisions", "tags"];
const FILE_RE = /^(model|views|code|decisions)\/[\w./-]+\.ya?ml$|^(boundaries|libraries)\.yaml$/;
const EXAMPLE = `For example:
objects:
  billing: {kind: app, in: shop, tech: [Go], context: "Charges orders, then emails the invoice."}
  checkout:   # an existing box: only these fields change
    context: |
      Takes the order and pays for it: one call to payments, then the order is saved.
entities:
  Invoice: {in: billing, fields: {id: uuid, total: Money}}
connections:
  - {from: checkout, to: billing, label: bills the order, tech: HTTPS, carries: [Invoice]}
remove: [old-box, checkout>legacy-api, view:old-view]   (a parameter beside yaml, or a key in it)`;

const QUOTE = 'quote it (context: "…") or write the box as a block (context: on its own line)';

/** The YAML library's messages, in ours: what's wrong on the line and what to write instead. */
const YAML_SAYS: Record<string, string> = {
  BLOCK_IN_FLOW: `the text has a colon inside {…}: ${QUOTE}`,
  MULTILINE_IMPLICIT_KEY:
    "a key runs over two lines: a line is missing its colon, or a text with a colon in it needs quotes",
  BAD_INDENT: "the indentation is off: a field goes two spaces in from the box it belongs to",
  TAB_AS_INDENT: "indent with spaces, not tabs",
  MISSING_CHAR: 'something isn\'t closed: every {, [ and " needs its closing }, ] or "',
  UNEXPECTED_TOKEN:
    "a stray character: a text with :, #, {, [ or a leading - or * in it needs quotes",
  BLOCK_AS_IMPLICIT_KEY: "a key can't be a list or a map: write key: value",
  BAD_DQ_ESCAPE:
    "a backslash inside \"…\" starts an escape: use '…' quotes, or double the backslash",
  BAD_SCALAR_START: "a text can't start with that character unquoted: put it in quotes",
  DUPLICATE_KEY: "a key appears twice in one map: keep one",
  KEY_OVER_1024_CHARS: "a key is too long: a text that long is a value, and needs quotes",
};

/**
 * A text with a colon in it, unquoted (name: Server: the HTTP edge), which YAML reads as a map
 * inside a value: say which field and how to quote it, from the line itself.
 */
function colonIn(line: string, code: string, col: number): string | null {
  if (code === "BLOCK_AS_IMPLICIT_KEY") {
    const m = /^\s*(?:-\s+)?([\w.-]+):\s+([^"'{[].*:.*)$/.exec(line);
    if (!m) return null;
    const v = m[2]!.replace(/\s+#.*$/, "").trim();
    return `${m[1]}: the text has a colon in it (${clip(v, 60)}), which YAML reads as a key: quote it (${m[1]}: "${clip(v, 60)}")`;
  }
  if (code === "BLOCK_IN_FLOW" && col > 1) {
    const key = /([\w.-]+):\s*$/.exec(line.slice(0, col - 1))?.[1];
    const v = /^(.*?)(?=,\s*[\w.-]+:\s|\s*\}|$)/.exec(line.slice(col - 1))?.[1]?.trim();
    if (!key || !v || !v.includes(":")) return null;
    return `${key}: the text has a colon inside {…} (${clip(v, 60)}): quote it (${key}: "${clip(v, 60)}") or write the box as a block`;
  }
  return null;
}

/** Strict YAML, as the reader takes it: no anchors, aliases, tags, directives or duplicate keys; one message per line, in our words. */
function strict(text: string, file: string): { doc: YAML.Document; problems: Problem[] } {
  const lc = new YAML.LineCounter();
  const doc = YAML.parseDocument(text, { merge: false, uniqueKeys: false, lineCounter: lc });
  const problems: Problem[] = [];
  const at = (n: YAML.Node) => (n.range ? `${file}:${lc.linePos(n.range[0]).line}` : file);
  const lines = new Set<number>();
  const src = text.split("\n");
  for (const e of doc.errors) {
    const line = e.linePos?.[0]?.line ?? 0;
    if (line && lines.has(line)) continue;
    lines.add(line);
    const colon = colonIn(src[line - 1] ?? "", e.code, e.linePos?.[0]?.col ?? 0);
    problems.push({
      level: "error",
      file: line ? `${file}:${line}` : file,
      message:
        colon ??
        YAML_SAYS[e.code] ??
        `${e.message.split("\n")[0]!.replace(/ at line \d+, column \d+:?$/, "")} (YAML)`,
    });
  }
  // Prose with a comma in a flow map: "{kind: actor, context: Hungry, tired}" reads as a key "tired". One error for the line, not one per stray key.
  YAML.visit(doc, {
    Map: (_, m) => {
      if (!m.flow) return;
      const prose = (it: (typeof m.items)[number]) =>
        YAML.isScalar(it.key) &&
        typeof it.key.value === "string" &&
        (/\s/.test(it.key.value.trim()) || /[.!?)]$/.test(it.key.value)) &&
        isNull(it.value) &&
        !(YAML.isScalar(it.value) && it.value.source);
      // A connection's label (or description) with a comma reads one way only: the stray keys
      // right after it are the rest of it. Put them back ("charges cards, then emails").
      // The rest of it: a key with no value that isn't a connection's field (prose, or one word).
      const rest = (it: (typeof m.items)[number]) =>
        prose(it) ||
        (YAML.isScalar(it.key) &&
          typeof it.key.value === "string" &&
          !(FIELDS.connection as readonly string[]).includes(it.key.value) &&
          isNull(it.value) &&
          !(YAML.isScalar(it.value) && it.value.source));
      if (m.has("from") && m.has("to"))
        for (let i = 0; i < m.items.length; i++) {
          const it = m.items[i]!;
          if (
            !YAML.isScalar(it.key) ||
            !["label", "description"].includes(String(it.key.value)) ||
            !YAML.isScalar(it.value) ||
            typeof it.value.value !== "string" ||
            it.value.type !== "PLAIN"
          )
            continue;
          while (m.items[i + 1] && rest(m.items[i + 1]!)) {
            it.value.value = `${it.value.value}, ${String((m.items[i + 1]!.key as YAML.Scalar).value).trim()}`;
            m.items.splice(i + 1, 1);
          }
        }
      const at2 = m.items.findIndex(prose);
      if (at2 < 0) return;
      const line = m.range ? lc.linePos(m.range[0]).line : 0;
      if (lines.has(line)) return;
      lines.add(line);
      // Which field's text it is: the one before the stray words (name, label, context, any).
      const field = at2 > 0 ? m.items[at2 - 1]! : null;
      const k = field && YAML.isScalar(field.key) ? String(field.key.value) : "";
      const v =
        field && YAML.isScalar(field.value) && typeof field.value.value === "string"
          ? field.value.value
          : "";
      const strays = m.items
        .slice(at2)
        .filter(prose)
        .map((it) => String((it.key as YAML.Scalar).value).trim());
      const whole = v ? [v, ...strays].join(", ") : "";
      problems.push({
        level: "error",
        file: line ? `${file}:${line}` : file,
        message:
          k && whole
            ? `${k}: the text has a comma inside {…}, so "${strays[0]}" reads as a field of its own: quote it (${k}: "${clip(whole, 80)}") or write the box as a block`
            : `the text has a comma inside {…}: ${QUOTE}`,
      });
    },
  });
  if (/^\s*%/m.test(text))
    problems.push({
      level: "error",
      file,
      message: "directives (%YAML, %TAG) aren't allowed; take the line out",
    });
  YAML.visit(doc, {
    Alias: (_, n) =>
      void problems.push({
        level: "error",
        file: at(n),
        message: `aliases (*${n.source}) aren't allowed; write the value out`,
      }),
    Node: (_, n) => {
      if (n.anchor)
        problems.push({
          level: "error",
          file: at(n),
          message: `anchors (&${n.anchor}) aren't allowed; write the value out each time`,
        });
      if (n.tag)
        problems.push({
          level: "error",
          file: at(n),
          message: `tags (${n.tag}) aren't allowed; write the plain value`,
        });
      if (YAML.isMap(n)) {
        const seen = new Set<string>();
        for (const it of n.items) {
          const k = YAML.isScalar(it.key) ? String(it.key.value) : "";
          if (seen.has(k))
            problems.push({
              level: "error",
              file: at(it.key as YAML.Node),
              message: `\`${k}\` appears twice; keep one`,
            });
          seen.add(k);
        }
      }
    },
  });
  return { doc, problems };
}

const isNull = (n: unknown) =>
  n === null ||
  n === undefined ||
  (YAML.isScalar(n) && (n.value === null || n.value === undefined));
const str = (n: unknown): string | undefined =>
  YAML.isScalar(n) && n.value !== null && n.value !== undefined
    ? String(n.value)
    : typeof n === "string"
      ? n
      : undefined;
const clone = <T>(n: T): T => (YAML.isNode(n) ? (n.clone() as T) : n);
/** A new thing's fields: null means "not set" (as on an existing one it takes the field off), so it's left out. */
const fresh = <T>(n: T): T => {
  const c = clone(n);
  if (YAML.isMap(c)) c.items = c.items.filter((it) => !isNull(it.value));
  return c;
};

/** Files that hold objects, entities and connections: everything but archnm.yaml, the views, the decisions and boundaries.yaml (model/, code/, libraries.yaml…). */
const holds = (p: string) =>
  /\.ya?ml$/.test(p) &&
  !/^(views|decisions)\//.test(p) &&
  p !== "archnm.yaml" &&
  p !== "boundaries.yaml";

/** What a write takes away, each kind by its own ids (a view and a box may share one). */
interface Removals {
  objects: string[];
  views: string[];
  boundaries: string[];
  decisions: string[];
}

/** The design's files as documents to merge into, made once each and only when touched. */
class Folder {
  readonly texts: Map<string, string>;
  private docs = new Map<string, YAML.Document>();
  readonly touched = new Set<string>();
  readonly objectAt = new Map<string, string>();
  readonly entityAt = new Map<string, string>();
  /** origin: where a read of these same files found each object and entity (saves reading them again). */
  constructor(files: Map<string, string>, origin?: Map<string, string>) {
    this.texts = new Map(files);
    if (origin) {
      for (const [k, at] of origin) {
        const m = /^(object|entity):([^#]+)$/.exec(k);
        const p = m && at.replace(/:\d+$/, "");
        if (!m || !p || !holds(p)) continue;
        (m[1] === "object" ? this.objectAt : this.entityAt).set(m[2]!, p);
      }
      return;
    }
    for (const [p, t] of files) {
      if (!holds(p)) continue;
      // Ids and names only, from a plain read: the documents are parsed when merged into.
      const v = (YAML.parse(t) ?? {}) as {
        objects?: Record<string, unknown>;
        entities?: Record<string, unknown>;
      };
      for (const id of Object.keys(v.objects ?? {})) this.objectAt.set(id, p);
      for (const n of Object.keys(v.entities ?? {})) this.entityAt.set(n, p);
    }
  }
  doc(path: string, empty: () => unknown = () => ({})): YAML.Document {
    let d = this.docs.get(path);
    if (!d) {
      const t = this.texts.get(path);
      d =
        t === undefined
          ? new YAML.Document(empty(), { aliasDuplicateObjects: false })
          : YAML.parseDocument(t, { merge: false, uniqueKeys: false });
      if (!YAML.isMap(d.contents)) d.contents = d.createNode({}) as never;
      this.docs.set(path, d);
    }
    this.touched.add(path);
    return d;
  }
  /** A map under the document's top key, made when missing. */
  section(path: string, key: string, seq = false): YAML.YAMLMap | YAML.YAMLSeq {
    const d = this.doc(path);
    let s = d.get(key);
    if (!s || !(seq ? YAML.isSeq(s) : YAML.isMap(s))) {
      s = d.createNode(seq ? [] : {});
      d.set(key, s);
    }
    return s as YAML.YAMLMap | YAML.YAMLSeq;
  }
  docsWith(key: string): [string, YAML.Document][] {
    const out: [string, YAML.Document][] = [];
    for (const p of this.texts.keys())
      if (holds(p) && this.texts.get(p)!.includes(`${key}:`)) out.push([p, this.doc(p)]);
    if (this.docs.has(SCRATCH) && !out.some(([p]) => p === SCRATCH))
      out.push([SCRATCH, this.doc(SCRATCH)]);
    return out;
  }
  files(): Map<string, string> {
    const out = new Map(this.texts);
    for (const p of this.touched)
      out.set(
        p,
        this.docs.get(p)!.toString({ lineWidth: 0, indent: 2, flowCollectionPadding: false }),
      );
    return out;
  }
}

/** Fields onto a map node: each written field replaces its own, null takes it off, the rest stay. */
function mergeInto(target: YAML.YAMLMap, fields: YAML.YAMLMap) {
  for (const it of fields.items) {
    const k = str(it.key);
    if (k === undefined) continue;
    if (isNull(it.value)) target.delete(k);
    else target.set(k, clone(it.value));
  }
}

/** Where problems come from: the fragment, or what it broke elsewhere. */
const site = (p: Problem) => `${p.file.replace(/:\d+$/, "")}: ${p.message}`;

/**
 * remove, read loosely: a list, one ref, a string that is a list ("[view:a, view:b]", as JSON
 * or YAML), or refs split by commas when no part has a space (a label with a comma stays whole).
 */
export function refList(v: unknown): string[] {
  const out: string[] = [];
  for (const x of arr(v as unknown[] | unknown)) {
    if (x === null || x === undefined) continue;
    if (typeof x !== "string") {
      out.push(String(x));
      continue;
    }
    const s = x.trim();
    if (!s) continue;
    if (s.startsWith("[") && s.endsWith("]")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(s);
      } catch {
        try {
          parsed = YAML.parse(s);
        } catch {
          parsed = undefined;
        }
      }
      if (Array.isArray(parsed)) {
        out.push(...refList(parsed));
        continue;
      }
    }
    const parts = s
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length > 1 && parts.every((p) => !/\s/.test(p))) out.push(...parts);
    else out.push(s);
  }
  return out;
}

const liftedNote = (lifted: string[], ignored: string[]) =>
  [
    lifted.length
      ? `(${lifted.join(", ")} in the yaml: taken as ${lifted.length === 1 ? "the parameter" : "parameters"}, beside yaml)`
      : "",
    ignored.length
      ? `(${ignored.join(", ")} in the yaml ignored: given as a parameter too, which wins)`
      : "",
  ]
    .filter(Boolean)
    .join(" ");

/** The repos a design's paths can name: the ones index start brought in for it, and those its paths and sources already use. */
function knownRepos(model: FileModel, registered: string[]): Set<string> {
  const out = new Set(registered);
  for (const o of model.objects) {
    if (o.path) out.add(o.path.split(":")[0]!);
    for (const s of o.sources ?? []) {
      const m = /^([\w.-]+)[@:]/.exec(s);
      if (m && !/^https?$/.test(m[1]!)) out.add(m[1]!);
    }
  }
  return out;
}

/** write's own parameters, which agents also write inside the yaml: taken out and used as the parameters. */
const PARAM_KEYS = [
  "tidy",
  "rearrange",
  "remove",
  "splits",
  "joins",
  "place",
  "route",
  "scope",
  "dry_run",
  "as",
  "label",
  "direction",
] as const;

/**
 * Parameters written inside the yaml (tidy: true, label: …, as: …), lifted out and used as the
 * parameters: a parameter given beside the yaml wins (remove: both, merged). Never throws: a
 * fragment that doesn't parse is left for write to report.
 */
export function liftParams<T extends WriteArgs & { as?: string }>(
  a: T,
): { args: T; lifted: string[]; ignored: string[] } {
  const lifted: string[] = [];
  const ignored: string[] = [];
  if (!a.yaml?.trim()) return { args: a, lifted, ignored };
  let v: unknown;
  try {
    v = YAML.parse(a.yaml);
  } catch {
    return { args: a, lifted, ignored };
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return { args: a, lifted, ignored };
  const out = { ...a } as Record<string, unknown>;
  for (const k of PARAM_KEYS) {
    if (!(k in (v as Record<string, unknown>))) continue;
    const val = (v as Record<string, unknown>)[k];
    if (k === "remove") {
      // Once each: a dry run keeps the yaml with its remove: and the list lifted from it, and its
      // apply lifts it again (every line was removed twice, the second time refused).
      out.remove = [...new Set([...refList(a.remove), ...refList(val)])];
      lifted.push(k);
    } else if (out[k] === undefined) {
      out[k] = val;
      lifted.push(k);
    } else if (JSON.stringify(out[k]) !== JSON.stringify(val)) ignored.push(k);
  }
  return { args: out as T, lifted, ignored };
}

/** How many of a view's arrows somebody shaped by hand, as it was before this write. */
function handShaped(idx: ModelIndex, diagramId: string): number {
  let n = 0;
  for (const s of idx.arrows.values())
    if (s.diagramId === diagramId && (s.bends?.length || s.split || s.join)) n++;
  return n;
}

/**
 * splits: on a view, arrows from one box drawn as one line to a point and on from there to each
 * of their boxes (a bus, a fan-out). It's how the view draws them: each stays its own connection.
 */
function setSplits(
  model: FileModel,
  splits: NonNullable<WriteArgs["splits"]>,
  kind: "split" | "join" = "split",
): { model: FileModel; problems: string[] } {
  const problems: string[] = [];
  const arrows = new Map(model.arrows);
  const drawn = (ends: string) => model.connections.some((c) => `${c.from}>${c.to}` === ends);
  for (const f of splits) {
    const say = (m: string) => problems.push(`${f?.from ?? "?"}: ${m}`);
    const at = f?.at;
    const point = Array.isArray(at) && at.length === 2 && at.every((n) => Number.isFinite(n));
    if (!f || typeof f.view !== "string" || typeof f.from !== "string" || !Array.isArray(f.to))
      return {
        model,
        problems: [
          kind === "split"
            ? "each split is {view, from: a, to: [b, c], at: [x, y]}"
            : "each join is {view, to: a, from: [b, c], at: [x, y]}",
        ],
      };
    const view = f.view.replace(/^view:/, "");
    if (!model.views.some((v) => v.key === view)) {
      say(`no view "${view}" (${model.views.map((v) => v.key).join(", ")})`);
      continue;
    }
    if (at !== null && !point) {
      say(
        "at is the point they part at, [x, y] as boxes are placed in the view's layout (null undoes it)",
      );
      continue;
    }
    const mine = { ...arrows.get(view) };
    for (const to of f.to) {
      const key = kind === "split" ? `${f.from}>${to}` : `${to}>${f.from}`;
      if (!drawn(key)) {
        say(`no connection ${key} (from and to are box ids)`);
        continue;
      }
      const { [kind]: _was, ...rest } = mine[key] ?? {};
      if (at) mine[key] = { ...rest, [kind]: [Math.round(at[0]), Math.round(at[1])] };
      else if (Object.keys(rest).length) mine[key] = rest;
      else delete mine[key];
    }
    arrows.set(view, mine);
  }
  return { model: { ...model, arrows }, problems };
}

/** Would a view's rules put this box on it (the rules a new box usually arrives by; the rest: no). */
function ruleTakes(
  model: FileModel,
  v: FileModel["views"][number],
  o: FileModel["objects"][number],
) {
  const hit = (s: NonNullable<typeof v.include>[number]): boolean => {
    if ("ids" in s) return s.ids.includes(o.id);
    if ("kind" in s) return s.kind === o.kind;
    if ("top" in s) return !o.in;
    if ("children" in s) return o.in === s.children;
    if ("tag" in s) return (o.tags ?? []).includes(s.tag as string);
    if ("neighbours" in s)
      return model.connections.some(
        (c) =>
          (c.from === o.id && c.to === s.neighbours) || (c.to === o.id && c.from === s.neighbours),
      );
    return false;
  };
  return (v.include ?? []).some(hit) && !(v.exclude ?? []).some(hit);
}

/**
 * A view somebody arranged by hand, that follows rules: boxes this write makes would land on
 * it by those rules, in the middle of their work. They're left off it (excluded by id) unless
 * the write places them there or rewrites the view itself, and the answer says so.
 */
function keepArranged(
  was: FileModel,
  model: FileModel,
  places: NonNullable<WriteArgs["place"]>,
): { model: FileModel; notes: string[] } {
  const notes: string[] = [];
  const old = new Set(was.objects.map((o) => o.id));
  const fresh = model.objects.filter((o) => !old.has(o.id));
  if (!fresh.length) return { model, notes };
  const views = model.views.map((v) => {
    const before = was.views.find((x) => x.key === v.key);
    const shaped = Object.values(model.arrows.get(v.key) ?? {}).some(
      (s) => s.bends?.length || s.split || s.join,
    );
    // Not arranged, not following rules, or its rules rewritten by this very write: theirs to say.
    if (!before || !shaped || !v.include?.length) return v;
    if (JSON.stringify([before.include, before.exclude]) !== JSON.stringify([v.include, v.exclude]))
      return v;
    const placed = new Set(
      places.filter((p) => p?.view?.replace(/^view:/, "") === v.key).map((p) => p.box),
    );
    const off = fresh.filter((o) => !placed.has(o.id) && ruleTakes(model, v, o)).map((o) => o.id);
    if (!off.length) return v;
    notes.push(
      `${v.key} was arranged by hand, so ${off.join(", ")} (which its rules would add) ${off.length === 1 ? "was" : "were"} left off it. Give ${off.length === 1 ? "it" : "them"} a view of ${off.length === 1 ? "its" : "their"} own with what ${off.length === 1 ? "it connects" : "they connect"} to (views: {<key>: {name, boxes: [...]}}); one or two that belong on ${v.key} go on with place: [{view: "${v.key}", box, side, of}], at its edge.`,
    );
    const ids = (v.exclude ?? []).find((s): s is { ids: string[] } => "ids" in s);
    const exclude = ids
      ? (v.exclude ?? []).map((s) => (s === ids ? { ids: [...ids.ids, ...off] } : s))
      : [...(v.exclude ?? []), { ids: off }];
    return { ...v, exclude };
  });
  return { model: { ...model, views }, notes };
}

/**
 * What a write would do to the views already drawn, said in the dry run: which boxes each
 * gains and where they'd land, and whether its lines would cross more. (The model as it
 * would be is built aside, with its rules applied, and measured.)
 */
function foresee(idx: ModelIndex, model: FileModel): string[] {
  const doc = new Y.Doc();
  const state = emptyState();
  const stop = mirror(doc, state, () => {});
  const system = { id: "archnm", name: "archnm", kind: "system" as const };
  try {
    applyOps(doc, state, toOps(emptyState(), model), system, "preview", system, { log: false });
    const mid = indexOf(state);
    const follow = [...state.diagrams.values()]
      .filter((d) => d.rules)
      .flatMap((d) => viewOps(mid, d.id));
    if (follow.length)
      applyOps(doc, state, follow, system, "rules", system, { pin: false, log: false });
  } catch {
    return [];
  } finally {
    stop();
  }
  const then = indexOf(state);
  const keyOf = (i: ModelIndex, id: string) => i.objects.get(id)?.key ?? id;
  const out: string[] = [];
  for (const d of idx.diagrams.values()) {
    const was = idx.placements.get(d.id);
    const after = [...then.diagrams.values()].find((x) => (x.key ?? x.id) === (d.key ?? d.id));
    if (!was?.size || !after) continue;
    const key = d.key ?? d.id;
    const had = new Set([...was.keys()].map((id) => keyOf(idx, id)));
    const gains = [...(then.placements.get(after.id)?.values() ?? [])]
      .filter((p) => !had.has(keyOf(then, p.objectId)))
      .map((p) => `${keyOf(then, p.objectId)} at [${Math.round(p.x)}, ${Math.round(p.y)}]`);
    const a = measure(idx, d.id).score;
    const b = measure(then, after.id).score;
    const worse = b.crossings >= a.crossings + 2;
    if (!gains.length && !worse) continue;
    out.push(
      `  ${key}: ${gains.length ? `gains ${gains.slice(0, 8).join(", ")}${gains.length > 8 ? "…" : ""} (${a.boxes} → ${b.boxes} boxes)` : "no new boxes"}; lines crossing ${a.crossings} → ${b.crossings}${worse ? `. That reads worse${handShaped(idx, d.id) ? ", and somebody arranged this view by hand" : ""}: put the new boxes on a view of their own, or place: and route: them round the outside` : ""}`,
    );
  }
  return out.length ? ["On the views as drawn:", ...out] : [];
}

/** A route's corners as whole numbers; undefined or null as given; false when they aren't points. */
function cornersOf(v: unknown): [number, number][] | null | undefined | false {
  if (v === undefined || v === null) return v;
  if (!Array.isArray(v)) return false;
  const ok = v.every(
    (b) => Array.isArray(b) && b.length === 2 && b.every((n) => Number.isFinite(n)),
  );
  return ok && (v as [number, number][]).map(([x, y]) => [Math.round(x), Math.round(y)]);
}

/** An arrow's shape with a route's sides and corners put on it (null takes one off). */
function reshaped(
  was: FArrow | undefined,
  r: { leaves?: BoxSide | null; enters?: BoxSide | null },
  bends: [number, number][] | null | undefined,
): FArrow {
  const shape = { ...was };
  if (r.leaves !== undefined) {
    delete shape.from_at;
    if (r.leaves) shape.from = r.leaves;
    else delete shape.from;
  }
  if (r.enters !== undefined) {
    delete shape.to_at;
    if (r.enters) shape.to = r.enters;
    else delete shape.to;
  }
  if (bends !== undefined) {
    if (bends?.length) shape.bends = bends;
    else delete shape.bends;
  }
  return shape;
}

const BOX_SIDES: readonly BoxSide[] = ["top", "right", "bottom", "left"];

/**
 * route: how one line runs on a view, so a line that would cut across a drawing goes round
 * it: the side it leaves, the side it enters, and corners on the way. Its split or join stays.
 */
function setRoutes(
  model: FileModel,
  routes: NonNullable<WriteArgs["route"]>,
): { model: FileModel; problems: string[] } {
  const problems: string[] = [];
  const arrows = new Map(model.arrows);
  const HOW =
    "each route is {view, from, to, leaves: top|right|bottom|left, enters: top|right|bottom|left, bends: [[x, y], …]} (any of the three; null clears one)";
  const side = (v: unknown) => v === undefined || v === null || BOX_SIDES.includes(v as BoxSide);
  for (const r of routes) {
    if (!r || typeof r.view !== "string" || typeof r.from !== "string" || typeof r.to !== "string")
      return { model, problems: [HOW] };
    const key = `${r.from}>${r.to}`;
    const say = (m: string) => problems.push(`${key}: ${m}`);
    const view = r.view.replace(/^view:/, "");
    if (!model.views.some((v) => v.key === view)) {
      say(`no view "${view}" (${model.views.map((v) => v.key).join(", ")})`);
      continue;
    }
    if (!model.connections.some((c) => c.from === r.from && c.to === r.to)) {
      const back = model.connections.some((c) => c.from === r.to && c.to === r.from);
      say(
        back
          ? `the connection runs ${r.to}>${r.from}: route that`
          : "no such connection (from and to are box ids)",
      );
      continue;
    }
    const bends = cornersOf(r.bends);
    if (!side(r.leaves) || !side(r.enters) || bends === false) {
      say(HOW);
      continue;
    }
    if (r.leaves === undefined && r.enters === undefined && bends === undefined) {
      say(HOW);
      continue;
    }
    const mine = { ...arrows.get(view) };
    const shape = reshaped(mine[key], r, bends);
    if (Object.keys(shape).length) mine[key] = shape;
    else delete mine[key];
    arrows.set(view, mine);
  }
  return { model: { ...model, arrows }, problems };
}

const SIDES: readonly Beside[] = ["left", "right", "above", "below"];

/**
 * place: where a box sits on a view, so something added to a view somebody arranged goes
 * where it reads well and nothing else moves. Beside another box (side, of), clear of the
 * rest; or at a spot.
 */
function setPlaces(
  model: FileModel,
  places: NonNullable<WriteArgs["place"]>,
): { model: FileModel; problems: string[] } {
  const problems: string[] = [];
  const layouts = new Map(model.layouts);
  let views = model.views;
  const HOW =
    "each place is {view, box, side: left|right|above|below, of: <a box on the view>} or {view, box, at: [x, y]}";
  for (const p of places) {
    if (!p || typeof p.view !== "string" || typeof p.box !== "string")
      return { model, problems: [HOW] };
    const view = p.view.replace(/^view:/, "");
    const say = (m: string) => problems.push(`${p.box}: ${m}`);
    if (!model.views.some((v) => v.key === view)) {
      say(`no view "${view}" (${model.views.map((v) => v.key).join(", ")})`);
      continue;
    }
    const o = model.objects.find((x) => x.id === p.box);
    if (!o) {
      say("no such box");
      continue;
    }
    const mine = { ...layouts.get(view) };
    const size = boxSize(o.kind);
    const at = p.at;
    if (Array.isArray(at) && at.length === 2 && at.every((n) => Number.isFinite(n))) {
      mine[p.box] = { ...mine[p.box], x: Math.round(at[0]), y: Math.round(at[1]) };
    } else if (p.side && SIDES.includes(p.side) && typeof p.of === "string") {
      const of = mine[p.of];
      if (!of) {
        say(`${p.of} isn't on ${view} (on it: ${Object.keys(mine).slice(0, 20).join(", ")})`);
        continue;
      }
      const rect = (id: string, b: { x: number; y: number; w?: number; h?: number }) => {
        const k = model.objects.find((x) => x.id === id)?.kind ?? "app";
        return { x: b.x, y: b.y, w: b.w ?? boxSize(k).w, h: b.h ?? boxSize(k).h };
      };
      const others = Object.entries(mine)
        .filter(([id]) => id !== p.box)
        .map(([id, b]) => rect(id, b));
      mine[p.box] = { ...mine[p.box], ...sideSpot(others, rect(p.of, of), p.side, size) };
    } else {
      say(HOW);
      continue;
    }
    layouts.set(view, mine);
    // Placed on a view that left it off: it's on it now.
    views = views.map((v) =>
      v.key !== view || !v.exclude
        ? v
        : {
            ...v,
            exclude: v.exclude
              .map((s) => ("ids" in s ? { ids: s.ids.filter((id) => id !== p.box) } : s))
              .filter((s) => !("ids" in s) || s.ids.length),
          },
    );
  }
  return { model: { ...model, layouts, views }, problems };
}

const DEPS_VIEW = "dependencies";

/**
 * The first library written into a design where no view draws libraries: a Dependencies view
 * for them (each library with what uses it), in the same step. Libraries are kept off the
 * landscape and the code views, so without it they were on no view at all, and agents wrote
 * package names into tech instead. Null when there's nothing to make.
 */
async function dependenciesView(host: Host, before: ModelIndex, ops: Op[]): Promise<string | null> {
  const fresh = ops.some(
    (op) =>
      op.op === "object.put" && op.object.kind === "library" && !before.objects.has(op.object.id),
  );
  if (!fresh) return null;
  // Only with the design's first libraries: once someone has removed the view, it stays gone.
  for (const o of before.objects.values()) if (o.kind === "library") return null;
  const now = host.index();
  for (const d of now.diagrams.values()) {
    if (d.key === DEPS_VIEW) return null;
    if (d.rules?.include?.some((r) => "kind" in r && r.kind === "library")) return null;
  }
  // A library someone already put on a view by hand: they have their own way of showing them.
  for (const o of now.objects.values())
    if (o.kind === "library" && now.placedOn.get(o.id)?.size) return null;
  const diagram = makeDiagram({
    name: "Dependencies",
    key: DEPS_VIEW,
    rules: { include: [{ kind: "library" }, { uses: "library" }], exclude: [] },
  });
  await host.commit([{ op: "diagram.put", diagram }], "", { join: true });
  host.applyRules?.();
  await host.settled?.();
  return `made view ${DEPS_VIEW}: every library with what uses it (libraries stay off the other views). It follows rules, so new libraries show on it by themselves; remove: ["view:${DEPS_VIEW}"] if this design shouldn't have one.`;
}

export async function write(host: Host, given: WriteArgs, brief = false): Promise<Out> {
  // A dry run's id: the same write, if the design is as it was when it was checked.
  if (given.apply) {
    const d = dryRuns.get(given.apply.trim());
    if (!d || Date.now() - d.at > DRY_KEEP_MS)
      return fail(
        `no dry run "${given.apply}" to apply: dry runs are kept for an hour, in this server's memory; send the write again (dry_run first if you like)`,
      );
    if (mainOf(d.design) !== mainOf(host.key))
      return fail(
        `dry run ${given.apply} was on ${d.design}, not ${host.key}: pass design: "${d.design}"`,
      );
    if (given.yaml || given.files || given.remove || given.dry_run)
      return fail(
        "apply takes the dry run as it was: send it alone (with label or as if you like), or send a new write",
      );
    const now = fingerprint(filesOf(host.state(), host.config(), host.index()).files);
    dryRuns.delete(given.apply.trim());
    // Someone wrote in between (another agent on the fork): writes merge by id, so check it
    // again against the design as it is now, and write it if it still passes.
    // tidy and direction sent with apply are added to the dry run's (write {apply, tidy}
    // wrote the change and dropped the tidy without a word).
    const both = (x: WriteArgs["tidy"], y: WriteArgs["tidy"]): WriteArgs["tidy"] =>
      x === true || y === true
        ? true
        : [...new Set([...arr(x ?? []), ...arr(y ?? [])].map(String))];
    const tidy = given.tidy ? both(d.args.tidy, given.tidy) : d.args.tidy;
    // The design is as the dry run saw it: its list of changes and its warnings were just
    // read, so they aren't printed a second time (applies were as long as their dry runs).
    const out = await write(
      host,
      {
        ...d.args,
        ...(given.label ? { label: given.label } : {}),
        ...(tidy ? { tidy } : {}),
        ...(given.direction ? { direction: given.direction } : {}),
      },
      now === d.print,
    );
    return now === d.print || out.isError
      ? out
      : {
          ...out,
          text: `${out.text}\n(${host.key} had changed since the dry run, as others wrote: every check ran again against it as it is now and passed, so this is written as checked; what they wrote stays.)`,
        };
  }
  // A refused write, corrected: only the fixes were sent, merged into what it had.
  if (given.onto) {
    const id = given.onto.trim();
    const d = drafts.get(id) ?? dryRuns.get(id);
    if (!d || Date.now() - d.at > DRY_KEEP_MS)
      return fail(
        `no write "${given.onto}" to build on: refused writes and dry runs are kept for an hour, in this server's memory; send the whole write again`,
      );
    if (mainOf(d.design) !== mainOf(host.key))
      return fail(
        `${given.onto} was a write to ${d.design}, not ${host.key}: pass design: "${d.design}"`,
      );
    let yaml = d.args.yaml ?? "";
    // Text first (what doesn't parse yet), then entries by key.
    for (const e of given.edits ?? []) {
      const n = e.old ? yaml.split(e.old).length - 1 : 0;
      if (n !== 1) {
        // Not there as sent: a fragment merged with onto is written out again, in its own layout.
        // The stored lines most like it, so the next edit can copy them exactly.
        const words = (t: string) => new Set(t.toLowerCase().match(/[a-z0-9_#.:/-]{3,}/g) ?? []);
        const want = words(e.old ?? "");
        const rows = yaml.split("\n");
        const score = (i: number) =>
          [...words(rows.slice(i, i + 3).join(" "))].filter((w) => want.has(w)).length;
        const best =
          n === 0 && rows.length
            ? rows.map((_, i) => i).reduce((x, y) => (score(y) > score(x) ? y : x), 0)
            : -1;
        const near =
          best >= 0 && score(best) > 0
            ? `\nIts fragment holds it as (copy from here):\n${rows.slice(Math.max(0, best - 1), best + 4).join("\n")}`
            : "";
        return fail(
          `edits: "${clip(e.old ?? "", 60)}" is in ${given.onto}'s fragment ${n} times; it must be exactly once (${n ? "copy more of the line around it" : "a fragment merged with onto is written out again in its own layout"}). Nothing changed.${near}`,
        );
      }
      yaml = yaml.replace(e.old, () => e.new);
    }
    if (given.yaml?.trim()) {
      const merged = mergeFragment(yaml, given.yaml);
      if (merged === undefined)
        return fail(
          `couldn't merge into ${given.onto}: ${YAML.parseDocument(yaml).errors.length ? "its fragment isn't YAML yet (the error said where): fix that text with edits: [{old, new}] (old copied exactly, once), alone or with yaml" : "the yaml sent isn't YAML that parses"}. Nothing changed.`,
        );
      yaml = merged;
    }
    const { onto: _, yaml: _y, edits: _e, ...rest } = given;
    // Onto a dry run is a dry run again (it wrote at once); dry_run: false writes it.
    // A dry run again unless told otherwise (three workers were surprised a refused
    // write, corrected, went straight in); dry_run: false writes it at once.
    const dry = given.dry_run ?? true;
    return write(host, {
      ...d.args,
      ...rest,
      dry_run: dry,
      yaml,
      remove: [...new Set([...refList(d.args.remove), ...refList(given.remove)])],
    });
  }
  const { args: a, lifted, ignored } = liftParams(given);
  const remove = refList(a.remove);
  if (a.undo) {
    if (!host.undo) return fail("undo isn't available here");
    if (!a.dry_run && !host.canEdit)
      return fail(`${host.actor.name} can read this design but not edit it`);
    const what = host.undo(!!a.dry_run);
    if (!what)
      return ok(
        "Nothing of yours to undo. (Notes aren't in it: reply, resolve or reopen them with note.)",
      );
    return ok(
      a.dry_run ? `Dry run, nothing changed. Undo would take back: ${what}.` : `Undone: ${what}.`,
    );
  }
  if (
    !a.yaml?.trim() &&
    !a.files &&
    !remove.length &&
    !a.tidy &&
    !a.splits?.length &&
    !a.joins?.length &&
    !a.place?.length &&
    !a.route?.length
  )
    return fail(`Send yaml (a fragment in the file grammar), remove, or tidy.\n${EXAMPLE}`);
  if (!a.dry_run && !host.canEdit)
    return fail(`${host.actor.name} can read this design but not edit it`);
  const cfg = host.config();
  const state = host.state();
  const idx = host.index();
  const scope = a.scope ? object(idx, a.scope) : null;
  // The design as files, read and checked once (kept until the next change: a dry run, then the write).
  const start = filesOf(state, cfg, idx);
  const base = start.files;
  const folder = new Folder(base, start.read.model.origin);
  const problems: Problem[] = [];
  const gone: Removals = { objects: [], views: [], boundaries: [], decisions: [] };

  // --- whole files: each replaces the objects, views… it names (an exported view, a file read with read {file}).
  for (const p of Object.keys(a.files ?? {})) {
    const layoutOfView = /^layout\/([\w.-]+)\.json$/.exec(p);
    if (
      p.includes("..") ||
      (!FILE_RE.test(p) &&
        !(layoutOfView && a.files?.[`views/${layoutOfView[1]}.yaml`] !== undefined))
    )
      problems.push({
        level: "error",
        file: p,
        message: layoutOfView
          ? `a layout file is written together with its view: send views/${layoutOfView[1]}.yaml (as read {file: "views/${layoutOfView[1]}.yaml"} gives it) in the same files as ${p}`
          : "write takes model/, code/, views/ and decisions/ YAML files, boundaries.yaml, libraries.yaml, and a view's layout/<view>.json beside its views/<view>.yaml",
      });
  }

  // --- the fragment.
  const tagNames = new Set<string>();
  const droppedGroups = new Set<string>();
  if (a.yaml?.trim()) {
    const { doc: frag, problems: parse } = strict(a.yaml, "yaml");
    problems.push(...parse);
    if (!parse.length) refsToIds(frag, idx, problems);
    if (!parse.length) {
      if (!YAML.isMap(frag.contents))
        problems.push({
          level: "error",
          file: "yaml",
          message:
            "the fragment is a map: objects:, entities:, connections:, views:, boundaries:, decisions:",
        });
      else
        for (const it of frag.contents.items) {
          const key = str(it.key) ?? "";
          // A parameter written in the fragment (tidy, remove, label…): liftParams took it out already.
          if ((PARAM_KEYS as readonly string[]).includes(key)) continue;
          if (!TOP_KEYS.includes(key)) {
            problems.push({
              level: "error",
              file: "yaml",
              message: `\`${key}\` isn't part of a fragment; it takes ${TOP_KEYS.join(", ")}${key === "remove" ? " (remove is a parameter of write, beside yaml)" : ""}`,
            });
            continue;
          }
          if (key === "tags") {
            // Tag groups (archnm.yaml's tags:), by name: a group replaced whole, null drops it (lanes needed one).
            if (!YAML.isMap(it.value))
              problems.push({
                level: "error",
                file: "yaml",
                message:
                  "tags: is a map of tag groups: tags: {lane: {values: [callers, doors, domain, vendors]}}",
              });
            else {
              const d = folder.doc("archnm.yaml");
              for (const g of it.value.items) {
                const name = str(g.key) ?? "";
                tagNames.add(name);
                if (isNull(g.value)) (d.deleteIn(["tags", name]), droppedGroups.add(name));
                else d.setIn(["tags", name], clone(g.value));
              }
            }
            continue;
          }
          // was: names a line by refs, as remove does (repo:path#fn): the files hold the boxes' keys.
          if (key === "connections" && YAML.isSeq(it.value))
            for (const c of it.value.items) {
              const w = YAML.isMap(c) ? str(c.get("was", true)) : undefined;
              if (w !== undefined) (c as YAML.YAMLMap).set("was", removeRefToIds(idx, w));
            }
          merge(folder, key, it.value, problems, gone);
        }
    }
  }

  // --- remove: box ids; view:<key>, boundary:<id>, decision:<id>; connections a>b[:label]; entities by name.
  const baseModel = start.read.model;
  for (const r of remove) {
    const t = removeRefToIds(idx, r);
    const arrow = /^([^>\s]+)\s*>\s*([^:>\s]+)(?::(.+))?$/.exec(t);
    if (arrow) {
      const why = dropConnection(folder, arrow[1]!, arrow[2]!, arrow[3]?.trim());
      if (why)
        problems.push({
          level: "error",
          file: "remove",
          message:
            why === "none" ? `no connection ${t}${nearConn(baseModel, arrow[1]!, arrow[2]!)}` : why,
        });
      continue;
    }
    const ns = /^(view|boundary|decision):(.+)$/.exec(t);
    if (ns) {
      const [, kind, id] = ns as unknown as [string, "view" | "boundary" | "decision", string];
      const known =
        kind === "view"
          ? baseModel.views.some((v) => v.key === id)
          : kind === "boundary"
            ? baseModel.boundaries.some((b) => b.id === id)
            : baseModel.decisions.some((d) => d.id === id);
      if (known)
        gone[kind === "view" ? "views" : kind === "boundary" ? "boundaries" : "decisions"].push(id);
      else problems.push({ level: "error", file: "remove", message: `no ${kind} ${id}` });
      continue;
    }
    if (baseModel.objects.some((o) => o.id === t)) {
      gone.objects.push(t);
      continue;
    }
    const at = folder.entityAt.get(t);
    if (at) {
      (folder.section(at, "entities") as YAML.YAMLMap).delete(t);
      continue;
    }
    // A type that's only named (carries: [Flag]), never defined: nothing to remove; it goes when
    // nothing names it (the whole write was refused for it).
    if (allEntities(baseModel).some((e) => e.implicit && e.id === t)) {
      problems.push({
        level: "warning",
        file: "remove",
        message: `${t} is only named (in carries or a field), never defined: there's nothing to remove; it goes when nothing names it`,
      });
      continue;
    }
    // Something else by that id, or a name or a code ref for a box: say how to name it.
    const other = baseModel.views.some((v) => v.key === t)
      ? `view:${t}`
      : baseModel.boundaries.some((b) => b.id === t)
        ? `boundary:${t}`
        : baseModel.decisions.some((d) => d.id === t)
          ? `decision:${t}`
          : "";
    let hint = other ? `; for the ${other.split(":")[0]}, remove ${other}` : "";
    if (!hint)
      try {
        hint = `; did you mean ${idOf(object(idx, t))}?`;
      } catch {
        /* nothing near */
      }
    problems.push({
      level: "error",
      file: "remove",
      message: `no box has the id ${t}${hint} (remove takes box ids, view:<key>, boundary:<id>, decision:<id>, a>b[:label] for a connection, an entity's name)`,
    });
  }

  // --- read it all back, as archnm check would.
  const files = folder.files();
  const before = new Set([...start.read.problems, ...start.checked].map(site));
  const { model: read0, problems: read } = readFiles(files);
  let model: FileModel = read0;
  const readProblems = [...read];
  // Whole files replace what they name (an object's connections are the file's list).
  if (a.files && Object.keys(a.files).length) {
    const { model: mine, problems: theirs } = readFiles(
      new Map([["archnm.yaml", base.get("archnm.yaml") ?? ""], ...Object.entries(a.files)]),
    );
    readProblems.push(...theirs);
    model = overlay(read0, mine);
    for (const p of Object.keys(a.files)) {
      const k = /^views\/([\w.-]+)\.ya?ml$/.exec(p)?.[1];
      if (k && mine.layouts.has(k))
        model.layouts = new Map(model.layouts).set(k, mine.layouts.get(k)!);
      if (k && mine.arrows.has(k)) model.arrows = new Map(model.arrows).set(k, mine.arrows.get(k)!);
    }
  }
  model = without(model, gone);
  if (Array.isArray(a.splits) && a.splits.length) {
    const forked = setSplits(model, a.splits);
    model = forked.model;
    problems.push(
      ...forked.problems.map((message) => ({ level: "error" as const, file: "splits", message })),
    );
  }
  if (Array.isArray(a.joins) && a.joins.length) {
    const forked = setSplits(
      model,
      a.joins.map((x) => ({ view: x?.view, from: x?.to, to: x?.from, at: x?.at })),
      "join",
    );
    model = forked.model;
    problems.push(
      ...forked.problems.map((message) => ({ level: "error" as const, file: "joins", message })),
    );
  }
  if (Array.isArray(a.route) && a.route.length) {
    const routed = setRoutes(model, a.route);
    model = routed.model;
    problems.push(
      ...routed.problems.map((message) => ({ level: "error" as const, file: "route", message })),
    );
  }
  if (Array.isArray(a.place) && a.place.length) {
    const placed = setPlaces(model, a.place);
    model = placed.model;
    problems.push(
      ...placed.problems.map((message) => ({ level: "error" as const, file: "place", message })),
    );
  }
  {
    const kept = keepArranged(baseModel, model, a.place ?? []);
    model = kept.model;
    problems.push(
      ...kept.notes.map((message) => ({ level: "warning" as const, file: "views", message })),
    );
  }
  // A dropped tag group takes its tags off the boxes, and its lanes off the views (the
  // tags stayed as chips on every box and were taken off one by one).
  if (droppedGroups.size) {
    let n = 0;
    const of = (t: string) => droppedGroups.has(t.split(":")[0]!);
    for (const o of model.objects)
      if (o.tags?.some(of)) ((o.tags = o.tags.filter((t) => !of(t))), n++);
    const views = model.views.filter((v) => v.lanes && droppedGroups.has(v.lanes));
    for (const v of views) delete v.lanes;
    if (n || views.length)
      problems.push({
        level: "warning",
        file: "tags",
        message: `dropping ${[...droppedGroups].join(", ")} took its tags off ${plural(n, "box", "boxes")}${views.length ? ` and its lanes off ${views.map((v) => v.key).join(", ")}` : ""}`,
      });
  }
  // A box given a path (a component with repo:server/{auth,signin/*}.ts) takes the imported
  // files it claims that sit above it, as a new import would (workers can't run the
  // import, so four moved dozens of files in one at a time). Only from its parent's side of
  // the tree, never out of another box.
  const claimed: string[] = [];
  {
    const was = new Map(baseModel.objects.map((o) => [o.id, o.path]));
    const parent = new Map(model.objects.map((o) => [o.id, o.in]));
    const folders = new Set(
      model.objects
        .filter((o) => o.kind === "module" && o.tags?.includes("generated"))
        .map((o) => o.id),
    );
    const above = (id: string, of: string) => {
      for (let cur = parent.get(of), n = 0; cur && n < 64; cur = parent.get(cur), n++)
        if (cur === id) return true;
      return false;
    };
    for (const box of model.objects) {
      if (
        !box.path ||
        box.kind === "module" ||
        box.kind === "function" ||
        was.get(box.id) === box.path
      )
        continue;
      const [repo, rest = ""] = [
        box.path.slice(0, box.path.indexOf(":")),
        box.path.slice(box.path.indexOf(":") + 1).replace(/\/+$/, ""),
      ];
      if (!repo || !rest) continue;
      const re = isGlob(rest) ? globRe(rest) : null;
      const hits = new Set(
        model.objects
          .filter(
            (m) =>
              m.kind === "module" &&
              m.tags?.includes("generated") &&
              m.path?.startsWith(`${repo}:`) &&
              m.in !== box.id &&
              m.id !== box.id,
          )
          .filter((m) => {
            const mp = m.path!.slice(repo.length + 1).replace(/\/+$/, "");
            return re ? re.test(mp) : mp === rest || mp.startsWith(`${rest}/`);
          })
          // From above the box only: past the imported folders it's in, the first real box is
          // the box's parent or one it's inside.
          .filter((m) => {
            let up = m.in;
            for (let n = 0; up && folders.has(up) && n < 64; n++) up = parent.get(up);
            return !!up && (up === parent.get(box.id) || above(up, box.id));
          })
          .map((m) => m.id),
      );
      for (const m of model.objects)
        if (hits.has(m.id) && !hits.has(m.in ?? "")) {
          m.in = box.id;
          claimed.push(m.id);
        }
    }
  }
  // A folder the import made that this write emptied (its files moved into components) goes,
  // and so do the folders above it it leaves empty (regrouping left empty folder boxes,
  // cleaned up by hand). Never one a line, a flow step or a hand-picked view names.
  {
    // Folders only: what held files or folders before, never a file whose functions moved.
    const had = new Set(
      baseModel.objects
        .filter((o) => o.kind === "module")
        .map((o) => o.in)
        .filter(Boolean),
    );
    for (const o of baseModel.objects) if (o.kind === "function" && o.in) had.delete(o.in);
    const named = new Set<string>();
    for (const c of model.connections) (named.add(c.from), named.add(c.to));
    // Anything a view says: its boxes, flow steps and rules ({children: <folder>}).
    for (const v of model.views)
      JSON.stringify(v, (_k, x) => (typeof x === "string" && named.add(x), x));
    const emptied: string[] = [];
    for (let grew = true; grew;) {
      grew = false;
      const holds = new Set(model.objects.map((o) => o.in).filter(Boolean));
      for (const o of model.objects)
        if (
          o.kind === "module" &&
          o.tags?.includes("generated") &&
          had.has(o.id) &&
          !holds.has(o.id) &&
          !named.has(o.id) &&
          !gone.objects.includes(o.id)
        ) {
          emptied.push(o.id);
          gone.objects.push(o.id);
          grew = true;
        }
      if (grew)
        model = without(model, { objects: emptied, views: [], boundaries: [], decisions: [] });
    }
    if (emptied.length)
      problems.push({
        level: "warning",
        file: "objects",
        message: `removed ${emptied.length} imported folder${emptied.length === 1 ? "" : "s"} left empty (${emptied.slice(0, 5).join(", ")}${emptied.length > 5 ? ", …" : ""})`,
      });
  }
  if (claimed.length)
    problems.push({
      level: "warning",
      file: "objects",
      message: `moved ${claimed.length} imported file${claimed.length === 1 ? "" : "s"} or folder${claimed.length === 1 ? "" : "s"} into the box whose path claims them (${claimed.slice(0, 5).join(", ")}${claimed.length > 5 ? ", …" : ""})`,
    });
  // The views to tidy, found before anything is written: a bad one stops the whole write.
  // A list sent as text ("[a, b]" or "a, b") is that list.
  const tidyKeys =
    a.tidy && a.tidy !== true
      ? arr(a.tidy as string | string[]).flatMap((v) =>
          typeof v === "string" && (/^\s*\[.*\]\s*$/.test(v) || v.includes(","))
            ? v
                .replace(/^\s*\[|\]\s*$/g, "")
                .split(",")
                .map((x) => x.trim().replace(/^["']|["']$/g, ""))
                .filter(Boolean)
            : [v],
        )
      : [];
  for (const v of tidyKeys) {
    let found = model.views.some((x) => x.key === v);
    if (!found)
      try {
        found = model.views.some((x) => x.key === viewId(findView(idx, v)));
      } catch {
        /* said below */
      }
    // A view the fragment itself writes, when another error kept the fragment from being read:
    // that error is the one to fix, not this (a duplicate key, then five "no view").
    const inFragment = new RegExp(`^\\s{2}${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`, "m").test(
      a.yaml ?? "",
    );
    if (!found && inFragment && problems.some((p) => p.level === "error")) continue;
    if (!found)
      problems.push({
        level: "error",
        file: "tidy",
        message: `no view ${v}; views: ${model.views
          .map((x) => x.key)
          .slice(0, 30)
          .join(", ")}`,
      });
  }
  // The landscape is the top of the design: given a scope, it becomes a look inside that box, and
  // the box itself (the system on it) is gone from the top, with nothing to say so.
  {
    const was = new Map(baseModel.views.map((v) => [v.key, v.scope]));
    for (const v of model.views)
      if (
        v.scope &&
        was.get(v.key) !== v.scope &&
        (v.key === "landscape" || v.name?.toLowerCase() === "landscape")
      )
        problems.push({
          level: "warning",
          file: `views: ${v.key}`,
          message: `the landscape is the design's top view; with scope: ${v.scope} it shows what's inside ${v.scope} instead, and ${v.scope} itself isn't on it. For a landscape with ${v.scope} on it, leave scope out; for its insides, use another view (views: {${v.scope}: {scope: ${v.scope}}})`,
        });
  }
  const an = (w: string) => `${/^[aeiou]/.test(w) ? "an" : "a"} ${w}`;
  // An existing id written with another kind: often a new box given an id that's taken (a job became a component). Say what it was, so a mistake is caught at the dry run.
  {
    const was = new Map(baseModel.objects.map((o) => [o.id, o]));
    for (const o of model.objects) {
      const w = was.get(o.id);
      if (w && w.kind !== o.kind)
        problems.push({
          level: "warning",
          file: `objects: ${o.id}`,
          message: `${o.id} was ${an(w.kind)}${w.name && w.name !== o.id ? ` (${w.name})` : ""}; this makes it ${an(o.kind)}. For a new box, give it an id of its own`,
        });
    }
  }
  // A path's repo should be one the design knows (index start registered it, or paths already use it), or its links won't resolve.
  {
    const known = knownRepos(baseModel, host.repos?.() ?? []);
    const was = new Map(baseModel.objects.map((o) => [o.id, o.path]));
    if (known.size)
      for (const o of model.objects) {
        if (!o.path || was.get(o.id) === o.path) continue;
        const repo = o.path.split(":")[0]!;
        if (!known.has(repo))
          problems.push({
            level: "warning",
            file: `objects: ${o.id}`,
            message: `repo ${repo} isn't one ${host.key} knows (${[...known].slice(0, 8).join(", ")}): use one of those, or run index start on it (it registers the repo by its folder's name)`,
          });
      }
  }
  const fresh = [
    ...problems,
    ...[...readProblems, ...check(model)].filter((p) => !before.has(site(p))),
  ];
  const errors = fresh.filter((p) => p.level === "error");
  const warnings = fresh.filter((p) => p.level === "warning");
  // A removed box takes what's inside it: when that breaks things, say so first, since it's the cause of the rest.
  if (errors.length)
    for (const id of [...gone.objects].reverse()) {
      // A remove takes what's inside with it; what fails is what still names those boxes (the dry run listed 30 going with the folder, then the apply said "still has 7 inside").
      const kids = baseModel.objects
        .filter((o) => o.in === id && !gone.objects.includes(o.id))
        .map((o) => o.id);
      if (kids.length)
        errors.unshift({
          level: "error",
          file: "remove",
          message: `removing ${id} takes the ${plural(kids.length, "box", "boxes")} inside it too (${kids.slice(0, 6).join(", ")}${kids.length > 6 ? ", …" : ""}), and something below still names them: keep any by moving it out first (objects: {${kids[0]}: {in: <another box>}}), and take the rest off the views and lines below`,
        });
    }
  const lines = (ps: Problem[]) =>
    ps
      .slice(0, 40)
      .map(
        (p) => `${p.level}: ${p.file.replace(/^model\/_write\.yaml/, "yaml (new)")}: ${p.message}`,
      )
      .concat(ps.length > 40 ? [`… and ${ps.length - 40} more`] : []);
  if (errors.length) {
    const draft = a.yaml?.trim() ? keepDraft(host.key, a) : null;
    const parses = !!a.yaml && !YAML.parseDocument(a.yaml).errors.length;
    const resend = draft
      ? parses
        ? `\n\nFix only what's wrong: write {onto: "${draft}", yaml: <just the corrected entries>} merges them into this write by key (an entry takes the fields sent and keeps the rest; null drops an entry or a field) and checks it all again; add dry_run: true to only check.`
        : `\n\nFix only what's wrong: write {onto: "${draft}", edits: [{old: "<the text as sent>", new: "<as it should be>"}]} changes just that text (old copied exactly, found once) and checks it all again; add dry_run: true to only check.`
      : "";
    return {
      text: `Not written: ${plural(errors.length, "error")}. Nothing changed.\n${lines(errors).join("\n")}${warnings.length ? `\n${lines(warnings).join("\n")}` : ""}${resend}\n\n${EXAMPLE}`,
      isError: true,
      data: { errors: errors.map((p) => ({ file: p.file, message: p.message })) },
    };
  }

  const ops = toOps(state, { ...model, config: cfg });
  // Tag groups this write set or dropped: their own ops, so they're in the step (one undo).
  for (const name of tagNames) {
    const group = model.config.tags?.[name];
    if (group && JSON.stringify(cfg.tags?.[name]) !== JSON.stringify(group))
      ops.unshift({ op: "taggroup.put", name, group });
    else if (!group && cfg.tags?.[name]) ops.unshift({ op: "taggroup.delete", name });
  }
  // Protected fields (archnm.yaml protect): an agent sets them on something new, never changes them.
  if (host.actor.kind === "agent")
    for (const op of ops) {
      if (op.op !== "object.put") continue;
      const was = state.objects.get(op.object.id);
      if (!was) continue;
      for (const f of cfg.protect ?? []) {
        const get = (o: ModelObject): unknown =>
          f.startsWith("refs.")
            ? o.refs?.[f.slice(5)]
            : f === "in"
              ? o.parentId
              : (o as unknown as Record<string, unknown>)[f];
        if (JSON.stringify(get(was) ?? null) !== JSON.stringify(get(op.object) ?? null))
          return fail(
            `Not written: ${f} on ${idOf(was)} is protected (archnm.yaml protect): only a person changes it. Leave it out, and say what you think it should be in a note.`,
          );
      }
    }
  // The views to tidy, by id once they exist: the ones named, or (true) every one this changed.
  const tidyIds = (now: ModelIndex) =>
    a.tidy === true
      ? [
          ...new Set(
            ops.flatMap((op) =>
              op.op === "placement.put"
                ? [op.placement.diagramId]
                : op.op === "placement.delete"
                  ? [op.diagramId]
                  : op.op === "diagram.put"
                    ? [op.diagram.id]
                    : [],
            ),
          ),
          // ...and the views that follow rules and so picked up (or lost) boxes because of it.
          ...[...now.diagrams.keys()].filter((id) => {
            const was = idx.placements.get(id);
            const is = now.placements.get(id);
            return (
              (was?.size ?? 0) !== (is?.size ?? 0) ||
              [...(is?.keys() ?? [])].some((k) => !was?.has(k))
            );
          }),
        ].filter((id, i, all) => now.diagrams.has(id) && all.indexOf(id) === i)
      : tidyKeys.map(
          (v) => [...now.diagrams.values()].find((d) => d.key === v)?.id ?? findView(now, v).id,
        );
  if (scope) {
    const out = outside(idx, scope, ops);
    // Tidying moves a view's boxes: only views about the scope (the ones named; with true, the ones this write may change).
    // Views name their scope by id (the file's) or by the index's id: both are inside when the box is.
    const newKey = new Map(
      ops.flatMap((op) =>
        op.op === "object.put" && op.object.key ? [[op.object.id, op.object.key] as const] : [],
      ),
    );
    const mine = new Set<string>();
    for (const id of scoped(idx, scope, ops))
      mine.add(id).add(idx.objects.get(id)?.key ?? newKey.get(id) ?? id);
    const aboutOf = (v: string): string | undefined => {
      const f = model.views.find((x) => x.key === v);
      if (f) return f.scope;
      try {
        return findView(idx, v).scopeId ?? undefined;
      } catch {
        return undefined;
      }
    };
    const named =
      a.tidy === true ? tidyIds(idx).map((id) => viewId(idx.diagrams.get(id)!)) : tidyKeys;
    for (const v of named) {
      const about = aboutOf(v);
      if (!about || !mine.has(about)) out.push(`tidy ${v} (a view not about ${idOf(scope)})`);
    }
    if (out.length) {
      // Kept like any refused write: dropping the entries outside is a small fix, not a resend.
      const draft = a.yaml?.trim() ? keepDraft(host.key, a) : null;
      return fail(
        `Not written: write {scope: "${a.scope}"} changes only what's inside ${a.scope}, and this also changes:\n${out
          .slice(0, 20)
          .map((l) => `  ${l}`)
          .join(
            "\n",
          )}\nLeave those out${draft ? ` (write {onto: "${draft}", yaml: <those entries as null>} drops them and writes the rest; edits: [{old, new}] for text)` : ""}, and tell their owner instead: note {action: "add", about: "<ref>", text, claim: {field, value, evidence}}.`,
      );
    }
  }
  const tbd = new Set(
    allEntities(model)
      .filter((e) => e.implicit)
      .map((e) => e.id),
  );
  const diff = summary(idx, ops, tbd, a.dry_run ? 200 : 60, new Set(Object.keys(cfg.tags ?? {})));
  const warn = warnings.length ? `\n${lines(warnings).join("\n")}` : "";
  if (a.dry_run) {
    const applyId = ops.length || a.tidy ? keepDryRun(host.key, a, fingerprint(start.files)) : null;
    return ok(
      `${lifted.length || ignored.length ? `${liftedNote(lifted, ignored)}\n` : ""}Dry run, nothing changed. It would:\n${diff.join("\n") || "  change nothing (the design already says that)"}${a.tidy ? "\n  and tidy the views" : ""}${
        ops.length && !a.tidy
          ? foresee(idx, model)
              .map((l) => `\n${l}`)
              .join("")
          : ""
      }${warn}\n${applyId ? `Looks right? write {apply: "${applyId}"} writes exactly this (no need to send it again), as long as nobody changes the design first.` : "Nothing to write."}`,
      { ops: ops.length, ...(applyId ? { apply: applyId } : {}) },
    );
  }

  const out: string[] = [];
  // One step: the change and its tidying are one undo and one history line.
  const step = { started: false };
  if (ops.length) {
    await host.commit(ops, a.label?.trim() || autoLabel(ops, tbd));
    step.started = true;
    host.applyRules?.();
    await host.settled?.();
    // Who, and the history line: so a manager running several workers sees which wrote what.
    if (lifted.length || ignored.length) out.push(liftedNote(lifted, ignored));
    out.push(
      `Written by ${host.actor.name}${host.actor.session && !host.actor.name.endsWith(host.actor.session) ? ` (${host.actor.session})` : ""}: "${a.label?.trim() || autoLabel(ops, tbd)}" (undo with write {undo: true}):`,
      ...(brief ? [`  the ${plural(diff.length, "line")} of changes the dry run listed`] : diff),
    );
    const elsewhere = host.wrote?.();
    if (elsewhere) out.push(elsewhere);
    const deps = await dependenciesView(host, idx, ops);
    if (deps) out.push(deps);
    out.push(...(await offShelfNotes(host, idx, ops)));
  } else if (!a.tidy) return ok("Nothing to change: the design already says that.");
  if (a.tidy) {
    const now = host.index();
    const ids = tidyIds(now);
    // A view whose settings this write changed (arrows: elbow) did change, even when no box moves.
    const set = new Map(
      ops.flatMap((op) =>
        op.op === "diagram.put" && idx.diagrams.has(op.diagram.id)
          ? [[op.diagram.id, viewChanges(idx.diagrams.get(op.diagram.id)!, op.diagram)] as const]
          : [],
      ),
    );
    for (const id of ids) {
      const d = host.index().diagrams.get(id)!;
      // A view somebody shaped by hand (bent arrows, splits, joins), and tidy: true that only
      // means "the views this changed": laying it out again would throw their work away.
      const shaped = handShaped(idx, id);
      if (shaped && !a.rearrange) {
        out.push(
          `${d.key ?? d.id}: not tidied. Somebody arranged it by hand (${shaped} shaped ${shaped === 1 ? "arrow" : "arrows"}), and a tidy would throw that away; new boxes went beside what they connect to (place: [{view, box, side, of}] moves one). Look at it (show {render: "${d.key ?? d.id}"}). Only if the person asked for a new layout: write {tidy: ["${d.key ?? d.id}"], rearrange: true}.`,
        );
        continue;
      }
      out.push(await tidyView(host, d, a.direction, step, set.get(id)));
    }
    // The Dependencies view this write made isn't in its ops: it's new, so it's laid out too.
    for (const d of now.diagrams.values())
      if (d.key === DEPS_VIEW && !idx.diagrams.has(d.id) && !ids.includes(d.id))
        out.push(await tidyView(host, host.index().diagrams.get(d.id)!, a.direction, step));
    if (a.tidy === true && !ids.length) out.push("no view changed, so none was tidied");
  } else if (step.started) {
    // A view that had nothing on it and now has boxes: nobody has arranged it, so lay it out
    // (boxes written without positions otherwise land in a pile). A view someone has arranged is
    // left alone unless tidy is asked for.
    const now = host.index();
    for (const d of now.diagrams.values()) {
      if (idx.placements.get(d.id)?.size || !now.placements.get(d.id)?.size) continue;
      out.push(await tidyView(host, d, a.direction, step));
    }
  }
  // A view that reads worse than before this write: say so while it's one undo away.
  if (step.started) {
    const now = host.index();
    for (const d of now.diagrams.values()) {
      // (A view that had nothing on it can't have got worse.)
      if (!idx.diagrams.has(d.id) || !idx.placements.get(d.id)?.size) continue;
      const was = measure(idx, d.id).score;
      const is = measure(now, d.id).score;
      const key = d.key ?? d.id;
      // A hand-arranged view that follows rules picked up boxes nobody put there.
      if (is.boxes > was.boxes && is.boxes > 12 && handShaped(idx, d.id)) {
        out.push(
          `${key} went from ${was.boxes} to ${is.boxes} boxes through its rules, and somebody arranged it by hand. Keep theirs as it was: leave the new boxes out (exclude: [{ids: [...]}], with its include written again) and give them a view of their own. Look: show {render: "${key}"}.`,
        );
        continue;
      }
      if (is.crossings < was.crossings + 2) continue;
      out.push(
        `${key} reads worse now: ${was.crossings} → ${is.crossings} lines cross (${was.boxes} → ${is.boxes} boxes). Look before calling it done: show {render: "${key}"}. More than about 12 boxes wants a second view, not a bigger one; write {undo: true} takes this write back.`,
      );
    }
  }
  out.push(...(warn && !brief ? [warn.trim()] : []));
  // New boxes that no view draws (nor anything they are inside): the person sees nothing of them.
  {
    const now = host.index();
    const drawn = (id: string | null): boolean => {
      for (let at = id; at; at = now.objects.get(at)?.parentId ?? null)
        if (now.placedOn.get(at)?.size) return true;
      return false;
    };
    const unseen = ops.flatMap((op) =>
      op.op === "object.put" && !idx.objects.has(op.object.id) && !drawn(op.object.id)
        ? [op.object]
        : [],
    );
    if (unseen.length)
      out.push(
        `warning: ${unseen
          .slice(0, 6)
          .map((o) => idOf(o))
          .join(", ")}${unseen.length > 6 ? ` and ${unseen.length - 6} more` : ""} ${
          unseen.length === 1 ? "is" : "are"
        } on no view, so nobody sees ${unseen.length === 1 ? "it" : "them"}: put ${
          unseen.length === 1 ? "it" : "them"
        } in a box that is drawn (in: <system>), or add to a view (views: {<view>: {include: [{ids: [...]}]}}); read {ref: "<view>"} says what a view shows and why`,
      );
  }
  // A view this write set hide_lines on, left with boxes and no lines (four went out so).
  for (const op of ops) {
    if (op.op !== "diagram.put" || !op.diagram.hideLines?.length) continue;
    const sc = scoreView(host.index(), op.diagram.id);
    if (sc.boxes >= 3 && sc.lines === 0)
      out.push(
        `warning: views: ${viewId(op.diagram)}: hide_lines leaves no lines at all (${sc.boxes} boxes); take out the rule that hides too much`,
      );
  }
  // "About 12 boxes a view": a view this write grew past 14 says so, with the usual fix.
  {
    const counts = (i: ModelIndex) => {
      const n = new Map<string, number>();
      for (const ds of i.placedOn.values()) for (const d of ds) n.set(d, (n.get(d) ?? 0) + 1);
      return n;
    };
    const was = counts(idx);
    const after = host.index();
    for (const [d, n] of counts(after)) {
      const v = after.diagrams.get(d);
      if (!v || n <= CROWDED || n <= (was.get(d) ?? 0)) continue;
      // fold only gathers boxes marked external: true; say it only where there are some to gather.
      const ext =
        projectDiagram(after, d).nodes.filter((x) => !x.folded && after.objects.get(x.id)?.external)
          .length >= 2;
      out.push(
        `warning: view:${viewId(v)} has ${n} boxes now (about 12 fit a screen): group some into a box and open it as its own view${ext ? ", or fold: externals (gathers its external: true boxes into one)" : ""}, or move some to another view (exclude: [{ids: […]}]); read {view: "${viewId(v)}"} shows them`,
      );
    }
  }
  const touched = ops.flatMap((op) => (op.op === "object.put" ? [op.object.id] : [])).slice(0, 1);
  const on = touched[0] ? [...(host.index().placedOn.get(touched[0]) ?? [])][0] : undefined;
  if (on) out.push(`open: ${host.url(on, touched[0])}`);
  return ok(out.join("\n"), { ops: ops.length });
}

/** The model without what was removed, each kind by its own ids: a box's removal takes what's inside it and its connections, never a view, boundary or decision of the same id. */
function without(model: FileModel, gone: Removals): FileModel {
  if (
    !gone.objects.length &&
    !gone.views.length &&
    !gone.boundaries.length &&
    !gone.decisions.length
  )
    return model;
  const m = gone.objects.length ? overlay(model, readFiles(new Map()).model, gone.objects) : model;
  const v = new Set(gone.views);
  const b = new Set(gone.boundaries);
  const d = new Set(gone.decisions);
  // A view's layout and arrow shapes go with it (layout/<view>.json), or they'd be left to warn.
  const keep = <T>(map: Map<string, T>) => new Map([...map].filter(([k]) => !v.has(k)));
  // A removed box's place on each view goes with it (it was left to warn).
  const left = new Set(m.objects.map((o) => o.id));
  const dropped = new Set(model.objects.map((o) => o.id).filter((id) => !left.has(id)));
  const layouts = dropped.size
    ? new Map(
        [...keep(model.layouts)].map(
          ([k, l]) =>
            [k, Object.fromEntries(Object.entries(l).filter(([id]) => !dropped.has(id)))] as const,
        ),
      )
    : keep(model.layouts);
  // And off the views that list it by hand.
  const views = model.views
    .filter((x) => !v.has(x.key))
    .map((x) =>
      x.boxes && dropped.size && x.boxes.some((b2) => dropped.has(b2))
        ? { ...x, boxes: x.boxes.filter((b2) => !dropped.has(b2)) }
        : x,
    );
  return {
    ...m,
    views,
    layouts,
    arrows: keep(model.arrows),
    boundaries: model.boundaries.filter((x) => !b.has(x.id)),
    decisions: model.decisions.filter((x) => !d.has(x.id)),
  };
}

/** One top-level section of the fragment into the folder. */
function merge(folder: Folder, key: string, value: unknown, problems: Problem[], gone: Removals) {
  const bad = (message: string) => problems.push({ level: "error", file: `yaml: ${key}`, message });
  if (key === "objects" || key === "entities") {
    if (!YAML.isMap(value))
      return bad(
        `${key} is a map keyed by ${key === "objects" ? "id" : "type name"} (${key}:\\n  ${key === "objects" ? "billing: {kind: app}" : "Invoice: {fields: {id: uuid}}"})`,
      );
    const at = key === "objects" ? folder.objectAt : folder.entityAt;
    for (const it of value.items) {
      const id = str(it.key);
      if (!id) continue;
      if (isNull(it.value)) {
        if (key === "objects") gone.objects.push(id);
        else if (at.get(id)) (folder.section(at.get(id)!, "entities") as YAML.YAMLMap).delete(id);
        continue;
      }
      if (!YAML.isMap(it.value)) {
        bad(
          `${id}: fields as a map (${id}: {${key === "objects" ? "kind: app, in: shop" : "fields: {id: uuid}"}})`,
        );
        continue;
      }
      const file = at.get(id);
      if (file) {
        const target = (folder.section(file, key) as YAML.YAMLMap).get(id, true);
        if (YAML.isMap(target)) {
          // An entity's fields merge one by one, as a box's do (adding one field to a
          // type wiped its other five); a field written null is taken out.
          const was = target.get("fields", true);
          const now = it.value.get("fields", true);
          if (key === "entities" && YAML.isMap(was) && YAML.isMap(now)) {
            const merged = clone(was) as YAML.YAMLMap;
            mergeInto(merged, now);
            const rest = clone(it.value) as YAML.YAMLMap;
            rest.set("fields", merged);
            mergeInto(target, rest);
          } else mergeInto(target, it.value);
        } else (folder.section(file, key) as YAML.YAMLMap).set(id, fresh(it.value));
      } else {
        (folder.section(SCRATCH, key) as YAML.YAMLMap).set(id, fresh(it.value));
        at.set(id, SCRATCH);
      }
    }
    return;
  }
  if (key === "connections") {
    if (!YAML.isSeq(value)) return bad("connections is a list: - {from: a, to: b, label: …}");
    for (const item of value.items) {
      if (!YAML.isMap(item)) {
        bad("each connection is a map: {from: a, to: b, label: …}");
        continue;
      }
      const from = str(item.get("from", true));
      const to = str(item.get("to", true));
      if (!from || !to) {
        bad(`a connection needs from and to: ${String(item)}`);
        continue;
      }
      // was: "a>b" (or a>b:label) re-points that line: its label, notes and the rest come along
      // (moving a line to another box took a remove and an add).
      const was = str(item.get("was", true));
      if (was !== undefined) {
        const m = /^\s*([^>\s]+)\s*>\s*(.+?)\s*$/.exec(was);
        if (!m) {
          bad(
            `was: "${was}" isn't a line: it's from>to (checkout>payments), with :label when two share the ends`,
          );
          continue;
        }
        // The far end can be a code ref (repo:path#fn): try it whole, then each colon as the
        // start of a label (the repo's colon was read as one).
        const tail = m[2]!;
        const tries: [string, string | undefined][] = [[tail, undefined]];
        for (let i = tail.indexOf(":"); i > 0; i = tail.indexOf(":", i + 1))
          tries.push([tail.slice(0, i).trim(), tail.slice(i + 1).trim()]);
        let old: ReturnType<typeof findConnection> = null;
        for (const [to2, label2] of tries) {
          if (/\s/.test(to2)) continue;
          old = findConnection(folder, m[1]!, to2, label2);
          if (old) break;
        }
        if (Array.isArray(old)) {
          bad(
            `was: ${m[1]}>${m[2]}: there are ${old.length} lines between them (${old.join(", ")}); say which with :label`,
          );
          continue;
        }
        if (!old) {
          bad(`was: no line ${was} to move (if two share the ends, add :label)`);
          continue;
        }
        const moved = clone(item) as YAML.YAMLMap;
        moved.delete("was");
        mergeInto(old, moved);
        continue;
      }
      const label = str(item.get("label", true));
      const hit = findConnection(folder, from, to, label);
      if (Array.isArray(hit))
        bad(
          `${from}>${to}: there are ${hit.length} connections between them (${hit.join(", ")}); say which with its label`,
        );
      else if (hit) mergeInto(hit, item);
      else (folder.section(SCRATCH, "connections", true) as YAML.YAMLSeq).add(fresh(item));
    }
    return;
  }
  if (key === "views" || key === "decisions") {
    if (!YAML.isMap(value))
      return bad(
        `${key} is a map keyed by id (${key}:\\n  ${key === "views" ? "billing: {name: Billing, scope: billing}" : "0004-split-billing: {title: …, status: proposed}"})`,
      );
    for (const it of value.items) {
      const id = str(it.key);
      if (!id) continue;
      if (isNull(it.value)) {
        gone[key === "views" ? "views" : "decisions"].push(id);
        continue;
      }
      if (!YAML.isMap(it.value)) {
        bad(`${id}: fields as a map`);
        continue;
      }
      const path = `${key}/${id}.yaml`;
      const d = folder.doc(path);
      // A view is hand-picked (boxes) or follows rules (include/exclude): writing one switches it, the other goes.
      if (key === "views") {
        const sets = (k: string) =>
          (it.value as YAML.YAMLMap).items.some((x) => str(x.key) === k && !isNull(x.value));
        const target = d.contents as YAML.YAMLMap;
        if (sets("boxes")) (target.delete("include"), target.delete("exclude"));
        else if (sets("include") || sets("exclude")) target.delete("boxes");
      }
      mergeInto(d.contents as YAML.YAMLMap, it.value);
      // A new view written without a name takes one from its id (refused for it).
      if (key === "views" && !str((d.contents as YAML.YAMLMap).get("name", true)))
        (d.contents as YAML.YAMLMap).set(
          "name",
          id.replace(/[-_]+/g, " ").replace(/^./, (c) => c.toUpperCase()),
        );
    }
    return;
  }
  if (key === "boundaries") {
    // A map by id, or the file's own list of {id, …}.
    const items: [string, YAML.YAMLMap][] = [];
    if (YAML.isMap(value))
      for (const it of value.items) {
        const id = str(it.key);
        if (id && isNull(it.value)) gone.boundaries.push(id);
        else if (id && YAML.isMap(it.value)) {
          const m = clone(it.value);
          m.set("id", id);
          items.push([id, m]);
        }
      }
    else if (YAML.isSeq(value))
      for (const it of value.items)
        if (YAML.isMap(it) && str(it.get("id", true)))
          items.push([str(it.get("id", true))!, clone(it)]);
        else
          return bad(
            "boundaries: a map by id ({vpc: {kind: network, name: VPC, include: [{ids: [api]}]}})",
          );
    const list = folder.section("boundaries.yaml", "boundaries", true) as YAML.YAMLSeq;
    for (const [id, m] of items) {
      const hit = list.items.find((x) => YAML.isMap(x) && str(x.get("id", true)) === id) as
        YAML.YAMLMap | undefined;
      if (hit) mergeInto(hit, m);
      else list.add(m);
    }
  }
}

/** Is this a code ref (repo:path, repo:path#fn) rather than an id? */
const codeish = (s: string) => /^[\w.@-]+:[^\s>]/.test(s) && !/^(view|boundary|decision):/.test(s);

/**
 * Code refs where a box's id goes (an object's key, in:, a connection's ends, a view's scope,
 * boxes and rules, a flow step's ends, a link's on, a boundary's rules), turned into the ids the
 * files use. Every ref works in every tool; one that names nothing says so, and how to add it.
 */
function refsToIds(frag: YAML.Document, idx: ModelIndex, problems: Problem[]): void {
  const known = new Set([...idx.objects.values()].map(idOf));
  const unknown = (ref: string, where: string, key = false) => {
    // A name in a file that is there (repo:path#EdgeRouter): import brings files and functions,
    // not classes, consts or types, so there's no box for it; it belongs on its file or as an entity.
    const [file, name] = ref.split("#") as [string, string | undefined];
    const home = key && name ? resolveRef(idx, file) : null;
    // Used where a box goes (a connection's end, a step): the file is there, the name isn't one
    // of its functions (arrow functions in properties, object literals' methods).
    const inFile = !key && name ? resolveRef(idx, file) : null;
    if (inFile) {
      const fns = (idx.children.get(inFile.id) ?? [])
        .filter((c) => c.kind === "function" && c.status !== "removed")
        .map((c) => c.name.replace(/\(\)$/, ""));
      const last = name!.split(".").pop()!.toLowerCase();
      const near = [
        ...fns.filter(
          (f) => f.toLowerCase().includes(last) || last.includes(f.split(".").pop()!.toLowerCase()),
        ),
        ...fns,
      ]
        .filter((f, i, all) => all.indexOf(f) === i)
        .slice(0, 8);
      problems.push({
        level: "error",
        file: `yaml: ${where}`,
        message: `no box has the code ref ${ref}: ${file} is there, but the indexer gave no function ${name} in it, so import made none (a function held in a variable, a property or an object's field often isn't one to an indexer). Use the file (${file}) or the function that holds it${near.length ? `; its functions include ${near.map((f) => `${file}#${f}`).join(", ")}` : ""}`,
      });
      return;
    }
    const message = home
      ? `no box has the code ref ${ref}: import brings files and functions, not classes, consts or types. Say what ${name} is in its file's context (${idOf(home)}: {context: …}), or, if it's a shape the design uses, make it an entity (entities: {${name!.split(".")[0]}: {in: ${idOf(home)}, fields: {…}}})`
      : `no box has the code ref ${ref}${key ? `: a new box takes an id as its key, with the ref as its path (${slugOf(ref)}: {kind: module, path: ${file}})` : `; find its id with read {q: "${ref.split(/[#/:]/).pop()}"}`}`;
    problems.push({ level: "error", file: `yaml: ${where}`, message });
  };
  const idFor = (ref: string, where: string, key = false): string | null => {
    if (known.has(ref) || !codeish(ref)) return null;
    const o = resolveRef(idx, ref);
    if (o) return idOf(o);
    unknown(ref, where, key);
    return null;
  };
  /** A scalar holding a ref: swapped in place. */
  const fix = (n: unknown, where: string) => {
    if (!YAML.isScalar(n) || typeof n.value !== "string") return;
    const id = idFor(n.value, where);
    if (id) n.value = id;
  };
  const list = (n: unknown, where: string) => {
    if (YAML.isSeq(n)) for (const x of n.items) fix(x, where);
    else fix(n, where);
  };
  const rules = (n: unknown, where: string) => {
    if (!YAML.isSeq(n)) return;
    for (const r of n.items) {
      if (!YAML.isMap(r)) continue;
      for (const k of ["children", "descendants", "neighbours"]) fix(r.get(k, true), where);
      list(r.get("ids", true), where);
    }
  };
  const top = frag.contents;
  if (!YAML.isMap(top)) return;
  const objects = top.get("objects", true);
  if (YAML.isMap(objects))
    for (const it of [...objects.items]) {
      const k = str(it.key);
      if (k) {
        const before = problems.length;
        const id = idFor(k, `objects: ${k}`, true);
        if (id) it.key = new YAML.Scalar(id);
        // A ref that names nothing: said once, not again as a bad id and a box with no kind.
        else if (problems.length > before) {
          objects.items.splice(objects.items.indexOf(it), 1);
          continue;
        }
      }
      if (YAML.isMap(it.value)) fix(it.value.get("in", true), `objects: ${k}`);
    }
  const conns = top.get("connections", true);
  if (YAML.isSeq(conns))
    for (const c of conns.items)
      if (YAML.isMap(c)) for (const end of ["from", "to"]) fix(c.get(end, true), "connections");
  // An entity's in: (the box it's defined in) takes a ref like any other.
  const ents = top.get("entities", true);
  if (YAML.isMap(ents))
    for (const it of ents.items)
      if (YAML.isMap(it.value)) fix(it.value.get("in", true), `entities: ${str(it.key)}`);
  const views = top.get("views", true);
  if (YAML.isMap(views))
    for (const it of views.items) {
      const v = it.value;
      const where = `views: ${str(it.key)}`;
      if (!YAML.isMap(v)) continue;
      fix(v.get("scope", true), where);
      list(v.get("boxes", true), where);
      for (const k of ["include", "exclude", "hide_lines"]) rules(v.get(k, true), where);
      const flows = v.get("flows", true);
      if (YAML.isSeq(flows))
        for (const f of flows.items) {
          const steps = YAML.isMap(f) ? f.get("steps", true) : null;
          if (YAML.isSeq(steps))
            for (const s of steps.items)
              if (YAML.isMap(s)) for (const end of ["from", "to"]) fix(s.get(end, true), where);
        }
      const links = v.get("links", true);
      if (YAML.isSeq(links))
        for (const l of links.items) if (YAML.isMap(l)) fix(l.get("on", true), where);
    }
  const bounds = top.get("boundaries", true);
  const each = YAML.isMap(bounds)
    ? bounds.items.map((x) => x.value)
    : YAML.isSeq(bounds)
      ? bounds.items
      : [];
  for (const b of each)
    if (YAML.isMap(b)) for (const k of ["include", "exclude"]) rules(b.get(k, true), "boundaries");
}

/** A remove entry with code refs, as ids: a box (repo:path#fn) or a connection (ref>ref[:label]). */
function removeRefToIds(idx: ModelIndex, raw: string): string {
  const t = raw.trim();
  const one = (s: string) => {
    const o = codeish(s) ? resolveRef(idx, s) : null;
    return o ? idOf(o) : null;
  };
  if (!t.includes(">")) return one(t) ?? t;
  const at = t.indexOf(">");
  const a = t.slice(0, at).trim();
  const rest = t.slice(at + 1).trim();
  const from = one(a) ?? a;
  // The far end, then a label after a colon: try the longest ref first.
  const cuts = [rest.length, ...[...rest.matchAll(/:/g)].map((m) => m.index!).reverse()];
  for (const c of cuts) {
    const to = one(rest.slice(0, c).trim());
    if (to) return `${from}>${to}${c < rest.length ? rest.slice(c) : ""}`;
  }
  return `${from}>${rest}`;
}

const slugOf = (ref: string) =>
  (ref.split("#")[1] ?? ref.split(/[/:]/).pop() ?? ref)
    .replace(/\.[a-z]+$/i, "")
    .replace(/[^\w.-]+/g, "-")
    .toLowerCase() || "code";

/** Every connection from → to in the folder, with the list it sits in. */
function between(
  folder: Folder,
  from: string,
  to: string,
): { map: YAML.YAMLMap; seq: YAML.YAMLSeq }[] {
  const out: { map: YAML.YAMLMap; seq: YAML.YAMLSeq }[] = [];
  for (const [, d] of folder.docsWith("connections")) {
    const seq = d.get("connections");
    if (!YAML.isSeq(seq)) continue;
    for (const x of seq.items)
      if (YAML.isMap(x) && str(x.get("from", true)) === from && str(x.get("to", true)) === to)
        out.push({ map: x, seq });
  }
  return out;
}

const refsOf = (from: string, to: string, xs: { map: YAML.YAMLMap }[]) =>
  xs.map(
    (x) =>
      `${from}>${to}${str(x.map.get("label", true)) ? `:${str(x.map.get("label", true))}` : ""}`,
  );

/**
 * The connection a fragment line means: same ends and label; or the only one between those
 * ends when it has no label or the line doesn't say one. Several and no label to tell them
 * apart: their refs (an error for the caller). None: null (a new one).
 */
function findConnection(
  folder: Folder,
  from: string,
  to: string,
  label: string | undefined,
): YAML.YAMLMap | string[] | null {
  const same = between(folder, from, to);
  if (label !== undefined) {
    const exact = same.find((x) => str(x.map.get("label", true)) === label);
    if (exact) return exact.map;
    return same.length === 1 && str(same[0]!.map.get("label", true)) === undefined
      ? same[0]!.map
      : null;
  }
  if (same.length > 1) return refsOf(from, to, same);
  return same[0]?.map ?? null;
}

/** Take one connection out. "none", a message when the ends have several and no label says which, or null when done. */
function dropConnection(folder: Folder, from: string, to: string, label?: string): string | null {
  const same = between(folder, from, to);
  const hits =
    label === undefined ? same : same.filter((x) => str(x.map.get("label", true)) === label);
  if (!hits.length) return "none";
  // Several with the very same label (or none): no ref can say which, and they read the same,
  // so one of them goes (the last written). Different labels: the label has to say which.
  const twins = hits.every(
    (x) => str(x.map.get("label", true)) === str(hits[0]!.map.get("label", true)),
  );
  if (hits.length > 1 && !twins)
    return `${from}>${to}: there are ${hits.length} connections between them (${refsOf(from, to, hits).join(", ")}); remove one by its label`;
  const { map, seq } = hits[hits.length - 1]!;
  seq.items.splice(seq.items.indexOf(map), 1);
  return null;
}

function nearConn(m: FileModel, from: string, to: string): string {
  const same = m.connections.filter((c) => c.from === from && c.to === to);
  if (same.length > 1)
    return `; there are ${same.length}: ${same.map((c) => `${from}>${to}:${c.label ?? ""}`).join(", ")}`;
  const back = m.connections.find((c) => c.from === to && c.to === from);
  if (back) return `; there is ${to}>${from}`;
  const outs = m.connections.filter((c) => c.from === from).map((c) => `${from}>${c.to}`);
  return outs.length ? `; ${from} connects to: ${outs.slice(0, 6).join(", ")}` : "";
}

/** A view's settings a change touches: "arrows curved → elbow" for a plain one, the field for the rest. */
function viewChanges(was: Diagram, now: Diagram): string[] {
  const AS: Record<string, string> = { scopeId: "scope", hideLines: "hide_lines" };
  const plain = (v: unknown) => v === undefined || v === null || typeof v !== "object";
  // Unset, false, "" and [] all say "not set": a merge fills them in, which isn't a change.
  const unset = (v: unknown) =>
    v === undefined ||
    v === null ||
    v === false ||
    v === "" ||
    (Array.isArray(v) && !v.length) ||
    (typeof v === "object" && v !== null && !Array.isArray(v) && !Object.keys(v).length);
  const same = (a: unknown, b: unknown) =>
    (unset(a) && unset(b)) || JSON.stringify(a) === JSON.stringify(b);
  const say = (v: unknown, k: string) =>
    unset(v) ? (k === "arrows" ? "curved" : "none") : String(v);
  return [...new Set([...Object.keys(was), ...Object.keys(now)])]
    .filter(
      (k) =>
        k !== "updatedAt" &&
        k !== "createdAt" &&
        !same(
          (was as unknown as Record<string, unknown>)[k],
          (now as unknown as Record<string, unknown>)[k],
        ),
    )
    .map((k) => {
      const a = (was as unknown as Record<string, unknown>)[k];
      const b = (now as unknown as Record<string, unknown>)[k];
      // A list is written whole: what a new one left out goes, so say what went (hide_lines lost {between: neighbours} unseen).
      const gone = (x: unknown, y: unknown) =>
        Array.isArray(x)
          ? x
              .filter(
                (e) =>
                  !(Array.isArray(y) ? y : []).some((f) => JSON.stringify(f) === JSON.stringify(e)),
              )
              .map((e) => JSON.stringify(e).replace(/"/g, ""))
          : [];
      const lost =
        k === "rules"
          ? (["include", "exclude"] as const).flatMap((r) =>
              gone(
                (a as Record<string, unknown> | undefined)?.[r],
                (b as Record<string, unknown> | undefined)?.[r],
              ).map((e) => `${r} ${e}`),
            )
          : gone(a, b);
      if (lost.length && !unset(b))
        return `${AS[k] ?? k} (a list is replaced whole: this drops ${lost.join(", ")}; to keep it, list it too)`;
      return plain(a) && plain(b) && k !== "story" && k !== "context"
        ? `${AS[k] ?? k} ${say(a, k)} → ${say(b, k)}`
        : (AS[k] ?? k);
    });
}

/** What a batch would change, a line each: + new, ~ changed (which fields), - gone. */
function summary(
  idx: ModelIndex,
  ops: Op[],
  tbd: Set<string> = new Set(),
  cap = 60,
  tagsBefore: Set<string> = new Set(),
): string[] {
  const out: string[] = [];
  const counts = new Map<string, number>();
  const name = (id: string) => (idx.objects.has(id) ? refOf(idx, id) : id);
  // Said as the files say them.
  const AS: Record<string, string> = {
    description: "context",
    technology: "tech",
    parentId: "in",
    name: "name",
    references: "uses/references",
    sourceId: "in",
    fromId: "from",
    toId: "to",
    viaId: "via",
  };
  const fieldsChanged = (a: object, b: object, as: Record<string, string> = AS) => [
    ...new Set(
      [...Object.keys(a), ...Object.keys(b)]
        .filter(
          (k) =>
            k !== "updatedAt" &&
            k !== "createdAt" &&
            JSON.stringify((a as Record<string, unknown>)[k]) !==
              JSON.stringify((b as Record<string, unknown>)[k]),
        )
        .map((k) => as[k] ?? k),
    ),
  ];
  const objKey = new Map<string, string>();
  for (const op of ops)
    if (op.op === "object.put") objKey.set(op.object.id, op.object.key ?? op.object.id);
  const ref = (id: string) => objKey.get(id) ?? name(id);
  for (const op of ops) {
    switch (op.op) {
      case "object.put": {
        const was = idx.objects.get(op.object.id);
        if (!was)
          out.push(
            `  + ${op.object.key ?? op.object.id} (${op.object.kind})${op.object.parentId ? ` in ${ref(op.object.parentId)}` : ""}`,
          );
        else out.push(`  ~ ${refOf(idx, was.id)}: ${fieldsChanged(was, op.object).join(", ")}`);
        break;
      }
      case "object.delete":
        out.push(`  - ${name(op.id)}`);
        break;
      case "connection.put": {
        const was = idx.connections.get(op.connection.id);
        const r = `${ref(op.connection.fromId)}>${ref(op.connection.toId)}${op.connection.name ? ` ${op.connection.name}` : ""}`;
        // A connection's name is its label, in the files and here.
        // A relabel says what it was (the old label wasn't shown).
        // A relabel says what it was; a confirmed guess says so, not just "guess".
        const fields = was
          ? fieldsChanged(was, op.connection, { ...AS, name: "label" }).map((f) =>
              f === "label"
                ? `label "${was.name ?? ""}" → "${op.connection.name ?? ""}"`
                : f === "guess"
                  ? op.connection.guess
                    ? "now a guess"
                    : "confirmed (no longer a guess)"
                  : f,
            )
          : [];
        // A call the import found, changed by hand: said so, so a label meant for a new line
        // isn't taken for one (same-ends writes quietly relabelled imported calls).
        const found =
          was &&
          !!idx.objects.get(was.fromId)?.tags.includes("generated") &&
          !!idx.objects.get(was.toId)?.tags.includes("generated");
        const whose = found
          ? ` (the call the import found${was!.guess || op.connection.guess ? "" : ", still exact"}; for a line of its own, give it another label)`
          : "";
        out.push(was ? `  ~ ${r}: ${fields.join(", ")}${whose}` : `  + ${r}`);
        break;
      }
      case "connection.delete": {
        const c = idx.connections.get(op.id);
        out.push(`  - ${c ? connRef(idx, c) : op.id}`);
        break;
      }
      case "entity.put": {
        const was = idx.entities.get(op.entity.id);
        // A name used but defined nowhere: a TBD entity (check warns about it), not one this wrote.
        if (!was && tbd.has(op.entity.name)) {
          out.push(`  + ${op.entity.name} (TBD: named, defined nowhere yet)`);
          break;
        }
        out.push(
          was
            ? `  ~ entity ${op.entity.name}: ${fieldsChanged(was, op.entity).join(", ")}`
            : `  + entity ${op.entity.name}`,
        );
        break;
      }
      case "entity.delete":
        out.push(`  - entity ${idx.entities.get(op.id)?.name ?? op.id}`);
        break;
      case "diagram.put": {
        const was = idx.diagrams.get(op.diagram.id);
        const what = was ? viewChanges(was, op.diagram) : [];
        out.push(
          was
            ? `  ~ view ${viewId(op.diagram)}${what.length ? `: ${what.join(", ")}` : ""}`
            : `  + view ${viewId(op.diagram)}`,
        );
        break;
      }
      case "diagram.delete":
        out.push(`  - view ${idx.diagrams.get(op.id) ? viewId(idx.diagrams.get(op.id)!) : op.id}`);
        break;
      // Decisions by name, as the rest: "(and 1 decision)" left people guessing what it was.
      case "decision.put": {
        const was = idx.decisions.get(op.decision.id);
        out.push(
          was
            ? `  ~ decision ${op.decision.id}: ${fieldsChanged(was, op.decision).join(", ")}`
            : `  + decision ${op.decision.id} "${op.decision.title}"`,
        );
        break;
      }
      case "decision.delete":
        out.push(`  - decision ${op.id}`);
        break;
      case "taggroup.put":
        out.push(
          `  ${tagsBefore.has(op.name) ? "~" : "+"} tag group ${op.name}: ${op.group.values.join(", ")}`,
        );
        break;
      case "taggroup.delete":
        out.push(`  - tag group ${op.name}`);
        break;
      default:
        counts.set(op.op, (counts.get(op.op) ?? 0) + 1);
    }
  }
  const rest = [...counts].map(
    ([k, n]) => `${n} ${k.replace(".put", "").replace(".delete", " removed")}`,
  );
  const once = [...new Set(out)];
  out.splice(0, out.length, ...once);
  if (out.length > cap) out.splice(cap, out.length, `  … and ${out.length - cap} more`);
  if (rest.length) out.push(`  (and ${rest.join(", ")})`);
  return out;
}

function autoLabel(ops: Op[], tbd: Set<string> = new Set()): string {
  // Each thing once (an entity can come in two ops: itself, then its links), TBD names not at all.
  const idOfOp = (o: Op): string =>
    o.op === "object.put"
      ? o.object.id
      : o.op === "connection.put"
        ? o.connection.id
        : o.op === "entity.put"
          ? o.entity.id
          : o.op === "diagram.put"
            ? o.diagram.id
            : o.op === "decision.put"
              ? o.decision.id
              : "";
  const n = (k: string) =>
    new Set(
      ops
        .filter((o) => o.op === k && !(o.op === "entity.put" && tbd.has(o.entity.name)))
        .map(idOfOp),
    ).size;
  const parts = [
    n("object.put") && plural(n("object.put"), "box", "boxes"),
    n("connection.put") && plural(n("connection.put"), "connection"),
    n("entity.put") && plural(n("entity.put"), "entity", "entities"),
    n("diagram.put") && plural(n("diagram.put"), "view"),
    n("decision.put") && plural(n("decision.put"), "decision"),
  ].filter(Boolean);
  const gone = ops.filter((o) => o.op.endsWith(".delete")).length;
  return `wrote ${parts.join(", ") || "changes"}${gone ? `, removed ${gone}` : ""}`;
}

/** The changes a scoped write may not make: anything about a box outside the scope's subtree. */
/** The scope's subtree, with the new boxes this batch puts inside it (only new ones: a box moved in from outside isn't the scope's to take). */
function scoped(idx: ModelIndex, scope: ModelObject, ops: Op[]): Set<string> {
  const mine = new Set([scope.id, ...descendants(idx, scope.id)]);
  // A store the scope reads or writes (a connection from inside it): new tables may go in it,
  // for the scope knows what it keeps there (workers were stopped adding the tables
  // of the store their part writes to).
  const conns = [
    ...idx.connections.values(),
    ...ops.flatMap((op) => (op.op === "connection.put" ? [op.connection] : [])),
  ];
  const used = new Set<string>();
  for (const c of conns) {
    if (mine.has(c.fromId)) used.add(c.toId);
    if (mine.has(c.toId)) used.add(c.fromId);
  }
  const stores = new Set(
    [...used]
      .flatMap((id) => [id, ...ancestors(idx, id)])
      .filter((id) => idx.objects.get(id)?.kind === "store"),
  );
  for (let grew = true; grew;) {
    grew = false;
    for (const op of ops) {
      if (op.op !== "object.put" || idx.objects.has(op.object.id) || mine.has(op.object.id))
        continue;
      // A new outside service the scope calls (a vendor no one had added): anywhere, since it isn't
      // part of anything here (a worker made nine vendors inside its own app instead).
      if (op.object.external) {
        mine.add(op.object.id);
        grew = true;
        continue;
      }
      if (!op.object.parentId) continue;
      if (
        mine.has(op.object.parentId) ||
        (op.object.kind === "table" && stores.has(op.object.parentId))
      )
        (mine.add(op.object.id), (grew = true));
    }
  }
  return mine;
}

function outside(idx: ModelIndex, scope: ModelObject, ops: Op[]): string[] {
  const mine = scoped(idx, scope, ops);
  const name = (id: string) => (idx.objects.has(id) ? refOf(idx, id) : id);
  const inside = (id: string | null | undefined) => !!id && mine.has(id);
  // A hand-picked view of no box (a flow's view) that shows the scope's own parts: the worker's
  // to write (every mapper's flow views were refused).
  const picked = new Map<string, Set<string>>();
  for (const [d, ps] of idx.placements) picked.set(d, new Set(ps.keys()));
  for (const op of ops)
    if (op.op === "placement.put")
      (
        picked.get(op.placement.diagramId) ??
        picked.set(op.placement.diagramId, new Set()).get(op.placement.diagramId)!
      ).add(op.placement.objectId);
  const pickedHere = (d: { id: string; scopeId?: string | null }) => {
    const was = idx.diagrams.get(d.id);
    if (d.scopeId || was?.scopeId) return false;
    return [...(picked.get(d.id) ?? [])].some((o) => mine.has(o));
  };
  const out: string[] = [];
  for (const op of ops) {
    const was = op.op === "object.put" ? idx.objects.get(op.object.id) : undefined;
    // An id that's already a box elsewhere: say so, or it reads as a new box refused.
    if (op.op === "object.put" && !mine.has(op.object.id))
      out.push(
        was
          ? `${op.object.key ?? op.object.id} (already a box, in ${was.parentId ? name(was.parentId) : "the top"}, outside ${idOf(scope)}: for a new one, give it an id of its own)`
          : `${op.object.key ?? op.object.id} (a box outside ${idOf(scope)})`,
      );
    // A move: where it was and where it goes must both be inside (the scope itself can't move).
    else if (
      op.op === "object.put" &&
      was &&
      (was.parentId ?? null) !== (op.object.parentId ?? null) &&
      !(inside(was.parentId) && inside(op.object.parentId))
    )
      out.push(
        `moving ${name(was.id)} from ${was.parentId ? name(was.parentId) : "the top"} to ${op.object.parentId ? name(op.object.parentId) : "the top"} (both must be inside ${idOf(scope)})`,
      );
    else if (op.op === "object.delete" && !mine.has(op.id)) out.push(`removing ${name(op.id)}`);
    else if (
      op.op === "connection.put" &&
      !mine.has(op.connection.fromId) &&
      !mine.has(op.connection.toId)
    )
      out.push(`${name(op.connection.fromId)}>${name(op.connection.toId)} (neither end is inside)`);
    else if (op.op === "connection.delete") {
      const c = idx.connections.get(op.id);
      if (c && !mine.has(c.fromId) && !mine.has(c.toId)) out.push(`removing ${connRef(idx, c)}`);
    } else if (op.op === "entity.put") {
      const home = op.entity.sourceId ?? idx.entities.get(op.entity.id)?.sourceId;
      const was = idx.entities.get(op.entity.id)?.sourceId;
      if ((home && !mine.has(home)) || (was && !mine.has(was)))
        out.push(
          `entity ${op.entity.name} (defined in ${name(was && !mine.has(was) ? was : home!)})`,
        );
    } else if (op.op === "entity.delete") {
      const e = idx.entities.get(op.id);
      if (e && !(e.sourceId && mine.has(e.sourceId)))
        out.push(
          `removing entity ${e.name}${e.sourceId ? ` (defined in ${name(e.sourceId)})` : ""}`,
        );
    } else if (
      op.op === "diagram.put" &&
      !(
        op.diagram.scopeId &&
        mine.has(op.diagram.scopeId) &&
        inside(idx.diagrams.get(op.diagram.id)?.scopeId ?? op.diagram.scopeId)
      ) &&
      !pickedHere(op.diagram)
    )
      out.push(
        `view ${viewId(op.diagram)} (not about ${idOf(scope)}: a view written under a scope needs scope: ${idOf(scope)}, or a box inside it; a hand-picked view with no scope needs boxes from inside ${idOf(scope)} on it)`,
      );
    else if (op.op === "diagram.delete") {
      const d = idx.diagrams.get(op.id);
      if (d && !inside(d.scopeId))
        out.push(`removing view ${viewId(d)} (not about ${idOf(scope)})`);
    } else if (op.op === "boundary.put" || op.op === "decision.put")
      out.push(
        `${op.op.split(".")[0]} ${op.op === "boundary.put" ? (op.boundary.key ?? op.boundary.id) : op.decision.id}`,
      );
    else if (op.op === "boundary.delete" || op.op === "decision.delete")
      out.push(`removing ${op.op.split(".")[0]} ${op.id}`);
  }
  return out;
}
