// The scope slice: a brief for working inside one box, under a token budget. The scope in
// full; its direct neighbours as contracts (what they are, what they expose, what they take,
// return and carry, how the lines are labelled); everything else as names, nearest and
// busiest first. What doesn't fit is said, with the call that gets it.
import { entitySummary, signatureTypes } from "../entities.ts";
import type { Connection, ModelObject } from "../model.ts";
import { descendants, type ModelIndex } from "../project.ts";
import { purpose } from "./host.ts";
import { boxLine, carriesOf, edgeLine, entityByName, idOf, refOf, usesOf } from "./refs.ts";

/** About four characters a token: close enough to budget by. */
const tokens = (s: string) => Math.ceil(s.length / 4);

export function scopeSlice(
  idx: ModelIndex,
  scope: ModelObject,
  o: { budget: number; design: string; guesses?: boolean },
): string {
  const mine = new Set([scope.id, ...descendants(idx, scope.id)]);
  // Calls only guessed by name are mostly noise: left out unless asked for, and counted.
  let guessed = 0;
  const lines = [...idx.connections.values()].filter((c) =>
    c.guess && !o.guesses && (mine.has(c.fromId) || mine.has(c.toId)) ? (guessed++, false) : true,
  );
  const out: string[] = [];
  let used = 0;
  let full = false;
  const push = (line: string): boolean => {
    if (full) return false;
    if (used + tokens(line) > o.budget) {
      full = true;
      return false;
    }
    out.push(line);
    used += tokens(line) + 1;
    return true;
  };
  const cut: string[] = [];

  // 1. The scope in full: the tree, each box's signature and context, its entities, its lines.
  push(`# scope ${idOf(scope)}: ${scope.name} (${plural(mine.size, "box", "boxes")})`);
  if (guessed)
    push(
      `(${plural(guessed, "guessed call", "guessed calls")} left out: calls the importer matched by name only. read {scope: "${idOf(scope)}", guesses: true} shows them)`,
    );
  // Code reads by file: a call between functions is shown as the file it goes to, a call
  // inside one file not at all, and functions nobody has described as one line of names.
  const isCode = (x: ModelObject | undefined) => x?.kind === "function" || x?.kind === "module";
  const fileOf = (id: string): string => {
    const x = idx.objects.get(id);
    return x?.kind === "function" && x.parentId ? fileOf(x.parentId) : id;
  };
  const shortName = (id: string) => idx.objects.get(id)?.name.replace(/\(\)$/, "") ?? id;
  const plain = (x: ModelObject) =>
    x.kind === "function" &&
    !(x.context || x.description || "").trim() &&
    !x.signature &&
    !(idx.children.get(x.id) ?? []).length;
  const walk = (o2: ModelObject, depth: number) => {
    const pad = "  ".repeat(depth);
    if (!push(`${pad}${boxLine(idx, o2, { purpose: false })}`)) return cut.push(refOf(idx, o2.id));
    const text = (o2.context || o2.description || "").trim();
    if (text)
      push(`${pad}  ${depth === 0 ? text.replace(/\n/g, `\n${pad}  `) : purpose(text, 160)}`);
    const uses = usesOf(idx, o2);
    if (uses.length) push(`${pad}  uses: ${uses.join(", ")}`);
    const toFiles = new Map<string, string[]>();
    for (const c of lines) {
      if (c.fromId !== o2.id) continue;
      const to = idx.objects.get(c.toId);
      if (isCode(o2) && isCode(to) && !c.name) {
        const f = fileOf(c.toId);
        if (f !== fileOf(o2.id))
          toFiles.set(f, [
            ...(toFiles.get(f) ?? []),
            to?.kind === "function" ? shortName(c.toId) : "",
          ]);
      } else push(`${pad}  ${edgeLine(idx, c, "out")}`);
    }
    for (const [f, names] of toFiles) {
      const n = names.filter(Boolean);
      push(
        `${pad}  → ${refOf(idx, f)}${n.length ? `: ${n.slice(0, 8).join(", ")}${n.length > 8 ? `, … ${n.length - 8} more` : ""}` : ""}`,
      );
    }
    const kids = idx.children.get(o2.id) ?? [];
    const quiet = kids.filter(plain);
    for (const ch of kids) if (!quiet.includes(ch)) walk(ch, depth + 1);
    // Named, with how to refer to them: a function's ref is its file's and its name.
    if (quiet.length)
      push(
        `${pad}  ${quiet.length === 1 ? "and" : `and ${quiet.length} more functions`}${o2.kind === "module" && o2.path ? ` (refs ${o2.path}#<name>)` : ""}: ${quiet
          .slice(0, 24)
          .map((x) => shortName(x.id))
          .join(", ")}${quiet.length > 24 ? `, … ${quiet.length - 24} more` : ""}`,
      );
  };
  walk(scope, 0);
  const ents = [...idx.entities.values()].filter((e) => e.sourceId && mine.has(e.sourceId));
  if (ents.length) {
    push("entities defined here:");
    for (const e of ents)
      push(
        `  ${e.name} (${entitySummary(e)}) in ${idOf(idx.objects.get(e.sourceId!)!)}${e.fields.length ? `: ${e.fields.join("; ")}` : e.values?.length ? `: ${e.values.join(" | ")}` : ""}`,
      );
  }
  const callers = lines.filter((c) => mine.has(c.toId) && !mine.has(c.fromId));
  if (callers.length) {
    push("called from outside:");
    // Calls between code, by the calling file and what in here it calls; the rest one each.
    const byFile = new Map<string, { from: Set<string>; to: Set<string> }>();
    for (const c of callers) {
      if (isCode(idx.objects.get(c.fromId)) && isCode(idx.objects.get(c.toId)) && !c.name) {
        const f = fileOf(c.fromId);
        const g = byFile.get(f) ?? { from: new Set<string>(), to: new Set<string>() };
        if (c.fromId !== f) g.from.add(shortName(c.fromId));
        g.to.add(shortName(c.toId));
        byFile.set(f, g);
      } else push(`  ${edgeLine(idx, c, "in")} → ${refOf(idx, c.toId)}`);
    }
    const few = (s: Set<string>, n: number) =>
      `${[...s].slice(0, n).join(", ")}${s.size > n ? `, … ${s.size - n} more` : ""}`;
    for (const [f, g] of byFile)
      push(
        `  ← ${refOf(idx, f)}${g.from.size ? ` (${few(g.from, 6)})` : ""} calls ${few(g.to, 8)}`,
      );
  }

  // 2. Neighbours as contracts: a function outside stands for its file, so a file that many
  // calls reach is one neighbour, not one per function.
  const touching = lines.filter((c) => mine.has(c.fromId) !== mine.has(c.toId));
  const near = new Map<string, Connection[]>();
  for (const c of touching) {
    const end = mine.has(c.fromId) ? c.toId : c.fromId;
    const other = idx.objects.get(end)?.kind === "function" ? fileOf(end) : end;
    near.set(other, [...(near.get(other) ?? []), c]);
  }
  if (near.size) push(`# neighbours (${near.size}), as contracts`);
  const neighbours = [...near].sort((a, b) => b[1].length - a[1].length);
  for (const [id, cs] of neighbours) {
    const n = idx.objects.get(id);
    if (!n) continue;
    if (!push(`${boxLine(idx, n, { purpose: false, parent: true })}`)) {
      cut.push(refOf(idx, id));
      continue;
    }
    const why = purpose(n.context || n.description, 140);
    if (why) push(`  ${why}`);
    // The labelled lines first (they say what travels); a file's plain calls past six as a count.
    const shown = [...cs].sort((a, b) => Number(!a.name) - Number(!b.name));
    for (const c of shown.slice(0, 6))
      push(
        `  ${mine.has(c.fromId) ? `← ${refOf(idx, c.fromId)}` : `→ ${refOf(idx, c.toId)}`}${c.name ? `  ${c.name}` : ""}${c.technology ? ` (${c.technology})` : ""}${carriesOf(idx, c).length ? ` carries ${carriesOf(idx, c).join(", ")}` : ""}`,
      );
    if (shown.length > 6)
      push(`  … ${shown.length - 6} more lines with it: read {ref: "${refOf(idx, id)}"}`);
    // What it exposes: functions inside it that have a signature, the called ones first.
    const fns = [id, ...descendants(idx, id)]
      .map((x) => idx.objects.get(x)!)
      .filter((x) => x && x.kind === "function" && x.signature);
    const called = new Set(cs.map((c) => (mine.has(c.fromId) ? c.toId : c.fromId)));
    fns.sort((a, b) => Number(!called.has(a.id)) - Number(!called.has(b.id)));
    for (const f of fns.slice(0, 6)) push(`  exposes ${refOf(idx, f.id)} ${f.signature}`);
    if (fns.length > 6) push(`  … ${fns.length - 6} more functions: read {scope: "${idOf(n)}"}`);
    const types = new Set([
      ...usesOf(idx, n),
      ...fns.flatMap((f) => signatureTypes(f.signature)),
      ...cs.flatMap((c) => carriesOf(idx, c)),
    ]);
    const shapes = [...types].map((t) => entityByName(idx, t)).filter((e) => !!e);
    if (shapes.length)
      push(
        `  takes/returns: ${shapes.map((e) => `${e!.name}${e!.fields.length ? ` {${e!.fields.slice(0, 6).join("; ")}${e!.fields.length > 6 ? "; …" : ""}}` : e!.values?.length ? ` (${e!.values.join(" | ")})` : " (TBD)"}`).join(", ")}`,
      );
  }

  // 3. Everything else, as names: by distance over connections, then by how connected.
  const degree = new Map<string, number>();
  for (const c of lines) {
    degree.set(c.fromId, (degree.get(c.fromId) ?? 0) + 1);
    degree.set(c.toId, (degree.get(c.toId) ?? 0) + 1);
  }
  const dist = new Map<string, number>();
  let frontier = [...near.keys()];
  for (const f of frontier) dist.set(f, 1);
  const adj = new Map<string, string[]>();
  for (const c of lines) {
    adj.set(c.fromId, [...(adj.get(c.fromId) ?? []), c.toId]);
    adj.set(c.toId, [...(adj.get(c.toId) ?? []), c.fromId]);
  }
  for (let d = 2; frontier.length; d++) {
    const next: string[] = [];
    for (const f of frontier)
      for (const x of adj.get(f) ?? [])
        if (!dist.has(x) && !mine.has(x)) {
          dist.set(x, d);
          next.push(x);
        }
    frontier = next;
  }
  // Imported code far from here is noise in a brief (half of every worker's budget went
  // on ~20,000 unrelated names): only what's connected, and the designed boxes.
  const code = (x: ModelObject) =>
    x.kind === "function" || (x.kind === "module" && !!x.tags?.includes("generated"));
  const rest = [...idx.objects.values()].filter(
    (x) =>
      !mine.has(x.id) &&
      !near.has(x.id) &&
      x.status !== "removed" &&
      !mine.has(x.parentId ?? "") &&
      (dist.has(x.id) || !code(x)),
  );
  const restBudget = Math.max(200, Math.round(o.budget / 6));
  let restUsed = 0;
  rest.sort(
    (a, b) =>
      (dist.get(a.id) ?? 99) - (dist.get(b.id) ?? 99) ||
      (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) ||
      idOf(a).localeCompare(idOf(b)),
  );
  if (rest.length && !full) {
    push(`# the rest (${rest.length}), nearest first`);
    let line = "";
    let shown = 0;
    for (const x of rest) {
      const add = `${line ? ", " : ""}${refOf(idx, x.id)}`;
      if (tokens(line + add) > 60) {
        restUsed += tokens(line);
        if (restUsed > restBudget || !push(line)) {
          shown -= line.split(", ").length;
          line = "";
          break;
        }
        line = "";
      }
      line += line ? `, ${refOf(idx, x.id)}` : refOf(idx, x.id);
      shown++;
    }
    if (line && push(line)) {
      /* the last line fit */
    } else if (line) shown -= line.split(", ").length;
    if (shown < rest.length) cut.push(`${rest.length - shown} names`);
  } else if (rest.length) cut.push(`${rest.length} names`);
  if (full || cut.length)
    out.push(
      `… over the budget of ${o.budget} tokens; left out: ${cut.slice(0, 12).join(", ")}${cut.length > 12 ? ", …" : ""}. More: read {scope: <one of them>} for its own brief, a part at a time (the next page, at this size), read {scope: "${idOf(scope)}", budget: ${o.budget * 2}} for all at once, or read {ref} on one.`,
    );
  return out.join("\n");
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
