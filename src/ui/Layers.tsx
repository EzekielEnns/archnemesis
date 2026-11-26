// Layers, as in Photoshop: what's drawn over the boxes, each one turned on and off from the
// panel at the bottom right. Tech and notes draw a compact row under each box; references draw
// as small nodes of their own beside it (a link you can open, an image's picture, a doc, a line
// of code, a library), and so do entities (the shapes it uses: Order, PaymentProvider). None of
// them can be placed or moved: they sit where there's room, and follow their box. Hovering a
// tech, a dependency or an entity lights every box that shares it; an entity's parent is a
// click away (on the node, or in its card).
import { useEffect, useRef, useState } from "react";
import {
  BookOpen,
  Braces,
  ChevronLeft,
  ChevronRight,
  Code2,
  Copy,
  Cpu,
  ExternalLink,
  X,
  Eye,
  EyeOff,
  FileText,
  Frame,
  Image as ImageIcon,
  Layers as LayersIcon,
  Link as LinkIcon,
  MessageSquare,
  Package,
  StickyNote,
} from "lucide-react";
import type { CanvasEdge, CanvasNode, ModelIndex } from "../../shared/project";
import { hostOf } from "../../shared/notes";
import type { ModelObject } from "../../shared/model";
import {
  libraryDocs,
  refKey,
  referencesOf,
  sharingRef,
  techsOf,
  type RefRow,
} from "../../shared/references";
import {
  carriersOf,
  entityRows,
  entitySummary,
  isTbd,
  splitField,
  usersOf,
} from "../../shared/entities";
import { worldToScreen } from "../canvas/camera";
import type { Scene, SceneView } from "../canvas/Scene";
import { LinkIcon as SiteIcon } from "./Notes";

const LAYER_IDS = ["comments", "groups", "tech", "references", "entities", "notes"] as const;
export type LayerId = (typeof LAYER_IDS)[number];
export type LayerState = Record<LayerId, boolean>;

const LAYER_INFO: Record<LayerId, { label: string; icon: React.ReactNode; hint: string }> = {
  comments: {
    label: "Comments",
    icon: <MessageSquare size={14} />,
    hint: "Threads pinned on the diagram",
  },
  groups: {
    label: "Groups",
    icon: <Frame size={14} />,
    hint: "Groups and regions drawn as frames",
  },
  tech: { label: "Tech", icon: <Cpu size={14} />, hint: "What each box is built with" },
  references: {
    label: "References",
    icon: <LinkIcon size={14} />,
    hint: "Links, images, docs, code, dependencies",
  },
  entities: {
    label: "Entities",
    icon: <Braces size={14} />,
    hint: "The shapes each box uses: Order, PaymentProvider",
  },
  notes: { label: "Notes", icon: <StickyNote size={14} />, hint: "Each box's running notes" },
};

const DEFAULTS: LayerState = {
  comments: true,
  groups: true,
  tech: false,
  references: false,
  entities: false,
  notes: false,
};
const KEY = "archnm.layers";

/** Which layers are on, kept per browser. */
export function useLayers(): [LayerState, (id: LayerId) => void, (all: boolean) => void] {
  const [s, setS] = useState<LayerState>(() => {
    try {
      return {
        ...DEFAULTS,
        ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<LayerState>),
      };
    } catch {
      return DEFAULTS;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(s));
    } catch {
      /* private window: just don't remember */
    }
  }, [s]);
  return [
    s,
    (id) => setS((x) => ({ ...x, [id]: !x[id] })),
    (all) => setS(Object.fromEntries(LAYER_IDS.map((k) => [k, all])) as LayerState),
  ];
}

/** The panel: one row per layer with its eye, and a count of what it would show here. */
export function LayersPanel(p: {
  layers: LayerState;
  counts: Partial<Record<LayerId, number>>;
  onToggle: (id: LayerId) => void;
  onAll: (on: boolean) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (ref.current && !ref.current.contains(t) && !t.closest(".layers-btn")) p.onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && p.onClose();
    window.addEventListener("pointerdown", down);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", down);
      window.removeEventListener("keydown", key);
    };
  });
  const allOn = LAYER_IDS.every((k) => p.layers[k]);
  return (
    <div className="layers-panel" ref={ref}>
      <div className="layers-head">
        <span>Layers</span>
        <button className="layers-all" onClick={() => p.onAll(!allOn)}>
          {allOn ? "Hide all" : "Show all"}
        </button>
      </div>
      {LAYER_IDS.map((id) => {
        const on = p.layers[id];
        const n = p.counts[id];
        return (
          <button
            key={id}
            className={on ? "layer-row on" : "layer-row"}
            onClick={() => p.onToggle(id)}
            title={LAYER_INFO[id].hint}
            aria-pressed={on}
          >
            <span className="layer-icon">{LAYER_INFO[id].icon}</span>
            <span className="layer-name">{LAYER_INFO[id].label}</span>
            {n !== undefined && <span className="layer-count">{n}</span>}
            <span className="layer-eye">{on ? <Eye size={14} /> : <EyeOff size={14} />}</span>
          </button>
        );
      })}
      <div className="layers-foot">
        Hover a tech, a dependency or an entity to see what else uses it.
      </div>
    </div>
  );
}

export function LayersButton(p: { open: boolean; active: number; onClick: () => void }) {
  return (
    <button
      className={p.open ? "icon-btn layers-btn on" : "icon-btn layers-btn"}
      onClick={p.onClick}
      title="Layers"
    >
      <LayersIcon size={16} />
      {p.active > 0 && <span className="layers-dot">{p.active}</span>}
    </button>
  );
}

/** Room a box's row (tech, notes) takes under it; boxes below are drawn this much lower. */
export const ROW_ROOM = 32; // a multiple of the 8px grid, so snapped drops stay snapped

/** Whether this box shows a row under it with these layers on. */
export function hasRow(idx: ModelIndex, n: CanvasNode, layers: LayerState): boolean {
  const o = idx.objects.get(n.id);
  if (!o || n.folded) return false;
  return (layers.tech && techsOf(o.technology).length > 0) || (layers.notes && !!o.notes?.trim());
}

/** How many of each part the boxes on this diagram have. */
export function layerCounts(
  idx: ModelIndex,
  nodes: CanvasNode[],
): Partial<Record<LayerId, number>> {
  let tech = 0;
  let references = 0;
  let notes = 0;
  let entities = 0;
  for (const n of nodes) {
    const o = idx.objects.get(n.id);
    if (!o || n.folded) continue;
    tech += techsOf(o.technology).length;
    references += referencesOf(idx, o).length;
    entities += entityRows(idx, o).length;
    if (o.notes?.trim()) notes++;
  }
  return { tech, references, entities, notes };
}

/** A note's lines as checklist rows: "- [x] Done" → done. */
function noteLines(text: string): { text: string; done: boolean | null }[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = /^[-*]\s*\[( |x|X)\]\s*(.*)$/.exec(l);
      if (m) return { text: m[2] ?? "", done: m[1] !== " " };
      return { text: l.replace(/^[-*]\s+/, "").replace(/^#+\s*/, ""), done: null };
    });
}

interface PartsProps {
  scene: Scene | null;
  idx: ModelIndex;
  nodes: CanvasNode[];
  layers: LayerState;
  /** Open a box's card: id, or the box the chip is under when id isn't on this diagram. */
  onOpen: (id: string, from: string) => void;
  /** Go to a box from a card: glide to it (or the box it's folded in, or its diagram) and open its card. */
  onGo: (id: string) => void;
  /** The arrows drawn: what their connections carry is drawn beside their labels. */
  edges?: CanvasEdge[];
  /** Light these arrows (from, to) for what's hovered or picked; null: none. */
  onLightPairs?: (pairs: [string, string][] | null) => void;
  /** Open an arrow's panel. */
  onOpenEdge?: (edgeId: string) => void;
  /** Where a box's layer nodes were dragged to, from its corner. */
  spotOf?: (id: string) => { x: number; y: number } | undefined;
  /** Save where a box's layer nodes were dragged to (null: back to finding room by themselves). Not given: they can't be dragged. */
  onMoveParts?: (id: string, spot: { x: number; y: number } | null) => void;
}

type Rect = { x: number; y: number; w: number; h: number };

/** A reference node's size on the diagram (world units). */
const REF_W = 184;
const REF_H = 44;
const IMG_H = 112;
const GAP = 6;
/** How far a box's references sit from it. */
const OFF = 32;
/** The picked reference's card width, with room to spare (index.css .ref-pop, .ref-pop.ep). */
const POP_W = 300;
const refHeight = (r: RefRow) => (r.kind === "image" ? IMG_H : REF_H);

/** What's drawn beside a box (or a connection) with these layers on: its references, then its entities. */
function drawnRefs(
  idx: ModelIndex,
  o: Pick<ModelObject, "links" | "references">,
  layers: LayerState,
): RefRow[] {
  return [
    ...(layers.references ? referencesOf(idx, o) : []),
    ...(layers.entities ? entityRows(idx, o) : []),
  ];
}

const overlap = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
const grow = (r: Rect, by: number): Rect => ({
  x: r.x - by,
  y: r.y - by,
  w: r.w + by * 2,
  h: r.h + by * 2,
});

/**
 * Where each box's references go: a stack (two columns past four) beside the box, searched in
 * widening rings around it. Covering a box costs most, covering another box's references
 * less, and distance a little, so they sit close when there's room and move out when there isn't.
 */
function layoutRefs(
  boxes: { id: string; r: Rect; refs: RefRow[]; spot?: { x: number; y: number } }[],
  solid: Rect[],
): Map<string, { group: Rect; items: { ref: RefRow; at: Rect }[] }> {
  const walls = solid.map((r) => grow(r, 12));
  const placed: Rect[] = [];
  const out = new Map<string, { group: Rect; items: { ref: RefRow; at: Rect }[] }>();
  // Stacks dragged somewhere go there, and the rest keep clear of them.
  for (const b of [...boxes].sort((a, c) => Number(!a.spot) - Number(!c.spot))) {
    const cols = b.refs.length > 4 ? 2 : 1;
    const heights = Array.from({ length: cols }, () => 0);
    const local: { ref: RefRow; x: number; y: number; h: number }[] = [];
    b.refs.forEach((ref, i) => {
      const c = i % cols;
      const h = refHeight(ref);
      local.push({ ref, x: c * (REF_W + GAP), y: heights[c]!, h });
      heights[c]! += h + GAP;
    });
    const gw = cols * REF_W + (cols - 1) * GAP;
    const gh = Math.max(...heights) - GAP;
    const { x, y, w, h } = b.r;
    let best: [number, number] = b.spot ? [x + b.spot.x, y + b.spot.y] : [x + w + OFF, y];
    let bestCost = b.spot ? 0 : Infinity;
    for (let ring = 0; ring < 10 && bestCost > 0; ring++) {
      const d = OFF + ring * 64;
      const tries: [number, number][] = [
        [x + w + d, y],
        [x + w + d, y + h / 2 - gh / 2],
        [x, y + h + d],
        [x + w / 2 - gw / 2, y + h + d],
        [x - d - gw, y],
        [x - d - gw, y + h / 2 - gh / 2],
        [x, y - d - gh],
        [x + w + d, y - gh + h],
        [x - d - gw, y - gh + h],
        [x + w - gw, y + h + d],
      ];
      for (const [tx, ty] of tries) {
        const g = { x: tx, y: ty, w: gw, h: gh };
        const cost =
          walls.reduce((s, t) => s + overlap(g, t) * 10, 0) +
          placed.reduce((s, t) => s + overlap(g, t) * 3, 0);
        // Free space wins at once; otherwise remember the least covered spot, nearer is better.
        if (cost === 0) {
          best = [tx, ty];
          bestCost = 0;
          break;
        }
        if (cost + d * 40 < bestCost) {
          best = [tx, ty];
          bestCost = cost + d * 40;
        }
      }
    }
    const group = { x: best[0], y: best[1], w: gw, h: gh };
    placed.push(grow(group, 8));
    out.set(b.id, {
      group,
      items: local.map((l) => ({
        ref: l.ref,
        at: { x: group.x + l.x, y: group.y + l.y, w: REF_W, h: l.h },
      })),
    });
  }
  return out;
}

export type RefLayout = Map<string, { group: Rect; items: { ref: RefRow; at: Rect }[] }>;

/** Where every box's references sit with these layers on (rows under boxes count as taken). */
/** What an arrow's connections carry and point at, once each (`at` numbers them for picking). */
function edgeRefs(idx: ModelIndex, edge: CanvasEdge, layers: LayerState): RefRow[] {
  const seen = new Set<string>();
  const out: RefRow[] = [];
  for (const cid of edge.connectionIds) {
    const c = idx.connections.get(cid);
    if (!c) continue;
    for (const r of drawnRefs(idx, c, layers)) {
      const k = refKey(r);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ ...r, at: out.length });
    }
  }
  return out;
}

/** A connection's parts are laid out under the key "edge:<its arrow's id>". */
export const EDGE_PARTS = "edge:";

export function layoutParts(
  idx: ModelIndex,
  nodes: CanvasNode[],
  layers: LayerState,
  rectOf: (n: CanvasNode) => Rect = (n) => n,
  spotOf: (id: string) => { x: number; y: number } | undefined = () => undefined,
  /** Arrows, with where each one's label is: what its connections carry goes beside it. */
  edges: { edge: CanvasEdge; at: Rect }[] = [],
): RefLayout {
  if (!layers.references && !layers.entities) return new Map();
  const shown = nodes.filter((n) => !n.folded && idx.objects.get(n.id));
  const solid = shown.map((n) => {
    const r = rectOf(n);
    return hasRow(idx, n, layers)
      ? { x: r.x, y: r.y, w: r.w, h: r.h + ROW_ROOM - 4 }
      : { x: r.x, y: r.y, w: r.w, h: r.h };
  });
  return layoutRefs(
    [
      ...shown.map((n) => ({
        id: n.id,
        r: rectOf(n),
        refs: drawnRefs(idx, idx.objects.get(n.id)!, layers),
        spot: spotOf(n.id),
      })),
      ...edges.map(({ edge, at }) => ({
        id: `${EDGE_PARTS}${edge.id}`,
        r: at,
        refs: edgeRefs(idx, edge, layers),
        spot: edge.shape?.parts,
      })),
    ].filter((b) => b.refs.length),
    solid,
  );
}

/**
 * Frames grow to hold their boxes' references: each frame (smallest first, so a frame inside
 * another grows before it) takes in the references of every box inside it, and any frame inside
 * it as grown, with room to spare.
 */
export function growFrames<G extends Rect & { lane?: boolean }>(
  groups: G[],
  nodes: CanvasNode[],
  layout: RefLayout,
): G[] {
  if (!layout.size) return groups;
  const inside = (a: Rect, b: Rect) =>
    a.x >= b.x - 1 && a.y >= b.y - 1 && a.x + a.w <= b.x + b.w + 1 && a.y + a.h <= b.y + b.h + 1;
  const order = groups
    .map((_, i) => i)
    .sort((a, b) => groups[a]!.w * groups[a]!.h - groups[b]!.w * groups[b]!.h);
  const out = groups.map((g) => ({ ...g }));
  const PAD = 20;
  for (const i of order) {
    const orig = groups[i]!;
    if (orig.lane) continue;
    let { x: x0, y: y0 } = orig;
    let x1 = orig.x + orig.w;
    let y1 = orig.y + orig.h;
    const take = (r: Rect, pad: number) => {
      x0 = Math.min(x0, r.x - pad);
      y0 = Math.min(y0, r.y - pad);
      x1 = Math.max(x1, r.x + r.w + pad);
      y1 = Math.max(y1, r.y + r.h + pad);
    };
    for (const n of nodes) {
      const refs = inside(n, orig) ? layout.get(n.id) : undefined;
      if (refs) take(refs.group, PAD);
    }
    for (const j of order)
      if (j !== i && inside(groups[j]!, orig) && !groups[j]!.lane) take(out[j]!, PAD);
    Object.assign(out[i]!, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  }
  return out;
}

/** The point on r's border nearest p. */
function nearest(r: Rect, p: { x: number; y: number }) {
  const x = Math.max(r.x, Math.min(r.x + r.w, p.x));
  const y = Math.max(r.y, Math.min(r.y + r.h, p.y));
  if (x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h) return { x: r.x + r.w, y };
  return { x, y };
}

/** "orbit:services/orders/src/payments.rs#L30" → repo, file, place. */
function codeParts(to: string) {
  const m = /^([^:]+):(.*?)(#.*)?$/.exec(to);
  const path = m ? m[2]! : to;
  return {
    repo: m ? m[1]! : "",
    file: path.split("/").filter(Boolean).pop() || path,
    place: m?.[3]?.slice(1) ?? "",
    path,
  };
}

/** Open a reference: a web address in a new tab; anything else opens its box's card. */
function openRef(r: RefRow, idx: ModelIndex, card: () => void) {
  const url =
    r.kind === "dependency"
      ? libraryDocs(idx.objects.get(r.to) ?? ({} as never))
      : /^https?:\/\//.test(r.to)
        ? r.to
        : null;
  if (url && r.kind !== "dependency") window.open(url, "_blank", "noopener,noreferrer");
  else card();
}

/** One reference, drawn as a node of its kind. A click picks it (what shares it lights up); a double-click opens it. */
function RefNode(p: {
  idx: ModelIndex;
  r: RefRow;
  box: string;
  on: boolean;
  onEntity?: (id: string) => void;
  shared: number;
  onPick: () => void;
  onOpen: () => void;
  onHot: (on: boolean) => void;
}) {
  const { r } = p;
  const web = /^https?:\/\//.test(r.to);
  const cls = `ref-node ref-${r.kind}${p.on ? " on" : ""}`;
  const events = {
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation();
      p.onPick();
    },
    onDoubleClick: (e: React.MouseEvent) => {
      e.stopPropagation();
      p.onOpen();
    },
    onPointerEnter: () => p.onHot(true),
    onPointerLeave: () => p.onHot(false),
    title: `${r.to}\nClick: what shares it · drag: move them · double-click: open`,
  };
  const count = p.shared > 1 && <span className="ref-node-uses">{p.shared}</span>;
  if (r.kind === "image") {
    return (
      <button className={cls} {...events}>
        <span className="ref-thumb">
          {web ? <img src={r.to} alt="" loading="lazy" /> : <ImageIcon size={22} />}
        </span>
        <span className="ref-node-words row">
          <ImageIcon size={11} />
          <b>{r.title}</b>
          {count}
        </span>
      </button>
    );
  }
  if (r.kind === "entity") {
    const e = p.idx.entities.get(r.to);
    const from = e?.sourceId && e.sourceId !== p.box ? p.idx.objects.get(e.sourceId)?.name : null;
    const parents = (e?.extends ?? []).flatMap((x) => p.idx.entities.get(x) ?? []);
    return (
      <button
        className={`${cls}${e && isTbd(e) ? " tbd" : ""}`}
        {...events}
        title={`${r.title}\nClick: its fields and who uses it · drag: move them · double-click: the box's card`}
      >
        <span className="ref-node-icon">
          <Braces size={14} />
        </span>
        <span className="ref-node-words">
          <b className="mono">{r.title}</b>
          <i>
            {parents.length > 0 ? (
              <>
                {"extends "}
                {parents.map((x, i) => (
                  <span key={x.id}>
                    {i > 0 && ", "}
                    <span
                      className="ref-ext-go"
                      title={`Open ${x.name}`}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        p.onEntity?.(x.id);
                      }}
                    >
                      {x.name}
                    </span>
                  </span>
                ))}
                {e && !isTbd(e) && ` · +${e.values?.length ?? e.fields.length}`}
              </>
            ) : e ? (
              entitySummary(e)
            ) : (
              ""
            )}
            {from && ` · from ${from}`}
          </i>
        </span>
        {count}
      </button>
    );
  }
  const lib = r.kind === "dependency" ? p.idx.objects.get(r.to) : undefined;
  const docs = lib ? libraryDocs(lib) : null;
  const c = r.kind === "code" ? codeParts(r.to) : null;
  return (
    <button className={cls} {...events}>
      {r.kind === "link" ? (
        <SiteIcon url={r.to} />
      ) : (
        <span className="ref-node-icon">
          {r.kind === "code" ? (
            <Code2 size={14} />
          ) : r.kind === "dependency" ? (
            <Package size={14} />
          ) : (
            <FileText size={14} />
          )}
        </span>
      )}
      <span className="ref-node-words">
        <b className={c ? "mono" : undefined}>{r.title}</b>
        <i className={c ? "mono" : undefined}>
          {r.kind === "link" && hostOf(r.to)}
          {c && (
            <>
              {c.file}
              {c.place && <em>#{c.place}</em>}
            </>
          )}
          {r.kind === "doc" && r.to.split("/").pop()}
          {lib &&
            `${lib.package?.ecosystem ?? "library"}${lib.package?.version ? ` ${lib.package.version}` : ""}`}
        </i>
      </span>
      {count}
      {docs && (
        <a
          className="ref-node-docs"
          href={docs}
          target="_blank"
          rel="noopener noreferrer"
          title={`Docs: ${docs}`}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <BookOpen size={12} />
        </a>
      )}
    </button>
  );
}

const KIND_WORD: Record<RefRow["kind"], string> = {
  link: "Link",
  image: "Image",
  doc: "Doc",
  code: "Code",
  dependency: "Dependency",
  entity: "Entity",
};

const KIND_NAME: Record<string, string> = {
  actor: "actor",
  system: "system",
  app: "app",
  store: "store",
  component: "component",
  module: "file",
  function: "function",
  library: "library",
  table: "table",
};

/** A field's type with the entities it names as links: "[Topping]" → [, Topping, ]. */
function TypeLinks(p: { idx: ModelIndex; type: string; onEntity: (id: string) => void }) {
  const parts = p.type.split(/(\b[A-Z][A-Za-z0-9_]*\b)/);
  return (
    <>
      {parts.map((t, i) => {
        const e = i % 2 ? [...p.idx.entities.values()].find((x) => x.name === t) : undefined;
        if (!e) return <span key={i}>{t}</span>;
        return (
          <button
            key={i}
            className={isTbd(e) ? "ep-type tbd" : "ep-type"}
            onClick={() => p.onEntity(e.id)}
            title={isTbd(e) ? `${e.name}: TBD` : `Open ${e.name}`}
          >
            {t}
          </button>
        );
      })}
    </>
  );
}

/** A box in the card's lists: its kind's dot, its name, and where it is when it's not drawn here. */
function BoxRow(p: {
  idx: ModelIndex;
  o: ModelObject;
  here: Set<string>;
  me?: boolean;
  onGo: (id: string) => void;
}) {
  const { o } = p;
  let inside: string | undefined;
  for (
    let c: string | null | undefined = p.here.has(o.id) ? null : o.parentId;
    c && !inside;
    c = p.idx.objects.get(c)?.parentId
  )
    if (p.here.has(c)) inside = p.idx.objects.get(c)?.name;
  return (
    <button
      className={p.me ? "ep-box me" : "ep-box"}
      onClick={() => p.onGo(o.id)}
      title={p.here.has(o.id) ? `Go to ${o.name}` : inside ? `In ${inside}` : "On another diagram"}
    >
      <span className="ref-pop-dot" data-kind={o.kind} />
      <span className="ep-box-name">{o.name}</span>
      <span className="ep-box-where">
        {p.me
          ? "this one"
          : p.here.has(o.id)
            ? KIND_NAME[o.kind]
            : inside
              ? `in ${inside}`
              : "elsewhere"}
      </span>
      <ChevronRight size={13} className="ep-box-go" />
    </button>
  );
}

/** An entity's card: what it is, its fields (what it inherits first), where it's defined and who uses it. Types and parents are links to theirs. */
function EntityPop(p: {
  idx: ModelIndex;
  r: RefRow;
  trail?: string[];
  onEntity?: (id: string) => void;
  onBack?: () => void;
  users: ModelObject[];
  here: Set<string>;
  from: string;
  at: { x: number; y: number };
  onGo: (id: string) => void;
  onGoEdge?: (connectionId: string) => void;
  edgeOf?: (connectionId: string) => string | undefined;
  onClose: () => void;
}) {
  // The entity shown: the last one clicked through to, else the one picked. Back goes one step.
  const trail = p.trail ?? [];
  const ent = p.idx.entities.get(trail.at(-1) ?? p.r.to);
  if (!ent) return null;
  const child = trail.length ? p.idx.entities.get(trail.at(-2) ?? p.r.to) : undefined;
  // Entities whose fields name this one (Pizza for Size), each a click away.
  const partOf = [...p.idx.entities.values()].filter(
    (x) =>
      x.id !== ent.id &&
      x.fields.some((f) => new RegExp(`\\b${ent.name}\\b`).test(splitField(f)[1])),
  );
  const src = ent.sourceId ? p.idx.objects.get(ent.sourceId) : undefined;
  const parents = (ent.extends ?? []).flatMap((x) => p.idx.entities.get(x) ?? []);
  const go = (id: string) => id !== ent.id && p.onEntity?.(id);
  const row = (f: string, faint?: string) => {
    const [n, t] = splitField(f);
    return (
      <div key={`${faint ?? ""}${f}`} className={faint ? "ep-field faint" : "ep-field"}>
        <span className="ep-fname">{n}</span>
        <span className="ep-ftype">{t && <TypeLinks idx={p.idx} type={t} onEntity={go} />}</span>
      </div>
    );
  };
  const tbd = isTbd(ent);
  const carriers = carriersOf(p.idx, ent.id);
  return (
    <div
      className="ref-pop ep"
      style={{
        transform: `translate(${p.at.x}px, ${p.at.y}px)`,
        maxHeight: window.innerHeight - p.at.y - 12,
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {child && (
        <button className="ep-crumb" onClick={() => p.onBack?.()}>
          <ChevronLeft size={12} /> {child.name}
        </button>
      )}
      <div className="ep-head">
        <span className={tbd ? "ep-icon tbd" : "ep-icon"}>
          <Braces size={14} />
        </span>
        <div className="ep-title">
          <b>{ent.name}</b>
          <span>{entitySummary(ent)}</span>
        </div>
        <button className="ref-pop-x" onClick={p.onClose} aria-label="Close">
          <X size={13} />
        </button>
      </div>
      {parents.length > 0 && (
        <div className="ep-extends">
          <span>extends</span>
          {parents.map((x) => (
            <button key={x.id} className="ep-chip" onClick={() => go(x.id)}>
              {x.name}
            </button>
          ))}
        </div>
      )}
      {tbd && !parents.length ? (
        <div className="ep-empty">
          Just a name so far. Give it fields from a card that uses it (Entities).
        </div>
      ) : (
        <div className="ep-fields">
          {parents.map((x) => (x.values?.length ? [] : x.fields.map((f) => row(f, x.name))))}
          {ent.values?.length ? (
            <div className="ep-values">
              {ent.values.map((v) => (
                <span key={v}>{v}</span>
              ))}
            </div>
          ) : (
            ent.fields.map((f) => row(f))
          )}
        </div>
      )}
      {src && (
        <div className="ep-sect">
          <div className="ep-label">Defined in</div>
          <BoxRow idx={p.idx} o={src} here={p.here} onGo={p.onGo} />
        </div>
      )}
      {partOf.length > 0 && (
        <div className="ep-sect">
          <div className="ep-label">Part of</div>
          <div className="ep-chips">
            {partOf.map((x) => (
              <button key={x.id} className="ep-chip" onClick={() => go(x.id)}>
                {x.name}
              </button>
            ))}
          </div>
        </div>
      )}
      {carriers.length > 0 && (
        <div className="ep-sect">
          <div className="ep-label">
            Carried on <em>{carriers.length}</em>
          </div>
          <div className="ep-list">
            {carriers.map((c) => (
              <button
                key={c.id}
                className={
                  p.from === `${EDGE_PARTS}${p.edgeOf?.(c.id)}` && !trail.length
                    ? "ep-box me"
                    : "ep-box"
                }
                onClick={() => p.onGoEdge?.(c.id)}
                title={c.name || "Go to it"}
              >
                <span className="ep-box-name">
                  {p.idx.objects.get(c.fromId)?.name ?? "?"} →{" "}
                  {p.idx.objects.get(c.toId)?.name ?? "?"}
                </span>
                <span className="ep-box-where">{c.name}</span>
                <ChevronRight size={13} className="ep-box-go" />
              </button>
            ))}
          </div>
        </div>
      )}
      {(p.users.length > 0 || !partOf.length) && (p.users.length > 0 || !carriers.length) && (
        <div className="ep-sect">
          <div className="ep-label">
            Used by <em>{p.users.length}</em>
          </div>
          {!p.users.length && <div className="ep-none">No box points at it yet.</div>}
          <div className="ep-list">
            {p.users.map((o) => (
              <BoxRow
                key={o.id}
                idx={p.idx}
                o={o}
                here={p.here}
                me={o.id === p.from && !trail.length}
                onGo={p.onGo}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** The card beside a picked reference: what it is, how to open it, and everything that shares it. */
function RefCard(p: {
  idx: ModelIndex;
  r: RefRow;
  trail?: string[];
  onEntity?: (id: string) => void;
  onBack?: () => void;
  onGoEdge?: (connectionId: string) => void;
  edgeOf?: (connectionId: string) => string | undefined;
  users: ModelObject[];
  here: Set<string>;
  from: string;
  at: { x: number; y: number };
  onGo: (id: string) => void;
  onClose: () => void;
}) {
  const { r } = p;
  const lib = r.kind === "dependency" ? p.idx.objects.get(r.to) : undefined;
  const docs = lib ? libraryDocs(lib) : null;
  const url = r.kind === "link" || (r.kind === "image" && /^https?:\/\//.test(r.to)) ? r.to : null;
  const where = lib
    ? [lib.package?.ecosystem, lib.package?.name, lib.package?.version].filter(Boolean).join(" ")
    : r.to;
  if (r.kind === "entity") return <EntityPop {...p} />;
  return (
    <div
      className="ref-pop"
      style={{ transform: `translate(${p.at.x}px, ${p.at.y}px)` }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="ref-pop-head">
        <span className={`ref-kind ref-${r.kind}`}>{KIND_WORD[r.kind]}</span>
        <b>{r.title}</b>
        <button className="ref-pop-x" onClick={p.onClose} aria-label="Close">
          <X size={12} />
        </button>
      </div>
      <div className="ref-pop-to">{where}</div>
      <div className="ref-pop-actions">
        {url && (
          <a href={url} target="_blank" rel="noopener noreferrer">
            <ExternalLink size={12} /> Open
          </a>
        )}
        {docs && (
          <a href={docs} target="_blank" rel="noopener noreferrer">
            <BookOpen size={12} /> Docs
          </a>
        )}
        {!url && !lib && (
          <button onClick={() => void navigator.clipboard?.writeText(r.to)}>
            <Copy size={12} /> Copy path
          </button>
        )}
        {lib && p.here.has(lib.id) && <button onClick={() => p.onGo(lib.id)}>Its card</button>}
      </div>
      <div className="ref-pop-label">
        {p.users.length === 1 ? "Only this one points here" : `Shared by ${p.users.length}`}
      </div>
      <div className="ref-pop-users">
        {p.users.map((o) => (
          <button
            key={o.id}
            className={o.id === p.from ? "ref-pop-user me" : "ref-pop-user"}
            onClick={() => p.onGo(o.id)}
            title={p.here.has(o.id) ? "Select it" : "Not on this diagram"}
          >
            <span className="ref-pop-dot" data-kind={o.kind} />
            <span className="ref-pop-name">{o.name}</span>
            {!p.here.has(o.id) && <i>elsewhere</i>}
          </button>
        ))}
      </div>
    </div>
  );
}

/** What's drawn over the boxes: a row under each (tech, notes) and its references as nodes. */
export function PartsLayer(p: PartsProps) {
  const [view, setView] = useState<SceneView | null>(null);
  const [hot, setHot] = useState<string | null>(null);
  /** A reference clicked on: its key (what makes it the same thing), the box it's under, and which of that box's references. */
  /** `trail`: the entities clicked through to from a picked entity (its parent, a field's type), last shown. */
  const [picked, setPicked] = useState<{
    key: string;
    box: string;
    kind: RefRow["kind"];
    at: number;
    trail?: string[];
  } | null>(null);
  useEffect(() => {
    if (!picked) return;
    // Esc steps back through the entities clicked through to, then closes.
    const key = (e: KeyboardEvent) =>
      e.key === "Escape" &&
      setPicked((x) => (x?.trail?.length ? { ...x, trail: x.trail.slice(0, -1) } : null));
    const down = (e: PointerEvent) =>
      !(e.target as HTMLElement).closest(".ref-node-at, .ref-pop") && setPicked(null);
    window.addEventListener("keydown", key);
    window.addEventListener("pointerdown", down);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("pointerdown", down);
    };
  }, [picked]);
  /** A box's layer nodes being dragged: by how far (screen px), once past a few pixels. */
  const [drag, setDrag] = useState<{ box: string; dx: number; dy: number } | null>(null);
  const press = useRef<{ box: string; x: number; y: number; moved: boolean } | null>(null);
  /** A drag ends in a click on the node it started on: that click isn't a pick. */
  const swallow = useRef(false);
  const dropAt = useRef<(box: string, dx: number, dy: number) => void>(() => {});
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const pr = press.current;
      if (!pr) return;
      const dx = e.clientX - pr.x;
      const dy = e.clientY - pr.y;
      if (!pr.moved && Math.hypot(dx, dy) < 4) return;
      pr.moved = true;
      setDrag({ box: pr.box, dx, dy });
    };
    const up = (e: PointerEvent) => {
      const pr = press.current;
      press.current = null;
      if (!pr?.moved) return;
      swallow.current = true;
      setTimeout(() => (swallow.current = false), 0);
      dropAt.current(pr.box, e.clientX - pr.x, e.clientY - pr.y);
      setDrag(null);
      setHot(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, []);
  // The arrows to light for what's hovered or picked (filled in as this renders; sent after).
  const lightNow = useRef<[string, string][] | null>(null);
  const lightSent = useRef("");
  lightNow.current = null;
  useEffect(() => {
    const k = JSON.stringify(lightNow.current);
    if (k === lightSent.current) return;
    lightSent.current = k;
    p.onLightPairs?.(lightNow.current);
  });
  /** The box whose notes are opened out (hovered); the others show one compact row. */
  const [open, setOpen] = useState<string | null>(null);
  const layer = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const off = p.scene?.watch((v) => setView({ camera: v.camera, moving: v.moving }));
    return () => void off?.();
  }, [p.scene]);
  useEffect(() => {
    const el = layer.current;
    const s = p.scene;
    if (!el || !s) return;
    // Scrolling a card scrolls the card; anywhere else on the layer moves the canvas.
    const fn = (e: WheelEvent) =>
      !(e.target as HTMLElement).closest?.(".ref-pop") && s.forwardWheel(e);
    el.addEventListener("wheel", fn, { passive: false });
    return () => el.removeEventListener("wheel", fn);
  }, [p.scene]);

  const { tech, references, entities, notes } = p.layers;
  if (!view || !(tech || references || entities || notes))
    return <div className="parts-layer" ref={layer} />;
  const cam = view.camera;
  if (cam.scale < 0.35) return <div className="parts-layer" ref={layer} />;

  const rectOf = (n: CanvasNode): Rect => {
    const m = view.moving.get(n.id);
    return { x: m?.x ?? n.x, y: m?.y ?? n.y, w: n.w, h: n.h };
  };
  const shown = p.nodes.filter((n) => !n.folded && p.idx.objects.get(n.id));

  // What lights up: a picked reference (it stays), else whatever's hovered: tech by name, a
  // reference by what it points at (refKey).
  const shownEntity = picked?.trail?.at(-1);
  const active = picked
    ? shownEntity
      ? refKey({ kind: "entity", to: shownEntity })
      : picked.key
    : hot;
  const keysOf = (id: string): Set<string> => {
    const o = p.idx.objects.get(id);
    const out = new Set<string>();
    if (!o) return out;
    for (const t of techsOf(o.technology)) out.add(`tech:${t.toLowerCase()}`);
    for (const r of referencesOf(p.idx, o)) out.add(refKey(r));
    for (const r of entityRows(p.idx, o)) out.add(refKey(r));
    if (o.kind === "library") out.add(`dependency:${o.id}`);
    return out;
  };
  const lit = active
    ? new Set(shown.filter((n) => keysOf(n.id).has(active)).map((n) => n.id))
    : null;
  const shareCount = new Map<string, number>();
  for (const o of [...p.idx.objects.values(), ...p.idx.connections.values()])
    if (o.status !== "removed")
      for (const k of new Set([...referencesOf(p.idx, o), ...entityRows(p.idx, o)].map(refKey)))
        shareCount.set(k, (shareCount.get(k) ?? 0) + 1);

  // The row under a box takes room too, so references keep clear of it.
  const edgesAt = (p.layers.entities || p.layers.references ? (p.edges ?? []) : []).flatMap(
    (edge) => {
      const at = p.scene?.edgeLabelAt(edge.id);
      return at ? [{ edge, at }] : [];
    },
  );
  const laid = layoutParts(p.idx, shown, p.layers, rectOf, p.spotOf, edgesAt);
  /** The box (or an arrow's label) a group of parts belongs to. */
  const ownerRect = (id: string): Rect | undefined => {
    if (id.startsWith(EDGE_PARTS))
      return edgesAt.find((e) => `${EDGE_PARTS}${e.edge.id}` === id)?.at;
    const n = shown.find((x) => x.id === id);
    return n && rectOf(n);
  };
  // The stack being dragged, drawn where the pointer has it.
  const refLayout: RefLayout = new Map(
    [...laid].map(([id, g]) => {
      if (drag?.box !== id) return [id, g];
      const ox = drag.dx / cam.scale;
      const oy = drag.dy / cam.scale;
      const by = (r: Rect): Rect => ({ ...r, x: r.x + ox, y: r.y + oy });
      return [id, { group: by(g.group), items: g.items.map((i) => ({ ...i, at: by(i.at) })) }];
    }),
  );
  if (active) {
    const pairs = edgesAt
      .filter(({ edge }) => edgeRefs(p.idx, edge, p.layers).some((r) => refKey(r) === active))
      .map(({ edge }): [string, string] => [edge.from, edge.to]);
    lightNow.current = pairs.length ? pairs : null;
  }
  /** The arrow a connection is drawn as here. */
  const edgeOf = (cid: string) => (p.edges ?? []).find((e) => e.connectionIds.includes(cid))?.id;
  dropAt.current = (box, dx, dy) => {
    const g = laid.get(box);
    const r = ownerRect(box);
    if (!g || !r || !p.onMoveParts) return;
    p.onMoveParts(box, {
      x: Math.round(g.group.x + dx / cam.scale - r.x),
      y: Math.round(g.group.y + dy / cam.scale - r.y),
    });
  };
  const toScreen = (r: Rect) => {
    const a = worldToScreen(cam, r);
    return { x: a.x, y: a.y, w: r.w * cam.scale, h: r.h * cam.scale };
  };

  return (
    <div className={active ? "parts-layer hot" : "parts-layer"} ref={layer}>
      {refLayout.size > 0 && (
        <svg className="ref-tethers">
          {[...refLayout.entries()].map(([id, g]) => {
            const owner = ownerRect(id);
            if (!owner) return null;
            const box = toScreen(owner);
            const grp = toScreen(g.group);
            const mid = { x: grp.x + grp.w / 2, y: grp.y + grp.h / 2 };
            const a = nearest(box, mid);
            const z = nearest(grp, { x: box.x + box.w / 2, y: box.y + box.h / 2 });
            const dim = lit && !lit.has(id);
            return (
              <line
                key={id}
                className={dim ? "dim" : undefined}
                x1={a.x}
                y1={a.y}
                x2={z.x}
                y2={z.y}
              />
            );
          })}
        </svg>
      )}
      {lit &&
        shown
          .filter((n) => lit.has(n.id))
          .map((n) => {
            const b = toScreen(rectOf(n));
            return (
              <div
                key={`ring-${n.id}`}
                className="parts-ring"
                style={{
                  transform: `translate(${b.x - 4}px, ${b.y - 4}px)`,
                  width: b.w + 8,
                  height: b.h + 8,
                }}
              />
            );
          })}
      {[...refLayout.entries()].flatMap(([id, g]) =>
        g.items.map(({ ref, at }) => {
          const s = worldToScreen(cam, at);
          const k = refKey(ref);
          const on = active === k;
          const dim = !!active && !on;
          const me = picked?.box === id && picked.kind === ref.kind && picked.at === ref.at;
          return (
            <div
              key={`${id}-${ref.kind}-${ref.at}`}
              className={`ref-node-at${dim ? " dim" : ""}${me ? " picked" : ""}${drag?.box === id ? " dragging" : ""}`}
              style={{
                transform: `translate(${s.x}px, ${s.y}px) scale(${cam.scale})`,
                width: at.w,
                height: at.h,
              }}
              onPointerDown={(e) => {
                if (e.button !== 0 || !p.onMoveParts) return;
                press.current = { box: id, x: e.clientX, y: e.clientY, moved: false };
              }}
              onClickCapture={(e) => {
                if (swallow.current) e.stopPropagation();
              }}
              onContextMenu={(e) => {
                // Moved somewhere: right-click puts them back where they find room by themselves.
                if (!p.onMoveParts || !p.spotOf?.(id)) return;
                e.preventDefault();
                e.stopPropagation();
                p.onMoveParts(id, null);
                setHot(null);
              }}
            >
              <RefNode
                idx={p.idx}
                r={ref}
                box={id}
                on={on}
                shared={shareCount.get(k) ?? 1}
                onPick={() =>
                  setPicked(
                    me && !picked?.trail?.length
                      ? null
                      : { key: k, box: id, kind: ref.kind, at: ref.at },
                  )
                }
                onEntity={(eid) =>
                  setPicked({ key: k, box: id, kind: ref.kind, at: ref.at, trail: [eid] })
                }
                onOpen={() =>
                  openRef(ref, p.idx, () =>
                    id.startsWith(EDGE_PARTS)
                      ? p.onOpenEdge?.(id.slice(EDGE_PARTS.length))
                      : p.onOpen(ref.kind === "dependency" ? ref.to : id, id),
                  )
                }
                onHot={(h) => setHot(h ? k : null)}
              />
            </div>
          );
        }),
      )}
      {(() => {
        if (!picked) return null;
        const item = refLayout
          .get(picked.box)
          ?.items.find((i) => i.ref.kind === picked.kind && i.ref.at === picked.at);
        if (!item) return null;
        const sc = toScreen(item.at);
        const here = new Set(shown.map((n) => n.id));
        return (
          <RefCard
            idx={p.idx}
            r={item.ref}
            trail={picked.trail}
            onEntity={(eid) =>
              setPicked({
                ...picked,
                trail: eid === item.ref.to ? [] : [...(picked.trail ?? []), eid],
              })
            }
            onBack={() => setPicked({ ...picked, trail: (picked.trail ?? []).slice(0, -1) })}
            users={
              item.ref.kind === "entity"
                ? usersOf(p.idx, shownEntity ?? item.ref.to)
                : sharingRef(p.idx, picked.key).filter(
                    (o) => o.kind !== "library" || item.ref.kind !== "dependency",
                  )
            }
            here={here}
            from={picked.box}
            // Beside it on the right, or on its left when that would run off the screen.
            at={{
              x:
                sc.x + sc.w + 10 + POP_W > window.innerWidth - 8
                  ? Math.max(8, sc.x - POP_W - 10)
                  : sc.x + sc.w + 10,
              y: Math.max(8, Math.min(sc.y, window.innerHeight - 440)),
            }}
            onGo={(oid) => {
              setHot(null);
              // From an entity: stay on it. Pick the same entity beside that box and glide there
              // (it and its card in the middle). Anywhere else, or when that box isn't drawn
              // here: go to the box and open its card.
              const eid = item.ref.kind === "entity" ? (shownEntity ?? item.ref.to) : null;
              const there = eid
                ? refLayout.get(oid)?.items.find((i) => i.ref.kind === "entity" && i.ref.to === eid)
                : undefined;
              if (!there) {
                setPicked(null);
                return p.onGo(oid);
              }
              setPicked({ key: refKey(there.ref), box: oid, kind: "entity", at: there.ref.at });
              const s = cam.scale;
              p.scene?.centerAt(
                { x: there.at.x + (there.at.w + (10 + POP_W) / s) / 2, y: there.at.y + 160 / s },
                true,
              );
            }}
            edgeOf={edgeOf}
            onGoEdge={(cid) => {
              setHot(null);
              // The same entity beside that arrow's label: pick it there. Not drawn: open the arrow.
              const eid = shownEntity ?? item.ref.to;
              const edge = edgeOf(cid);
              if (!edge) return;
              const there = refLayout
                .get(`${EDGE_PARTS}${edge}`)
                ?.items.find((i) => i.ref.kind === "entity" && i.ref.to === eid);
              if (!there) {
                setPicked(null);
                return p.onOpenEdge?.(edge);
              }
              setPicked({
                key: refKey(there.ref),
                box: `${EDGE_PARTS}${edge}`,
                kind: "entity",
                at: there.ref.at,
              });
              const s = cam.scale;
              p.scene?.centerAt(
                { x: there.at.x + (there.at.w + (10 + POP_W) / s) / 2, y: there.at.y + 160 / s },
                true,
              );
            }}
            onClose={() => setPicked(null)}
          />
        );
      })()}
      {shown.map((n) => {
        const o = p.idx.objects.get(n.id)!;
        const techs = tech ? techsOf(o.technology) : [];
        const lines = notes && o.notes?.trim() ? noteLines(o.notes) : [];
        if (!techs.length && !lines.length) return null;
        const r = rectOf(n);
        const at = worldToScreen(cam, { x: r.x, y: r.y + r.h + 4 });
        const checks = lines.filter((l) => l.done !== null);
        const done = checks.filter((l) => l.done).length;
        const dim = lit && !lit.has(n.id);
        const style = {
          transform: `translate(${at.x}px, ${at.y}px) scale(${cam.scale})`,
          width: Math.max(n.w, 180),
        };
        const techChip = (t: string) => {
          const k = `tech:${t.toLowerCase()}`;
          return (
            <span
              key={t}
              className={hot === k ? "pchip tech on" : "pchip tech"}
              onPointerEnter={() => setHot(k)}
              onPointerLeave={() => setHot(null)}
            >
              {t}
            </span>
          );
        };
        if (open !== n.id) {
          return (
            <div key={n.id} className={dim ? "parts compact dim" : "parts compact"} style={style}>
              <div className="parts-row nowrap">
                {techs.slice(0, 3).map(techChip)}
                {techs.length > 3 && <span className="pchip tech">+{techs.length - 3}</span>}
                {lines.length > 0 && (
                  <span
                    className="pchip note-chip"
                    title="Notes: hover to read"
                    onPointerEnter={() => setOpen(n.id)}
                  >
                    <StickyNote size={11} />
                    {checks.length > 0 ? (
                      <span>
                        {done}/{checks.length}
                      </span>
                    ) : null}
                  </span>
                )}
              </div>
            </div>
          );
        }
        return (
          <div
            key={n.id}
            className={dim ? "parts full dim" : "parts full"}
            style={style}
            onPointerLeave={() => setOpen(null)}
          >
            {techs.length > 0 && <div className="parts-row">{techs.map(techChip)}</div>}
            {lines.length > 0 && (
              <button className="pnote" onClick={() => p.onOpen(n.id, n.id)} title="Open its notes">
                <span className="pnote-head">
                  <StickyNote size={11} /> Notes
                  {checks.length > 0 && (
                    <span className="pnote-progress">
                      {done}/{checks.length}
                    </span>
                  )}
                </span>
                {lines.slice(0, 6).map((l, i) => (
                  <span key={i} className={l.done ? "pnote-line done" : "pnote-line"}>
                    {l.done !== null && <span className="pnote-box">{l.done ? "✓" : ""}</span>}
                    {l.text}
                  </span>
                ))}
                {lines.length > 6 && <span className="pnote-more">+{lines.length - 6} more</span>}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
