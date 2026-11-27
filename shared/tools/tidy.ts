// Tidy a view: lay it out again and say how it reads (write's tidy).
// Layout (elk) loads when a view is tidied: the page keeps it out of its first load.
import type { Diagram, LayoutDirection, Op, Placement } from "../model.ts";
import { crossingHelp, noteLanes, projectDiagram, type ModelIndex } from "../project.ts";
import { scoreGraph, scoreLine } from "../score.ts";
import type { Host } from "./host.ts";

/** The index as it would be after layout ops (placements and the view itself), without committing. */
function preview(idx: ModelIndex, ops: Op[]): ModelIndex {
  const placements = new Map(
    [...idx.placements].map(([d, m]) => [d, new Map(m)] as [string, Map<string, Placement>]),
  );
  const diagrams = new Map(idx.diagrams);
  for (const op of ops) {
    if (op.op === "placement.put")
      placements.set(
        op.placement.diagramId,
        (placements.get(op.placement.diagramId) ?? new Map()).set(
          op.placement.objectId,
          op.placement,
        ),
      );
    else if (op.op === "placement.delete") placements.get(op.diagramId)?.delete(op.objectId);
    else if (op.op === "diagram.put") diagrams.set(op.diagram.id, op.diagram);
  }
  return { ...idx, placements, diagrams };
}

export function measure(idx: ModelIndex, diagramId: string) {
  const g = projectDiagram(idx, diagramId);
  const all = [...g.nodes, ...g.groups];
  if (!all.length) return { score: scoreGraph(g), w: 0, h: 0 };
  const x0 = Math.min(...all.map((n) => n.x));
  const y0 = Math.min(...all.map((n) => n.y));
  return {
    score: scoreGraph(g),
    w: Math.round(Math.max(...all.map((n) => n.x + n.w)) - x0),
    h: Math.round(Math.max(...all.map((n) => n.y + n.h)) - y0),
  };
}

/** A long strip reads badly on a screen (about 16:10). */
const stripness = (m: { w: number; h: number; score: { boxes: number } }) =>
  m.w && m.h && m.score.boxes >= 4 ? Math.max(m.w / m.h, m.h / m.w) : 1;
/** The crossings advice each view was last given, by id (in memory: advice, not the model). */
const advised = new Map<string, string>();
const OTHER: Partial<Record<string, LayoutDirection>> = { right: "down", down: "right" };

/** Lay one view out and commit it; says how it reads after. */
/** step: the write this tidy is part of; once started, the tidy joins it (one undo, one history line). */
/** settings: what the same write changed on the view (arrows curved → elbow), said apart from the boxes moving. */
export async function tidyView(
  host: Host,
  d: Diagram,
  direction?: LayoutDirection,
  step: { started: boolean } = { started: false },
  settings: readonly string[] = [],
): Promise<string> {
  const idx = host.index();
  if (!idx.placements.get(d.id)?.size) {
    // A view that follows rules and shows nothing: say which rules, the usual cause.
    const r = d.rules;
    const why = r
      ? r.include.length
        ? `: its rules (include: ${JSON.stringify(r.include)}${r.exclude.length ? `, exclude: ${JSON.stringify(r.exclude)}` : ""}) pick nothing`
        : `: it has no include rule, so nothing is on it; add include: [{children: <box>}, {neighbours: <box>}]`
      : ": no boxes picked (boxes: [...])";
    return `${d.key ?? d.id}: empty, nothing to tidy${why}`;
  }
  const { layoutOps } = await import("../layout.ts");
  const tags = host.config().tags;
  let dir = (direction ?? d.tidy ?? "right") as LayoutDirection;
  let ops = await layoutOps(idx, d.id, dir, tags);
  let turned = "";
  // No direction asked for and it came out a long strip: try the other way.
  if (!direction && ops.length && OTHER[dir]) {
    const a = measure(preview(idx, ops), d.id);
    if (stripness(a) > 2.5) {
      const alt = OTHER[dir]!;
      const altOps = await layoutOps(idx, d.id, alt, tags);
      const b = measure(preview(idx, altOps), d.id);
      if (stripness(b) < stripness(a) && b.score.crossings <= a.score.crossings + 2) {
        turned = ` (laid out ${alt}: ${dir} made a ${a.w}×${a.h} strip)`;
        ops = altOps;
        dir = alt;
      }
    }
  }
  if (dir !== d.tidy)
    ops.unshift({
      op: "diagram.put",
      diagram: { ...d, tidy: dir, updatedAt: new Date().toISOString() },
    });
  if (!ops.length) {
    const m = measure(idx, d.id);
    noteLanes(d.id, !!d.lanes, m.score.crossings);
    const other = dir === "down" ? "right" : "down";
    if (settings.length)
      return `${d.key ?? d.id}: its settings changed (${settings.join(", ")}); no box moved: it's already laid out ${dir} (${scoreLine(m.score)}, ${m.w}×${m.h}).`;
    return `${d.key ?? d.id}: nothing moved: it's already laid out ${dir}${direction ? "" : " (the way it was last tidied)"} (${scoreLine(m.score)}, ${m.w}×${m.h}). For another shape: tidy it with direction: "${other}"; to change what's on it, change its boxes or rules.`;
  }
  await host.commit(ops, `tidied ${d.name}`, step.started ? { join: true } : undefined);
  step.started = true;
  const m = measure(host.index(), d.id);
  const now = host.index().diagrams.get(d.id) ?? d;
  noteLanes(d.id, !!now.lanes, m.score.crossings);
  const help = m.score.crossings >= 2 ? crossingHelp(host.index(), d.id) : [];
  // The options in full the first time a view is tidied with them; after that, only that they
  // stand (the same paragraph on every tidy, skimmed after the first).
  const said = help.join("; or ");
  const again = said && advised.get(d.id) === said;
  if (said) advised.set(d.id, said);
  const left =
    m.score.crossings >= 2
      ? ` ${m.score.crossings} lines still cross${again ? ` (the options are as the last tidy said; read {view: "${d.key ?? d.id}"} has them)` : help.length ? `: ${said}` : " with everything a layout can do already set: leave it, or take boxes off"}.`
      : "";
  return `tidied ${d.key ?? d.id}${turned}: ${scoreLine(m.score)}, ${m.w}×${m.h}.${left}`;
}
