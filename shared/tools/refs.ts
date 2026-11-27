// Refs: how every line names a thing, and how a ref is read back. A box is its id (or
// repo:path#fn for code), an entity its type name, a connection from>to (:label when two
// share ends), a view its key. Every one of these works in any tool.
import { findObject, findView } from "../agent.ts";
import { codeRef, resolveRef } from "../context.ts";
import { entitySummary, signatureTypes } from "../entities.ts";
import {
  mergedContext,
  type Connection,
  type Decision,
  type Diagram,
  type Entity,
  type ModelObject,
  type Note,
} from "../model.ts";
import type { ModelIndex } from "../project.ts";
import { ToolError, clip, purpose } from "./host.ts";

export const idOf = (o: { id: string; key?: string }) => o.key ?? o.id;
export const viewId = (d: Diagram) => d.key ?? d.id;

/** The ref a line shows for an object: repo:path#fn for code, else its id. */
export const refOf = (idx: ModelIndex, id: string) => codeRef(idx, id);

export function entityByName(idx: ModelIndex, name: string): Entity | undefined {
  const all = [...idx.entities.values()];
  return (
    all.find((e) => e.name === name) ??
    all.find((e) => e.name.toLowerCase() === name.trim().toLowerCase()) ??
    idx.entities.get(name)
  );
}

/** Entity names a box points at: its uses, and what its signature names that is an entity. */
export function usesOf(idx: ModelIndex, o: ModelObject): string[] {
  const named = (o.references ?? []).flatMap((r) =>
    r.kind === "entity" ? [idx.entities.get(r.to)?.name ?? r.to] : [],
  );
  const sig = signatureTypes(o.signature).filter((t) => entityByName(idx, t));
  return [...new Set([...named, ...sig])];
}

/** What a connection carries, by entity name. */
export function carriesOf(idx: ModelIndex, c: Connection): string[] {
  return [
    ...new Set(
      (c.references ?? []).flatMap((r) =>
        r.kind === "entity" ? [idx.entities.get(r.to)?.name ?? r.to] : [],
      ),
    ),
  ];
}

/** "a>b", with ":label" when another connection shares its ends. */
export function connRef(idx: ModelIndex, c: Connection): string {
  const a = idOf(idx.objects.get(c.fromId) ?? { id: c.fromId });
  const b = idOf(idx.objects.get(c.toId) ?? { id: c.toId });
  const twin = [...idx.connections.values()].some(
    (x) => x !== c && x.fromId === c.fromId && x.toId === c.toId,
  );
  return `${a}>${b}${twin && c.name ? `:${c.name}` : ""}`;
}

/** One line for a box: `id  Name · kind · tech · status · external — purpose`, ref first. */
export function boxLine(
  idx: ModelIndex,
  o: ModelObject,
  o2: { purpose?: boolean; parent?: boolean; cutNote?: boolean } = {},
): string {
  const meta = [
    o.kind,
    o.technology,
    o.status !== "live" ? o.status : "",
    o.external ? "external" : "",
    o.guess ? "guess" : "",
  ]
    .filter(Boolean)
    .join(" · ");
  // Code shows its ref (repo:path#fn) and its id: either works in every tool.
  const ref = refOf(idx, o.id) === idOf(o) ? idOf(o) : `${refOf(idx, o.id)} [id ${idOf(o)}]`;
  const name = o.name && o.name !== refOf(idx, o.id) && o.name !== idOf(o) ? `  ${o.name}` : "";
  const parent =
    o2.parent && o.parentId ? ` in ${idOf(idx.objects.get(o.parentId) ?? { id: o.parentId })}` : "";
  const sig = o.signature ? ` ${o.signature}` : "";
  const all = mergedContext(o.description, o.context);
  const why = o2.purpose !== false ? purpose(all, 90) : "";
  // Said when it's cut, so nobody writes a context back from a search line.
  const cut =
    o2.cutNote && why && why.replace(/…$/, "").trim() !== all.replace(/\s+/g, " ").trim()
      ? " (cut; read {ref} for all)"
      : "";
  return `${ref}${name} (${meta})${sig}${parent}${why ? ` — ${why}${cut}` : ""}`;
}

/** An edge from where we stand: `→ id  label (tech) carries X`, or `← id …` for callers. */
export function edgeLine(idx: ModelIndex, c: Connection, dir: "out" | "in", from?: string): string {
  const other = idx.objects.get(dir === "out" ? c.toId : c.fromId);
  const near = dir === "out" ? c.fromId : c.toId;
  const by = from && near !== from ? ` (from ${refOf(idx, near)})` : "";
  const carries = carriesOf(idx, c);
  const bits = [
    c.technology ? `(${c.technology})` : "",
    c.status !== "live" ? `[${c.status}]` : "",
    c.guess ? "[guess]" : "",
    carries.length ? `carries ${carries.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `${dir === "out" ? "→" : "←"} ${other ? refOf(idx, other.id) : "?"}${c.name ? `  ${c.name}` : ""}${bits ? ` ${bits}` : ""}${by}`;
}

export function entityLine(idx: ModelIndex, e: Entity): string {
  const home = e.sourceId ? idx.objects.get(e.sourceId) : undefined;
  return `${e.name} (entity · ${entitySummary(e)})${home ? ` in ${idOf(home)}` : ""}${e.description ? ` — ${purpose(e.description, 80)}` : ""}`;
}

export function noteLine(idx: ModelIndex, n: Note): string {
  const about = n.about ?? n.objectId;
  const conn = n.connectionId ? idx.connections.get(n.connectionId) : undefined;
  const what = n.kind === "link" ? "link" : n.forAgent ? "flag" : "note";
  const replies = idx.replies.get(n.id)?.length ?? 0;
  const on = conn
    ? ` on ${connRef(idx, conn)}`
    : about
      ? ` on ${refOf(idx, about)}`
      : ` ${looseSpot(idx, n)}`;
  return `${n.id} ${what}${n.resolved ? " (resolved)" : ""}${on} ${n.author.name}: ${clip(n.kind === "link" ? `${n.text} ${n.url ?? ""}` : n.text, 120)}${replies ? ` (${replies} repl${replies === 1 ? "y" : "ies"})` : ""}`;
}

/**
 * Where a note that's pinned to nothing sits: the view, and the box it was dropped over or
 * next to there. It's a hint from where it was put, not something the person said, so it
 * reads as one ("over", "near"), unlike "on" for a pinned note.
 */
function looseSpot(idx: ModelIndex, n: Note): string {
  const view = idx.diagrams.get(n.diagramId);
  const where = view ? `on ${viewId(view)}` : "on a view that's gone";
  let over: { id: string; area: number } | null = null;
  let near: { id: string; d: number } | null = null;
  for (const [id, p] of idx.placements.get(n.diagramId) ?? []) {
    const dx = Math.max(p.x - n.x, 0, n.x - (p.x + p.w));
    const dy = Math.max(p.y - n.y, 0, n.y - (p.y + p.h));
    const d = Math.hypot(dx, dy);
    // Inside several (a frame and a box in it): the smallest is the one meant.
    if (d === 0 && (!over || p.w * p.h < over.area)) over = { id, area: p.w * p.h };
    else if (d > 0 && d <= 160 && (!near || d < near.d)) near = { id, d };
  }
  const box = over ?? near;
  if (!box) return `loose ${where}`;
  return `loose ${where}, ${over ? "over" : "near"} ${refOf(idx, box.id)}`;
}

export type Resolved =
  | { kind: "object"; o: ModelObject }
  | { kind: "entity"; e: Entity }
  | { kind: "connection"; c: Connection }
  | { kind: "view"; d: Diagram }
  | { kind: "note"; n: Note }
  | { kind: "decision"; dec: Decision };

/** A ref of any kind, read back; a ToolError that says what's near when there's nothing. */
export function resolve(idx: ModelIndex, raw: string): Resolved {
  const ref = raw.trim();
  if (!ref) throw new ToolError("an empty ref");
  // A link from the app: a note, a box, or a view.
  const link = /#\/[^/]+(?:\/d\/([^/?#]+))?(?:\/o\/([^/?#]+))?(?:\/n\/([^/?#]+))?/.exec(ref);
  if (link && ref.includes("#/")) {
    if (link[3]) return note(idx, link[3]);
    if (link[2]) return { kind: "object", o: findObject(idx, link[2]) };
    if (link[1]) return { kind: "view", d: findView(idx, link[1]) };
  }
  if (idx.notes.has(ref)) return note(idx, ref);
  // A decision by decision:<id> or its id (planners couldn't read the one they shared).
  const dk = /^decision:(.+)$/.exec(ref)?.[1]?.trim() ?? (idx.decisions.has(ref) ? ref : undefined);
  if (dk !== undefined) {
    const dec =
      idx.decisions.get(dk) ??
      [...idx.decisions.values()].find(
        (x) => x.id.startsWith(dk) || x.title.toLowerCase() === dk.toLowerCase(),
      );
    if (!dec)
      throw new ToolError(
        `no decision ${dk}; decisions: ${[...idx.decisions.keys()].slice(0, 12).join(", ") || "none yet"}`,
      );
    return { kind: "decision", dec };
  }
  const vk = /^view:(.+)$/.exec(ref);
  if (vk) return { kind: "view", d: findView(idx, vk[1]!.trim()) };
  // a>b or a>b:label
  const arrow = /^([^>\s]+)\s*>\s*([^:>\s]+)(?::(.+))?$/.exec(ref);
  if (arrow && !ref.includes("#"))
    return { kind: "connection", c: connection(idx, arrow[1]!, arrow[2]!, arrow[3]) };
  if (ref.includes(">") && !ref.includes("#"))
    throw new ToolError(
      `${ref} isn't a connection ref: it's from>to with both ends' ids (checkout>payments), and :label when two share the ends (checkout>payments:charges cards)`,
    );
  const code = ref.includes(":") ? resolveRef(idx, ref) : null;
  if (code) return { kind: "object", o: code };
  if (idx.objects.has(ref) || [...idx.objects.values()].some((o) => o.key === ref))
    return { kind: "object", o: findObject(idx, ref) };
  const e = [...idx.entities.values()].find((x) => x.name === ref);
  if (e) return { kind: "entity", e };
  const d = [...idx.diagrams.values()].find((x) => x.key === ref || x.id === ref);
  if (d) return { kind: "view", d };
  // A file's path without its repo (server/live.ts, server/live.ts#Live.start), when one repo has it.
  if (!/^[\w.@-]+:/.test(ref) && /[/.]/.test(ref.split("#")[0]!)) {
    const [p] = ref.split("#") as [string];
    const repos = [
      ...new Set(
        [...idx.objects.values()]
          .filter((o) => o.kind === "module" && o.path?.endsWith(`:${p.replace(/\/+$/, "")}`))
          .map((o) => o.path!.split(":")[0]!),
      ),
    ];
    if (repos.length === 1) {
      const got = resolveRef(idx, `${repos[0]}:${ref}`);
      if (got) return { kind: "object", o: got };
    }
  }
  // An id without the few letters made to keep it unique (shared-files-ts for shared-files-ts-2vc0l).
  {
    const stem = [...idx.objects.values()].filter(
      (o) =>
        o.status !== "removed" &&
        [o.id, o.key].some(
          (k) => k && k.startsWith(`${ref}-`) && /^[a-z0-9]{4,6}$/.test(k.slice(ref.length + 1)),
        ),
    );
    if (stem.length === 1) return { kind: "object", o: stem[0]! };
  }
  try {
    return { kind: "object", o: findObject(idx, ref) };
  } catch (err) {
    const e2 = entityByName(idx, ref);
    if (e2) return { kind: "entity", e: e2 };
    const d2 = [...idx.diagrams.values()].find((x) => x.name.toLowerCase() === ref.toLowerCase());
    if (d2) return { kind: "view", d: d2 };
    throw new ToolError(
      `${(err as Error).message}. A ref is a box id, an entity's type name, a connection a>b, view:<key>, repo:path#fn or a link; find one with read {q: "${ref}"}`,
    );
  }
}

/**
 * When a bare ref names two things (a box and a view both called "returns"): which one it was
 * read as (a box or an entity wins over a view), and how to name the view. Null when it's plain.
 */
export function ambiguity(idx: ModelIndex, raw: string, r: Resolved): string | null {
  const ref = raw.trim();
  if (/^view:|#|>/.test(ref)) return null;
  const view = [...idx.diagrams.values()].find((x) => x.key === ref);
  if (view && (r.kind === "object" || r.kind === "entity"))
    return `"${ref}" is both ${r.kind === "object" ? "a box" : "an entity"} and a view: this is the ${r.kind === "object" ? "box" : "entity"}; for the view, view:${ref}.`;
  return null;
}

function note(idx: ModelIndex, id: string): Resolved {
  const n = idx.notes.get(id);
  if (!n) throw new ToolError(`no note ${id}: it was deleted, or it's on another fork`);
  return { kind: "note", n };
}

function connection(idx: ModelIndex, a: string, b: string, label?: string): Connection {
  const from = findObject(idx, a);
  const to = findObject(idx, b);
  const all = [...idx.connections.values()].filter((c) => c.fromId === from.id && c.toId === to.id);
  const hit = label
    ? (all.find((c) => c.name === label) ??
      all.find((c) => c.name.toLowerCase() === label.toLowerCase()))
    : all.length === 1
      ? all[0]
      : undefined;
  if (hit) return hit;
  if (!all.length) {
    const back = [...idx.connections.values()].some(
      (c) => c.fromId === to.id && c.toId === from.id,
    );
    throw new ToolError(
      `no connection ${idOf(from)}>${idOf(to)}${back ? ` (there is one ${idOf(to)}>${idOf(from)})` : ""}`,
    );
  }
  const refs = all.map((c) => `${idOf(from)}>${idOf(to)}${c.name ? `:${c.name}` : ""}`).join(", ");
  if (label)
    throw new ToolError(
      `no connection ${idOf(from)}>${idOf(to)}:${label}; ${all.length === 1 ? "there is" : "there are"} ${refs}`,
    );
  throw new ToolError(
    `${all.length} connections ${idOf(from)}>${idOf(to)}: name one by label (${refs})`,
  );
}

/** The object a ref names (boxes only), as a ToolError when it isn't one. */
export function object(idx: ModelIndex, ref: string): ModelObject {
  const r = resolve(idx, ref);
  if (r.kind !== "object")
    throw new ToolError(
      `${ref} is ${r.kind === "entity" ? "an entity" : `a ${r.kind}`}; this wants a box`,
    );
  return r.o;
}

/** The view to show a box on: the one about its parent first, then any it's on, then its nearest drawn ancestor's. */
export function viewFor(
  idx: ModelIndex,
  objectId: string,
): { d: Diagram; objectId: string } | null {
  for (let cur: string | null | undefined = objectId; cur; cur = idx.objects.get(cur)?.parentId) {
    const o = idx.objects.get(cur);
    const ids = [...(idx.placedOn.get(cur) ?? [])];
    const best = ids
      .map((id) => idx.diagrams.get(id)!)
      .filter(Boolean)
      .sort((a, b) => Number(a.scopeId !== o?.parentId) - Number(b.scopeId !== o?.parentId))[0];
    if (best) return { d: best, objectId: cur };
  }
  return null;
}

/** A history entry's actor is `by`: its session's short id (s-1a2b), its worker name (as), or its whole name. */
export function matchesBy(actor: { name: string; session?: string }, by: string): boolean {
  const b = by.trim().toLowerCase();
  if (!b) return true;
  const name = actor.name.toLowerCase();
  const sid = actor.session?.toLowerCase();
  // A whole session id (a uuid) matches its short id.
  const shortOf = (x: string) =>
    /^[0-9a-f]{8}-/.test(x) ? `s-${x.replace(/-/g, "").slice(0, 4)}` : x;
  return sid === b || sid === shortOf(b) || name === b || name.endsWith(` · ${b}`);
}
