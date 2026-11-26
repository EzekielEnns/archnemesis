// Is this design good enough to hand over? The finish line for an agent mapping a code base:
// what still has to be fixed (must) and what would make it better (should), each with how.
// An agent loops on it until nothing's left in must, so nobody has to judge "half decent".
import { worklist } from "./curate.ts";
import { GENERATED } from "./codeindex.ts";
import { DEFAULT_LIMITS } from "./files.ts";
import {
  ancestors,
  crossingHelp,
  diagramForScope,
  projectDiagram,
  type ModelIndex,
} from "./project.ts";
import { scoreView } from "./score.ts";
import { resolve } from "./views.ts";

interface ReviewItem {
  /** What it's about: a view or an object's key. */
  about: string;
  problem: string;
  fix: string;
}

export interface Review {
  must: ReviewItem[];
  should: ReviewItem[];
  /** A few numbers, to say how big it is and how far along. */
  stats: { objects: number; views: number; connections: number; code: number };
}

const keyOf = (idx: ModelIndex, id: string) => idx.objects.get(id)?.key ?? id;

export function review(idx: ModelIndex): Review {
  const must: ReviewItem[] = [];
  const should: ReviewItem[] = [];
  const live = [...idx.objects.values()].filter(
    (o) => o.status !== "removed" && o.status !== "deprecated",
  );
  const code = live.filter((o) => o.kind === "module" || o.kind === "function");
  const arch = live.filter(
    (o) => o.kind !== "module" && o.kind !== "function" && o.kind !== "library",
  );
  const conns = [...idx.connections.values()].filter((c) => c.status !== "removed");

  if (!arch.length) {
    must.push({
      about: "(design)",
      problem: "nothing modelled yet",
      fix: "map it: index start, then scan, then write the systems, apps and stores",
    });
    return {
      must,
      should,
      stats: {
        objects: live.length,
        views: idx.diagrams.size,
        connections: conns.length,
        code: code.length,
      },
    };
  }

  // The way in: a top view, and each level opening into the next.
  const top = diagramForScope(idx, null);
  if (!top)
    must.push({
      about: "(design)",
      problem: "no top-level view (the landscape): there's nowhere to start reading",
      fix: "add a view with no scope: actors, your systems, the outside services they use",
    });

  // Externals on a view that fold would gather into one box (none: don't suggest it).
  const unfolded = (id: string) =>
    projectDiagram(idx, id).nodes.filter((n) => !n.folded && idx.objects.get(n.id)?.external)
      .length >= 2;
  for (const d of idx.diagrams.values()) {
    const s = scoreView(idx, d.id);
    const v = d.key ?? d.id;
    if (!s.boxes && !(d.rules && resolve(idx, d).ids.size))
      (d.id === top?.id ? must : should).push({
        about: v,
        problem: `${d.name} is empty`,
        fix: "give it rules or boxes, or remove it",
      });
    // A store's tables: they stay in their store, so they're split into views, not grouped
    // (review said group 28 tables; grouping them made every table a warning).
    const tables = projectDiagram(idx, d.id).nodes.filter((n) => n.kind === "table").length;
    if (s.boxes > DEFAULT_LIMITS.boxes && tables > s.boxes / 2)
      should.push({
        about: v,
        problem: `${d.name} has ${s.boxes} boxes, ${tables} of them tables`,
        fix: "tables stay in their store, so don't group them: make views by area (boxes: the tables that go together, with the keys between them) and keep this one as the full list, saying so in its story",
      });
    else if (s.boxes > DEFAULT_LIMITS.boxes * 1.5)
      must.push({
        about: v,
        problem: `${d.name} has ${s.boxes} boxes: far past one screen`,
        fix: `group the parts (add grouping objects and move them in)${unfolded(d.id) ? ", fold externals" : ""}, or scope it tighter`,
      });
    else if (s.boxes > DEFAULT_LIMITS.boxes)
      should.push({
        about: v,
        problem: `${d.name} has ${s.boxes} boxes, past the ${DEFAULT_LIMITS.boxes} that read at a glance`,
        fix: `group some${unfolded(d.id) ? ", fold externals" : ""}, or exclude libraries`,
      });
    const help = () =>
      [
        ...crossingHelp(idx, d.id),
        "hide_lines: [{ids: [<box>, …]}] (or {tag: …}, {kind: …}) stops drawing the lines touching the shared plumbing it picks",
      ].join("; or ");
    // Tidied, with every layout fix but lanes already on: what's left is the model's shape (three
    // apps each using most of the core), not the layout's. Worth a look, not a must.
    const spent = !!d.tidy && crossingHelp(idx, d.id).every((h) => h.startsWith("lanes"));
    if (s.crossings > Math.max(8, s.lines / 2) && spent)
      should.push({
        about: v,
        problem: `${d.name}: ${s.crossings} arrows cross, after tidying`,
        fix: "what's left comes from what connects to what, not the layout: leave it, or regroup (fewer, bigger parts), or show the routes that matter as flows; lanes put callers, doors and vendors in columns, if they fit",
      });
    else if (s.crossings > Math.max(8, s.lines / 2))
      must.push({
        about: v,
        problem: `${d.name}: ${s.crossings} arrows cross`,
        fix: `tidy it, then: ${help()}`,
      });
    else if (s.crossings > Math.max(4, Math.ceil(s.lines / 3)))
      should.push({
        about: v,
        problem: `${d.name}: ${s.crossings} arrows cross`,
        fix: `tidy it, then: ${help()}`,
      });
    // Calls between code, rolled up onto boxes, cross however they're laid out: a flow (kind:
    // path) shows a route better than untangling them. Worth a look, not a must.
    if (s.codeCrossings > Math.max(8, s.lines / 2))
      should.push({
        about: v,
        problem: `${d.name}: ${s.codeCrossings} crossings among calls between code`,
        fix: "it's a call graph rolled up, and no layout untangles one: leave it, and show the routes that matter as flows (kind: path); or show fewer files (group them in components)",
      });
    // Crossings a guessed line makes aren't the layout's fault: confirm the guesses or leave them off.
    if (s.guessCrossings > Math.max(4, Math.ceil(s.lines / 3)))
      should.push({
        about: v,
        problem: `${d.name}: ${s.guessCrossings} crossings involve guessed lines (calls matched by name)`,
        fix: "confirm the real ones (write guess: false) and remove the rest, or leave guesses off this view: hide_lines: [{guess: true}]",
      });
  }

  const lonelyApps: string[] = [];
  const lonelyStores: string[] = [];
  const lonelyParts: string[] = [];
  for (const o of arch) {
    // Tables too stay out: they can't be grouped, they're split into views (this said
    // group postgres's 35 tables while the view rule said don't).
    const kids = (idx.children.get(o.id) ?? []).filter(
      (c) =>
        c.status !== "removed" &&
        c.kind !== "module" &&
        c.kind !== "function" &&
        c.kind !== "table",
    );
    if (kids.length > DEFAULT_LIMITS.boxes * 1.5)
      must.push({
        about: keyOf(idx, o.id),
        problem: `${o.name} has ${kids.length} things directly inside: its view can't fit one screen`,
        fix: "add grouping objects inside it (by domain or audience) and move the parts into them",
      });
    // Everything that does something talks to something: a box with no line at all is either
    // missing its connections or isn't real.
    if ((o.kind === "app" || o.kind === "store" || o.kind === "component") && !o.external) {
      const mine = new Set([
        o.id,
        ...[...idx.objects.values()]
          .filter((x) => ancestors(idx, x.id).includes(o.id))
          .map((x) => x.id),
      ]);
      const touched = conns.some((c) => mine.has(c.fromId) || mine.has(c.toId));
      if (!touched)
        (o.kind === "component"
          ? lonelyParts
          : o.kind === "store"
            ? lonelyStores
            : lonelyApps
        ).push(keyOf(idx, o.id));
    }
    if ((o.kind === "system" || o.kind === "app") && !o.external && !o.description?.trim())
      should.push({
        about: keyOf(idx, o.id),
        problem: `${o.name} has no description`,
        fix: "one line on what it does, for whoever opens it",
      });
  }

  // Many alike are one item: an agent fixes them as one piece of work.
  const lonely = (keys: string[], what: string, fix: string, to: ReviewItem[]) => {
    if (!keys.length) return;
    if (keys.length <= 3)
      for (const k of keys)
        to.push({ about: k, problem: `${what.replace(/s$/, "")} connected to nothing`, fix });
    else
      to.push({
        about: `${keys.slice(0, 8).join(", ")}${keys.length > 8 ? `, +${keys.length - 8}` : ""}`,
        problem: `${keys.length} ${what} connected to nothing`,
        fix,
      });
  };
  lonely(
    lonelyApps,
    "apps",
    "connect what each calls and what calls it (the code says: clients it builds, URLs it reads from config), or remove the ones that aren't real",
    must,
  );
  lonely(
    lonelyStores,
    "stores",
    "connect what reads and writes each (who publishes to a topic, who subscribes)",
    must,
  );
  lonely(lonelyParts, "components", "connect them, or fold them into their app", should);

  // Imported code that isn't under anything that runs it.
  const loose = code.filter(
    (o) => o.tags.includes(GENERATED) && o.kind === "module" && !o.parentId,
  );
  if (loose.length)
    must.push({
      about: loose
        .map((o) => keyOf(idx, o.id))
        .slice(0, 5)
        .join(", "),
      problem: `${loose.length} imported folders sit at the top, under nothing`,
      fix: "index import again with under: the app that runs that code",
    });

  // What the curator would flag: code no process claims, things gone from the code, guesses.
  const w = worklist(idx);
  if (w.unplaced.length)
    should.push({
      about: w.unplaced.slice(0, 5).join(", "),
      problem: `${w.unplaced.length} top-level code module${w.unplaced.length === 1 ? "" : "s"} no process runs`,
      fix: "add each to the process boundary of what runs it (its main, the service's start command)",
    });
  if (w.gone.length)
    should.push({
      about: w.gone.slice(0, 5).join(", "),
      problem: `${w.gone.length} imported things are gone from the code`,
      fix: "check nothing needs them, then remove them",
    });
  if (w.guessed.length)
    should.push({
      about: "(calls)",
      problem: `${w.guessed.length} calls were guessed by name`,
      fix: "install the language's SCIP indexer and index start again for exact calls, or confirm the ones that matter",
    });
  if (w.flags.length)
    should.push({
      about: "(notes)",
      problem: `${w.flags.length} open flag${w.flags.length === 1 ? "" : "s"} for agents`,
      fix: "answer them (notes, note reply_to)",
    });

  return {
    must,
    should,
    stats: {
      objects: live.length,
      views: idx.diagrams.size,
      connections: conns.length,
      code: code.length,
    },
  };
}

export function reviewText(r: Review, design: string): string {
  const line = (i: ReviewItem) => `  ${i.about}: ${i.problem}. Fix: ${i.fix}.`;
  const head = `${design}: ${r.stats.objects} objects (${r.stats.code} of them code), ${r.stats.connections} connections, ${r.stats.views} views.`;
  const verdict = r.must.length
    ? `Not ready: ${r.must.length} thing${r.must.length === 1 ? "" : "s"} to fix first. Fix them, then review again.`
    : r.should.length
      ? "Ready to hand over. Worth doing if there's time:"
      : "Ready to hand over: nothing to fix.";
  return [
    head,
    verdict,
    ...(r.must.length
      ? [
          "",
          "Must fix:",
          ...r.must.slice(0, 30).map(line),
          ...(r.must.length > 30 ? [`  … and ${r.must.length - 30} more`] : []),
        ]
      : []),
    ...(r.should.length
      ? [
          "",
          r.must.length ? "Then:" : "",
          ...r.should.slice(0, 20).map(line),
          ...(r.should.length > 20 ? [`  … and ${r.should.length - 20} more`] : []),
        ].filter((x, i) => x || i === 0)
      : []),
  ].join("\n");
}
