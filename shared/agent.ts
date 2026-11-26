// What agents work with: references by name, a batch of plain changes, and answers as
// compact text. The MCP is a thin layer over this, so it's tested without a server.
//
// References: an object or view can be named by its key ("shop-api"), its internal id, or
// its name ("Shop API", any case). A name two things share is an error that lists both,
// never a guess.
import {
  boundaryChain,
  boundaryClashes,
  boundaryMembers,
  boundaryOf,
  crossesRegions,
} from "./boundaries.ts";
import { Checker, ModelError, pkey, type ModelState } from "./doc.ts";
import {
  nextDecisionId,
  OBJECT_KINDS,
  cleanTags,
  makeDiagram,
  makeBoundary,
  BOUNDARY_KINDS,
  DECISION_STATUSES,
  FOLD_MODES,
  type FoldMode,
  type ArrowStyle,
  type Decision,
  type DecisionStatus,
  type Boundary,
  type BoundaryKind,
  makeFlow,
  makeStep,
  now,
  slug,
  type Connection,
  type Diagram,
  type ModelObject,
  type ObjectKind,
  type Op,
  type Status,
  type Flow,
  type FlowKind,
  type Package,
  type DocLink,
  safeUrl,
  type Column,
  mergedContext,
  REFERENCE_KINDS,
  type Reference,
} from "./model.ts";
import { titleFromUrl } from "./notes.ts";
import { referenceLines } from "./references.ts";
import { packageLinks, resolveRef } from "./context.ts";
import {
  crossingHelp,
  descendants,
  isInside,
  lineEnds,
  projectDiagram,
  type ModelIndex,
} from "./project.ts";
import type { FConfig } from "./files.ts";
import { describeSelector, frameOps, pinEdits, resolve, type Selector } from "./views.ts";
import { scoreGraph, scoreLine } from "./score.ts";

export class RefError extends Error {}

const norm = (s: string) => s.trim().toLowerCase();

/** A link copied from the app (".../#/<design>/d/<diagram>/o/<object>"): the id in it. */
function fromLink(ref: string, part: "o" | "d"): string {
  const m = /#\/[^/]+(?:\/d\/([^/?#]+))?(?:\/o\/([^/?#]+))?/.exec(ref);
  return (part === "o" ? m?.[2] : m?.[1]) ?? ref;
}

export function findObject(idx: ModelIndex, ref: string): ModelObject {
  ref = fromLink(ref.trim(), "o");
  const direct = idx.objects.get(ref);
  if (direct) return direct;
  const byKey = [...idx.objects.values()].filter((o) => o.key === ref);
  if (byKey.length === 1) return byKey[0]!;
  // Code: repo:path, repo:path#fn.
  const code = ref.includes(":") ? resolveRef(idx, ref) : null;
  if (code) return code;
  if (ref.includes(":") && /^[\w.@-]+:/.test(ref))
    throw new RefError(
      `no box has the code ref ${ref} (no module or box with path ${ref.split("#")[0]}${ref.includes("#") ? `, or no function ${ref.split("#")[1]} in it` : ""}); find it with read {q: "${ref.split(/[#/:]/).pop()}"}`,
    );
  const byName = [...idx.objects.values()].filter((o) => norm(o.name) === norm(ref));
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) {
    throw new RefError(
      `"${ref}" could be ${byName.map((o) => `${o.key ?? o.id} (${o.kind}${o.parentId ? ` in ${idx.objects.get(o.parentId)?.name}` : ""})`).join(" or ")}; use the id`,
    );
  }
  const near = [...idx.objects.values()]
    .filter((o) => norm(o.name).includes(norm(ref)) || (o.key ?? "").includes(slug(ref)))
    .slice(0, 5);
  throw new RefError(
    `no object "${ref}"${near.length ? `; did you mean ${near.map((o) => `${o.key ?? o.id} (${o.name})`).join(", ")}?` : ""}`,
  );
}

/** A boundary by key, id or name (null only when `missingOk` and there's none). */
function findBoundary(
  idx: ModelIndex,
  ref: string,
  extra: Map<string, Boundary> = new Map(),
  missingOk = false,
): Boundary | null {
  const all = [...extra.values(), ...[...idx.boundaries.values()].filter((b) => !extra.has(b.id))];
  const hit =
    all.find((b) => b.id === ref || b.key === ref) ?? all.find((b) => norm(b.name) === norm(ref));
  if (hit || missingOk) return hit ?? null;
  throw new RefError(
    `no boundary "${ref}"${all.length ? `; boundaries: ${all.map((b) => b.key ?? b.id).join(", ")}` : ""}`,
  );
}

export function findView(idx: ModelIndex, ref: string): Diagram {
  ref = fromLink(ref.trim(), "d");
  const all = [...idx.diagrams.values()];
  const hit =
    idx.diagrams.get(ref) ??
    all.find((d) => d.key === ref) ??
    all.filter((d) => norm(d.name) === norm(ref))[0];
  if (hit) return hit;
  throw new RefError(`no view "${ref}"; views: ${all.map((d) => d.key ?? d.id).join(", ")}`);
}

const label = (o: ModelObject) => o.key ?? o.id;

// --- reading as text ------------------------------------------------------------------------

function objectLine(idx: ModelIndex, o: ModelObject): string {
  const meta = [
    o.kind,
    o.technology,
    o.status !== "live" ? o.status : "",
    o.external ? "external" : "",
    ...(o.tags ?? []).map((t) => `#${t}`),
  ]
    .filter(Boolean)
    .join(" · ");
  const parent = o.parentId ? idx.objects.get(o.parentId) : undefined;
  return `${label(o)}  ${o.name} (${meta})${parent ? ` in ${label(parent)}` : ""}`;
}

/** One object: what it is, what's inside, what it talks to, which views show it. */
export function describe(idx: ModelIndex, o: ModelObject): string {
  const lines = [objectLine(idx, o)];
  if (o.description) lines.push(`  ${o.description.replace(/\n/g, "\n  ")}`);
  if (o.context) lines.push(`context (for agents):\n${o.context.replace(/^/gm, "  ")}`);
  const inside = idx.children.get(o.id) ?? [];
  if (inside.length) lines.push(`inside: ${inside.map(label).join(", ")}`);
  const mine = new Set([o.id, ...descendants(idx, o.id)]);
  const out: string[] = [];
  const inn: string[] = [];
  const across = (c: { fromId: string; toId: string }) => crossesRegions(idx, c.fromId, c.toId);
  for (const c of idx.connections.values()) {
    const a = mine.has(c.fromId);
    const b = mine.has(c.toId);
    if (a === b) continue;
    const from = idx.objects.get(c.fromId)!;
    const to = idx.objects.get(c.toId)!;
    const via = c.viaId ? idx.objects.get(c.viaId) : undefined;
    const text = `${label(from)} → ${label(to)}${c.name ? ` "${c.name}"` : ""}${c.technology ? ` [${c.technology}]` : ""}${via ? ` via ${label(via)}` : ""}${c.status !== "live" ? ` (${c.status})` : ""}${across(c) ? ` (across regions: ${across(c)})` : ""}`;
    // What travels over it, for agents: under the line, indented.
    (a ? out : inn).push(
      c.context ? `${text}\n    context:\n${c.context.replace(/^/gm, "      ")}` : text,
    );
  }
  const data = o.kind === "table";
  if (out.length) lines.push(data ? "points to:" : "calls:", ...out.map((t) => `  ${t}`));
  if (inn.length)
    lines.push(data ? "pointed at or used by:" : "called by:", ...inn.map((t) => `  ${t}`));
  const on = [...(idx.placedOn.get(o.id) ?? [])]
    .map((d) => idx.diagrams.get(d))
    .filter(Boolean) as Diagram[];
  lines.push(`on views: ${on.length ? on.map((d) => d.key ?? d.name).join(", ") : "none"}`);
  const runs = boundaryChain(idx, boundaryOf(idx, o.id)).map((id) => idx.boundaries.get(id)!);
  if (runs.length)
    lines.push(`runs in: ${runs.map((b) => `${b.key ?? b.id} (${b.kind})`).join(" › ")}`);
  if (o.refs && Object.keys(o.refs).length)
    lines.push(
      `refs: ${Object.entries(o.refs)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ")}`,
    );
  if (o.sources?.length) lines.push(`sources: ${o.sources.join(", ")}`);
  if (o.links?.length) lines.push("links:", ...o.links.map((l) => `  ${l.title}: ${l.url}`));
  lines.push(...referenceLines(idx, o));
  if (o.notes?.trim())
    lines.push(
      "notes (its running doc):",
      ...o.notes
        .trim()
        .split("\n")
        .map((l) => `  ${l}`),
    );
  const decided = [...idx.decisions.values()].filter((d) => d.affects.includes(o.id));
  if (decided.length)
    lines.push(
      "decisions:",
      ...decided.map((d) => `  ${d.id} "${d.title}" (${d.status}${d.date ? `, ${d.date}` : ""})`),
    );
  return lines.join("\n");
}

/** How many boxes fit one screen; past this, a diagram wants grouping. */
const SCREEN_BOXES = 12;

/** A view as drawn: its boxes and the arrows between them (connections rolled up). */
export function outlineView(idx: ModelIndex, d: Diagram): string {
  const g = projectDiagram(idx, d.id);
  const name = (id: string) => {
    const o = idx.objects.get(id);
    return o ? label(o) : id;
  };
  const lines = [
    `${d.name} [${d.key ?? d.id}]${d.scopeId ? ` inside ${name(d.scopeId)}` : ""}, ${d.rules ? "follows the model" : "hand-picked"}`,
  ];
  lines.push(`reads as: ${scoreLine(scoreGraph(g))}`);
  if (d.story)
    lines.push(
      `story: ${d.story
        .split("\n")
        .find((l) => l.trim())
        ?.replace(/^#+\s*/, "")}`,
    );
  if (d.context)
    lines.push(
      `context (for agents; read it before working on this view):\n${d.context.replace(/^/gm, "  ")}`,
    );
  if (d.hideLines?.length)
    lines.push(
      `lines hidden: touching ${d.hideLines.map((s) => describeSelector(s, name)).join(", ")}`,
    );
  if (d.lanes) lines.push(`lanes: by ${d.lanes}`);
  // Crossing: what can still help this view (the same options tidy gives, less what it has).
  const crossings = scoreGraph(g).crossings;
  if (crossings >= 2) {
    const help = crossingHelp(idx, d.id);
    lines.push(
      `tip: ${crossings} crossings${help.length ? `: ${help.join("; or ")}` : ": everything a layout can do is set; leave it, or take boxes off"}`,
    );
  }
  lines.push(
    `boxes (${g.nodes.length}${g.nodes.length > SCREEN_BOXES ? `: more than the ~${SCREEN_BOXES} that fit one screen; group some` : ""}):`,
  );
  for (const n of g.nodes)
    lines.push(
      n.folded
        ? `  ${n.name} (folded): ${n.folded.map(name).join(", ")}`
        : `  ${objectLine(idx, idx.objects.get(n.id)!)}`,
    );
  // Boxes drawn as frames around their insides: their own lines end on the frame.
  const nodeIds = new Set(g.nodes.map((n) => n.id));
  const framed = [...lineEnds(g).keys()].filter((id) => !nodeIds.has(id)).map((id) => ({ id }));
  const frameIds = new Set(framed.map((f) => f.id));
  if (framed.length)
    lines.push(
      `frames (boxes drawn around their insides; their own lines end on the frame): ${framed.map((f) => `${name(f.id)}${f.id === d.scopeId ? " (the view's scope)" : ""}`).join(", ")}`,
    );
  lines.push("arrows:");
  for (const e of g.edges) {
    lines.push(
      `  ${name(e.from)} → ${name(e.to)}${e.label && !e.merged ? ` "${e.label}"` : ""}${e.merged ? ` (${e.merged.length} connections, one arrow):` : ""}`,
    );
    for (const m of e.merged ?? []) lines.push(`      ${m}`);
  }
  // A box's line to something inside itself can't be drawn (the frame holds it): say so.
  const own = [...idx.connections.values()].filter(
    (c) =>
      c.status !== "removed" &&
      ((frameIds.has(c.fromId) && isInside(idx, c.toId, c.fromId)) ||
        (frameIds.has(c.toId) && isInside(idx, c.fromId, c.toId))),
  );
  if (own.length)
    lines.push(
      `not drawn (a box's line to what's inside it; model it from the part that does it, and the box's own lines follow from its parts'): ${own.map((c) => `${name(c.fromId)} → ${name(c.toId)}${c.name ? ` "${c.name}"` : ""}`).join(", ")}`,
    );
  const flows = [...idx.flows.values()].filter((f) => f.diagramId === d.id);
  if (flows.length) {
    lines.push("flows:");
    for (const f of flows)
      lines.push(
        `  ${f.name}${f.kind === "path" ? " (path)" : ""}: ${f.steps.map((s) => `${name(s.fromId)} → ${name(s.toId)}${s.text ? ` (${s.text})` : ""}`).join("; ")}`,
      );
  }
  const frames = g.groups.filter((x) => x.boundary);
  if (d.boundaries)
    lines.push(
      frames.length
        ? `boundaries drawn: ${frames.map((f) => `${f.name} (${f.boundary})`).join(", ")}`
        : "boundaries: on, but none holds a box here",
    );
  return lines.join("\n");
}

/** Boundaries as a tree: kind, rules, how many objects they pick. */
export function outlineBoundaries(idx: ModelIndex): string[] {
  if (!idx.boundaries.size) return [];
  const name = (id: string) => idx.objects.get(id)?.key ?? id;
  const lines = ["", "boundaries (where things run; frames on views with boundaries: true):"];
  const walk = (parent: string | null, depth: number) => {
    for (const b of [...idx.boundaries.values()]
      .filter((x) => x.parentId === parent)
      .sort((a, c) => (a.name < c.name ? -1 : 1))) {
      const members = boundaryMembers(idx, b);
      const rules = b.rules.include.map((r) => describeSelector(r, name)).join("; ");
      lines.push(
        `${"  ".repeat(depth + 1)}${b.key ?? b.id}  ${b.name} (${b.kind}) · ${members.size} picked${rules ? ` · ${rules}` : ""}`,
      );
      walk(b.id, depth + 1);
    }
  };
  walk(null, 0);
  for (const c of boundaryClashes(idx))
    lines.push(
      `  ! ${name(c.objectId)} is picked by both ${c.boundaries.join(" and ")}, which don't nest: it's drawn in one`,
    );
  return lines;
}

/** The whole model as an indented tree, with each object's outgoing connections. */
export function outlineModel(idx: ModelIndex): string {
  const lines: string[] = [];
  const walk = (list: ModelObject[], depth: number) => {
    for (const o of [...list].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const calls = [...idx.connections.values()]
        .filter((c) => c.fromId === o.id)
        .map((c) => `${label(idx.objects.get(c.toId)!)}${c.name ? ` "${c.name}"` : ""}`);
      lines.push(
        `${"  ".repeat(depth)}${objectLine(idx, o).replace(/ in [^ ]+$/, "")}${calls.length ? `  → ${calls.join(", ")}` : ""}`,
      );
      walk(idx.children.get(o.id) ?? [], depth + 1);
    }
  };
  walk(
    [...idx.objects.values()].filter((o) => !o.parentId),
    0,
  );
  lines.push(...outlineBoundaries(idx));
  lines.push(
    "",
    `views: ${[...idx.diagrams.values()].map((d) => `${d.key ?? d.id} (${idx.placements.get(d.id)?.size ?? 0})`).join(", ")}`,
  );
  if (idx.decisions.size)
    lines.push(
      "",
      "decisions:",
      ...[...idx.decisions.values()]
        .sort((x, y) => x.id.localeCompare(y.id))
        .map((d) => `  ${d.id} "${d.title}" (${d.status})`),
    );
  return lines.join("\n");
}

/** Why each box is on a view. */
export function explain(idx: ModelIndex, d: Diagram): string {
  const name = (id: string) => idx.objects.get(id)?.name ?? id;
  const key = (id: string) => {
    const o = idx.objects.get(id);
    return o ? label(o) : id;
  };
  if (!d.rules)
    return `${d.name} is hand-picked: ${[...(idx.placements.get(d.id)?.keys() ?? [])].map(key).join(", ") || "empty"}`;
  const r = resolve(idx, d);
  const lines = [
    `${d.name} follows these rules:`,
    `  include: ${JSON.stringify(d.rules.include)}`,
    `  exclude: ${JSON.stringify(d.rules.exclude)}`,
  ];
  // Boxes there for the same reason on one line (a line per box, "x: inside Archnemesis server").
  const byWhy = new Map<string, string[]>();
  for (const [id, why] of r.why) {
    const w = why.map((s) => describeSelector(s, name)).join("; ");
    byWhy.set(w, [...(byWhy.get(w) ?? []), key(id)]);
  }
  for (const [w, ids] of byWhy) lines.push(`  ${w}: ${ids.join(", ")}`);
  for (const [id, s] of r.excluded)
    lines.push(`  ${key(id)} left off: ${describeSelector(s, name)}`);
  for (const s of r.empty) lines.push(`  warning: ${JSON.stringify(s)} matches nothing`);
  return lines.join("\n");
}

/**
 * How `from` reaches `to` through connections, shortest first. Each end can be a box or
 * anything inside it, so "storefront to payments" finds storefront → checkout → payments.
 */
export function path(idx: ModelIndex, from: ModelObject, to: ModelObject, directed = true): string {
  const start = new Set([from.id, ...descendants(idx, from.id)]);
  const goal = new Set([to.id, ...descendants(idx, to.id)]);
  const adj = new Map<string, Connection[]>();
  for (const c of idx.connections.values()) {
    adj.set(c.fromId, [...(adj.get(c.fromId) ?? []), c]);
    if (!directed) adj.set(c.toId, [...(adj.get(c.toId) ?? []), c]);
  }
  const prev = new Map<string, Connection | null>();
  const queue = [...start];
  for (const s of start) prev.set(s, null);
  while (queue.length) {
    const cur = queue.shift()!;
    if (goal.has(cur)) {
      const steps: string[] = [];
      for (
        let at = cur, c = prev.get(at);
        c;
        at = c.fromId === at ? c.toId : c.fromId, c = prev.get(at)
      ) {
        const a = idx.objects.get(c.fromId)!;
        const b = idx.objects.get(c.toId)!;
        steps.unshift(`${label(a)} → ${label(b)}${c.name ? ` "${c.name}"` : ""}`);
      }
      return steps.length ? steps.join("\n") : `${label(from)} and ${label(to)} overlap`;
    }
    for (const c of adj.get(cur) ?? []) {
      const next = c.fromId === cur ? c.toId : c.fromId;
      if (prev.has(next)) continue;
      prev.set(next, c);
      queue.push(next);
    }
  }
  if (!directed) return "no path";
  const loose = path(idx, from, to, false);
  return loose === "no path"
    ? "no path"
    : `no path following the arrows; ignoring direction:\n${loose}`;
}

// --- changing -------------------------------------------------------------------------------

interface ObjectFields {
  name?: string;
  kind?: ObjectKind;
  in?: string | null;
  description?: string;
  context?: string;
  tech?: string;
  /** The logo, when the one guessed from tech is wrong: a technology, or "none"; "" goes back to guessing. */
  icon?: string;
  /** A module's place in its repo (repo:path); "" takes it off. */
  path?: string;
  /** A function's signature; "" takes it off. */
  signature?: string;
  /** A library's package; null takes it off. */
  package?: Package | null;
  /** A table's columns, the whole list in order (an empty one takes them all off). */
  columns?: Column[];
  status?: Status;
  external?: boolean;
  tags?: string[];
  /** Identifiers elsewhere; a null value takes one off. */
  refs?: Record<string, string | null>;
  sources?: string[];
  /** Docs about it; the whole list (an empty one takes them all off). */
  links?: { title?: string; url: string }[];
  /** Everything it points at, links included: the whole list (an empty one takes them off). */
  references?: {
    link?: string;
    image?: string;
    doc?: string;
    code?: string;
    dependency?: string;
    entity?: string;
    title?: string;
  }[];
  /** Its running doc (markdown); "" clears it. */
  notes?: string;
}

/** What the design's archnm.yaml says, as far as apply cares. */
export interface PlanRules {
  /** Fields only people change ("refs.sys", "name"…). */
  protect?: string[];
  tags?: FConfig["tags"];
  /** The changes come from an agent, so protected fields are refused. */
  agent?: boolean;
}

export type Change =
  | { add: ObjectFields & { id?: string; name: string; kind: ObjectKind } }
  | { update: string; set: ObjectFields }
  | { remove: string }
  | {
      connect: {
        from: string;
        to: string;
        label?: string;
        tech?: string;
        description?: string;
        context?: string;
        status?: Status;
        via?: string | null;
        sources?: string[];
        guess?: boolean | null;
        column?: string | null;
        to_column?: string | null;
      };
    }
  | { disconnect: { from: string; to: string; label?: string } }
  | { move: { objects: string[]; to: string | null } }
  | {
      view: {
        id?: string;
        name: string;
        scope?: string | null;
        include?: Selector[];
        exclude?: Selector[];
        boundaries?: boolean;
        color_by?: string | null;
        story?: string;
        context?: string;
        links?: { title?: string; url: string }[];
        fold?: FoldMode | null;
        hide_lines?: Selector[] | null;
        lanes?: string | null;
        arrows?: ArrowStyle;
        reset_joints?: boolean;
      };
    }
  | {
      decision: {
        id?: string;
        title: string;
        status?: DecisionStatus;
        date?: string;
        affects?: string[];
        text?: string;
        superseded_by?: string | null;
      };
    }
  | { remove_decision: string }
  | { remove_view: string }
  | {
      boundary: {
        id?: string;
        name: string;
        kind?: BoundaryKind;
        in?: string | null;
        description?: string;
        include?: Selector[];
        exclude?: Selector[];
      };
    }
  | { remove_boundary: string }
  | { show: { view: string; objects: string[] } }
  | { hide: { view: string; objects: string[] } }
  | {
      flow: {
        view: string;
        name: string;
        kind?: FlowKind;
        steps: { from: string; to: string; text?: string }[];
      };
    };

export interface Planned {
  ops: Op[];
  /** One line per change, in plain words ("+ app refunds in shop"). */
  summary: string[];
  /** With onError "skip": the changes left out, each with why. */
  skipped?: string[];
}

/** A change in a few words, for an error about it. */
function changeLabel(ch: Change): string {
  const k = Object.keys(ch)[0]!;
  const v = (ch as Record<string, unknown>)[k];
  if (typeof v === "string") return `${k} ${v}`;
  const o = v as Record<string, unknown>;
  if (k === "connect" || k === "disconnect") return `${k} ${String(o.from)} → ${String(o.to)}`;
  return `${k} ${String(o.id ?? o.name ?? o.title ?? o.view ?? "")}`.trim();
}

/**
 * The order changes are made in, whatever order they came in: what exists first, then
 * what refers to it, removals last. Adds go parents first. So a batch never fails because a
 * view named something added further down, or a removal came before what still used it.
 */
export function orderChanges(changes: Change[]): { ch: Change; i: number }[] {
  const phase = (ch: Change): number =>
    "add" in ch
      ? 0
      : "update" in ch || "move" in ch
        ? 1
        : "boundary" in ch
          ? 2
          : "connect" in ch || "disconnect" in ch
            ? 3
            : "view" in ch
              ? 4
              : "show" in ch || "hide" in ch || "flow" in ch
                ? 5
                : "decision" in ch
                  ? 6
                  : 7;
  const list = changes.map((ch, i) => ({ ch, i }));
  // Adds: parents before what goes in them.
  const adds = list.filter((x) => "add" in x.ch);
  const byRef = new Map<string, { ch: Change; i: number }>();
  for (const a of adds) {
    const add = (a.ch as { add: { id?: string; name: string } }).add;
    if (add.id) byRef.set(add.id, a);
    byRef.set(norm(add.name), a);
  }
  const sorted: { ch: Change; i: number }[] = [];
  const seen = new Set<number>();
  const visit = (x: { ch: Change; i: number }, depth = 0) => {
    if (seen.has(x.i) || depth > 50) return;
    seen.add(x.i);
    const parent = (x.ch as { add: { in?: string | null } }).add.in;
    const p = parent ? (byRef.get(parent) ?? byRef.get(norm(parent))) : undefined;
    if (p) visit(p, depth + 1);
    sorted.push(x);
  };
  for (const a of adds) visit(a);
  const rest = list
    .filter((x) => !("add" in x.ch))
    .sort((a, b) => phase(a.ch) - phase(b.ch) || a.i - b.i);
  return [...sorted, ...rest];
}

/**
 * Turn an agent's changes into checked ops, in orderChanges' order (so any change can refer
 * to anything added in the batch). Throws RefError listing every change that can't be made,
 * having changed nothing; with onError "skip", leaves those out and says so.
 */
export function planChanges(
  state: ModelState,
  idx0: ModelIndex,
  changes: Change[],
  rules: PlanRules = {},
  opts: { onError?: "stop" | "skip" } = {},
): Planned {
  const errors: string[] = [];
  // Objects added in this batch, so later changes can refer to them.
  const added = new Map<string, ModelObject>();
  const ops: Op[] = [];
  const summary: string[] = [];
  const t = now();
  const usedKeys = new Set(
    [...idx0.objects.values()].map((o) => o.key).filter(Boolean) as string[],
  );
  // The batch so far, checked: each change's ops go on top of it (all or nothing per change).
  const checker = new Checker(state);

  // Lookups by id, key and name, made once: a batch of thousands refers by name thousands of times.
  const group = <K, V>(list: Iterable<V>, k: (v: V) => K | undefined) => {
    const m = new Map<K, V[]>();
    for (const v of list) {
      const key = k(v);
      if (key !== undefined) (m.get(key) ?? m.set(key, []).get(key)!).push(v);
    }
    return m;
  };
  const byKey0 = group(idx0.objects.values(), (o) => o.key);
  const byName0 = group(idx0.objects.values(), (o) => norm(o.name));
  const conns0 = group(idx0.connections.values(), (c) => `${c.fromId}>${c.toId}`);
  /** An existing object by id, key or name, as findObject finds it (its errors when it doesn't). */
  const find0 = (ref: string): ModelObject => {
    const r = ref.trim();
    const hit =
      idx0.objects.get(r) ??
      (byKey0.get(r)?.length === 1 ? byKey0.get(r)![0] : undefined) ??
      (byName0.get(norm(r))?.length === 1 ? byName0.get(norm(r))![0] : undefined);
    return hit ?? findObject(idx0, ref);
  };
  // What this batch added, by name too (the first one of a name, as a search in order finds it).
  const addedByName = new Map<string, ModelObject>();
  const keepAdded = (o: ModelObject) => {
    const was = added.get(o.id);
    if (was && norm(was.name) !== norm(o.name) && addedByName.get(norm(was.name))?.id === o.id)
      addedByName.delete(norm(was.name));
    added.set(o.id, o);
    const n = norm(o.name);
    if (!addedByName.has(n) || addedByName.get(n)!.id === o.id) addedByName.set(n, o);
  };
  const obj = (ref: string): ModelObject => {
    // An id or key, here or added, before a name: an import under "acme" (the system's key)
    // put the folders in a library it had just made, also named acme.
    const exact =
      added.get(ref) ??
      idx0.objects.get(ref) ??
      (byKey0.get(ref)?.length === 1 ? byKey0.get(ref)![0] : undefined);
    if (exact) return latest.get(exact.id) ?? exact;
    const a = addedByName.get(norm(ref));
    if (a) return a;
    const o = find0(ref);
    return latest.get(o.id) ?? o;
  };
  const latest = new Map<string, ModelObject>();
  const fields = (f: ObjectFields, base: ModelObject): ModelObject => {
    const next: ModelObject = { ...base };
    if (f.name !== undefined) next.name = f.name;
    if (f.kind !== undefined) next.kind = f.kind;
    if (f.in !== undefined) next.parentId = f.in === null ? null : obj(f.in).id;
    // One text: context (description is its older name); both given, description goes first.
    if (f.description !== undefined || f.context !== undefined) {
      next.description = mergedContext(f.description, f.context);
      delete next.context;
    }
    if (f.tech !== undefined) next.technology = f.tech;
    if (f.icon !== undefined) {
      if (f.icon.trim()) next.icon = f.icon.trim();
      else delete next.icon;
    }
    if (f.path !== undefined) {
      if (f.path.trim()) next.path = f.path.trim();
      else delete next.path;
    }
    if (f.signature !== undefined) {
      if (f.signature.trim()) next.signature = f.signature.trim();
      else delete next.signature;
    }
    if (f.package !== undefined) {
      if (f.package)
        next.package = {
          ecosystem: f.package.ecosystem,
          name: f.package.name,
          ...(f.package.version ? { version: f.package.version } : {}),
        };
      else delete next.package;
    }
    if (f.columns !== undefined) {
      if (f.columns.length) next.columns = f.columns.map(cleanColumn);
      else delete next.columns;
    }
    if (f.status !== undefined) next.status = f.status;
    if (f.external !== undefined) next.external = f.external;
    if (f.tags !== undefined) {
      next.tags = cleanTags(f.tags);
      for (const tag of next.tags) {
        const i = tag.indexOf(":");
        const g = i > 0 ? rules.tags?.[tag.slice(0, i)] : undefined;
        if (g && !g.values.includes(tag.slice(i + 1)))
          throw new RefError(
            `tag "${tag}": ${tag.slice(0, i)} is one of ${g.values.map((v) => `${tag.slice(0, i)}:${v}`).join(", ")} (archnm.yaml tags)`,
          );
      }
    }
    if (f.refs !== undefined) {
      const r: Record<string, string> = { ...(base.refs ?? {}) };
      for (const [k, v] of Object.entries(f.refs)) {
        if (!/^[a-z][a-z0-9_-]{0,31}$/.test(k))
          throw new RefError(`refs.${k}: names are lowercase (sys, key, linear)`);
        if (v === null) delete r[k];
        else r[k] = String(v);
      }
      next.refs = Object.keys(r).length ? r : undefined;
    }
    if (f.sources !== undefined)
      next.sources = f.sources.length ? f.sources.map(String) : undefined;
    if (f.links !== undefined) next.links = docLinks(f.links);
    if (f.references !== undefined) {
      const links: { title?: string; url: string }[] = [];
      const refs: Reference[] = [];
      for (const r of f.references) {
        const kinds = (["link", ...REFERENCE_KINDS] as const).filter(
          (k) => typeof r[k] === "string" && !!r[k]!.trim(),
        );
        if (kinds.length !== 1)
          throw new RefError(
            `references: each one is exactly one of link, image, doc, code, dependency, entity (got ${JSON.stringify(r)})`,
          );
        const k = kinds[0]!;
        const to = r[k]!.trim();
        const title = r.title?.trim() || undefined;
        if (k === "link") links.push({ url: to, ...(title ? { title } : {}) });
        else if (k === "entity") {
          const e = [...state.entities.values()].find(
            (x) => x.id === to || x.key === to || x.name === to,
          );
          if (!e)
            throw new RefError(
              `references: no entity "${to}" (an entity is made under entities: in its box's file, or by naming it in a signature, uses or carries)`,
            );
          refs.push({ kind: k, to: e.id, ...(title ? { title } : {}) });
        } else if (k === "dependency") {
          const lib = obj(to);
          if (lib.kind !== "library")
            throw new RefError(
              `references: ${lib.name} is a ${lib.kind}; a dependency is a library`,
            );
          refs.push({ kind: k, to: lib.id, ...(title ? { title } : {}) });
        } else refs.push({ kind: k, to, ...(title ? { title } : {}) });
      }
      next.links = docLinks(links);
      next.references = refs.length ? refs : undefined;
    }
    if (f.notes !== undefined) next.notes = f.notes.trim() || undefined;
    // A library starts with its package's links (registry, deps.dev, docs), like any links:
    // shown and edited with the rest.
    if (next.kind === "library" && next.package && !next.links?.length)
      next.links = docLinks(packageLinks(next.package));
    guard(base, next);
    return next;
  };
  // archnm.yaml's protected fields: an agent may set them on something new, never change them.
  const guard = (before: ModelObject, after: ModelObject) => {
    if (!rules.agent || !rules.protect?.length || !idx0.objects.has(before.id)) return;
    const was = idx0.objects.get(before.id)!;
    for (const p of rules.protect) {
      const get = (o: ModelObject): unknown =>
        p.startsWith("refs.")
          ? o.refs?.[p.slice(5)]
          : p === "in"
            ? o.parentId
            : (o as unknown as Record<string, unknown>)[p];
      if (JSON.stringify(get(was) ?? null) !== JSON.stringify(get(after) ?? null))
        throw new RefError(
          `${p} on ${label(was)} is protected (archnm.yaml protect): only a person changes it. Leave it as it is, and say in your summary what you think it should be.`,
        );
    }
  };
  // Views made earlier in this batch count too (a view, then a flow on it).
  const addedViews = new Map<string, Diagram>();
  const viewOf = (ref: string): Diagram => {
    const r = norm(ref);
    const hit = [...addedViews.values()].find(
      (d) => d.key === ref || d.id === ref || norm(d.name) === r,
    );
    return hit ?? findView(idx0, ref);
  };
  const addedBounds = new Map<string, Boundary>();
  const addedDecisions = new Map<string, Decision>();
  const mapSel = (s: Selector): Selector => {
    if ("ids" in s) return { ids: s.ids.map((r) => obj(r).id) };
    if ("children" in s) return { children: obj(s.children).id };
    if ("descendants" in s) return { descendants: obj(s.descendants).id };
    if ("neighbours" in s) return { neighbours: obj(s.neighbours).id };
    return s;
  };
  const nextX = new Map<string, number>();

  for (const { ch, i: at } of orderChanges(changes)) {
    const mark = [ops.length, summary.length] as const;
    try {
      if ("add" in ch) {
        const a = ch.add;
        if (!OBJECT_KINDS.includes(a.kind))
          throw new RefError(`kind must be one of ${OBJECT_KINDS.join(", ")}`);
        // Adding something that exists by that id is an update: re-running a task is safe.
        const existing = a.id ? (byKey0.get(a.id)?.[0] ?? idx0.objects.get(a.id)) : undefined;
        if (existing) {
          const next = { ...fields(a, latest.get(existing.id) ?? existing), updatedAt: t };
          latest.set(existing.id, next);
          ops.push({ op: "object.put", object: next });
          summary.push(`~ ${label(existing)} (already there; updated)`);
          checker.step(ops.slice(mark[0]));
          continue;
        }
        let key = a.id ?? slug(a.name);
        if (!a.id) for (let i = 2; usedKeys.has(key); i++) key = `${slug(a.name)}-${i}`;
        else if (usedKeys.has(key)) throw new RefError(`id "${key}" is taken`);
        usedKeys.add(key);
        const base: ModelObject = {
          id: key,
          key,
          kind: a.kind,
          name: a.name,
          description: "",
          technology: "",
          status: "live",
          parentId: null,
          external: false,
          tags: [],
          createdAt: t,
          updatedAt: t,
        };
        const o = fields(a, base);
        keepAdded(o);
        ops.push({ op: "object.put", object: o });
        const parent = o.parentId
          ? (added.get(o.parentId) ?? idx0.objects.get(o.parentId))
          : undefined;
        summary.push(`+ ${o.kind} ${key} "${o.name}"${parent ? ` in ${label(parent)}` : ""}`);
      } else if ("update" in ch) {
        const cur = obj(ch.update);
        const next = { ...fields(ch.set, cur), updatedAt: t };
        const diffs = (Object.keys(ch.set) as (keyof ObjectFields)[]).map(
          (k) => `${k}: ${JSON.stringify(ch.set[k])}`,
        );
        latest.set(cur.id, next);
        if (added.has(cur.id)) keepAdded(next);
        ops.push({ op: "object.put", object: next });
        summary.push(`~ ${label(cur)}: ${diffs.join(", ")}`);
      } else if ("remove" in ch) {
        const isView = [...idx0.diagrams.values()].some(
          (d) => d.key === ch.remove || d.name === ch.remove,
        );
        const isObject = [...idx0.objects.values()].some(
          (o) => o.key === ch.remove || o.id === ch.remove || o.name === ch.remove,
        );
        if (isView && !isObject)
          throw new RefError(
            `"${ch.remove}" is a view, not an object: delete it with { remove_view: "${ch.remove}" }`,
          );
        const cur = obj(ch.remove);
        const inside = descendants(idx0, cur.id).length;
        ops.push({ op: "object.delete", id: cur.id });
        summary.push(
          `- ${label(cur)}${inside ? ` and the ${inside} thing(s) inside it` : ""} (consider status: deprecated instead)`,
        );
      } else if ("connect" in ch) {
        const c = ch.connect;
        const from = obj(c.from);
        const to = obj(c.to);
        // Two keys between the same tables are two connections: a column tells them apart.
        const same = (conns0.get(`${from.id}>${to.id}`) ?? []).find(
          (x) =>
            x.fromId === from.id &&
            x.toId === to.id &&
            x.name === (c.label ?? x.name) &&
            (!c.column || x.column === c.column),
        );
        const conn: Connection = {
          id:
            same?.id ??
            `c_${slug(`${label(from)}-${label(to)}`)}_${Math.random().toString(16).slice(2, 8)}`,
          fromId: from.id,
          toId: to.id,
          name: c.label ?? same?.name ?? "",
          description: c.description ?? same?.description ?? "",
          ...((c.context ?? same?.context)?.trim()
            ? { context: (c.context ?? same?.context)!.trim() }
            : {}),
          technology: c.tech ?? same?.technology ?? "",
          status: c.status ?? same?.status ?? "live",
        };
        const via = c.via === undefined ? same?.viaId : c.via === null ? null : obj(c.via).id;
        if (via) conn.viaId = via;
        const sources = c.sources ?? same?.sources;
        if (sources?.length) conn.sources = sources;
        const guess = c.guess === undefined ? same?.guess : c.guess;
        if (guess) conn.guess = true;
        const column = c.column === undefined ? same?.column : c.column;
        if (column) conn.column = column;
        const toColumn = c.to_column === undefined ? same?.toColumn : c.to_column;
        if (toColumn) conn.toColumn = toColumn;
        ops.push({ op: "connection.put", connection: conn });
        summary.push(
          `${same ? "~" : "+"} ${label(from)} → ${label(to)}${conn.name ? ` "${conn.name}"` : ""}`,
        );
      } else if ("disconnect" in ch) {
        const from = obj(ch.disconnect.from);
        const to = obj(ch.disconnect.to);
        const hits = (conns0.get(`${from.id}>${to.id}`) ?? []).filter(
          (x) =>
            x.fromId === from.id &&
            x.toId === to.id &&
            (ch.disconnect.label === undefined || x.name === ch.disconnect.label),
        );
        if (!hits.length)
          throw new RefError(
            `no connection ${label(from)} → ${label(to)}${ch.disconnect.label ? ` "${ch.disconnect.label}"` : ""}`,
          );
        for (const h of hits) ops.push({ op: "connection.delete", id: h.id });
        summary.push(`- ${label(from)} → ${label(to)} (${hits.length})`);
      } else if ("view" in ch) {
        const v = ch.view;
        // By id, else by name: naming an existing view changes it, never makes a second one.
        const cur = v.id
          ? [...idx0.diagrams.values()].find((d) => d.key === v.id || d.id === v.id)
          : [...idx0.diagrams.values()].find((d) => d.name.toLowerCase() === v.name.toLowerCase());
        const scopeId =
          v.scope === undefined
            ? (cur?.scopeId ?? null)
            : v.scope === null
              ? null
              : obj(v.scope).id;
        const include =
          v.include?.map(mapSel) ??
          (scopeId && !cur
            ? [{ children: scopeId }, { neighbours: scopeId }]
            : (cur?.rules?.include ?? []));
        const exclude = v.exclude?.map(mapSel) ?? cur?.rules?.exclude ?? [];
        let key = v.id ?? slug(v.name);
        if (!cur) {
          const taken = new Set([...idx0.diagrams.values()].map((d) => d.key ?? d.id));
          for (let i = 2; taken.has(key); i++) key = `${v.id ?? slug(v.name)}-${i}`;
        }
        const base = cur ?? makeDiagram({ name: v.name, key });
        // A hand-picked view stays hand-picked unless rules are given (renaming it mustn't
        // turn it into an empty rules view).
        const handPicked = cur && !cur.rules && !v.include && !v.exclude && v.scope === undefined;
        const d: Diagram = {
          ...base,
          name: v.name,
          scopeId,
          rules: handPicked ? null : { include, exclude },
          updatedAt: t,
        };
        if (v.boundaries !== undefined) d.boundaries = v.boundaries;
        if (v.color_by !== undefined) {
          if (v.color_by && !rules.tags?.[v.color_by])
            throw new RefError(
              `color_by: "${v.color_by}" isn't a tag group in archnm.yaml (${Object.keys(rules.tags ?? {}).join(", ") || "none declared"})`,
            );
          d.colorBy = v.color_by || null;
        }
        if (v.story !== undefined) d.story = v.story.trim();
        if (v.context !== undefined) d.context = v.context.trim() || undefined;
        if (v.links !== undefined) d.links = docLinks(v.links);
        if (v.fold !== undefined) {
          if (v.fold !== null && !FOLD_MODES.includes(v.fold))
            throw new RefError(`fold is one of ${FOLD_MODES.join(", ")}`);
          d.fold = v.fold;
        }
        if (v.hide_lines !== undefined)
          d.hideLines = v.hide_lines?.length ? v.hide_lines.map(mapSel) : null;
        if (v.lanes !== undefined) {
          if (v.lanes && !rules.tags?.[v.lanes])
            throw new RefError(
              `lanes: "${v.lanes}" isn't a tag group in archnm.yaml (${Object.keys(rules.tags ?? {}).join(", ") || "none declared"})`,
            );
          d.lanes = v.lanes || null;
        }
        if (v.arrows !== undefined) d.arrows = v.arrows === "curved" ? undefined : v.arrows;
        addedViews.set(d.id, d);
        ops.push({ op: "diagram.put", diagram: d });
        if (v.reset_joints)
          for (const a of idx0.arrows.values())
            if (a.diagramId === d.id)
              ops.push({ op: "arrow.delete", diagramId: d.id, from: a.from, to: a.to });
        summary.push(
          `${cur ? "~" : "+"} view ${d.key} "${d.name}"${d.rules ? " (follows rules; boxes appear after the change)" : ""}`,
        );
      } else if ("move" in ch) {
        const to = ch.move.to === null ? null : obj(ch.move.to);
        for (const r of ch.move.objects) {
          const cur = obj(r);
          const next = { ...cur, parentId: to?.id ?? null, updatedAt: t };
          latest.set(cur.id, next);
          if (added.has(cur.id)) keepAdded(next);
          ops.push({ op: "object.put", object: next });
        }
        summary.push(
          `~ moved ${ch.move.objects.length} into ${to ? label(to) : "the top level"} (connections stay)`,
        );
      } else if ("boundary" in ch) {
        const b = ch.boundary;
        const cur = b.id
          ? findBoundary(idx0, b.id, addedBounds, true)
          : findBoundary(idx0, b.name, addedBounds, true);
        if (!cur && !b.kind)
          throw new RefError(`a new boundary needs a kind: one of ${BOUNDARY_KINDS.join(", ")}`);
        if (b.kind && !BOUNDARY_KINDS.includes(b.kind))
          throw new RefError(`a boundary's kind is one of ${BOUNDARY_KINDS.join(", ")}`);
        let key = cur?.key ?? b.id ?? slug(b.name);
        if (!cur) {
          const taken = new Set(
            [...idx0.boundaries.values(), ...addedBounds.values()].map((x) => x.key ?? x.id),
          );
          for (let i = 2; taken.has(key); i++) key = `${b.id ?? slug(b.name)}-${i}`;
        }
        const base = cur ?? makeBoundary({ id: key, key, name: b.name, kind: b.kind! });
        const parentId =
          b.in === undefined
            ? base.parentId
            : b.in === null
              ? null
              : findBoundary(idx0, b.in, addedBounds)!.id;
        const next: Boundary = {
          ...base,
          name: b.name,
          kind: b.kind ?? base.kind,
          description: b.description ?? base.description,
          parentId,
          rules: {
            include: b.include ? b.include.map(mapSel) : base.rules.include,
            exclude: b.exclude ? b.exclude.map(mapSel) : base.rules.exclude,
          },
          updatedAt: t,
        };
        addedBounds.set(next.id, next);
        ops.push({ op: "boundary.put", boundary: next });
        const parent = parentId
          ? (addedBounds.get(parentId) ?? idx0.boundaries.get(parentId))
          : undefined;
        summary.push(
          `${cur ? "~" : "+"} ${next.kind} boundary ${next.key} "${next.name}"${parent ? ` in ${parent.key ?? parent.id}` : ""}`,
        );
      } else if ("decision" in ch) {
        const dc = ch.decision;
        const all = [...state.decisions.values(), ...addedDecisions.values()];
        const cur = dc.id
          ? all.find((x) => x.id === dc.id)
          : all.find((x) => norm(x.title) === norm(dc.title));
        let id = cur?.id ?? dc.id;
        if (!id) id = nextDecisionId(all, dc.title);
        if (dc.status && !DECISION_STATUSES.includes(dc.status))
          throw new RefError(`a decision's status is one of ${DECISION_STATUSES.join(", ")}`);
        if (dc.date && !/^\d{4}-\d{2}-\d{2}$/.test(dc.date))
          throw new RefError("date is YYYY-MM-DD");
        const next: Decision = {
          id,
          title: dc.title,
          status: dc.status ?? cur?.status ?? "proposed",
          affects: dc.affects
            ? [...new Set(dc.affects.map((r) => obj(r).id))]
            : (cur?.affects ?? []),
          text: dc.text ?? cur?.text ?? "",
          createdAt: cur?.createdAt ?? t,
          updatedAt: t,
        };
        const date = dc.date ?? cur?.date;
        if (date) next.date = date;
        const sup = dc.superseded_by === undefined ? cur?.supersededBy : dc.superseded_by;
        if (sup) {
          if (!all.some((x) => x.id === sup))
            throw new RefError(`superseded_by: no decision "${sup}"`);
          next.supersededBy = sup;
        }
        addedDecisions.set(id, next);
        ops.push({ op: "decision.put", decision: next });
        summary.push(
          `${cur ? "~" : "+"} decision ${id} "${next.title}" (${next.status})${next.affects.length ? `, affects ${next.affects.length}` : ""}`,
        );
      } else if ("remove_decision" in ch) {
        const cur =
          state.decisions.get(ch.remove_decision) ?? addedDecisions.get(ch.remove_decision);
        if (!cur) throw new RefError(`no decision "${ch.remove_decision}"`);
        ops.push({ op: "decision.delete", id: cur.id });
        summary.push(`- decision ${cur.id} (consider status: superseded or rejected instead)`);
      } else if ("remove_view" in ch) {
        const cur = findView(idx0, ch.remove_view);
        ops.push({ op: "diagram.delete", id: cur.id });
        summary.push(
          `- view ${cur.key ?? cur.id} "${cur.name}" (the model is unchanged; only the diagram goes)`,
        );
      } else if ("remove_boundary" in ch) {
        const cur = findBoundary(idx0, ch.remove_boundary, addedBounds)!;
        ops.push({ op: "boundary.delete", id: cur.id });
        summary.push(`- boundary ${cur.key ?? cur.id} (what was inside it moves up a level)`);
      } else if ("show" in ch || "hide" in ch) {
        const spec = "show" in ch ? ch.show : ch.hide;
        const d = viewOf(spec.view);
        for (const r of spec.objects) {
          const o = obj(r);
          if ("show" in ch) {
            if (state.placements.has(pkey(d.id, o.id))) continue;
            // A rough spot; the agent never picks coordinates. Rules views place it themselves.
            // Right of everything already there, and of what this batch placed before it.
            if (!nextX.has(d.id)) {
              const placed = [...(idx0.placements.get(d.id)?.values() ?? [])];
              nextX.set(d.id, placed.length ? Math.max(...placed.map((p) => p.x + p.w)) + 120 : 0);
            }
            const x = nextX.get(d.id)!;
            nextX.set(d.id, x + 184 + 72);
            ops.push({
              op: "placement.put",
              placement: { diagramId: d.id, objectId: o.id, x, y: 0, w: 184, h: 72 },
            });
          } else {
            ops.push({ op: "placement.delete", diagramId: d.id, objectId: o.id });
          }
        }
        // A view that follows rules keeps the change in its rules (an ids include, or an
        // exclude), the way the app does, or the rules would put a hidden box straight back.
        if (d.rules) {
          const ids = spec.objects.map((r) => obj(r).id);
          const prior =
            [...ops]
              .reverse()
              .find(
                (x): x is Extract<Op, { op: "diagram.put" }> =>
                  x.op === "diagram.put" && x.diagram.id === d.id,
              )?.diagram ?? d;
          const pinned = pinEdits(idx0, prior, "show" in ch ? ids : [], "show" in ch ? [] : ids);
          if (pinned) ops.push({ op: "diagram.put", diagram: { ...pinned, updatedAt: t } });
        }
        summary.push(
          `${"show" in ch ? "+" : "-"} on ${d.key ?? d.name}: ${spec.objects.join(", ")}`,
        );
      } else if ("flow" in ch) {
        const d = viewOf(ch.flow.view);
        const cur = [...idx0.flows.values()].find(
          (f) => f.diagramId === d.id && norm(f.name) === norm(ch.flow.name),
        );
        const steps = ch.flow.steps.map((s) =>
          makeStep({ fromId: obj(s.from).id, toId: obj(s.to).id, text: s.text ?? "" }),
        );
        const kind = ch.flow.kind ?? cur?.kind;
        const base: Flow = cur
          ? { ...cur, steps, updatedAt: t }
          : makeFlow({ diagramId: d.id, name: ch.flow.name, steps });
        const flow: Flow =
          kind && kind !== "story" ? { ...base, kind } : (({ kind: _k, ...rest }) => rest)(base);
        ops.push({ op: "flow.put", flow });
        summary.push(
          `${cur ? "~" : "+"} flow "${ch.flow.name}" on ${d.key ?? d.name}: ${steps.length} step(s)`,
        );
      }
      // Each change on its own, on top of the changes before it, so an error names the change.
      checker.step(ops.slice(mark[0]));
    } catch (e) {
      if (!(e instanceof RefError || e instanceof ModelError)) throw e;
      ops.length = mark[0];
      summary.length = mark[1];
      errors.push(`change ${at + 1} (${changeLabel(ch)}): ${e.message}`);
    }
  }
  errors.sort(
    (a, b) => Number(/^change (\d+)/.exec(a)?.[1]) - Number(/^change (\d+)/.exec(b)?.[1]),
  );
  if (errors.length && opts.onError !== "skip")
    throw new RefError(
      `${errors.length} of ${changes.length} change(s) can't be made, so nothing was applied:\n${errors.join("\n")}\nFix those and send the batch again, or pass on_error: "skip" to apply the rest. (Order doesn't matter: adds go first, removals last.)`,
    );
  // New functions join the frames their files are drawn as (unless this batch placed them).
  const placedHere = new Set(
    ops.flatMap((x) =>
      x.op === "placement.put" ? [`${x.placement.diagramId}|${x.placement.objectId}`] : [],
    ),
  );
  ops.push(...frameOps(idx0, [...added.values()], placedHere));
  return { ops, summary, ...(errors.length ? { skipped: errors } : {}) };
}

/** Links as given: http(s) only, one per address, a title read from the address if none. */
function docLinks(list: { title?: string; url: string }[]): DocLink[] | undefined {
  const out: DocLink[] = [];
  for (const l of list) {
    const url = safeUrl(l?.url);
    if (!url) throw new RefError(`links: "${l?.url}" isn't an http or https address`);
    if (out.some((x) => x.url === url)) continue;
    out.push({ title: (l.title?.trim() || titleFromUrl(url)).slice(0, 200), url });
  }
  return out.length ? out : undefined;
}

/** A column as given, with only the fields it has (no empty strings, no false flags). */
function cleanColumn(c: Column): Column {
  return {
    name: c.name.trim(),
    type: (c.type ?? "").trim(),
    ...(c.pk ? { pk: true } : {}),
    ...(c.unique ? { unique: true } : {}),
    ...(c.nullable ? { nullable: true } : {}),
    ...(c.personal ? { personal: true } : {}),
    ...(c.description?.trim() ? { description: c.description.trim() } : {}),
  };
}
