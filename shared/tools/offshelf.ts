// An experiment (ARCHNM_EXPERIMENTS=offshelf): what a write says back so that a plan leans on
// existing tools and libraries instead of code of its own. Agents planning a system drew queues,
// workers and hand-written clients first and named packages only in tech; advice in a playbook is
// read once, if at all, so this speaks at the moment of writing. Off unless the server asks for
// it: taking it out is unsetting the variable.
import { statsLine, type LibStats } from "../libstats.ts";
import { mergedContext, type ModelObject, type Op, type Package } from "../model.ts";
import { descendants, type ModelIndex } from "../project.ts";
import type { Host } from "./host.ts";
import { idOf } from "./refs.ts";

export const OFFSHELF = "offshelf";

/** The one line added to what every agent is told, while the experiment is on. */
export const OFFSHELF_LINE =
  "- Off the shelf first: an existing tool or library before code of your own, written as a library box (kind: library, package: {ecosystem, name, version}) connected from what uses it. What you would write yourself says why in its context.";

/** Names that are usually something a library or a service already does. */
const USUAL =
  /\b(queue|worker|scheduler|cron|cache|retry|retries|backoff|throttle|rate.?limit\w*|parser|scraper|fetcher|http.?client|api.?client|client|router|pool|migrations?|logger|logging|validator|validation|auth|session|sync)\b/i;
/** A box whose context already says why it's written by hand. */
const SAYS_WHY =
  /hand.?(written|rolled)|no (existing |good )?(library|tool)|nothing (existing|off the shelf)/i;

const list = (xs: string[], n = 6) =>
  `${xs.slice(0, n).join(", ")}${xs.length > n ? ` and ${xs.length - n} more` : ""}`;

/** What to say after a write, each a line; none when there's nothing to push on. */
export async function offShelfNotes(host: Host, before: ModelIndex, ops: Op[]): Promise<string[]> {
  if (!host.experiments?.has(OFFSHELF)) return [];
  const now = host.index();
  const out: string[] = [];
  const put = ops.flatMap((op) => (op.op === "object.put" ? [op.object] : []));
  const libs = [...now.objects.values()].filter(
    (o) => o.kind === "library" && o.status !== "removed",
  );

  // Each new library, with how well kept it is: the evidence right after the pick.
  const fresh = put.filter((o) => o.kind === "library" && o.package && !before.objects.has(o.id));
  for (const lib of fresh.slice(0, 8)) {
    const s = await statsFor(host, lib.package!);
    if (!s) continue;
    if (s.error && /answered 404/.test(s.error))
      out.push(
        `warning: ${idOf(lib)}: ${lib.package!.name} wasn't found on ${lib.package!.ecosystem}. Check the name against the registry: package names get made up.`,
      );
    else if (!s.error || s.latest) out.push(`library ${idOf(lib)}: ${statsLine(s)}`);
  }

  // Packages named only in tech.
  const known = libs.flatMap((l) => [l.name, l.package?.name ?? ""]).map((x) => x.toLowerCase());
  const isKnown = (t: string) =>
    known.some((k) => k && (k === t || k.includes(t) || t.includes(k)));
  const loose = new Set<string>();
  for (const o of put) {
    if (o.kind === "library" || o.status !== "future") continue;
    for (const t of o.technology.split(",").map((x) => x.trim()))
      if (t && !isKnown(t.toLowerCase())) loose.add(t);
  }
  if (loose.size)
    out.push(
      `off the shelf: tech names ${list([...loose])} with no library box. Write the packages among them as libraries (kind: library, package: {ecosystem, name, version}), connected from what uses them; a language or a runtime can stay as tech.`,
    );

  // New planned parts that are usually a library's job, with no library behind them.
  const usesLib = (o: ModelObject) => {
    const mine = new Set([o.id, ...descendants(now, o.id)]);
    for (const c of now.connections.values())
      if (mine.has(c.fromId) && now.objects.get(c.toId)?.kind === "library") return true;
    for (const id of mine)
      if (now.objects.get(id)?.references?.some((r) => r.kind === "dependency")) return true;
    return false;
  };
  const byHand = put.filter(
    (o) =>
      !before.objects.has(o.id) &&
      o.status === "future" &&
      (o.kind === "component" || o.kind === "module" || o.kind === "function") &&
      USUAL.test(o.name.replace(/[._/-]/g, " ")) &&
      !SAYS_WHY.test(mergedContext(o.description, o.context)) &&
      !usesLib(o),
  );
  if (byHand.length)
    out.push(
      `off the shelf: ${list(byHand.map((o) => idOf(o)))} ${byHand.length === 1 ? "looks" : "look"} hand-written, and that's usually a tool's or a library's job. Is there one? Connect it (from: <the box>, to: <the library>), or say in the box's context why it's written by hand.`,
    );
  return out;
}

/** A library's stats: fetched now when the server can, else what it has kept. */
async function statsFor(host: Host, p: Package): Promise<LibStats | null> {
  try {
    return (await host.statsNow?.(p)) ?? host.stats?.(p) ?? null;
  } catch {
    return host.stats?.(p) ?? null;
  }
}
