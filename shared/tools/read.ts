// read: one tool for looking, by what's asked (docs/mcp-v2.md). Search first; one thing in
// full; a bounded walk; impact and routes computed here, not walked by the model; a scope's
// slice under a budget; views, lenses, history, files, and what the person is looking at.
// Every answer is capped and says what's left and the call that gets it.
import YAML from "yaml";
import { explain, findView, outlineBoundaries, outlineView, path as route } from "../agent.ts";
import { codeRef, contextText, resolveRef, runsIn } from "../context.ts";
import { entitySummary } from "../entities.ts";
import { editDistance, writeFiles } from "../files.ts";
import { impact } from "../impact.ts";
import {
  mergedContext,
  type Connection,
  type Diagram,
  type Entity,
  type ModelObject,
  type Note,
  type ObjectKind,
} from "../model.ts";
import { referenceLines } from "../references.ts";
import { descendants, flowsOf, type ModelIndex } from "../project.ts";
import { lens, type Lens } from "./lens.ts";
import type { ForkFocus } from "./diff.ts";
import { scoreView } from "../score.ts";
import { ToolError, clip, more, ok, plural, type Host, type Out } from "./host.ts";
import {
  ambiguity,
  boxLine,
  carriesOf,
  connRef,
  edgeLine,
  entityLine,
  idOf,
  matchesBy,
  noteLine,
  object,
  refOf,
  resolve,
  usesOf,
  viewId,
  type Resolved,
} from "./refs.ts";
import { scopeSlice } from "./slice.ts";

export const FOLLOW = ["calls", "callers", "carries", "in", "uses"] as const;
type Follow = (typeof FOLLOW)[number];

export interface ReadArgs {
  /** With ref or scope: the calls only guessed by name too (left out by default). */
  guesses?: boolean;
  q?: string;
  kind?: ObjectKind;
  in?: string;
  ref?: string;
  depth?: number;
  follow?: Follow[];
  impact?: "upstream" | "downstream";
  /** A route's start (with to); with file, the line to start at. */
  from?: string | number;
  to?: string;
  scope?: string;
  budget?: number;
  view?: string;
  lens?: Lens;
  history?: boolean;
  /** With history or diff: one session (short id) or worker name. */
  by?: string;
  file?: string;
  here?: boolean;
  limit?: number;
  detail?: "brief" | "full";
  /** With lens on a fork: the whole design, not only what the fork changed. */
  all?: boolean;
  /** What the fork changed (filled in by the tool, for lenses). */
  focus?: ForkFocus | null;
}

export function read(host: Host, a: ReadArgs): Out {
  const idx = host.index();
  const limit = Math.max(1, Math.min(a.limit ?? 20, 500));
  const full = a.detail === "full";
  if (a.here) return here(host, idx);
  if (a.history) return history(host, idx, a.ref, limit, a.by);
  if (a.file !== undefined)
    return file(host, a.file, limit, a.from === undefined ? 1 : Number(a.from));
  // in (or ref) narrows every lens to that box and what's inside it; view to that view; on a
  // fork, problems/review/drift to what the fork changed (unless all).
  if (a.lens)
    return lens(host, idx, a.lens, {
      limit,
      ref: a.ref ?? a.in,
      view: a.view,
      focus: a.all ? null : a.focus,
    });
  if (a.from || a.to) {
    if (!a.from || !a.to) throw new ToolError("routes need both from and to");
    const from = object(idx, String(a.from));
    const to = object(idx, a.to);
    return ok(
      `${refOf(idx, from.id)} to ${refOf(idx, to.id)}:\n${elide(route(idx, from, to), limit, "hops")}`,
    );
  }
  if (a.scope)
    return ok(
      scopeSlice(idx, object(idx, a.scope), {
        budget: a.budget ?? 4000,
        design: host.key,
        guesses: a.guesses,
      }),
    );
  // Every view, a line each (view:* was read as a view's name).
  const all = a.view === "*" || /^view:\s*\*$/.test(a.ref?.trim() ?? "");
  if (all) {
    const ds = [...idx.diagrams.values()].sort((x, y) => viewId(x).localeCompare(viewId(y)));
    // Boxes and lines as drawn: a view with boxes and no lines stands out.
    const line = (d: (typeof ds)[number]) => {
      const sc = scoreView(idx, d.id);
      return `view:${viewId(d)}  ${d.name}${d.scopeId ? ` (inside ${refOf(idx, d.scopeId)})` : ""} · ${plural(sc.boxes, "box", "boxes")}, ${plural(sc.lines, "line")}${sc.boxes >= 3 && !sc.lines ? " (no lines!)" : ""}`;
    };
    return ok(`${plural(ds.length, "view")}:\n${ds.map(line).join("\n")}`);
  }
  if (a.view !== undefined) return view(host, idx, a.view, limit);
  if (a.ref && a.impact) return impactOf(idx, object(idx, a.ref), a.impact, limit);
  if (a.ref && (a.depth || a.follow?.length))
    return walk(idx, a.ref, {
      depth: a.depth ?? 2,
      follow: a.follow?.length ? a.follow : ["calls"],
      limit: a.limit ?? 40,
    });
  if (a.ref) return one(host, idx, a.ref, { limit, full, guesses: a.guesses });
  if (a.q !== undefined || a.kind || a.in)
    return search(idx, a.q ?? "", {
      kind: a.kind,
      in: a.in,
      limit,
      ...(a.in && a.depth ? { depth: a.depth } : {}),
    });
  return overview(host, idx, limit);
}

// --- search ------------------------------------------------------------------------------------

const words = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

interface Hit {
  ref: string;
  line: string;
  score: number;
  /** A box: what it's in, and its line said under that (search answers group by it). */
  parent?: string;
  short?: string;
}

/** Ranked over ids, names, tech, tags, paths, context, entities and views; fuzzy on words. */
function search(
  idx: ModelIndex,
  q: string,
  o: { kind?: ObjectKind; in?: string; limit: number; depth?: number },
): Out {
  // "*" (or "all") means everything: with kind, every box of that kind.
  const query = /^\s*(\*|all|everything)\s*$/i.test(q) ? "" : q.trim().toLowerCase();
  const qw = words(query);
  // depth: 1 is what's directly inside, 2 one level more (it gave all 19,800 below).
  const under = (id: string, depth: number): string[] =>
    depth <= 0
      ? []
      : (idx.children.get(id) ?? []).flatMap((c) => [c.id, ...under(c.id, depth - 1)]);
  const within = o.in
    ? new Set([
        object(idx, o.in).id,
        ...(o.depth
          ? under(object(idx, o.in).id, o.depth)
          : descendants(idx, object(idx, o.in).id)),
      ])
    : null;
  /** How well one query (a phrase, or one of its terms) matches these fields. */
  const scoreFor = (
    fields: { text: string; weight: number }[],
    query: string,
    qw: string[],
  ): number => {
    if (!query) return 1;
    let s = 0;
    for (const f of fields) {
      const t = f.text.toLowerCase();
      if (!t) continue;
      if (t === query) s = Math.max(s, 100 * f.weight);
      else if (t.startsWith(query)) s = Math.max(s, 70 * f.weight);
      else if (t.includes(query)) s = Math.max(s, 50 * f.weight);
      // Every word of the query somewhere, or within a typo of one.
      const tw = words(t);
      const each = qw.map((w) =>
        tw.some((x) => x === w)
          ? 1
          : tw.some((x) => x.startsWith(w))
            ? 0.8
            : w.length > 3 &&
                tw.some(
                  (x) =>
                    Math.abs(x.length - w.length) <= 2 &&
                    editDistance(x, w) <= (w.length > 5 ? 2 : 1),
                )
              ? 0.5
              : 0,
      );
      if (qw.length && each.every((x) => x > 0))
        s = Math.max(
          s,
          30 * f.weight * (each.reduce((x: number, y: number) => x + y, 0) / qw.length),
        );
    }
    return s;
  };
  // Several terms ("personal.ts PersonalTokens main.ts"): a thing matching any of them counts,
  // ranked by how many and how well, under one that matches the whole phrase.
  const terms = [...new Set(query.split(/[\s,]+/).filter(Boolean))];
  const score = (fields: { text: string; weight: number }[]): number => {
    const whole = scoreFor(fields, query, qw);
    if (terms.length < 2) return whole;
    const any = terms.reduce((n, t) => n + scoreFor(fields, t, words(t)), 0) * 0.6;
    return Math.max(whole, any);
  };
  // A ref in the query (repo:path, repo:path#fn) is that box, first.
  const exact = new Set(
    terms
      .filter((t) => t.includes(":"))
      .flatMap((t) => {
        const o2 = resolveRef(idx, t);
        return o2 ? [o2.id] : [];
      }),
  );
  const hits: Hit[] = [];
  for (const ob of idx.objects.values()) {
    if (o.kind && ob.kind !== o.kind) continue;
    if (within && !within.has(ob.id)) continue;
    const s = score([
      { text: idOf(ob), weight: 1.2 },
      { text: ob.name, weight: 1.1 },
      { text: ob.path ?? "", weight: 1 },
      { text: codeRef(idx, ob.id), weight: 1 },
      { text: ob.technology, weight: 0.8 },
      { text: ob.tags.join(" "), weight: 0.8 },
      { text: ob.signature ?? "", weight: 0.6 },
      { text: ob.context ?? "", weight: 0.4 },
      { text: ob.description, weight: 0.4 },
    ]);
    // A term that's a file name (main.ts, lib.rs) means that file above what's in it.
    const fileHit =
      ob.kind === "module" && ob.path
        ? terms.some(
            (t) =>
              /\.[a-z0-9]{1,6}$/i.test(t) &&
              (ob.path!.endsWith(`/${t}`) || ob.path!.endsWith(`:${t}`)),
          )
        : false;
    const s2 = exact.has(ob.id) ? Math.max(s, 1000) : fileHit ? s + 100 : s;
    if (s2 > 0)
      hits.push({
        ref: refOf(idx, ob.id),
        line: boxLine(idx, ob, { parent: true, cutNote: true }),
        parent: ob.parentId ?? undefined,
        short: shortLine(idx, ob),
        score:
          s2 +
          (ob.status === "removed" ? -20 : 0) +
          (ob.kind === "function" || ob.kind === "module" ? -1 : 0) +
          (ob.tags?.includes("generated") && !exact.has(ob.id) && !fileHit ? -10 : 0),
      });
  }
  if (!o.kind)
    for (const e of idx.entities.values()) {
      if (within && !(e.sourceId && within.has(e.sourceId))) continue;
      const s = score([
        { text: e.name, weight: 1.1 },
        { text: e.fields.join(" "), weight: 0.5 },
        { text: (e.values ?? []).join(" "), weight: 0.5 },
        { text: e.description, weight: 0.4 },
      ]);
      if (s > 0) hits.push({ ref: e.name, line: entityLine(idx, e), score: s });
    }
  if (!o.kind && !within && query)
    for (const d of idx.diagrams.values()) {
      const s = score([
        { text: viewId(d), weight: 1 },
        { text: d.name, weight: 1 },
      ]);
      if (s > 0)
        hits.push({
          ref: `view:${viewId(d)}`,
          line: `view:${viewId(d)}  ${d.name} (view · ${plural(idx.placements.get(d.id)?.size ?? 0, "box", "boxes")})`,
          score: s - 5,
        });
    }
  // Decisions too, by title and text (search didn't find the one they shared).
  if (!o.kind && query)
    for (const d of idx.decisions.values()) {
      if (within && !d.affects.some((id) => within.has(id))) continue;
      const s = score([
        { text: d.id, weight: 1 },
        { text: d.title, weight: 1.1 },
        { text: d.text, weight: 0.4 },
      ]);
      if (s > 0)
        hits.push({
          ref: `decision:${d.id}`,
          line: `decision:${d.id}  ${d.title} (decision · ${d.status})`,
          score: s,
        });
    }
  hits.sort((x, y) => y.score - x.score || x.ref.localeCompare(y.ref));
  if (!hits.length) {
    // Say what was searched, and the nearest names, so "nothing" reads as an answer, not a search that didn't run.
    const pool = [...idx.objects.values()].filter(
      (x) =>
        x.status !== "removed" && (!o.kind || x.kind === o.kind) && (!within || within.has(x.id)),
    );
    const words = query.split(/\s+/).filter(Boolean);
    const near = pool
      .map((x) => ({
        ref: idOf(x),
        d: Math.min(
          ...words.map((w) => Math.min(editDistance(w, idOf(x)), editDistance(w, x.name))),
        ),
      }))
      .sort((a, b) => a.d - b.d || a.ref.localeCompare(b.ref))
      .slice(0, 5)
      .map((x) => x.ref);
    const searched = `searched ${plural(pool.length, "box", "boxes")}${o.kind ? "" : `, ${plural(idx.entities.size, "entity", "entities")} and ${plural(idx.diagrams.size, "view")}`}`;
    return ok(
      `nothing matches "${q}"${o.kind ? ` among ${o.kind}s` : ""}${o.in ? ` in ${o.in}` : ""} (${searched}).${near.length ? ` Nearest names: ${near.join(", ")}.` : ""} Try fewer words, or read {} for the top level.`,
      { hits: [] },
    );
  }
  const shown = hits.slice(0, o.limit);
  const tail = more(
    hits.length,
    shown.length,
    `read {q: "${q}", limit: ${Math.min(hits.length, o.limit * 3)}}, or narrow it with kind or in`,
  );
  return ok(
    [...grouped(idx, shown), tail, "", `next: read {ref: "${shown[0]!.ref}"} for one in full`]
      .filter((l, i, a) => l || (i > 0 && a[i - 1]))
      .join("\n"),
    { hits: shown.map((h) => h.ref), total: hits.length },
  );
}

/** A box's line under its parent's heading: its ref after the parent's ("#start" in a file), no id,
 * no parent; the kind only where the signature doesn't say it. */
function shortLine(idx: ModelIndex, o: ModelObject): string | undefined {
  const parent = o.parentId ? refOf(idx, o.parentId) : undefined;
  const ref = refOf(idx, o.id);
  if (!parent || !ref.startsWith(`${parent}#`)) return undefined;
  const full = boxLine(idx, o);
  const why = full.includes(" — ") ? full.slice(full.indexOf(" — ")) : "";
  const kind =
    o.kind === "function" && o.signature
      ? ""
      : ` (${[o.kind, o.status !== "live" ? o.status : "", o.guess ? "guess" : ""].filter(Boolean).join(" · ")})`;
  return `  ${ref.slice(parent.length)}${kind}${o.signature ? ` ${clip(o.signature, 100)}` : ""}${why}`;
}

/** Search lines, where three or more share a parent: the parent once, then each under it
 * (forty functions of one file each said its file, its id and its parent: 11k). */
function grouped(idx: ModelIndex, shown: Hit[]): string[] {
  const n = new Map<string, number>();
  for (const h of shown) if (h.parent && h.short) n.set(h.parent, (n.get(h.parent) ?? 0) + 1);
  const out: string[] = [];
  const done = new Set<string>();
  for (const h of shown) {
    const p = h.parent;
    if (!p || !h.short || (n.get(p) ?? 0) < 3) {
      out.push(h.line);
      continue;
    }
    if (done.has(p)) continue;
    done.add(p);
    const pr = refOf(idx, p);
    out.push(
      `in ${pr} (each is ${pr}#<name>; each says its first sentence: read its ref for all):`,
    );
    for (const x of shown) if (x.parent === p && x.short) out.push(x.short);
  }
  return out;
}

// --- one thing in full -------------------------------------------------------------------------

function one(
  host: Host,
  idx: ModelIndex,
  ref: string,
  o: { limit: number; full: boolean; guesses?: boolean },
): Out {
  const r = resolve(idx, ref);
  const out = oneOf(host, idx, r, o);
  const both = ambiguity(idx, ref, r);
  return both ? { ...out, text: `${both}\n${out.text}` } : out;
}

function oneOf(
  host: Host,
  idx: ModelIndex,
  r: Resolved,
  o: { limit: number; full: boolean; guesses?: boolean },
): Out {
  if (r.kind === "object")
    return ok(box(host, idx, r.o, o), { ref: refOf(idx, r.o.id), kind: r.o.kind });
  if (r.kind === "entity") return ok(entity(idx, r.e, o.limit), { ref: r.e.name, kind: "entity" });
  if (r.kind === "connection")
    return ok(conn(idx, r.c), { ref: connRef(idx, r.c), kind: "connection" });
  if (r.kind === "view") return view(host, idx, viewId(r.d), o.limit);
  if (r.kind === "decision") {
    const d = r.dec;
    const affects = d.affects.map((id) => (idx.objects.has(id) ? refOf(idx, id) : id));
    return ok(
      [
        `decision:${d.id}  ${d.title} (${d.status}${d.date ? `, ${d.date}` : ""})`,
        ...(affects.length ? [`affects: ${affects.join(", ")}`] : []),
        "",
        d.text.trim(),
      ].join("\n"),
      { ref: `decision:${d.id}`, kind: "decision" },
    );
  }
  return ok(thread(idx, r.n), { ref: r.n.id, kind: "note" });
}

const CODE = new Set(["module", "function", "library", "table"]);

function box(
  host: Host,
  idx: ModelIndex,
  o: ModelObject,
  opt: { limit: number; full: boolean; guesses?: boolean },
): string {
  // Code: where it runs, the file it's in, its calls across processes, its libraries.
  if (CODE.has(o.kind)) {
    const r = refOf(idx, o.id);
    const url = (id: string) => {
      const on = [...(idx.placedOn.get(id) ?? [])][0];
      return on ? host.url(on, id) : "";
    };
    return `${contextText(idx, o.id, { design: host.key, url, stats: host.stats, limit: opt.limit, guesses: opt.guesses })}\nnext: read {ref: "${r}", depth: 2, follow: ["calls"]} · read {ref: "${r}", impact: "upstream"}`;
  }
  const lines = [boxLine(idx, o, { purpose: false, parent: true })];
  const text = mergedContext(o.description, o.context);
  // The whole context, always: an agent adding to it writes it back in full, so it must see all of it.
  if (text) lines.push("context:", ...text.split("\n").map((l) => `  ${l}`));
  if (o.columns?.length)
    lines.push(
      `columns: ${o.columns.map((c) => `${c.name} ${c.type}${c.pk ? " pk" : ""}`).join(", ")}`,
    );
  if (o.package)
    lines.push(
      `package: ${o.package.ecosystem} ${o.package.name}${o.package.version ? `@${o.package.version}` : ""}`,
    );
  const uses = usesOf(idx, o);
  if (uses.length) lines.push(`uses: ${uses.join(", ")}`);
  const defines = [...idx.entities.values()].filter((e) => e.sourceId === o.id);
  if (defines.length)
    lines.push(
      `defines (${defines.length}): ${defines
        .slice(0, opt.limit)
        .map((e) => `${e.name} (${entitySummary(e)})`)
        .join(
          ", ",
        )}${defines.length > opt.limit ? `, … ${defines.length - opt.limit} more: read {q: "", in: "${idOf(o)}"}` : ""}`,
    );
  // Its edges: its own first, then those of what's inside it (said where from).
  const mine = new Set([o.id, ...descendants(idx, o.id)]);
  const out: Connection[] = [];
  const inn: Connection[] = [];
  // Calls only guessed by name are left out unless asked for (mostly noise), and counted.
  let guessed = 0;
  for (const c of idx.connections.values()) {
    const a = mine.has(c.fromId);
    const b = mine.has(c.toId);
    if (a === b) continue;
    if (c.guess && !opt.guesses) {
      guessed++;
      continue;
    }
    (a ? out : inn).push(c);
  }
  const own = (c: Connection, end: "fromId" | "toId") => Number(c[end] !== o.id);
  out.sort((x, y) => own(x, "fromId") - own(y, "fromId"));
  inn.sort((x, y) => own(x, "toId") - own(y, "toId"));
  const edges = (list: Connection[], dir: "out" | "in", head: string) => {
    if (!list.length) return;
    const shown = list.slice(0, opt.limit);
    // Several through one of its insides: that one once, its lines under it (each
    // line said "(from repo:path#Fn)" again).
    const near = (c: Connection) => (dir === "out" ? c.fromId : c.toId);
    const n = new Map<string, number>();
    for (const c of shown) n.set(near(c), (n.get(near(c)) ?? 0) + 1);
    const body: string[] = [];
    const done = new Set<string>();
    for (const c of shown) {
      const k = near(c);
      if (k === o.id || (n.get(k) ?? 0) < 2) body.push(`  ${edgeLine(idx, c, dir, o.id)}`);
      else if (!done.has(k)) {
        done.add(k);
        body.push(
          `  ${dir === "out" ? "from" : "to"} ${refOf(idx, k)}:`,
          ...shown.filter((x) => near(x) === k).map((x) => `    ${edgeLine(idx, x, dir)}`),
        );
      }
    }
    lines.push(`${head} (${list.length}):`, ...body);
    const t = more(
      list.length,
      shown.length,
      `read {ref: "${refOf(idx, o.id)}", limit: ${list.length}}`,
    );
    if (t) lines.push(`  ${t}`);
  };
  edges(out, "out", o.kind === "table" ? "points to" : "calls");
  edges(inn, "in", o.kind === "table" ? "pointed at by" : "called by");
  if (guessed)
    lines.push(
      `(${plural(guessed, "guessed call", "guessed calls")} left out: matched by name only. read {ref: "${refOf(idx, o.id)}", guesses: true} shows them)`,
    );
  const inside = idx.children.get(o.id) ?? [];
  if (inside.length) {
    const shown = inside.slice(0, opt.limit);
    lines.push(`inside (${inside.length}):`, ...shown.map((c) => `  ${boxLine(idx, c)}`));
    const t = more(
      inside.length,
      shown.length,
      `read {q: "", in: "${idOf(o)}", limit: ${inside.length}}`,
    );
    if (t) lines.push(`  ${t}`);
  }
  const runs = runsIn(idx, o.id);
  if (runs.length) lines.push(`runs in: ${runs.join(" › ")}`);
  if (o.sources?.length) lines.push(`sources: ${o.sources.join(", ")}`);
  const capped = (head: string, xs: string[]) => {
    if (!xs.length) return;
    lines.push(
      `${head}${xs.length > opt.limit ? ` (${xs.length})` : ""}:`,
      ...xs.slice(0, opt.limit),
    );
    const t = more(
      xs.length,
      Math.min(xs.length, opt.limit),
      `read {ref: "${refOf(idx, o.id)}", limit: ${xs.length}}`,
    );
    if (t) lines.push(`  ${t}`);
  };
  capped(
    "links",
    (o.links ?? []).map((l) => `  ${l.title}: ${l.url}`),
  );
  capped(
    "references",
    referenceLines(idx, o)
      .slice(1)
      .filter((l) => !/^\s*entity:/.test(l)),
  );
  if (o.notes?.trim())
    lines.push(
      "notes (its running doc):",
      ...o.notes
        .trim()
        .split("\n")
        .slice(0, opt.full ? 200 : 12)
        .map((l) => `  ${l}`),
    );
  const notes = [...idx.notes.values()].filter(
    (n) =>
      !n.resolved && n.kind === "note" && (mine.has(n.about ?? "") || mine.has(n.objectId ?? "")),
  );
  if (notes.length)
    lines.push(
      `open notes (${notes.length}):`,
      ...notes.slice(0, opt.limit).map((n) => `  ${noteLine(idx, n)}`),
      ...(notes.length > opt.limit
        ? [
            `  ${more(notes.length, opt.limit, `note {action: "list", about: "${refOf(idx, o.id)}"}`)}`,
          ]
        : []),
    );
  const decided = [...idx.decisions.values()].filter((d) => d.affects.includes(o.id));
  capped(
    "decisions",
    decided.map(
      (d) =>
        `  ${d.id} "${d.title}" (${d.status}${d.date ? `, ${d.date}` : ""})${opt.full && d.text ? `\n${d.text.replace(/^/gm, "    ")}` : ""}`,
    ),
  );
  const on = [...(idx.placedOn.get(o.id) ?? [])]
    .map((d) => idx.diagrams.get(d))
    .filter((d): d is Diagram => !!d);
  lines.push(
    on.length
      ? `on views: ${on.slice(0, opt.limit).map(viewId).join(", ")}${on.length > opt.limit ? `, … ${on.length - opt.limit} more` : ""}  ${host.url(on[0]!.id, o.id)}`
      : `on views: none (views with rules pick it up; a hand-picked view lists it under boxes)`,
  );
  const r = refOf(idx, o.id);
  lines.push(
    `next: read {ref: "${r}", depth: 2} (a walk) · read {ref: "${r}", impact: "upstream"} (what depends on it)${inside.length ? ` · read {scope: "${idOf(o)}"} (a brief for working inside it)` : ""}`,
  );
  return lines.join("\n");
}

function entity(idx: ModelIndex, e: Entity, limit: number): string {
  const lines = [entityLine(idx, e)];
  if (e.extends?.length)
    lines.push(`extends: ${e.extends.map((x) => idx.entities.get(x)?.name ?? x).join(", ")}`);
  if (e.values?.length)
    lines.push(
      `values (${e.values.length}): ${e.values.slice(0, limit * 2).join(", ")}${e.values.length > limit * 2 ? `, … ${e.values.length - limit * 2} more: read {ref: "${e.name}", limit: ${e.values.length}}` : ""}`,
    );
  if (e.fields.length) {
    lines.push(
      `fields (${e.fields.length}):`,
      ...e.fields.slice(0, limit * 2).map((f) => `  ${f}`),
    );
    if (e.fields.length > limit * 2)
      lines.push(
        `  ${more(e.fields.length, limit * 2, `read {ref: "${e.name}", limit: ${Math.ceil(e.fields.length / 2)}}`)}`,
      );
  }
  if (!e.values?.length && !e.fields.length)
    lines.push(
      "TBD: nobody has said what's in it yet. Write it: entities: {" +
        e.name +
        ": {in: <box>, fields: {id: uuid}}}",
    );
  if (e.description) lines.push("context:", ...e.description.split("\n").map((l) => `  ${l}`));
  const users = [...idx.objects.values()].filter(
    (o) => o.status !== "removed" && usesOf(idx, o).includes(e.name),
  );
  if (users.length)
    lines.push(
      `used by (${users.length}):`,
      ...users.slice(0, limit).map((o) => `  ${boxLine(idx, o, { purpose: false })}`),
      ...(users.length > limit
        ? [`  … ${users.length - limit} more: read {ref: "${e.name}", limit: ${users.length}}`]
        : []),
    );
  const carriers = [...idx.connections.values()].filter((c) => carriesOf(idx, c).includes(e.name));
  if (carriers.length)
    lines.push(
      `carried by (${carriers.length}):`,
      ...carriers.slice(0, limit).map((c) => `  ${connRef(idx, c)}${c.name ? `  ${c.name}` : ""}`),
      ...(carriers.length > limit
        ? [
            `  … ${carriers.length - limit} more: read {ref: "${e.name}", limit: ${carriers.length}}`,
          ]
        : []),
    );
  return lines.join("\n");
}

function conn(idx: ModelIndex, c: Connection): string {
  const from = idx.objects.get(c.fromId);
  const to = idx.objects.get(c.toId);
  const lines = [
    `${connRef(idx, c)}${c.name ? `  ${c.name}` : ""} (connection${c.technology ? ` · ${c.technology}` : ""}${c.status !== "live" ? ` · ${c.status}` : ""}${c.guess ? " · guess" : ""})`,
  ];
  if (from) lines.push(`from: ${boxLine(idx, from, { parent: true })}`);
  if (to) lines.push(`to: ${boxLine(idx, to, { parent: true })}`);
  const via = c.viaId ? idx.objects.get(c.viaId) : undefined;
  if (via) lines.push(`via: ${idOf(via)}`);
  const carries = carriesOf(idx, c);
  if (carries.length) lines.push(`carries: ${carries.join(", ")}`);
  if (c.column) lines.push(`column: ${c.column}${c.toColumn ? ` → ${c.toColumn}` : ""}`);
  const text = (c.context || c.description || "").trim();
  if (text) lines.push("context:", ...text.split("\n").map((l) => `  ${l}`));
  if (c.sources?.length) lines.push(`sources: ${c.sources.join(", ")}`);
  if (c.notes?.trim())
    lines.push(
      "notes (its running doc):",
      ...c.notes
        .trim()
        .split("\n")
        .slice(0, 12)
        .map((l) => `  ${l}`),
    );
  const open = [...idx.notes.values()].filter(
    (n) => n.kind === "note" && !n.resolved && n.connectionId === c.id,
  );
  if (open.length)
    lines.push(
      `open notes (${open.length}):`,
      ...open.slice(0, 10).map((n) => `  ${noteLine(idx, n)}`),
    );
  return lines.join("\n");
}

function thread(idx: ModelIndex, n: Note): string {
  const replies = idx.replies.get(n.id) ?? [];
  return [
    noteLine(idx, n),
    ...(n.kind === "note" ? [`  ${n.author.name}: ${n.text}`] : []),
    ...replies.map((r) => `  ${r.author.name}: ${r.text}`),
    n.kind === "note" && !n.resolved
      ? `Answer: note {action: "reply", note: "${n.id}", text}; settle it: note {action: "resolve", note: "${n.id}"}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

// --- walks, impact -----------------------------------------------------------------------------

/** A bounded walk from one thing, as an indented tree. */
function walk(
  idx: ModelIndex,
  ref: string,
  o: { depth: number; follow: Follow[]; limit: number },
): Out {
  const start = resolve(idx, ref);
  const depth = Math.max(1, Math.min(o.depth, 4));
  const follow = new Set(o.follow);
  const lines: string[] = [];
  const seen = new Set<string>();
  let count = 0;
  let cut = 0;
  type Step = { key: string; line: string; obj?: ModelObject; ent?: Entity };
  const steps = (s: Step): Step[] => {
    const out: Step[] = [];
    if (s.obj) {
      const x = s.obj;
      if (follow.has("in"))
        for (const c of idx.children.get(x.id) ?? [])
          out.push({ key: c.id, line: `inside: ${boxLine(idx, c)}`, obj: c });
      for (const c of idx.connections.values()) {
        if (follow.has("calls") && c.fromId === x.id) {
          const t = idx.objects.get(c.toId);
          if (t) out.push({ key: t.id, line: edgeLine(idx, c, "out"), obj: t });
        }
        if (follow.has("callers") && c.toId === x.id) {
          const f = idx.objects.get(c.fromId);
          if (f) out.push({ key: f.id, line: edgeLine(idx, c, "in"), obj: f });
        }
        if (follow.has("carries") && (c.fromId === x.id || c.toId === x.id))
          for (const n of carriesOf(idx, c)) {
            const e = [...idx.entities.values()].find((y) => y.name === n);
            if (e)
              out.push({
                key: `e:${e.id}`,
                line: `carries ${entityLine(idx, e)} (over ${connRef(idx, c)})`,
                ent: e,
              });
          }
      }
      if (follow.has("uses"))
        for (const n of usesOf(idx, x)) {
          const e = [...idx.entities.values()].find((y) => y.name === n);
          if (e) out.push({ key: `e:${e.id}`, line: `uses ${entityLine(idx, e)}`, ent: e });
        }
    } else if (s.ent) {
      const e = s.ent;
      if (follow.has("uses") || follow.has("carries")) {
        for (const p of e.extends ?? []) {
          const b = idx.entities.get(p);
          if (b) out.push({ key: `e:${b.id}`, line: `extends ${entityLine(idx, b)}`, ent: b });
        }
        for (const ob of idx.objects.values())
          if (ob.status !== "removed" && usesOf(idx, ob).includes(e.name))
            out.push({ key: ob.id, line: `used by ${boxLine(idx, ob)}`, obj: ob });
      }
    }
    return out;
  };
  const root: Step =
    start.kind === "object"
      ? { key: start.o.id, line: boxLine(idx, start.o, { parent: true }), obj: start.o }
      : start.kind === "entity"
        ? { key: `e:${start.e.id}`, line: entityLine(idx, start.e), ent: start.e }
        : (() => {
            throw new ToolError(`walks start at a box or an entity; ${ref} is a ${start.kind}`);
          })();
  const visit = (s: Step, d: number) => {
    seen.add(s.key);
    for (const n of steps(s)) {
      if (count >= o.limit) {
        cut++;
        continue;
      }
      const again = seen.has(n.key);
      lines.push(`${"  ".repeat(d)}${n.line}${again ? " (above)" : ""}`);
      count++;
      if (!again && d < depth) visit(n, d + 1);
      else seen.add(n.key);
    }
  };
  lines.push(root.line);
  visit(root, 1);
  // A folder or a group with no calls of its own: what's inside it is the answer ("nothing
  // to follow" on app-fe's src read as empty, and a remove then took 30 files with it).
  const box = start.kind === "object" ? start.o : undefined;
  const kids = box ? (idx.children.get(box.id) ?? []).filter((c) => c.status !== "removed") : [];
  if (count === 0 && kids.length) {
    lines.push(`  no ${[...follow].join(", ")} of its own; inside it (${kids.length}):`);
    for (const c of kids.slice(0, o.limit)) lines.push(`    ${shortLine(idx, c)}`);
    if (kids.length > o.limit)
      lines.push(
        `    … ${kids.length - o.limit} more: read {in: "${refOf(idx, box!.id)}", q: "*", depth: 1, limit: ${kids.length}}`,
      );
  } else if (count === 0)
    lines.push(
      `  nothing to follow (${[...follow].join(", ")}); try follow: ${FOLLOW.filter((f) => !follow.has(f)).join(", ")}`,
    );
  if (cut)
    lines.push(
      `… ${cut} more steps not shown, showing ${count}: raise limit, lower depth, or follow less`,
    );
  return ok(lines.join("\n"), { shown: count, cut });
}

function impactOf(
  idx: ModelIndex,
  o: ModelObject,
  way: "upstream" | "downstream",
  limit: number,
): Out {
  const reached = impact(idx, o.id, way).filter((r) => idx.objects.get(r.id)?.status !== "removed");
  const r = refOf(idx, o.id);
  if (!reached.length)
    return ok(
      `${r}: nothing ${way === "upstream" ? "depends on it" : "it depends on"} (no connections ${way === "upstream" ? "into" : "out of"} it or anything inside it)`,
      { count: 0 },
    );
  const byHops = new Map<number, typeof reached>();
  for (const x of reached) byHops.set(x.hops, [...(byHops.get(x.hops) ?? []), x]);
  const lines = [
    `${r}: ${plural(reached.length, "thing")} ${way === "upstream" ? "depend on it" : "it depends on"}, ${plural(byHops.size, "hop")} deep`,
  ];
  let shown = 0;
  for (const [hops, list] of [...byHops].sort((x, y) => x[0] - y[0])) {
    lines.push(`${hops} hop${hops === 1 ? "" : "s"} (${list.length}):`);
    for (const x of list) {
      if (shown >= limit) break;
      const ob = idx.objects.get(x.id)!;
      lines.push(`  ${refOf(idx, x.id)}  ${ob.kind}${x.via.name ? ` — via "${x.via.name}"` : ""}`);
      shown++;
    }
  }
  const t = more(
    reached.length,
    shown,
    `read {ref: "${r}", impact: "${way}", limit: ${reached.length}}`,
  );
  if (t) lines.push(t);
  return ok(lines.join("\n"), {
    count: reached.length,
    refs: reached.slice(0, shown).map((x) => refOf(idx, x.id)),
  });
}

// --- views, history, files, here, the overview -------------------------------------------------

/** A view as it's written (scope, rules or boxes), in the grammar, so an agent sees what it would overwrite. */
function definition(host: Host, d: Diagram): string {
  try {
    const file = writeFiles(host.state(), host.config()).get(`views/${viewId(d)}.yaml`);
    if (!file) return "";
    const v = (YAML.parse(file) ?? {}) as Record<string, unknown>;
    const def: Record<string, unknown> = {};
    for (const k of ["scope", "include", "exclude", "boxes"]) if (v[k] !== undefined) def[k] = v[k];
    if (Array.isArray(def.boxes) && def.boxes.length > 30)
      def.boxes = [...def.boxes.slice(0, 30), `… ${def.boxes.length - 30} more`];
    const line = YAML.stringify(
      { [viewId(d)]: def },
      { collectionStyle: "flow", flowCollectionPadding: false, lineWidth: 0 },
    ).trim();
    return `definition (${d.rules ? "follows rules" : "hand-picked"}; views/${viewId(d)}.yaml): views: ${line}. Writing boxes makes it hand-picked; writing include/exclude makes it follow rules.`;
  } catch {
    return "";
  }
}

function view(host: Host, idx: ModelIndex, ref: string, limit: number): Out {
  if (!ref.trim() || ref === "*") {
    const all = [...idx.diagrams.values()];
    const shown = all.slice(0, limit * 3);
    const lines = shown.map((d) => {
      const scope = d.scopeId ? idx.objects.get(d.scopeId) : undefined;
      // Boxes and lines as drawn: a view with boxes and no lines stands out.
      const sc = scoreView(idx, d.id);
      return `${viewId(d)}  ${d.name}${scope ? ` (inside ${idOf(scope)})` : ""} · ${plural(sc.boxes, "box", "boxes")}, ${plural(sc.lines, "line")}${sc.boxes >= 3 && !sc.lines ? " (none!)" : ""} · ${d.rules ? "rules" : "hand-picked"}${flowsOf(idx, d.id).length ? ` · ${plural(flowsOf(idx, d.id).length, "flow")}` : ""}`;
    });
    return ok(
      [
        `${all.length} views:`,
        ...lines,
        more(all.length, shown.length, `read {view: "*", limit: ${all.length}}`),
      ]
        .filter(Boolean)
        .join("\n"),
      { views: shown.map(viewId) },
    );
  }
  const key = ref.trim().replace(/^view:/, "");
  let d: Diagram | undefined;
  try {
    d = findView(idx, key);
  } catch {
    // A box: the view about it.
    try {
      const r = resolve(idx, key);
      d =
        r.kind === "view"
          ? r.d
          : r.kind === "object"
            ? [...idx.diagrams.values()].find((x) => x.scopeId === r.o.id)
            : undefined;
    } catch {
      /* said below */
    }
  }
  if (!d) throw new ToolError(`no view ${key}; read {view: "*"} lists them`);
  const open = [...idx.notes.values()].filter(
    (n) => n.diagramId === d.id && n.kind === "note" && !n.resolved,
  ).length;
  const again = `read {view: "${viewId(d)}", limit: ${limit * 5}}`;
  const placed = idx.placements.get(d.id)?.size ?? 0;
  const empty = placed
    ? ""
    : d.rules
      ? "no boxes yet: its rules match nothing in the model (why each box is there, below, says which rule matches what)"
      : `no boxes: it's hand-picked and the list is empty; write views: {${viewId(d)}: {boxes: [ids]}}`;
  const extra = [
    empty,
    definition(host, d),
    open ? `${plural(open, "open note")}: note {action: "list", view: "${viewId(d)}"}` : "",
    `why each box is there:\n${elide(
      explain(idx, d)
        .split("\n")
        .filter((_, i) => !d.rules || i > 2)
        .join("\n"),
      limit,
      "lines",
      again,
      false,
    ).replace(/^/gm, "  ")}`,
  ];
  return ok(
    `${elide(outlineView(idx, d), limit * 3, "lines", again, false)}\n${extra.filter(Boolean).join("\n")}\nopen: ${host.url(d.id)}`,
    { view: viewId(d) },
  );
}

function history(
  host: Host,
  idx: ModelIndex,
  ref: string | undefined,
  limit: number,
  by?: string,
): Out {
  if (!host.recent) return ok("no history here");
  const id = ref ? object(idx, ref).id : null;
  const everything = host.recent(1000);
  const all = everything.filter(
    (e) => (!id || e.ids.includes(id)) && (!by || matchesBy(e.actor, by)),
  );
  const shown = all.slice(-limit);
  if (!shown.length) {
    const who = [
      ...new Set(
        everything
          .filter((e) => e.actor.session)
          .map((e) => `${e.actor.name} (${e.actor.session})`),
      ),
    ].slice(0, 10);
    return ok(
      `${id ? `no changes to ${ref}` : "no changes"}${by ? ` by ${by}` : ""} yet${by && who.length ? `; sessions with changes: ${who.join(", ")}` : ""}`,
    );
  }
  return ok(
    [
      ...shown.map(
        (e) =>
          `${e.at.slice(0, 16).replace("T", " ")}  ${e.actor.name}${e.actor.kind === "agent" ? ` (agent${e.actor.session && !e.actor.name.endsWith(e.actor.session) ? `, ${e.actor.session}` : ""})` : ""}: ${e.label}`,
      ),
      more(
        all.length,
        shown.length,
        `read {history: true${ref ? `, ref: "${ref}"` : ""}${by ? `, by: "${by}"` : ""}, limit: ${Math.min(all.length, limit * 5)}}`,
      ),
      "Undo your own last change: write {undo: true}.",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

/** At most n lines: the first n (or, middle: the first and last halves) and how many were left out. */
function elide(text: string, n: number, what: string, next = "", middle = true): string {
  const ls = text.split("\n");
  if (ls.length <= n) return text;
  if (!middle)
    return [
      ...ls.slice(0, n),
      `… ${ls.length - n} more ${what}, showing ${n} of ${ls.length}${next ? `: ${next}` : ""}`,
    ].join("\n");
  const head = Math.ceil(n / 2);
  const tail = n - head;
  return [
    ...ls.slice(0, head),
    `… ${ls.length - n} ${what} in between (${ls.length} in all; raise limit to see them)`,
    ...ls.slice(ls.length - tail),
  ].join("\n");
}

function file(host: Host, path: string, limit: number, from = 1): Out {
  const files = writeFiles(host.state(), host.config());
  if (!path.trim() || path === "*") {
    const list = [...files].filter(
      ([p]) => !p.startsWith("layout/") && !p.startsWith("schema/") && p !== "AGENTS.md",
    );
    const shown = list.slice(0, limit * 5);
    return ok(
      [
        ...shown.map(([p, t]) => `${p}  ${t.split("\n").length} lines`),
        more(list.length, shown.length, `read {file: "*", limit: ${list.length}}`),
      ]
        .filter(Boolean)
        .join("\n"),
      { files: shown.map(([p]) => p) },
    );
  }
  const t = files.get(path.trim());
  if (t === undefined) {
    const near = [...files.keys()]
      .filter((p) =>
        p.includes(
          path
            .replace(/\.ya?ml$/, "")
            .split("/")
            .pop() ?? "",
        ),
      )
      .slice(0, 5);
    throw new ToolError(
      `no file ${path}${near.length ? `; did you mean ${near.join(", ")}?` : ""} (read {file: "*"} lists them)`,
    );
  }
  // A page at a time: long files (a big model file, a view with hundreds of boxes) come in pieces.
  const all = t.replace(/\n$/, "").split("\n");
  const page = Math.min(limit * 10, 2000);
  const start = Math.max(1, Math.min(Number.isFinite(from) ? Math.floor(from) : 1, all.length));
  const end = Math.min(all.length, start + page - 1);
  if (start === 1 && end === all.length) return ok(`--- ${path}\n${t}`);
  const rest =
    end < all.length
      ? `\n… lines ${end + 1}-${all.length} next: read {file: "${path}", from: ${end + 1}}`
      : "";
  return ok(
    `--- ${path} (lines ${start}-${end} of ${all.length})\n${all.slice(start - 1, end).join("\n")}${rest}`,
    { from: start, to: end, lines: all.length },
  );
}

function here(host: Host, idx: ModelIndex): Out {
  if (!host.canvas)
    return ok(
      "Nobody's canvas is reachable from here: ask the person what they're looking at, or send them a link.",
    );
  const h = host.canvas.here();
  const lines: string[] = [];
  if (h.design && h.design !== host.key)
    lines.push(
      `They have ${h.design} open, not ${host.key}: pass design: "${h.design}" to read what they see.`,
    );
  const d = h.diagram ? idx.diagrams.get(h.diagram) : undefined;
  if (d) lines.push(`view: ${viewId(d)}  ${d.name}  ${host.url(d.id)}`);
  else lines.push("view: not on a view of this design right now");
  const sel = (h.selection ?? [])
    .map((id) => idx.objects.get(id))
    .filter((o): o is ModelObject => !!o);
  if (sel.length)
    lines.push(
      `selected (${sel.length}):`,
      ...sel.slice(0, 12).map((o) => `  ${boxLine(idx, o, { parent: true })}`),
    );
  if (h.recent?.length)
    lines.push("their last moves:", ...h.recent.slice(-12).map((l) => `  ${l}`));
  if (h.note) lines.push(h.note);
  if (sel[0]) lines.push(`next: read {ref: "${refOf(idx, sel[0].id)}"}`);
  else if (d) lines.push(`next: read {view: "${viewId(d)}"}`);
  return ok(lines.join("\n"), {
    design: h.design ?? host.key,
    view: d ? viewId(d) : null,
    selection: sel.map((o) => refOf(idx, o.id)),
  });
}

/** No question: what the design is, its top level, and where to go next. */
function overview(host: Host, idx: ModelIndex, limit: number): Out {
  const all = [...idx.objects.values()].filter((o) => o.status !== "removed");
  const counts = new Map<string, number>();
  for (const o of all) counts.set(o.kind, (counts.get(o.kind) ?? 0) + 1);
  const top = all.filter((o) => !o.parentId);
  const shown = top.slice(0, limit * 2);
  const lines = [
    `${host.key}${host.branch ? ` (fork ${host.branch})` : ""}: ${[...counts].map(([k, n]) => plural(n, k)).join(", ") || "empty"}; ${plural(idx.connections.size, "connection")}, ${plural(idx.entities.size, "entity", "entities")}, ${plural(idx.diagrams.size, "view")}`,
    "top level:",
    ...shown.map(
      (o) =>
        `  ${boxLine(idx, o)}${idx.children.get(o.id)?.length ? ` [${idx.children.get(o.id)!.length} inside]` : ""}`,
    ),
    more(top.length, shown.length, `read {q: "", limit: ${top.length}}`),
    ...outlineBoundaries(idx).slice(0, 12),
    `views: ${[...idx.diagrams.values()].slice(0, 15).map(viewId).join(", ")}${idx.diagrams.size > 15 ? ", …" : ""}`,
    `next: read {q: "<words>"} to search · read {ref: "<id>"} for one thing · read {scope: "<id>"} for a brief · guide {} for how`,
  ];
  return ok(lines.filter(Boolean).join("\n"));
}
