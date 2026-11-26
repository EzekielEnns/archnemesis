// Open a box in place: its inside view drawn right here, in a frame where the box was, with
// everything to its right and below it moved over to make room. For looking only: nothing is
// written (the boxes it adds have no placement on this diagram, so dragging them does nothing,
// and the ones it moved are moved back before a drag is saved). See docs/nodes-plan.md, "unwrap".
import { CARD_H, CARD_W, type Placement } from "./model.ts";
import { diagramForScope, isInside, type CanvasGroup, type ModelIndex } from "./project.ts";

type Rect = { x: number; y: number; w: number; h: number };

const PAD = 28;
const LABEL = 34;
const GAP = 48;

/** Room on each side of an opened box's insides for the reference cards drawn beside them (one card and its gap). */
export const PARTS_GUTTER = 216;

/** An opened box's frame is selected as the boundary "open:<object id>". */
export const OPEN_FRAME = "open:";

export interface Exploded {
  /** The index to draw from: this diagram's placements, with the opened boxes' insides in. */
  idx: ModelIndex;
  /** A frame per opened box, named after it. */
  frames: CanvasGroup[];
  /** How far each moved box was moved, to take off again before a drag is saved. */
  moved: Map<string, { dx: number; dy: number }>;
  /** Each box opened, in order: where it was then and how much room it made. */
  steps: { box: Rect; grow: { x: number; y: number } }[];
  /** Per panel (by frame id): its box's own view, and the offset from a spot drawn in the panel
   * (relative to the panel's corner) to that spot in the view. Not there for a box with no view. */
  views: Map<string, { viewId: string; dx: number; dy: number }>;
}

/** Where a spot drawn inside an opened box's panel is in that box's own view. */
export function inView(
  ex: Exploded,
  frameId: string,
  p: { x: number; y: number },
): { viewId: string; x: number; y: number } | null {
  const v = ex.views.get(frameId);
  const f = ex.frames.find((x) => x.id === frameId);
  if (!v || !f) return null;
  return { viewId: v.viewId, x: p.x - f.x + v.dx, y: p.y - f.y + v.dy };
}

/** Where a point drawn on the opened layout really is on the diagram (undoing the room made). */
export function unexplode(ex: Exploded, p: { x: number; y: number }): { x: number; y: number } {
  let { x, y } = p;
  for (const { box, grow } of [...ex.steps].reverse()) {
    const right = box.x + box.w;
    const bottom = box.y + box.h;
    // Beside the panel there's no real spot (it's the room made): the nearest one still drawn
    // beside it is just inside the closed box's edge.
    if (x >= right + grow.x) x -= grow.x;
    else if (x >= right) x = right - 1;
    if (y >= bottom + grow.y) y -= grow.y;
    else if (y >= bottom) y = bottom - 1;
  }
  return { x, y };
}

/** What's inside a box, placed as its own view has them (or in rows, when it has no view). */
function insideOf(idx: ModelIndex, boxId: string): Placement[] {
  const view = diagramForScope(idx, boxId);
  const own = view
    ? [...(idx.placements.get(view.id)?.values() ?? [])].filter(
        (p) => p.objectId !== boxId && isInside(idx, p.objectId, boxId),
      )
    : [];
  if (own.length) return own;
  const kids = (idx.children.get(boxId) ?? []).filter((c) => c.status !== "removed");
  const cols = Math.max(1, Math.ceil(Math.sqrt(kids.length)));
  return kids.map((c, i) => ({
    diagramId: "",
    objectId: c.id,
    x: (i % cols) * (CARD_W + GAP),
    y: Math.floor(i / cols) * (CARD_H + GAP),
    w: CARD_W,
    h: CARD_H,
  }));
}

/** Can it open here: it has something inside. */
export function canExplode(idx: ModelIndex, boxId: string): boolean {
  return insideOf(idx, boxId).length > 0;
}

export function explode(
  idx: ModelIndex,
  diagramId: string,
  open: string[],
  opts: { gutter?: number } = {},
): Exploded | null {
  const side = PAD + (opts.gutter ?? 0);
  const base = idx.placements.get(diagramId);
  if (!base || !open.length) return null;
  const here = new Map(base);
  const frames: CanvasGroup[] = [];
  const moved = new Map<string, { dx: number; dy: number }>();
  const steps: Exploded["steps"] = [];
  const views: Exploded["views"] = new Map();
  for (const boxId of open) {
    const box = here.get(boxId);
    if (!box) continue;
    // What's inside. Something also drawn here on its own (dropped into the box on this
    // diagram) moves into the panel while it's open.
    // Nothing inside (all of it dragged out, say): an empty panel, so it doesn't vanish.
    const inner = insideOf(idx, boxId);
    const minX = inner.length ? Math.min(...inner.map((p) => p.x)) : 0;
    const minY = inner.length ? Math.min(...inner.map((p) => p.y)) : 0;
    const w = inner.length
      ? Math.max(...inner.map((p) => p.x + p.w)) - minX + side * 2
      : Math.max(box.w, CARD_W + PAD * 2);
    const h = inner.length
      ? Math.max(...inner.map((p) => p.y + p.h)) - minY + side * 2 + LABEL
      : Math.max(box.h, CARD_H + PAD * 2 + LABEL);
    const view = diagramForScope(idx, boxId);
    if (view)
      views.set(`boundary:${OPEN_FRAME}${boxId}`, {
        viewId: view.id,
        dx: minX - side,
        dy: minY - side - LABEL,
      });
    const grow = { x: Math.max(0, w - box.w), y: Math.max(0, h - box.h) };
    steps.push({ box: { x: box.x, y: box.y, w: box.w, h: box.h }, grow });
    // Make room: what starts right of the box moves right, what starts below it moves down.
    // An earlier panel moves as one, with everything in it (an outer one holding this box
    // grows instead, and what's in it moves by the same rule as the rest).
    const holds = (f: Rect) =>
      box.x >= f.x && box.y >= f.y && box.x + box.w <= f.x + f.w && box.y + box.h <= f.y + f.h;
    const within = (r: Rect, f: Rect) =>
      r.x >= f.x && r.y >= f.y && r.x + r.w <= f.x + f.w && r.y + r.h <= f.y + f.h;
    const shiftOf = (r: Rect) => ({
      dx: r.x >= box.x + box.w ? grow.x : 0,
      dy: r.y >= box.y + box.h ? grow.y : 0,
    });
    // Each thing moves as the outermost panel around it that isn't opening this box.
    const unit = (r: Rect): Rect => {
      let best: Rect | null = null;
      for (const f of frames)
        if (!holds(f) && within(r, f) && (!best || f.w * f.h > best.w * best.h)) best = f;
      return best ?? r;
    };
    const nodeShift = new Map<string, { dx: number; dy: number }>();
    for (const [id, p] of here) if (id !== boxId) nodeShift.set(id, shiftOf(unit(p)));
    const frameShift = frames.map((f) => (holds(f) ? null : shiftOf(unit(f))));
    for (const [id, d] of nodeShift) {
      if (!d.dx && !d.dy) continue;
      const p = here.get(id)!;
      here.set(id, { ...p, x: p.x + d.dx, y: p.y + d.dy });
    }
    frames.forEach((f, i) => {
      const d = frameShift[i];
      if (!d) {
        f.w += grow.x;
        f.h += grow.y;
        return;
      }
      f.x += d.dx;
      f.y += d.dy;
    });
    here.delete(boxId);
    for (const p of inner)
      here.set(p.objectId, {
        ...p,
        diagramId,
        x: p.x - minX + box.x + side,
        y: p.y - minY + box.y + side + LABEL,
      });
    frames.push({
      id: `boundary:${OPEN_FRAME}${boxId}`,
      name: idx.objects.get(boxId)?.name ?? "",
      boundary: "group",
      inset: true,
      kind: idx.objects.get(boxId)?.kind,
      depth: 0,
      x: box.x,
      y: box.y,
      w,
      h,
    });
  }
  if (!frames.length) return null;
  // How far each box that's really on this diagram was moved, to take off before a drag is saved.
  for (const [id, p] of base) {
    const now = here.get(id);
    if (now && (now.x !== p.x || now.y !== p.y))
      moved.set(id, { dx: now.x - p.x, dy: now.y - p.y });
  }
  const placements = new Map(idx.placements);
  placements.set(diagramId, here);
  return { idx: { ...idx, placements }, frames, moved, steps, views };
}
