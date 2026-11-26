// Lay out a diagram with ELK's layered algorithm: callers before callees, few crossings.
// Runs on the server (the MCP's tidy) and in the browser (Lay out, loaded on first use).
// A hand-placed box is never moved unless a whole diagram is laid out on request.
import ELK, { type ElkNode } from "elkjs/lib/elk.bundled.js";
import { moveOps } from "./actions.ts";
import { boundaryPath } from "./boundaries.ts";
import { shiftBends } from "./align.ts";
import type { LayoutDirection, Op } from "./model.ts";
import { ancestors, laneOf, projectDiagram, type CanvasGraph, type ModelIndex } from "./project.ts";

export { type LayoutDirection } from "./model.ts";

let elk: InstanceType<typeof ELK> | null = null;

/**
 * Where each box goes: callers left of callees ("right") or above them ("down"), on the
 * 8px grid, with the whole thing's top-left at `origin`.
 */
export async function layout(
  nodes: { id: string; w: number; h: number }[],
  edges: { from: string; to: string; label?: string }[],
  direction: LayoutDirection = "right",
  origin = { x: 0, y: 0 },
  /** Boxes that belong together (a boundary, outermost first): laid out as nested groups. */
  clusters?: Map<string, string[]>,
  /** Lanes: box → its column (0 first). Boxes keep to their column; arrows may go either way. */
  partitions?: Map<string, number>,
): Promise<Map<string, { x: number; y: number }>> {
  elk ??= new ELK();
  const ids = new Set(nodes.map((n) => n.id));
  // Nested groups, when asked for: each boundary a node holding its boxes and inner boundaries.
  const groupNodes = new Map<string, ElkNode>();
  const top: ElkNode[] = [];
  const holder = (path: string[]): ElkNode[] => {
    let list = top;
    for (let i = 0; i < path.length; i++) {
      const gid = `group:${path.slice(0, i + 1).join("/")}`;
      let n = groupNodes.get(gid);
      if (!n) {
        // A file's frame is drawn snug around its functions; a boundary's has room for its title.
        const pad = path[i]!.startsWith("frame:")
          ? "[top=44,left=20,bottom=20,right=20]"
          : "[top=70,left=36,bottom=36,right=36]";
        n = { id: gid, children: [], layoutOptions: { "elk.padding": pad } };
        groupNodes.set(gid, n);
        list.push(n);
      }
      list = n.children!;
    }
    return list;
  };
  const lane = (part: number | undefined) =>
    part !== undefined ? { layoutOptions: { "elk.partitioning.partition": String(part) } } : {};
  // Lanes with groups: a group goes in one column as a whole (the one most of its boxes are
  // in), so a file's functions stay inside its frame instead of spreading over the columns.
  const votes = new Map<string, Map<number, number>>();
  for (const n of nodes) {
    const path = clusters?.get(n.id) ?? [];
    const part = partitions?.get(n.id);
    if (path.length && part !== undefined) {
      const gid = `group:${path[0]}`;
      const v = votes.get(gid) ?? votes.set(gid, new Map()).get(gid)!;
      v.set(part, (v.get(part) ?? 0) + 1);
    }
    holder(path).push({ id: n.id, width: n.w, height: n.h, ...(path.length ? {} : lane(part)) });
  }
  for (const [gid, v] of votes) {
    const g = groupNodes.get(gid)!;
    const part = [...v].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]![0];
    g.layoutOptions = { ...g.layoutOptions, ...lane(part).layoutOptions };
  }
  const input: ElkNode = {
    id: "root",
    layoutOptions: {
      ...(groupNodes.size ? { "elk.hierarchyHandling": "INCLUDE_CHILDREN" } : {}),
      ...(partitions?.size
        ? {
            "elk.partitioning.activate": "true",
            "elk.layered.spacing.nodeNodeBetweenLayers": "160",
          }
        : {}),
      "elk.algorithm": "layered",
      "elk.direction": direction === "down" ? "DOWN" : "RIGHT",
      "elk.spacing.nodeNode": direction === "down" ? "72" : "56",
      "elk.layered.spacing.nodeNodeBetweenLayers": direction === "down" ? "96" : "120",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
      // Balanced: a box sits centred over (or beside) what it calls, not off to one side.
      "elk.layered.nodePlacement.bk.fixedAlignment": "BALANCED",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.separateConnectedComponents": "true",
      "elk.spacing.componentComponent": "96",
    },
    children: top,
    // An end can be a group (a frame a line ends on: "group:…").
    edges: edges
      .filter(
        (e) =>
          (ids.has(e.from) || groupNodes.has(e.from)) &&
          (ids.has(e.to) || groupNodes.has(e.to)) &&
          e.from !== e.to,
      )
      .map((e, i) => ({ id: `e${i}`, sources: [e.from], targets: [e.to] })),
  };
  const graph = await elk.layout(input);
  // Lanes, one after another along the flow: ELK keeps their order but lets them overlap (trials
  // 19, 21, 22: the bands lay over each other, and callers landed inside a frame). Each top-level
  // box or group moves with its lane, so the order ELK found across lanes (its crossings) stays.
  if (partitions?.size) {
    const across = direction === "down" ? "y" : "x";
    const size = direction === "down" ? "height" : "width";
    const partOf = (c: ElkNode): number | undefined => {
      const p = c.layoutOptions?.["elk.partitioning.partition"];
      return p === undefined ? partitions.get(c.id) : Number(p);
    };
    const lanes = new Map<number, { from: number; to: number; items: ElkNode[] }>();
    for (const c of graph.children ?? []) {
      const p = partOf(c);
      if (p === undefined) continue;
      const at = c[across] ?? 0;
      const l = lanes.get(p) ?? lanes.set(p, { from: at, to: at, items: [] }).get(p)!;
      l.from = Math.min(l.from, at);
      l.to = Math.max(l.to, at + (c[size] ?? 0));
      l.items.push(c);
    }
    // Inside a lane, its rows close up: ELK spread them over the whole view's layers. The order
    // along each row (what keeps lines from crossing) stays as ELK found it.
    const step = direction === "down" ? 96 : 120;
    let next = Math.min(...[...lanes.values()].map((l) => l.from));
    for (const [, l] of [...lanes].sort((x, y) => x[0] - y[0])) {
      const items = [...l.items].sort((x, y) => (x[across] ?? 0) - (y[across] ?? 0));
      let rowStart = Number.NEGATIVE_INFINITY;
      let rowEnd = Number.NEGATIVE_INFINITY;
      let placed = next;
      let placedEnd = next;
      for (const c of items) {
        const at = c[across] ?? 0;
        if (at >= rowEnd) {
          // A new row: after the last one, with the usual gap.
          placed = rowStart === Number.NEGATIVE_INFINITY ? next : placedEnd + step;
          rowStart = at;
        }
        rowEnd = Math.max(rowEnd, at + (c[size] ?? 0));
        c[across] = placed + (at - rowStart);
        placedEnd = Math.max(placedEnd, c[across]! + (c[size] ?? 0));
      }
      next = placedEnd + LANE_GAP;
    }
  }
  // Positions inside a group are relative to it: add them up.
  const abs: { id: string; x: number; y: number }[] = [];
  const collect = (list: ElkNode[], dx: number, dy: number) => {
    for (const c of list) {
      const x = dx + (c.x ?? 0);
      const y = dy + (c.y ?? 0);
      if (groupNodes.has(c.id)) collect(c.children ?? [], x, y);
      else abs.push({ id: c.id, x, y });
    }
  };
  collect(graph.children ?? [], 0, 0);
  const out = new Map<string, { x: number; y: number }>();
  // ELK pads the graph; start the boxes themselves at the origin.
  const minX = Math.min(...abs.map((c) => c.x));
  const minY = Math.min(...abs.map((c) => c.y));
  const raw = new Map(abs.map((c) => [c.id, { x: c.x - minX, y: c.y - minY }]));
  roomForLines(raw, new Map(nodes.map((n) => [n.id, n])), edges, direction);
  for (const [id, p] of raw) out.set(id, { x: snap(origin.x + p.x), y: snap(origin.y + p.y) });
  return out;
}

/** Room a line takes beside its neighbours (the router keeps 12px between them), and a label row. */
const PER_LINE = 14;
const LABEL_ROW = 26;

/**
 * Rows (along the flow) get apart by what runs between them: every line that turns in a gap
 * takes room in it, and a gap with labels in it needs a row for them. A fixed gap squeezed a
 * dozen lines and their labels into 96px (an agent's service map, 2026-11-26). Moves whole rows,
 * so the order and what's beside what stay as the layout found them.
 */
export function roomForLines(
  pos: Map<string, { x: number; y: number }>,
  size: Map<string, { w: number; h: number }>,
  edges: { from: string; to: string; label?: string }[],
  direction: LayoutDirection,
): void {
  const down = direction === "down";
  const at = (id: string) => (down ? pos.get(id)!.y : pos.get(id)!.x);
  const len = (id: string) => (down ? size.get(id)!.h : size.get(id)!.w);
  const ids = [...pos.keys()].filter((id) => size.has(id)).sort((a, b) => at(a) - at(b));
  if (ids.length < 2) return;
  // Rows: boxes whose spans along the flow overlap.
  const rows: { from: number; to: number; ids: string[] }[] = [];
  for (const id of ids) {
    const last = rows[rows.length - 1];
    if (last && at(id) < last.to) {
      last.to = Math.max(last.to, at(id) + len(id));
      last.ids.push(id);
    } else rows.push({ from: at(id), to: at(id) + len(id), ids: [id] });
  }
  if (rows.length < 2) return;
  const rowOf = new Map(rows.flatMap((r, i) => r.ids.map((id) => [id, i] as const)));
  const lines = new Array<number>(rows.length - 1).fill(0);
  const labels = new Array<number>(rows.length - 1).fill(0);
  for (const e of edges) {
    const a = rowOf.get(e.from);
    const b = rowOf.get(e.to);
    if (a === undefined || b === undefined) continue;
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    // A line takes height where it turns: in the gap it leaves its row by, and the one it comes
    // into its other end by. Straight through a gap in between, it only takes width. A line
    // within a row goes round through the gap after it.
    const first = Math.min(lo, rows.length - 2);
    const last = lo === hi ? first : hi - 1;
    lines[first]!++;
    if (last !== first) lines[last]!++;
    // Its label lies along a turn: count it in the first.
    if (e.label) labels[first]!++;
  }
  let shift = 0;
  for (let i = 1; i < rows.length; i++) {
    const gap = rows[i]!.from - rows[i - 1]!.to;
    const need =
      40 +
      lines[i - 1]! * PER_LINE +
      (labels[i - 1]! ? LABEL_ROW * Math.min(2, Math.ceil(labels[i - 1]! / 6)) : 0);
    shift += Math.max(0, need - gap);
    if (shift)
      for (const id of rows[i]!.ids)
        pos.set(
          id,
          down
            ? { ...pos.get(id)!, y: pos.get(id)!.y + shift }
            : { ...pos.get(id)!, x: pos.get(id)!.x + shift },
        );
  }
}

/** Between two lanes along the flow: room for each band's padding and its title, and the lines. */
const LANE_GAP = 136;

const snap = (v: number) => Math.round(v / 8) * 8;

/**
 * Lay out a whole diagram: the moves, and its hand-shaped arrows' bends carried along,
 * as one batch of ops (empty if nothing would move). From the diagram's top-left.
 */
export async function layoutOps(
  idx: ModelIndex,
  diagramId: string,
  direction: LayoutDirection,
  /** The design's tag groups, for lanes: columns go in the order its values are listed. */
  tags?: Record<string, { values: string[] }>,
): Promise<Op[]> {
  const g = projectDiagram(idx, diagramId);
  if (g.nodes.length < 2) return [];
  const origin = {
    x: Math.min(...g.nodes.map((n) => n.x)),
    y: Math.min(...g.nodes.map((n) => n.y)),
  };
  const d = idx.diagrams.get(diagramId);
  // Lanes: a column per value, in archnm.yaml's order (else as first met). Boxes with none
  // (the people and vendors around a system) get a column of their own on either side:
  // before the lanes if they only call in, after them otherwise. Mixed into a lane's column,
  // they'd sit inside its frame.
  let partitions: Map<string, number> | undefined;
  if (d?.lanes) {
    const group = d.lanes;
    const values = tags?.[group]?.values ?? [];
    const order = [...values];
    for (const n of g.nodes) {
      const v = laneOf(idx, n.id, group);
      if (v && !order.includes(v)) order.push(v);
    }
    const laned = new Set(g.nodes.filter((n) => laneOf(idx, n.id, group)).map((n) => n.id));
    if (laned.size) {
      partitions = new Map(
        g.nodes.map((n) => {
          const v = laneOf(idx, n.id, group);
          if (v) return [n.id, order.indexOf(v) + 1] as const;
          // Parts of the viewed box without a lane: a column of their own next to the lanes, so
          // the box's frame around its parts doesn't take in the outside boxes.
          const sc = d.scopeId;
          const ins = (id: string) => !!sc && id !== sc && ancestors(idx, id).includes(sc);
          if (ins(n.id)) return [n.id, order.length + 1] as const;
          // A line to the viewed box itself (it ends on its frame) is a line in, too.
          const into = (id: string) => laned.has(id) || id === sc || ins(id);
          const callsIn = g.edges.some((e) => e.from === n.id && into(e.to));
          const calledFrom = g.edges.some((e) => e.to === n.id && into(e.from));
          return [n.id, callsIn && !calledFrom ? 0 : order.length + 2] as const;
        }),
      );
    }
  }
  // With boundaries drawn, keep each boundary's boxes together so the frames don't overlap.
  // (Lanes win over boundaries; code frames go into a lane whole, see layout.)
  // On a view inside something (and no lanes), its own parts stay together, so the frame
  // drawn around them doesn't take in the people and systems around it.
  const scope = d?.scopeId ?? null;
  const inside = (id: string) => !!scope && id !== scope && ancestors(idx, id).includes(scope);
  // Code: each function stays inside its file's frame, and each file inside its process. A
  // module whose insides run in more than one process (a crate that's the CLI and the hub)
  // can't be one group inside the processes, so it isn't one; its frame is drawn around
  // wherever its parts land.
  const frames = new Set(g.groups.filter((x) => x.container).map((x) => x.id));
  const where = (id: string) => (d?.boundaries ? boundaryPath(idx, id) : []);
  if (frames.size) {
    const spans = new Map<string, Set<string>>();
    for (const n of g.nodes)
      for (const a of ancestors(idx, n.id))
        if (frames.has(a))
          (spans.get(a) ?? spans.set(a, new Set()).get(a)!).add(where(n.id).join("/"));
    for (const [f, s] of spans) if (s.size > 1) frames.delete(f);
  }
  const framesOf = (id: string) =>
    ancestors(idx, id)
      .filter((a) => frames.has(a))
      .reverse()
      .map((a) => `frame:${a}`);
  // With lanes, only the code frames group (a group then takes one lane as a whole).
  const clusters = partitions
    ? frames.size
      ? new Map(g.nodes.map((n) => [n.id, framesOf(n.id)]))
      : undefined
    : !(
          d?.boundaries ||
          frames.size ||
          (scope && g.nodes.some((n) => inside(n.id)) && g.nodes.some((n) => !inside(n.id)))
        )
      ? undefined
      : new Map(
          g.nodes.map((n) => [
            n.id,
            [...(scope && inside(n.id) ? ["scope"] : []), ...where(n.id), ...framesOf(n.id)],
          ]),
        );
  // A line ending on a frame is laid out to the frame's group, when the frame is one here.
  const groupOf = (id: string): string | null => {
    const step = id === scope ? "scope" : `frame:${id}`;
    for (const path of clusters?.values() ?? []) {
      const i = path.indexOf(step);
      if (i >= 0) return `group:${path.slice(0, i + 1).join("/")}`;
    }
    return null;
  };
  const onIt = new Set(g.nodes.map((n) => n.id));
  const edges = g.edges.flatMap((e) => {
    const from = onIt.has(e.from) ? e.from : groupOf(e.from);
    const to = onIt.has(e.to) ? e.to : groupOf(e.to);
    return from && to ? [{ from, to, ...(e.label ? { label: e.label } : {}) }] : [];
  });
  const at = await layout(g.nodes, edges, direction, origin, clusters, partitions);
  const moves = g.nodes.flatMap((n) => {
    const p = at.get(n.id);
    return p && (p.x !== n.x || p.y !== n.y) ? [{ id: n.id, ...p }] : [];
  });
  if (!moves.length) return [];
  const before = new Map(g.nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
  const bends: Op[] = shiftBends(
    g.edges.flatMap((e) => (e.shape ? [e.shape] : [])),
    before,
    at,
  ).map((arrow) => ({ op: "arrow.put", arrow }));
  return [...moveOps(idx, diagramId, moves), ...bends];
}

/** What a diagram is made of (its boxes and arrows, not where they sit): keep tidy lays out again when this changes. */
export function structureOf(g: CanvasGraph): string {
  return `${g.nodes
    .map((n) => n.id)
    .sort()
    .join(",")}|${g.edges
    .map((e) => e.id)
    .sort()
    .join(",")}`;
}
