// How readable each diagram is, as numbers and as warnings an agent can act on: too many
// boxes or lines for one screen, arrows that cross, and things with an inside that no
// diagram opens. Used by `archnm check`, the MCP's check and apply, and the outline.
import type { Problem } from "./files.ts";
import { DEFAULT_LIMITS } from "./files.ts";
import {
  ancestors,
  lineEnds,
  projectDiagram,
  type CanvasGraph,
  type ModelIndex,
} from "./project.ts";
import { framePoint } from "./router.ts";
import { crossesRegions } from "./boundaries.ts";

/** The model file an object is written to: its top-level ancestor's. */
const fileOf = (idx: ModelIndex, id: string) => {
  const top = ancestors(idx, id).at(-1) ?? id;
  return idx.objects.get(top)?.key ?? top;
};

export interface ViewScore {
  boxes: number;
  lines: number;
  /** Pairs of confirmed arrows that cross, drawn straight centre to centre (close to what's drawn). */
  crossings: number;
  /** Pairs that cross where one or both are only guesses (calls matched by name): counted apart, since confirming or hiding them is the fix, not the layout. */
  guessCrossings: number;
  /** Pairs of confirmed calls between code (functions, files) that cross: a call graph rolled up; flows and paths read it better than any layout. */
  codeCrossings: number;
  /** Externals folded into one box. */
  folded: number;
}

export function scoreGraph(g: CanvasGraph): ViewScore {
  const at = new Map(g.nodes.map((n) => [n.id, { x: n.x + n.w / 2, y: n.y + n.h / 2 }]));
  // A line to a frame ends on its border, facing the other end.
  const ends = lineEnds(g);
  const end = (id: string, other: string) =>
    at.get(id) ??
    (ends.has(id) && ends.has(other) ? framePoint(ends.get(id)!, ends.get(other)!) : undefined);
  const segs = g.edges.flatMap((e) => {
    const a = end(e.from, e.to);
    const b = end(e.to, e.from);
    return a && b ? [{ e, a, b }] : [];
  });
  let crossings = 0;
  let guessCrossings = 0;
  let codeCrossings = 0;
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const s = segs[i]!;
      const t = segs[j]!;
      // Arrows sharing a box meet there; that's not a crossing.
      if (s.e.from === t.e.from || s.e.from === t.e.to || s.e.to === t.e.from || s.e.to === t.e.to)
        continue;
      if (cross(s.a, s.b, t.a, t.b)) {
        if (s.e.guess || t.e.guess) guessCrossings++;
        else if (s.e.code && t.e.code) codeCrossings++;
        else crossings++;
      }
    }
  }
  return {
    boxes: g.nodes.length,
    lines: g.edges.length,
    crossings,
    guessCrossings,
    codeCrossings,
    folded: g.nodes.reduce((n, x) => n + (x.folded?.length ?? 0), 0),
  };
}

type P = { x: number; y: number };
const side = (a: P, b: P, c: P) => Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
const cross = (a: P, b: P, c: P, d: P) =>
  side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0;

export function scoreView(idx: ModelIndex, diagramId: string): ViewScore {
  return scoreGraph(projectDiagram(idx, diagramId));
}

/** One line for an outline: "12 boxes, 18 lines, 3 crossings". */
export function scoreLine(s: ViewScore): string {
  return `${s.boxes} boxes, ${s.lines} lines, ${s.crossings} crossing${s.crossings === 1 ? "" : "s"}${s.guessCrossings ? ` (and ${s.guessCrossings} with guessed lines)` : ""}${s.codeCrossings ? ` (and ${s.codeCrossings} among code calls)` : ""}${s.folded ? `, ${s.folded} externals folded` : ""}`;
}

/** What to do about a busy diagram, in the order to try it. */
const BUSY_FIX =
  "fold the externals (fold: externals), hide supporting lines (hide_lines), scope it tighter, or split it into views that each tell one story";

export function viewProblems(
  idx: ModelIndex,
  limits: { boxes?: number; lines?: number } = {},
): Problem[] {
  const maxBoxes = limits.boxes ?? DEFAULT_LIMITS.boxes;
  const maxLines = limits.lines ?? DEFAULT_LIMITS.lines;
  const out: Problem[] = [];
  for (const d of idx.diagrams.values()) {
    const file = `views/${d.key ?? d.id}.yaml`;
    const s = scoreView(idx, d.id);
    if (s.boxes > maxBoxes)
      out.push({
        level: "warning",
        file,
        message: `${d.name}: ${s.boxes} boxes, past the ${maxBoxes} that read at a glance; ${BUSY_FIX}`,
      });
    if (s.lines > maxLines)
      out.push({
        level: "warning",
        file,
        message: `${d.name}: ${s.lines} lines, past ${maxLines}; ${BUSY_FIX}`,
      });
    // Lines hidden until none are left: a view of boxes with nothing between them.
    if (d.hideLines?.length && s.boxes >= 3 && s.lines === 0)
      out.push({
        level: "warning",
        file,
        message: `${d.name}: hide_lines leaves no lines at all (${s.boxes} boxes); take out the rule that hides too much, or say why in its story`,
      });
    // A few crossings are normal; many means the layout is fighting the shape of the graph.
    if (s.crossings > Math.max(4, Math.ceil(s.lines / 3)))
      out.push({
        level: "warning",
        file,
        message: `${d.name}: ${s.crossings} arrows cross; tidy it (Archnemesis tidy)${d.lanes ? "" : ", or set lanes to put each layer in its own column"}`,
      });
  }
  // Something with an inside that no diagram opens: its parts are only ever seen rolled up.
  const scoped = new Set([...idx.diagrams.values()].map((d) => d.scopeId).filter(Boolean));
  for (const o of idx.objects.values()) {
    const inside = idx.children.get(o.id)?.filter((c) => c.status !== "removed") ?? [];
    // Not for a module (a folder or a file): the navigator opens those, and a diagram that
    // draws one shows it as a frame around its insides.
    // Nor for a box of a few files (29 views, several of two files): opening it on
    // the canvas draws them. Parts that aren't code, or more files than that, do want one.
    const codeOnly = inside.every((c) => c.kind === "module" || c.kind === "function");
    // A group of files only (a component over a path pattern) opens like a folder: no view needed
    // (dozens of these warnings for groups that only organise files).
    if (
      !codeOnly &&
      inside.length >= 2 &&
      !scoped.has(o.id) &&
      o.status !== "removed" &&
      o.kind !== "module"
    )
      out.push({
        level: "warning",
        file: `model/${fileOf(idx, o.id)}.yaml`,
        message: `${o.name} has ${inside.length} things inside it but no diagram of its own; add a view with scope: ${o.key ?? o.id}`,
      });
  }
  // Residency: a pointer across regions should carry only an opaque id. A key held in a
  // column marked personal (or by a table tagged personal-data) carries more than that.
  for (const c of idx.connections.values()) {
    if (c.status === "removed") continue;
    const across = crossesRegions(idx, c.fromId, c.toId);
    if (!across) continue;
    const from = idx.objects.get(c.fromId);
    if (from?.kind !== "table") continue;
    const col = c.column ? from.columns?.find((x) => x.name === c.column) : undefined;
    const what = col?.personal
      ? `its column ${col.name} is marked personal`
      : from.tags.some(isPersonal)
        ? "the table is tagged personal data"
        : null;
    if (what)
      out.push({
        level: "warning",
        file: `model/${fileOf(idx, from.id)}.yaml`,
        message: `${from.name}${c.column ? `.${c.column}` : ""} → ${idx.objects.get(c.toId)?.name ?? c.toId} reaches across regions (${across}) and ${what}: a pointer across a residency line should carry only an opaque id; move the value into the other region, or mark what it holds correctly`,
      });
  }
  return out;
}

/** personal-data, or a value of that tag group (personal-data:holds), except personal-data:none. */
const isPersonal = (t: string) =>
  (t === "personal-data" || t.startsWith("personal-data:")) && t !== "personal-data:none";
