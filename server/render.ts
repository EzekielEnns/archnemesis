// A diagram as an image, drawn on the server: what an agent looks at to check its own work,
// what a pull request shows before and after, what a link preview uses. SVG first; PNG is
// that SVG through resvg (WebAssembly, so the build stays the same on every platform) with
// Inter bundled, since there are no system fonts to count on.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import { AvoidLib, type Avoid } from "libavoid-js";
import { EdgeRouter, routerEdges } from "../shared/router.ts";
import type { FConfig } from "../shared/files.ts";
import type { Flow } from "../shared/model.ts";
import {
  colorGraph,
  lineEnds,
  logoOf,
  projectDiagram,
  type CanvasEdge,
  type CanvasGraph,
  type CanvasNode,
  type ModelIndex,
} from "../shared/project.ts";
import {
  BoxGrid,
  arrowHead,
  pinOffset,
  pinOffsets,
  bentRoute,
  boundsOf,
  curveAround,
  chooseSides,
  placeLabel,
  placeLabelOn,
  fanSides,
  fanStart,
  forkRoute,
  startAt,
  ports,
  route,
  routePoint,
  traceRoute,
  type Point,
  type Rect,
  type Route,
  type Side,
  clipToBoxes,
  lineRoute,
} from "../shared/geometry.ts";
import { brandColor, iconFor, iconSvg } from "../shared/icons.ts";

// The canvas's colours (src/canvas/Scene.ts THEME), so an image reads like the app.
const C = {
  bg: "#0f1115",
  card: "#1a1e26",
  cardExternal: "#15181e",
  cardStroke: "#2c323d",
  cardStrokeExternal: "#3b4150",
  title: "#e6e9ef",
  subtitle: "#8b93a3",
  tag: "#6f7889",
  future: "#d8a657",
  deprecated: "#c07070",
  edge: "#5f6a7e",
  edgeFuture: "#8a7a45",
  edgeDeprecated: "#7a4b4b",
  labelBg: "#14171d",
  label: "#aab3c3",
  group: "#13161c",
  groupStroke: "#343b48",
  groupTitle: "#c7cdd8",
  select: "#4f8cff",
  path: "#f2c14e",
};
/** A line whose ends are in different regions: the region boundary's colour. */
const REGION_EDGE = "#b39ddb";
const KIND: Record<string, string> = {
  actor: "#a78bfa",
  system: "#60a5fa",
  app: "#34d399",
  store: "#fbbf24",
  component: "#f472b6",
  module: "#f0a060",
  function: "#7dcfcf",
  library: "#c792ea",
  table: "#f2c46d",
};
const BOUNDARY: Record<string, string> = {
  cloud: "#7f8ea3",
  project: "#6f9bd1",
  host: "#8fb3e0",
  network: "#5fb39a",
  subnet: "#8cc08a",
  region: "#b39ddb",
  edge: "#d9a35f",
  trust: "#d97f7f",
  process: "#8fd1b8",
  group: "#9aa3b2",
};
const SIDE_OF_WORD: Record<string, Side> = { left: "l", right: "r", top: "t", bottom: "b" };
const FONT = "Inter";
const PAD = 48;
const HEAD = 56;

export interface RenderOptions {
  /** Light up this flow: its steps numbered, everything else dimmed. */
  flow?: Flow | null;
  /** One step of the flow (from 0); left out shows them all. */
  step?: number;
  /** The design's name, for the heading. */
  title?: string;
  /** Elbow or straight arrows, routed around the boxes (routePaths): edge id → points. */
  paths?: Map<string, Point[]>;
  /** Where each label landed (its rect) and its line, for measuring a layout. */
  onLabels?: (labels: { id: string; rect: Rect; route: Route }[], boxes: Rect[]) => void;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Roughly how wide text is in Inter, good enough to clip and to size label backgrounds. */
const width = (s: string, size: number) => s.length * size * 0.56;
const clip = (s: string, room: number, size: number) => {
  if (width(s, size) <= room) return s;
  const n = Math.max(1, Math.floor(room / (size * 0.56)) - 1);
  return `${s.slice(0, n)}…`;
};

/** An SVG path's "d" for a route. */
function pathOf(r: Route): string {
  const out: string[] = [];
  const f = (n: number) => Math.round(n * 10) / 10;
  traceRoute(
    {
      moveTo: (x, y) => out.push(`M${f(x)} ${f(y)}`),
      lineTo: (x, y) => out.push(`L${f(x)} ${f(y)}`),
      bezierCurveTo: (a, b, c, d, x, y) =>
        out.push(`C${f(a)} ${f(b)} ${f(c)} ${f(d)} ${f(x)} ${f(y)}`),
      quadraticCurveTo: (a, b, x, y) => out.push(`Q${f(a)} ${f(b)} ${f(x)} ${f(y)}`),
    },
    r,
  );
  return out.join("");
}

/** The view as an SVG document. */
export function renderSvg(
  idx: ModelIndex,
  diagramId: string,
  config: FConfig,
  opts: RenderOptions = {},
): string {
  const d = idx.diagrams.get(diagramId);
  if (!d) throw new Error(`no diagram ${diagramId}`);
  const graph: CanvasGraph = colorGraph(
    projectDiagram(idx, diagramId),
    idx,
    d.colorBy,
    config.tags,
  ).graph;
  for (const e of graph.edges)
    if (e.labels?.length)
      e.label = `${e.labels.join(" · ")}${e.crosses && e.label.endsWith(e.crosses) ? ` · ${e.crosses}` : ""}`;
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  // Where lines end: the boxes, and the frames of boxes drawn around their insides.
  const ends = lineEnds(graph);
  const rect = (id: string): Rect | undefined => ends.get(id);

  // Arrows leave the sides the canvas would pick, spread along them as it would.
  const grid = new BoxGrid();
  for (const n of graph.nodes) grid.add(n.id, n);
  const chosen =
    graph.nodes.length <= 400
      ? chooseSides(graph.edges, rect, grid)
      : new Map<string, { from: Side; to: Side }>();
  // A fan leaves from one spot and is named once.
  const fans = fanSides(graph.edges, (id) => (nodes.has(id) ? rect(id) : undefined));
  for (const [id, { side }] of fans)
    if (chosen.has(id)) chosen.set(id, { from: side, to: chosen.get(id)!.to });
  for (const e of graph.edges) if (e.fan && !e.fanLead) e.label = "";
  const spread = ports(graph.edges, rect, chosen);
  for (const [id, f] of fans) {
    const a = rect(graph.edges.find((e) => e.id === id)!.from)!;
    spread.set(id, { a: pinOffset(a, f.side, f.at ?? 0.5) ?? 0, b: spread.get(id)?.b ?? 0 });
  }
  const byEdge = new Map(graph.edges.map((e) => [e.id, e]));
  // A fork: from the spot on the arrow it comes off, not from its box.
  const forked = (e: CanvasEdge): Route | undefined => {
    const parent = e.forkOf ? byEdge.get(e.forkOf) : undefined;
    if (!parent || e.shape?.forkAt === undefined || !ends.has(parent.to)) return undefined;
    const round = d.arrows === "straight" ? 0 : 10;
    const up = routeOf(parent);
    const pts = e.shape.bends?.length ? undefined : opts.paths?.get(e.id);
    return pts
      ? lineRoute(
          clipToBoxes(
            startAt(pts, routePoint(up, e.shape.forkAt)),
            { x: -1e9, y: -1e9, w: 0, h: 0 },
            ends.get(e.to)!,
          ),
          round,
        )
      : forkRoute(up, e.shape.forkAt, ends.get(e.to)!, e.shape.bends, round);
  };
  const routeOf = (e: CanvasEdge): Route => forked(e) ?? boxRoute(e);
  const boxRoute = (e: CanvasEdge): Route => {
    const a = ends.get(e.from)!;
    const b = ends.get(e.to)!;
    const pin = {
      from: e.shape?.fromSide ? SIDE_OF_WORD[e.shape.fromSide] : undefined,
      to: e.shape?.toSide ? SIDE_OF_WORD[e.shape.toSide] : undefined,
    };
    const at = pinOffsets(a, b, pin, e.shape);
    if (e.shape?.bends?.length) {
      const st = fanStart(pin, at, fans.get(e.id), spread.get(e.id)?.a);
      return bentRoute(a, b, e.shape.bends, d.arrows ?? "curved", st.pin, st.at);
    }
    const routed = opts.paths?.get(e.id);
    if (routed) return lineRoute(clipToBoxes(routed, a, b), d.arrows === "elbow" ? 10 : 0);
    const c = chosen.get(e.id);
    const p = spread.get(e.id);
    const via = { from: pin.from ?? c?.from ?? "r", to: pin.to ?? c?.to ?? "l" } as const;
    const off = { a: p?.a ?? 0, b: p?.b ?? 0, ...at };
    const r = route(a, b, off.a, off.b, via);
    return d.arrows && d.arrows !== "curved" ? r : curveAround(r, a, b, via, graph.nodes, off);
  };

  // Each label's spot, clear of the boxes and of each other where the line allows (placeLabel).
  const labelAt = new Map<string, Point>();
  // A label's text: shortened where the whole of it would still cover a box. Lines split by
  // "\n": a label of two or three connections, one line each.
  const labelText = new Map<string, string>();
  const LINE = 14;
  const lw = (t: string) => Math.max(...t.split("\n").map((l) => width(l, 11))) + 12;
  const lh = (t: string) => 18 + (t.split("\n").length - 1) * LINE;
  {
    const taken: Rect[] = [];
    // The boxes, and each frame's title (a label over "archnm server" hid it).
    const boxes: Rect[] = [
      ...graph.nodes,
      ...graph.groups
        .filter((g) => g.name)
        .map((g) => ({ x: g.x, y: g.y, w: Math.min(g.w, width(g.name, 14) + 28), h: 32 })),
    ];
    // Every line's route, so a label keeps off the others' straight runs.
    const routes = new Map(
      graph.edges.filter((e) => ends.has(e.from) && ends.has(e.to)).map((e) => [e.id, routeOf(e)]),
    );
    const others = [...routes.values()];
    for (const e of graph.edges) {
      if (!e.label || !ends.has(e.from) || !ends.has(e.to)) continue;
      const shaped = e.shape?.label;
      const r = routes.get(e.id)!;
      // Several connections' labels are the point of the label: each keeps a part, but where the
      // whole would cover a box (a title on a short hop), each part is cut short, not dropped.
      const covers = (x: string) =>
        shaped === undefined
          ? placeLabelOn(r, lw(x), lh(x), boxes, taken, false, others).covers
          : 0;
      let t = clip(e.label, e.labels?.length ? 400 : 220, 11);
      if (e.labels && e.labels.length >= 2 && e.labels.length <= 3) {
        // Two or three connections on one arrow: a line each, so they read as several, not one
        // sentence ("POST /mcp · curls the script"). Shorter where that clears the boxes.
        const tries = [220, 140, 90, 60].map((room) =>
          e.labels!.map((l) => clip(l, room, 11)).join("\n"),
        );
        t =
          tries.find((x) => covers(x) === 0) ??
          tries.reduce((best, x) => (covers(x) < covers(best) ? x : best));
        if (covers(t) > 3000) t = `${e.labels.length} connections`;
      } else if (e.labels?.length) {
        // The longest that clears the boxes; on a hop too short for any, the one covering least.
        if (covers(t) > 0) {
          const tries = [
            t,
            ...[140, 90, 60].map((room) => e.labels!.map((l) => clip(l, room, 11)).join(" · ")),
          ];
          t = tries.reduce((best, x) => (covers(x) < covers(best) ? x : best));
          // A hop too short for any of them, where even the shortest would hide a box's title
          // (about 5,400 px² of the Web app box): the count, as the canvas says it.
          // Less than that, the parts stay, cut short.
          if (covers(t) > 3000) t = `${e.labels.length} connections`;
        }
      } else if (covers(t) > 0) {
        t = clip(e.label, 100, 11);
      }
      labelText.set(e.id, t);
      labelAt.set(
        e.id,
        shaped !== undefined
          ? routePoint(r, shaped)
          : placeLabel(r, lw(t), lh(t), boxes, taken, others),
      );
    }
    opts.onLabels?.(
      [...labelAt].map(([id, p]) => {
        const t = labelText.get(id)!;
        return {
          id,
          rect: { x: p.x - lw(t) / 2, y: p.y - lh(t) / 2, w: lw(t), h: lh(t) },
          route: routes.get(id)!,
        };
      }),
      graph.nodes,
    );
  }

  // A flow: which arrows and boxes are in it, and each step's number.
  const steps = opts.flow
    ? opts.step !== undefined && opts.step >= 0
      ? opts.flow.steps.slice(opts.step, opts.step + 1).map((s) => ({ s, n: opts.step! + 1 }))
      : opts.flow.steps.map((s, i) => ({ s, n: i + 1 }))
    : [];
  const nearest = (id: string): string | undefined => {
    for (let cur: string | null | undefined = id; cur; cur = idx.objects.get(cur)?.parentId)
      if (nodes.has(cur)) return cur;
    return undefined;
  };
  const lit = new Set<string>();
  const litEdges = new Set<string>();
  const badges: { at: Point; n: number }[] = [];
  // A path lights its route in one colour, without step numbers.
  const isPath = opts.flow?.kind === "path";
  for (const { s, n } of steps) {
    const a = nearest(s.fromId);
    const b = nearest(s.toId);
    if (!a || !b) continue;
    lit.add(a).add(b);
    const e = graph.edges.find((x) => (x.from === a && x.to === b) || (x.from === b && x.to === a));
    if (a === b) badges.push({ at: { x: nodes.get(a)!.x, y: nodes.get(a)!.y }, n });
    else if (e) {
      litEdges.add(e.id);
      // Beside the arrow's label, not on it.
      const m = labelAt.get(e.id) ?? routePoint(routeOf(e), 0.5);
      const half = e.label ? lw(labelText.get(e.id) ?? clip(e.label, 220, 11)) / 2 + 12 : 0;
      badges.push({ at: { x: m.x - half, y: m.y }, n });
    } else badges.push({ at: routePoint(route(nodes.get(a)!, nodes.get(b)!), 0.5), n });
  }
  const dim = (on: boolean) => (opts.flow && !on ? ` opacity="0.28"` : "");

  // What's drawn reaches past the boxes: arrows that bend out around them, and their labels.
  const reach: Rect[] = [...graph.nodes, ...graph.groups];
  for (const e of graph.edges) {
    if (!ends.has(e.from) || !ends.has(e.to)) continue;
    const r = routeOf(e);
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const p = routePoint(r, t);
      reach.push({ x: p.x - 6, y: p.y - 6, w: 12, h: 12 });
    }
    if (e.label) {
      const m = labelAt.get(e.id) ?? routePoint(r, 0.5);
      const t = labelText.get(e.id) ?? clip(e.label, 220, 11);
      const w = lw(t);
      reach.push({ x: m.x - w / 2 - 14, y: m.y - lh(t) / 2 - 1, w: w + 28, h: lh(t) + 2 });
    }
  }
  const all = boundsOf(reach) ?? { x: 0, y: 0, w: 400, h: 200 };
  const x0 = all.x - PAD;
  const y0 = all.y - PAD - HEAD;
  const W = Math.ceil(all.w + PAD * 2);
  const H = Math.ceil(all.h + PAD * 2 + HEAD);
  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="${x0} ${y0} ${W} ${H}" font-family="${FONT}, sans-serif">`,
  );
  out.push(`<rect x="${x0}" y="${y0}" width="${W}" height="${H}" fill="${C.bg}"/>`);
  const scope = d.scopeId ? idx.objects.get(d.scopeId)?.name : null;
  const heading = `${opts.title ? `${opts.title} › ` : ""}${d.name}`;
  out.push(
    `<text x="${x0 + PAD}" y="${y0 + 34}" font-size="18" font-weight="600" fill="${C.title}">${esc(heading)}</text>`,
  );
  const sub = [
    scope && !opts.title?.includes(scope) ? `inside ${scope}` : "",
    opts.flow
      ? `${isPath ? "path" : "flow"}: ${opts.flow.name}${opts.step !== undefined && opts.step >= 0 ? `, step ${opts.step + 1} of ${opts.flow.steps.length}` : ""}`
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
  if (sub)
    out.push(
      `<text x="${x0 + PAD + width(heading, 18) + 14}" y="${y0 + 34}" font-size="13" fill="${C.subtitle}">${esc(sub)}</text>`,
    );

  // Frames: the scope, boundaries (dashed, by kind) and lanes.
  for (const g of [...graph.groups].sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0))) {
    if (g.lane) {
      out.push(
        `<rect x="${g.x}" y="${g.y}" width="${g.w}" height="${g.h}" rx="10" fill="none" stroke="${C.groupStroke}" stroke-dasharray="2 6"/>`,
      );
      out.push(
        `<text x="${g.x + g.w - 16}" y="${g.y + 24}" font-size="12" text-anchor="end" fill="${C.subtitle}">${esc(g.name)}</text>`,
      );
    } else if (g.container) {
      // A file or package around its functions: a quiet frame, its name in code type.
      out.push(
        `<rect x="${g.x}" y="${g.y}" width="${g.w}" height="${g.h}" rx="10" fill="${C.card}" fill-opacity="0.55" stroke="${KIND.module ?? C.groupStroke}" stroke-opacity="0.35"/>`,
      );
      out.push(
        `<text x="${g.x + 10}" y="${g.y + 17}" font-size="11.5" font-family="ui-monospace, Menlo, monospace" fill="${KIND.module ?? C.groupTitle}">${esc(g.name)}</text>`,
      );
    } else if (g.boundary) {
      const col = BOUNDARY[g.boundary] ?? C.groupStroke;
      out.push(
        `<rect x="${g.x}" y="${g.y}" width="${g.w}" height="${g.h}" rx="6" fill="${col}" fill-opacity="0.04" stroke="${col}" stroke-opacity="0.8" stroke-dasharray="8 5" stroke-width="1.5"/>`,
      );
      out.push(
        `<text x="${g.x + 12}" y="${g.y + 20}" font-size="13" fill="${col}">${esc(g.name)}<tspan dx="8" font-size="10.5" fill-opacity="0.7">${esc(g.boundary === "trust" ? "trust zone" : g.boundary)}</tspan></text>`,
      );
    } else {
      out.push(
        `<rect x="${g.x}" y="${g.y}" width="${g.w}" height="${g.h}" rx="14" fill="${C.group}" stroke="${C.groupStroke}"/>`,
      );
      out.push(
        `<text x="${g.x + 14}" y="${g.y + 24}" font-size="14" fill="${C.groupTitle}">${esc(g.name)}</text>`,
      );
    }
  }

  // Arrows, then their labels on top.
  const labels: string[] = [];
  for (const e of graph.edges) {
    if (!ends.has(e.from) || !ends.has(e.to)) continue;
    const r = routeOf(e);
    const on = litEdges.has(e.id);
    const col = on
      ? isPath
        ? C.path
        : C.select
      : e.status === "future"
        ? C.edgeFuture
        : e.status === "deprecated" || e.status === "removed"
          ? C.edgeDeprecated
          : e.crosses
            ? REGION_EDGE
            : C.edge;
    const dash = e.hop
      ? ` stroke-dasharray="5 4"`
      : e.status === "future"
        ? ` stroke-dasharray="6 5"`
        : "";
    const [h1, h2] = arrowHead(r.p1, r.c2, 9);
    const [b1, b2] = arrowHead(r.p0, r.c1, 9);
    const back = e.both
      ? `<polygon points="${r.p0.x},${r.p0.y} ${b1.x},${b1.y} ${b2.x},${b2.y}" fill="${col}"/>`
      : "";
    out.push(
      `<g${e.quiet && !on ? ` opacity="0.25"` : dim(on)}><path d="${pathOf(r)}" fill="none" stroke="${col}" stroke-width="${on ? 2.5 : 1.5}"${dash}/><polygon points="${r.p1.x},${r.p1.y} ${h1.x},${h1.y} ${h2.x},${h2.y}" fill="${col}"/>${back}${e.forkOf ? `<circle cx="${r.p0.x}" cy="${r.p0.y}" r="3.5" fill="${col}"/>` : ""}</g>`,
    );
    if (e.label) {
      const m = labelAt.get(e.id) ?? routePoint(r, 0.5);
      const t = labelText.get(e.id) ?? clip(e.label, 220, 11);
      const w = lw(t);
      const h = lh(t);
      const rows = t.split("\n");
      const text =
        rows.length === 1
          ? esc(t)
          : rows.map((l, i) => `<tspan x="${m.x}" dy="${i ? LINE : 0}">${esc(l)}</tspan>`).join("");
      labels.push(
        `<g${dim(on)}><rect x="${m.x - w / 2}" y="${m.y - h / 2}" width="${w}" height="${h}" rx="4" fill="${C.labelBg}"/><text x="${m.x}" y="${m.y - h / 2 + 13}" font-size="11" text-anchor="middle" fill="${on ? C.title : C.label}">${text}</text></g>`,
      );
    }
  }
  for (const n of graph.nodes) out.push(card(n, opts.flow ? lit.has(n.id) : true));

  // Labels over the boxes: placeLabel keeps them clear where the line allows, and where it
  // doesn't, a label over a box's edge still reads; under it, it's cut off.
  out.push(...labels);

  for (const b of isPath ? [] : badges) {
    out.push(
      `<g><circle cx="${b.at.x}" cy="${b.at.y}" r="10" fill="${C.select}" stroke="${C.bg}" stroke-width="2"/><text x="${b.at.x}" y="${b.at.y + 4}" font-size="11" font-weight="600" text-anchor="middle" fill="#fff">${b.n}</text></g>`,
    );
  }
  out.push("</svg>");
  return out.join("\n");
}

/** A box, as the canvas draws it: logo tile, name, kind and tech, tags at the bottom. */
function card(n: CanvasNode, on: boolean): string {
  if (n.kind === "function") return slim(n, on);
  const ext = n.external;
  const rx = n.kind === "actor" ? Math.min(n.h / 2, 26) : 10;
  const stroke =
    n.color ?? (n.status === "future" ? C.future : ext ? C.cardStrokeExternal : C.cardStroke);
  const dash = n.status === "future" || ext ? ` stroke-dasharray="${ext ? "5 4" : "6 4"}"` : "";
  const parts: string[] = [`<g${on ? "" : ` opacity="0.28"`}>`];
  parts.push(
    `<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="${rx}" fill="${ext ? C.cardExternal : C.card}" stroke="${stroke}" stroke-width="${n.color ? 2 : 1}"${dash}/>`,
  );
  // Logo tile: the first technology's logo, else the kind's colour.
  const tile = 34;
  const tx = n.x + 12;
  const ty = n.y + Math.min(14, (n.h - tile) / 2);
  const kind = KIND[n.kind] ?? C.subtitle;
  parts.push(
    `<rect x="${tx}" y="${ty}" width="${tile}" height="${tile}" rx="8" fill="${kind}" fill-opacity="0.14"/>`,
  );
  const tech = logoOf(n).split(",")[0]?.trim() ?? "";
  const icon = tech ? iconFor(tech) : undefined;
  const logo = icon ? iconSvg(tech, brandColor(icon)) : null;
  if (logo) {
    // Its own size and place give way to the tile's.
    const open = /<svg[^>]*>/.exec(logo)![0];
    const placed = open
      .replace(/\s(width|height|x|y)="[^"]*"/g, "")
      .replace("<svg", `<svg x="${tx + 8}" y="${ty + 8}" width="18" height="18"`);
    parts.push(logo.replace(open, placed));
  } else
    parts.push(
      `<text x="${tx + tile / 2}" y="${ty + tile / 2 + 5}" font-size="14" font-weight="600" text-anchor="middle" fill="${kind}">${esc(n.kind[0]!.toUpperCase())}</text>`,
    );
  const left = tx + tile + 10;
  const room = n.x + n.w - left - 10;
  const titleColor = n.status === "deprecated" || n.status === "removed" ? C.deprecated : C.title;
  parts.push(
    `<text x="${left}" y="${ty + 15}" font-size="15" font-weight="500" fill="${titleColor}">${esc(clip(n.name, room, 15))}</text>`,
  );
  parts.push(
    `<text x="${left}" y="${ty + 31}" font-size="12" fill="${C.subtitle}">${esc(clip(n.subtitle, room, 12))}</text>`,
  );
  // Tags along the bottom, right-aligned, as many as fit.
  const tags = [n.childCount ? `${n.childCount} inside →` : "", ...n.tags].filter(Boolean);
  let x = n.x + n.w - 12;
  const y = n.y + n.h - 10;
  for (const t of [...tags].reverse()) {
    const w = width(t, 10);
    if (x - w < n.x + 12) break;
    parts.push(
      `<text x="${x}" y="${y}" font-size="10" text-anchor="end" fill="${C.tag}">${esc(t)}</text>`,
    );
    x -= w + 8;
  }
  parts.push("</g>");
  return parts.join("");
}

/** A function: a slim box, its name in code type and what it is beside it. */
function slim(n: CanvasNode, on: boolean): string {
  const kind = KIND[n.kind] ?? C.subtitle;
  const stroke = n.status === "future" ? C.future : C.cardStroke;
  const dash = n.status === "future" ? ` stroke-dasharray="6 4"` : "";
  const room = n.w - 20;
  const parts = [`<g${on ? "" : ` opacity="0.28"`}>`];
  parts.push(
    `<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="7" fill="${C.card}" stroke="${stroke}"${dash}/>`,
  );
  parts.push(
    `<rect x="${n.x}" y="${n.y + 6}" width="3" height="${n.h - 12}" rx="1.5" fill="${kind}"/>`,
  );
  parts.push(
    `<text x="${n.x + 11}" y="${n.y + (n.technology ? 17 : n.h / 2 + 4)}" font-size="12.5" font-weight="600" font-family="ui-monospace, Menlo, monospace" fill="${kind}">${esc(clip(n.name, room, 12.5))}</text>`,
  );
  if (n.technology)
    parts.push(
      `<text x="${n.x + 11}" y="${n.y + 31}" font-size="10.5" fill="${C.subtitle}">${esc(clip(n.technology, room, 10.5))}</text>`,
    );
  parts.push("</g>");
  return parts.join("");
}

let avoid: Promise<Avoid | null> | null = null;
/** libavoid in Node, once; null if it won't load (arrows stay curved). */
function loadAvoid(): Promise<Avoid | null> {
  avoid ??= (async () => {
    try {
      await AvoidLib.load(); // the Node build finds its own wasm
      return AvoidLib.getInstance();
    } catch (e) {
      console.warn("archnm: arrow router didn't load for renders; arrows stay curved", e);
      return null;
    }
  })();
  return avoid;
}

/**
 * A view with elbow or straight arrows: route them around the boxes as the canvas does, with
 * the same router. Curved views (the default) need nothing; arrows bent by hand keep their bends.
 */
export async function routePaths(
  idx: ModelIndex,
  diagramId: string,
): Promise<Map<string, Point[]> | undefined> {
  const d = idx.diagrams.get(diagramId);
  if (!d?.arrows || d.arrows === "curved") return undefined;
  const A = await loadAvoid();
  if (!A) return undefined;
  const g = projectDiagram(idx, diagramId);
  const boxes = new Map<string, Rect>(
    g.nodes.map((n) => [n.id, { x: n.x, y: n.y, w: n.w, h: n.h }]),
  );
  const ends = lineEnds(g);
  const byId = new Map(g.edges.map((e) => [e.id, e]));
  const r = new EdgeRouter(A);
  // A fork is routed from its spot on the arrow it comes off, once that arrow has its path.
  const junction = (id: string): Point | undefined => {
    const e = byId.get(id);
    const up = e?.forkOf ? byId.get(e.forkOf) : undefined;
    const pts = up && r.path(up.id);
    const [a, b] = [up && ends.get(up.from), up && ends.get(up.to)];
    if (!pts || !a || !b || e?.shape?.forkAt === undefined) return undefined;
    return routePoint(lineRoute(up!.forkOf ? pts : clipToBoxes(pts, a, b)), e.shape.forkAt);
  };
  try {
    let edges = routerEdges(g.edges, ends, boxes, junction);
    r.sync(boxes, edges, d.arrows);
    // Forks, then forks of forks: each pass routes the ones whose arrow now has a path.
    for (let i = 0; i < 3 && g.edges.some((e) => e.forkOf && !r.path(e.id)); i++) {
      edges = routerEdges(g.edges, ends, boxes, junction);
      r.sync(boxes, edges, d.arrows);
    }
    return new Map(
      edges.flatMap((e) => (r.path(e.id) ? [[e.id, r.path(e.id)!] as [string, Point[]]] : [])),
    );
  } finally {
    r.destroy();
  }
}

/** A view of a design by key, id or name, with a flow by name or id; what the endpoint and MCP share. */
export async function renderView(
  idx: ModelIndex,
  config: FConfig,
  view: string,
  flow?: string | null,
  step?: number,
): Promise<{ svg: string; diagramId: string; flow: Flow | null }> {
  const want = view.trim().toLowerCase();
  const d = [...idx.diagrams.values()].find(
    (x) => x.id === view || x.key === view || x.name.toLowerCase() === want,
  );
  if (!d) throw new Error(`no view "${view}"`);
  const f = flow
    ? ([...idx.flows.values()].find(
        (x) =>
          x.diagramId === d.id &&
          (x.id === flow || x.name.toLowerCase() === flow.trim().toLowerCase()),
      ) ?? null)
    : null;
  if (flow && !f) throw new Error(`no flow "${flow}" on ${d.name}`);
  return {
    svg: renderSvg(idx, d.id, config, {
      title: config.name,
      flow: f,
      step,
      paths: await routePaths(idx, d.id),
    }),
    diagramId: d.id,
    flow: f,
  };
}

// --- PNG ---------------------------------------------------------------------------------

let ready: Promise<{ fonts: Uint8Array[]; has: Set<number> }> | null = null;
/** Load the WebAssembly renderer and the font once. */
function boot(): Promise<{ fonts: Uint8Array[]; has: Set<number> }> {
  ready ??= (async () => {
    const req = createRequire(import.meta.url);
    await initWasm(readFileSync(req.resolve("@resvg/resvg-wasm/index_bg.wasm")));
    const font = (w: string) =>
      new Uint8Array(readFileSync(req.resolve(`@expo-google-fonts/inter/${w}/Inter_${w}.ttf`)));
    const fonts = [font("400Regular"), font("500Medium"), font("600SemiBold")];
    return { fonts, has: covered(fonts[0]!) };
  })();
  return ready;
}

/** The characters a TrueType font draws (its cmap, format 12 or 4). */
export function covered(ttf: Uint8Array): Set<number> {
  const dv = new DataView(ttf.buffer, ttf.byteOffset, ttf.byteLength);
  const out = new Set<number>();
  let cmap = 0;
  for (let i = 0, n = dv.getUint16(4); i < n; i++) {
    const o = 12 + i * 16;
    if (String.fromCharCode(...ttf.subarray(o, o + 4)) === "cmap") cmap = dv.getUint32(o + 8);
  }
  if (!cmap) return out;
  for (let i = 0, n = dv.getUint16(cmap + 2); i < n; i++) {
    const off = cmap + dv.getUint32(cmap + 8 + i * 8);
    const fmt = dv.getUint16(off);
    if (fmt === 12) {
      for (let j = 0, g = dv.getUint32(off + 12); j < g; j++)
        for (
          let c = dv.getUint32(off + 16 + j * 12), e = dv.getUint32(off + 20 + j * 12);
          c <= e;
          c++
        )
          out.add(c);
    } else if (fmt === 4) {
      const seg = dv.getUint16(off + 6) / 2;
      for (let j = 0; j < seg; j++)
        for (
          let c = dv.getUint16(off + 16 + seg * 2 + j * 2), e = dv.getUint16(off + 14 + j * 2);
          c <= e && c !== 0xffff;
          c++
        )
          out.add(c);
    }
  }
  return out;
}

// What to draw for a character the font hasn't got: the nearest one it has (a
// label's "⇄" drew as a missing-glyph box). Labels are anyone's text, so this is by
// character, not by label.
const NEAR: Record<string, string> = {
  "⇄": "↔",
  "⇆": "↔",
  "⇋": "↔",
  "⇌": "↔",
  "⟺": "⇔",
  "⇉": "⇒",
  "⟶": "→",
  "⟵": "←",
  "✦": "★",
  "✧": "☆",
  "✔": "✓",
  "✘": "✗",
  "❌": "✗",
  "✅": "✓",
  "➜": "→",
  "➔": "→",
  "➡": "→",
  "⬅": "←",
};

/** `text` with each character `has` lacks swapped for the nearest it has (else left as is). */
export function drawable(text: string, has: Set<number>): string {
  if (!has.size) return text;
  let out = "";
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80 || has.has(c)) {
      out += ch;
      continue;
    }
    const near = NEAR[ch];
    const parts = ch.normalize("NFKD").replace(/\p{M}/gu, "");
    out +=
      near && [...near].every((x) => has.has(x.codePointAt(0)!))
        ? near
        : parts !== ch && [...parts].every((x) => has.has(x.codePointAt(0)!))
          ? parts
          : ch;
  }
  return out;
}

/** The SVG as a PNG, at `scale` (2 for sharp text), capped so a huge view stays a sane size. */
export async function toPng(svg: string, scale = 2): Promise<Uint8Array> {
  const { fonts, has } = await boot();
  svg = drawable(svg, has);
  const w = Number(/width="(\d+)"/.exec(svg)?.[1] ?? 1000);
  const s = Math.min(scale, 6000 / w);
  const r = new Resvg(svg, {
    fitTo: { mode: "zoom", value: s },
    font: { fontBuffers: fonts, defaultFontFamily: FONT, sansSerifFamily: FONT },
    background: C.bg,
  });
  return r.render().asPng();
}
