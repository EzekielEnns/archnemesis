// Lenses: what check, curate and review found, and what a staff engineer looks for (single
// points of failure, hotspots, cycles, contracts that disagree), as findings with refs.
import { worklist } from "../curate.ts";
import { review } from "../handover.ts";
import { impact } from "../impact.ts";
import type { Connection } from "../model.ts";
import { descendants, type ModelIndex } from "../project.ts";
import { ToolError, more, ok, plural, type Host, type Out } from "./host.ts";
import { problemsOf } from "./problems.ts";
import { carriesOf, connRef, entityByName, idOf, object, refOf, usesOf } from "./refs.ts";
import { findView } from "../agent.ts";
import type { ForkFocus } from "./diff.ts";

export const LENSES = [
  "problems",
  "review",
  "drift",
  "guesses",
  "flags",
  "hotspots",
  "cycles",
  "spof",
  "mismatches",
] as const;
export type Lens = (typeof LENSES)[number];

const live = (idx: ModelIndex) =>
  [...idx.connections.values()].filter(
    (c) =>
      c.status !== "removed" &&
      idx.objects.get(c.fromId)?.status !== "removed" &&
      idx.objects.get(c.toId)?.status !== "removed",
  );

export function lens(
  host: Host,
  idx: ModelIndex,
  which: Lens,
  o: { limit: number; ref?: string; view?: string; focus?: ForkFocus | null },
): Out {
  // A ref narrows every lens to what's inside that box (or touches it); view to the boxes on
  // that view. On a fork, problems, review and drift look at what the fork changed (focus).
  const refSet = o.ref
    ? new Set([object(idx, o.ref).id, ...descendants(idx, object(idx, o.ref).id)])
    : null;
  const theView = o.view !== undefined ? findView(idx, o.view) : null;
  const viewSet = theView
    ? new Set([...idx.objects.keys()].filter((id) => idx.placedOn.get(id)?.has(theView.id)))
    : null;
  const focus =
    o.focus && (which === "problems" || which === "review" || which === "drift") ? o.focus : null;
  const sets = [refSet, viewSet, focus?.objects ?? null].filter((s): s is Set<string> => !!s);
  const within = sets.length
    ? new Set([...sets[0]!].filter((id) => idx.objects.has(id) && sets.every((s) => s.has(id))))
    : null;
  // The views whose findings count: the one named, the changed ones (on a fork), those inside the box.
  const viewKey = (d: { key?: string; id: string }) => d.key ?? d.id;
  const views = !within
    ? null
    : new Set(
        [...idx.diagrams.values()]
          .filter(
            (d) =>
              (!theView || d.id === theView.id) &&
              (!focus || focus.views.has(viewKey(d))) &&
              (!refSet || (!!d.scopeId && refSet.has(d.scopeId))),
          )
          .map(viewKey),
      );
  const inside = (id?: string | null) => !within || (!!id && within.has(id));
  // What a lens looked at, said with an empty answer: "none" has to read differently from "didn't run".
  const looked = () => {
    const boxes = [...idx.objects.values()].filter(
      (x) => x.status !== "removed" && inside(x.id),
    ).length;
    const conns = live(idx).filter((c) => inside(c.fromId) || inside(c.toId)).length;
    return `checked ${plural(boxes, "box", "boxes")}, ${plural(conns, "connection")}, ${plural(views ? views.size : idx.diagrams.size, "view")}${o.ref ? ` in ${o.ref}` : ""}${theView ? ` on view:${viewKey(theView)}` : ""}${focus ? `: what ${host.key} changed against ${focus.against}` : ""}`;
  };
  // A ref a worklist gives (an id or repo:path#fn), inside the box asked about.
  const refsIn = within
    ? new Set([...within].flatMap((id) => [idOf(idx.objects.get(id)!), refOf(idx, id)]))
    : null;
  const refIn = (r: string) => !refsIn || refsIn.has(r);
  const list = (head: string, items: string[], empty: string, nextHint = ""): Out => {
    if (!items.length)
      return ok(
        `${which}: none. ${empty} (${looked()})${focus ? `\nThe whole design: read {lens: "${which}", all: true}.` : ""}`,
        { findings: [] },
      );
    const shown = items.slice(0, o.limit);
    const tail = more(
      items.length,
      shown.length,
      `read {lens: "${which}"${o.ref ? `, ref: "${o.ref}"` : ""}${o.view ? `, view: "${o.view}"` : ""}, limit: ${items.length}}`,
    );
    const scope = focus
      ? `Only what ${host.key} changed against ${focus.against}; the whole design: read {lens: "${which}", all: true}.`
      : "";
    return ok(
      [`${head} (${items.length}):`, ...shown.map((l) => `  ${l}`), tail, nextHint, scope]
        .filter(Boolean)
        .join("\n"),
      { findings: shown, total: items.length },
    );
  };
  switch (which) {
    case "problems": {
      // Inside: a problem naming one of its boxes (as a whole word, or by its code ref), or in one of its views' files.
      const names = within
        ? new Set([...within].flatMap((id) => [idOf(idx.objects.get(id)!), refOf(idx, id)]))
        : null;
      const viewFiles = views ? new Set([...views].map((k) => `views/${k}.yaml`)) : null;
      const mine = (p: { file: string; message: string }) =>
        !names ||
        viewFiles!.has(p.file.replace(/:\d+$/, "")) ||
        (p.message.match(/[\w.:/#-]+/g) ?? []).some(
          (w) => names.has(w) || names.has(w.replace(/[.:]+$/, "")),
        );
      const ps = problemsOf(host.state(), host.config(), host.index()).filter(mine);
      const errors = ps.filter((p) => p.level === "error").length;
      // The same advice for several: said once, each one's own part under it.
      const items: string[] = [];
      const byTail = new Map<string, typeof ps>();
      const tail = (m: string) => (m.includes("; ") ? m.slice(m.indexOf("; ") + 2) : "");
      for (const p of ps)
        if (tail(p.message))
          byTail.set(`${p.level}|${tail(p.message)}`, [
            ...(byTail.get(`${p.level}|${tail(p.message)}`) ?? []),
            p,
          ]);
      const said = new Set<string>();
      for (const p of ps) {
        const k = `${p.level}|${tail(p.message)}`;
        const g = tail(p.message) ? byTail.get(k)! : [p];
        if (g.length < 2) items.push(`${p.level}: ${p.file}: ${p.message}`);
        else if (!said.has(k)) {
          said.add(k);
          items.push(
            `${p.level}, ${g.length} of them: ${tail(p.message)}\n${g.map((x) => `    ${x.file}: ${x.message.slice(0, x.message.indexOf("; "))}`).join("\n")}`,
          );
        }
      }
      return list(
        `problems: ${plural(errors, "error")}, ${plural(ps.length - errors, "warning")}`,
        items,
        "No errors or warnings.",
        errors
          ? "Errors first: fix each with write (the message names the field and the nearest real id)."
          : "",
      );
    }
    case "review": {
      const r = review(idx);
      if (within) {
        const names = new Set([...within].map((id) => idOf(idx.objects.get(id)!)));
        const ok2 = (x: { about: string }) =>
          x.about
            .split(/,\s*/)
            .some(
              (a) =>
                names.has(a) ||
                names.has(a.replace(/^view:/, "")) ||
                views!.has(a) ||
                views!.has(a.replace(/^view:/, "")),
            );
        r.must = r.must.filter(ok2);
        r.should = r.should.filter(ok2);
      }
      // The same fix for several: said once, with each one's problem under it (one
      // call-graph paragraph per view, ten times over).
      const lines: string[] = [];
      for (const [level, xs] of [
        ["must", r.must],
        ["should", r.should],
      ] as const) {
        const byFix = new Map<string, typeof xs>();
        for (const x of xs) byFix.set(x.fix, [...(byFix.get(x.fix) ?? []), x]);
        for (const [fix, g] of byFix)
          lines.push(
            g.length === 1
              ? `${level}: ${g[0]!.about}: ${g[0]!.problem} — ${fix}`
              : `${level}, ${g.length} of them: ${fix}\n${g.map((x) => `    ${x.about}: ${x.problem}`).join("\n")}`,
          );
      }
      return list(
        "before a person sees it",
        lines,
        "Ready to hand over: nothing under must or should.",
        r.must.length ? 'Fix what\'s under must, then read {lens: "review"} again.' : "",
      );
    }
    case "drift": {
      const w = worklist(idx, { stats: host.stats });
      const lines = [
        ...w.drift.map(
          (d) =>
            `${d.repo}: indexed at ${d.commits.length} commits (${d.commits.map((c) => `${c.sha.slice(0, 7)} ×${c.count}`).join(", ")}): import it again`,
        ),
        ...w.gone
          .filter(refIn)
          .map(
            (r) =>
              `${r}: gone from the code (the importer marked it deprecated): remove it, or say why it stays`,
          ),
        ...w.libraries.filter((l) => refIn(l.ref)).map((l) => `${l.ref}: ${l.warnings.join("; ")}`),
        ...w.unplaced.filter(refIn).map((r) => `${r}: no process boundary runs this code`),
      ];
      return list(
        "drift between the design and the code",
        lines,
        "Everything generated was indexed at one commit.",
      );
    }
    case "guesses": {
      const w = worklist(idx);
      const lines = [
        ...w.guessedObjects.map((r) => `${r}: a guessed box`),
        ...w.guessed.map((g) => `${g.from}>${g.to}: a guessed call`),
      ].filter((l) => !within || [...within].some((id) => l.startsWith(refOf(idx, id))));
      return list(
        "guesses to confirm or remove",
        lines,
        "Nothing is marked guess.",
        "Confirm one by writing it without guess (guess: false), or remove it: write {remove: [ref]}.",
      );
    }
    case "flags": {
      const flags = [...idx.notes.values()].filter(
        (n) => n.kind === "note" && n.forAgent && !n.resolved && inside(n.about ?? n.objectId),
      );
      return list(
        "open flags",
        flags.map(
          (n) =>
            `${n.id} on ${n.about || n.objectId ? refOf(idx, (n.about ?? n.objectId)!) : "the view"} by ${n.author.name}: ${n.text.replace(/\s+/g, " ")}`,
        ),
        "No open flags.",
        'Fix what you can with write, then note {action: "resolve", note: id}.',
      );
    }
    case "hotspots": {
      const fanIn = new Map<string, Set<string>>();
      for (const c of live(idx))
        fanIn.set(c.toId, new Set([...(fanIn.get(c.toId) ?? []), c.fromId]));
      const ranked = [...fanIn]
        .filter(([id]) => inside(id))
        .sort((a, b) => b[1].size - a[1].size)
        .filter(([, s]) => s.size >= 2);
      return list(
        "fan-in hotspots (most callers first)",
        ranked.map(
          ([id, s]) =>
            `${refOf(idx, id)}: ${plural(s.size, "caller")} (${[...s]
              .slice(0, 5)
              .map((x) => refOf(idx, x))
              .join(", ")}${s.size > 5 ? ", …" : ""})`,
        ),
        "Nothing has two callers or more.",
      );
    }
    case "cycles": {
      const cycles = sccs(idx).filter((c) => c.some(inside));
      return list(
        "cycles (each set calls round in a loop)",
        cycles.map((c) => c.map((id) => refOf(idx, id)).join(" → ") + ` → ${refOf(idx, c[0]!)}`),
        "Nothing calls round in a loop.",
      );
    }
    case "spof": {
      // What most depends on: by how much reaches it upstream, among things with 2+ direct callers.
      const fanIn = new Map<string, number>();
      for (const c of live(idx)) fanIn.set(c.toId, (fanIn.get(c.toId) ?? 0) + 1);
      const ranked = [...fanIn]
        .filter(([id, n]) => n >= 2 && inside(id))
        .map(([id]) => ({ id, up: impact(idx, id, "upstream").length }))
        .sort((a, b) => b.up - a.up);
      return list(
        "single points of failure (what most depends on)",
        ranked.map((r) => {
          const ob = idx.objects.get(r.id)!;
          return `${refOf(idx, r.id)} (${ob.kind}${ob.external ? ", external" : ""}): ${plural(r.up, "thing")} depend on it, ${fanIn.get(r.id)} directly`;
        }),
        "Nothing has two callers, so no single point stands out.",
        `What breaks if one goes: read {ref, impact: "upstream"}.`,
      );
    }
    case "mismatches": {
      // A contract that disagrees: a connection carries what neither end works with, or
      // something nobody has defined; two lines between the same ends that disagree on tech.
      const lines: string[] = [];
      for (const c of live(idx)) {
        if (!inside(c.fromId) && !inside(c.toId)) continue;
        const from = idx.objects.get(c.fromId)!;
        const to = idx.objects.get(c.toId)!;
        for (const n of carriesOf(idx, c)) {
          const e = entityByName(idx, n);
          if (e && !e.fields.length && !e.values?.length)
            lines.push(`${connRef(idx, c)} carries ${n}, which is TBD: define it`);
          const knows = (id: string) =>
            [id, ...descendants(idx, id)].some((x) => {
              const ob = idx.objects.get(x);
              return !!ob && (usesOf(idx, ob).includes(n) || (!!e && e.sourceId === x));
            });
          if (
            e &&
            (from.kind === "function" || to.kind === "function") &&
            !knows(c.fromId) &&
            !knows(c.toId)
          )
            lines.push(`${connRef(idx, c)} carries ${n}, but neither end uses or defines it`);
        }
      }
      const byEnds = new Map<string, Connection[]>();
      for (const c of live(idx))
        byEnds.set(`${c.fromId}>${c.toId}`, [...(byEnds.get(`${c.fromId}>${c.toId}`) ?? []), c]);
      for (const cs of byEnds.values()) {
        const techs = new Set(cs.map((c) => c.technology).filter(Boolean));
        if (techs.size > 1 && (inside(cs[0]!.fromId) || inside(cs[0]!.toId)))
          lines.push(
            `${connRef(idx, cs[0]!).split(":")[0]}: ${cs.length} lines disagree on tech (${[...techs].join(", ")})`,
          );
      }
      return list("contracts that disagree", lines, "Connections and what they carry agree.");
    }
    default:
      throw new ToolError(`no lens "${which}"; lenses: ${LENSES.join(", ")}`);
  }
}

/** Strongly connected sets of 2 or more: the loops. Tarjan's, iteratively. */
function sccs(idx: ModelIndex): string[][] {
  const adj = new Map<string, string[]>();
  for (const c of live(idx))
    if (c.fromId !== c.toId) adj.set(c.fromId, [...(adj.get(c.fromId) ?? []), c.toId]);
  let n = 0;
  const num = new Map<string, number>();
  const low = new Map<string, number>();
  const on = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  for (const start of adj.keys()) {
    if (num.has(start)) continue;
    const work: [string, number][] = [[start, 0]];
    while (work.length) {
      const top = work[work.length - 1]!;
      const [v, i] = top;
      if (i === 0) {
        num.set(v, n);
        low.set(v, n++);
        stack.push(v);
        on.add(v);
      }
      const next = adj.get(v) ?? [];
      if (i < next.length) {
        top[1]++;
        const w = next[i]!;
        if (!num.has(w)) work.push([w, 0]);
        else if (on.has(w)) low.set(v, Math.min(low.get(v)!, num.get(w)!));
        continue;
      }
      work.pop();
      if (work.length) {
        const p = work[work.length - 1]![0];
        low.set(p, Math.min(low.get(p)!, low.get(v)!));
      }
      if (low.get(v) === num.get(v)) {
        const comp: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          on.delete(w);
          comp.push(w);
        } while (w !== v);
        if (comp.length > 1) out.push(comp.reverse());
      }
    }
  }
  return out.sort((a, b) => b.length - a.length);
}
