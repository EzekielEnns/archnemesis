// The curator's worklist: what's keeping a design's code layer from being true, gathered in
// one place for an agent to fix on a fork and propose. Archnemesis doesn't run a model itself; a
// scheduled agent (a Claude Code routine, a CI job) reads it through the MCP (read {lens: "flags"}, "drift", "guesses") or
// `archnm curate`, works through it, and hands a person the pull request. Nothing lands on
// main by itself.
import { codeRef } from "./context.ts";
import { GENERATED } from "./codeindex.ts";
import type { LibStats } from "./libstats.ts";
import type { ModelObject, Package } from "./model.ts";
import { processOf, type ModelIndex } from "./project.ts";

export interface Worklist {
  flags: { id: string; ref: string; text: string; by: string }[];
  /** Per repo with more than one: the commits its generated things were indexed at, most first. */
  drift: { repo: string; commits: { sha: string; count: number }[] }[];
  /** Generated things the importer found gone, still in the model. */
  gone: string[];
  /** Calls guessed by name, to confirm or remove. */
  guessed: { from: string; to: string }[];
  /** Boxes put in as a guess (guess: true), to confirm or remove. */
  guessedObjects: string[];
  /** Libraries with reasons to look twice. */
  libraries: { ref: string; warnings: string[] }[];
  /** Top-level code (crates, packages) that no process boundary claims. */
  unplaced: string[];
  /** Ref → a link that opens it in Archnemesis (or, when it isn't drawn, the nearest box that holds it). */
  links: Record<string, string>;
}

const shaOf = (source: string) => /^([^@:]+)@([^:]+):/.exec(source);

export function worklist(
  idx: ModelIndex,
  opts: {
    stats?: (p: Package) => LibStats | null;
    url?: (diagramId: string, objectId?: string) => string;
  } = {},
): Worklist {
  const all = [...idx.objects.values()];
  const w: Worklist = {
    flags: [],
    drift: [],
    gone: [],
    guessed: [],
    guessedObjects: [],
    libraries: [],
    unplaced: [],
    links: {},
  };
  // The link for an object: a view it's on, else the view of its nearest drawn ancestor.
  const linkFor = (id: string): string | undefined => {
    if (!opts.url) return undefined;
    for (let cur: string | undefined = id; cur; cur = idx.objects.get(cur)?.parentId ?? undefined) {
      const on = [...(idx.placedOn.get(cur) ?? [])][0];
      if (on) return opts.url(on, cur);
    }
    return undefined;
  };
  const ref = (id: string, link: string | undefined = linkFor(id)) => {
    const r = codeRef(idx, id);
    if (link && !w.links[r]) w.links[r] = link;
    return r;
  };

  for (const n of idx.notes.values()) {
    if (n.kind !== "note" || !n.forAgent || n.resolved) continue;
    const about = n.about ?? n.objectId;
    const link = opts.url?.(n.diagramId, about ?? undefined);
    w.flags.push({
      id: n.id,
      ref: about ? ref(about, link) : "(the view)",
      text: n.text.split("\n").join(" "),
      by: n.author.name,
    });
  }

  const shas = new Map<string, Map<string, number>>();
  for (const o of all) {
    if (!o.tags.includes(GENERATED) || o.status === "deprecated") continue;
    for (const s of o.sources ?? []) {
      const m = shaOf(s);
      if (!m) continue;
      const [, repo, sha] = m as unknown as [string, string, string];
      const per = shas.get(repo) ?? shas.set(repo, new Map()).get(repo)!;
      per.set(sha, (per.get(sha) ?? 0) + 1);
    }
  }
  for (const [repo, per] of shas)
    if (per.size > 1)
      w.drift.push({
        repo,
        commits: [...per].map(([sha, count]) => ({ sha, count })).sort((a, b) => b.count - a.count),
      });

  w.gone = all
    .filter((o) => o.tags.includes(GENERATED) && o.status === "deprecated")
    .map((o) => ref(o.id));
  w.guessed = [...idx.connections.values()]
    .filter((c) => c.guess && c.status !== "removed")
    .map((c) => ({ from: ref(c.fromId), to: ref(c.toId) }));
  w.guessedObjects = all.filter((o) => o.guess && o.status !== "removed").map((o) => ref(o.id));

  if (opts.stats)
    for (const o of all) {
      if (o.kind !== "library" || !o.package) continue;
      const warnings = opts.stats(o.package)?.warnings ?? [];
      if (warnings.length) w.libraries.push({ ref: ref(o.id), warnings });
    }

  // Top-level code: a module whose parent isn't a module. Where it runs is a person's (or an
  // agent's) call; code can't say, so it's asked for here, once a design draws processes.
  const hasProcesses = [...idx.boundaries.values()].some((b) => b.kind === "process");
  if (hasProcesses) {
    const isModule = (o?: ModelObject) => o?.kind === "module";
    for (const o of all)
      if (
        o.kind === "module" &&
        o.status !== "deprecated" &&
        !isModule(o.parentId ? idx.objects.get(o.parentId) : undefined) &&
        !processOf(idx, o.id)
      ) {
        const inside = all.some(
          (x) => x.parentId === o.id && x.kind === "module" && processOf(idx, x.id),
        );
        if (!inside) w.unplaced.push(ref(o.id));
      }
  }
  return w;
}

export const isEmpty = (w: Worklist) =>
  !w.flags.length &&
  !w.drift.length &&
  !w.gone.length &&
  !w.guessed.length &&
  !w.guessedObjects?.length &&
  !w.libraries.length &&
  !w.unplaced.length;

/** The worklist as instructions an agent follows. */
export function worklistText(w: Worklist, design: string, opts: { max?: number } = {}): string {
  if (isEmpty(w))
    return `Nothing to curate in ${design}: no open flags, no drift, nothing gone, no guesses.`;
  const max = opts.max ?? 25;
  const at = (r: string) => (w.links[r] ? ` (${w.links[r]})` : "");
  const some = <T>(xs: T[], line: (x: T) => string) => [
    ...xs.slice(0, max).map(line),
    ...(xs.length > max ? [`  … and ${xs.length - max} more`] : []),
  ];
  const out = [
    `Curate ${design}: make every fix below on ONE fork (design {action: "fork"}, then write with design "<the fork>"), then propose it and give the person the link. Don't merge. Skip what you can't settle from the code; say why in your summary.`,
  ];
  if (w.flags.length)
    out.push(
      "",
      `Open flags (${w.flags.length}): fix what each says in the model, then resolve it (note {action: "resolve", note, text}) with a line on what you did.`,
      ...some(w.flags, (f) => `  ${f.id} on ${f.ref}${at(f.ref)} (${f.by}): ${f.text}`),
    );
  if (w.drift.length)
    out.push(
      "",
      "Drift: generated things indexed at different commits. Run `archnm import <repo> --under <its parent> --server <this archnm> --design <the fork>` at the repo's current commit:",
      ...w.drift.map(
        (d) => `  ${d.repo}: ${d.commits.map((c) => `${c.sha} (${c.count})`).join(", ")}`,
      ),
    );
  if (w.gone.length)
    out.push(
      "",
      `Gone from the code (${w.gone.length}): check nothing still needs each, then remove it.`,
      ...some(w.gone, (r) => `  ${r}${at(r)}`),
    );
  if (w.guessed.length)
    out.push(
      "",
      `Calls guessed by name (${w.guessed.length}): read the code; confirm each (connect again with guess: false) or disconnect it.`,
      ...some(w.guessed, (g) => `  ${g.from} → ${g.to}${at(g.from)}`),
    );
  if (w.guessedObjects?.length)
    out.push(
      "",
      `Boxes put in as a guess (${w.guessedObjects.length}): check each against the code or the people who know; drop guess: true, or remove it.`,
      ...some(w.guessedObjects, (r) => `  ${r}${at(r)}`),
    );
  if (w.libraries.length)
    out.push(
      "",
      `Libraries to look at twice (${w.libraries.length}): flag them for a person, or note a replacement.`,
      ...some(w.libraries, (l) => `  ${l.ref}${at(l.ref)}: ${l.warnings.join("; ")}`),
    );
  if (w.unplaced.length)
    out.push(
      "",
      `Code no process claims (${w.unplaced.length}): find what runs it (its main, the service's start command) and add it to that process boundary.`,
      ...some(w.unplaced, (r) => `  ${r}${at(r)}`),
    );
  return out.join("\n");
}
