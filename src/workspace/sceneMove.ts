// Boxes dragged on the canvas: their new places, and (simple mode) dropped into a frame or onto
// a box they go inside it in the model, dropped out of its frame they come out.
import { moveOps, updateObject } from "../../shared/actions.ts";
import { CARD_H, CARD_W } from "../../shared/model.ts";
import type { ModelObject, Op } from "../../shared/model.ts";
import { descendants, type CanvasGraph, type ModelIndex } from "../../shared/project.ts";
import { inView, OPEN_FRAME, unexplode } from "../../shared/explode.ts";

import type { SceneCallbacks } from "../canvas/Scene";
import type { LatestRef } from "./latest";
import type { Spread } from "../canvas/spread";
import type { Exploded } from "../../shared/explode.ts";

interface MoveContext {
  i: ModelIndex;
  d: string;
  g: CanvasGraph | null;
  sp: Spread;
  ex: Exploded | null;
}

/** Where a box dropped into (or out of) a frame goes in the model: undefined when it stays. */
function newParent(
  o: ModelObject,
  into: string | null,
  { i, g }: MoveContext,
  scope: string | null,
): string | null | undefined {
  let to: string | null | undefined;
  if (into && into !== o.parentId) {
    const t = i.objects.get(into);
    // Not into itself or something inside it, nor into what can't hold things.
    if (
      t &&
      !["actor", "table", "library"].includes(t.kind) &&
      into !== o.id &&
      !descendants(i, o.id).includes(into)
    )
      to = into;
  } else if (
    !into &&
    o.parentId &&
    g?.groups.some(
      (x) =>
        (x.container && x.id === o.parentId) ||
        (x.inset && x.id === `boundary:${OPEN_FRAME}${o.parentId}`),
    )
  ) {
    to = i.objects.get(o.parentId)?.parentId ?? scope;
  }
  return to;
}

type Size = { w: number; h: number };
type Panel = NonNullable<ReturnType<typeof inView>>;

/** Into a box opened here: where it was let go, in that box's own view; off this one. */
function intoOpenedView(
  ops: Op[],
  o: ModelObject,
  panel: Panel,
  size: Size,
  d: string,
  was: unknown,
) {
  ops.push({
    op: "placement.put",
    placement: {
      diagramId: panel.viewId,
      objectId: o.id,
      x: Math.round(panel.x),
      y: Math.round(panel.y),
      ...size,
    },
  });
  if (was) ops.push({ op: "placement.delete", diagramId: d, objectId: o.id });
}

/**
 * Into a box drawn as a box: it goes in, closed (off this diagram, and off the view
 * of any box opened here it was drawn in; the box counts it).
 */
function intoDrawnBox(ops: Op[], o: ModelObject, { i, d, ex }: MoveContext, was: unknown) {
  if (was) ops.push({ op: "placement.delete", diagramId: d, objectId: o.id });
  for (const v of ex?.views.values() ?? [])
    if (i.placements.get(v.viewId)?.has(o.id))
      ops.push({ op: "placement.delete", diagramId: v.viewId, objectId: o.id });
}

/** Out of a box opened here onto this diagram: where it was let go. */
function outOntoDiagram(
  ops: Op[],
  o: ModelObject,
  ex: Exploded,
  m: { x: number; y: number },
  sp: Spread,
  d: string,
  size: Size,
) {
  const at = unexplode(ex, { x: m.x, y: sp.up(m.y) });
  ops.push({
    op: "placement.put",
    placement: {
      diagramId: d,
      objectId: o.id,
      x: Math.round(at.x),
      y: Math.round(at.y),
      ...size,
    },
  });
}

/** Put one box into `to` (or out onto this diagram), in the right view; says what it did. */
function reparentOps(
  ops: Op[],
  o: ModelObject,
  to: string | null,
  drawnMoves: { id: string; x: number; y: number }[],
  c: MoveContext,
): string {
  const { i, d, g, sp, ex } = c;
  ops.push(...updateObject(o, { parentId: to }));
  const m = drawnMoves.find((x) => x.id === o.id)!;
  const n = g?.nodes.find((x) => x.id === o.id);
  const was = i.placements.get(d)?.get(o.id);
  const size = { w: was?.w ?? n?.w ?? CARD_W, h: was?.h ?? n?.h ?? CARD_H };
  const panel =
    to && ex ? inView(ex, `boundary:${OPEN_FRAME}${to}`, { x: m.x, y: sp.up(m.y) }) : null;
  const holderHere = to ? g?.nodes.some((x) => x.id === to) : false;
  if (panel) intoOpenedView(ops, o, panel, size, d, was);
  else if (holderHere) intoDrawnBox(ops, o, c, was);
  else if (ex?.frames.some((x) => x.id === `boundary:${OPEN_FRAME}${o.parentId}`))
    outOntoDiagram(ops, o, ex, m, sp, d, size);
  return to ? `put ${o.name} in ${i.objects.get(to)?.name}` : `take ${o.name} out`;
}

export function moveHandler(latest: LatestRef): SceneCallbacks["onMove"] {
  return (drawnMoves, dropped) => {
    // Into a box opened here: into that box.
    const into = dropped?.startsWith(`boundary:${OPEN_FRAME}`)
      ? dropped.slice(`boundary:${OPEN_FRAME}`.length)
      : dropped;
    const { idx: i, diagramId: d, run: r, graph: g, spread: sp, exploded: ex } = latest.current;
    if (!d) return;
    // A box opened here moved things over to make room: they're saved where they really are.
    const moves = drawnMoves.map((m) => {
      const off = ex?.moved.get(m.id);
      return { ...m, x: m.x - (off?.dx ?? 0), y: Math.round(sp.up(m.y)) - (off?.dy ?? 0) };
    });
    // Simple mode: dropped onto a box or into a frame, it goes inside that (in the model, so
    // every view agrees); dropped out of its frame onto empty canvas, it comes out.
    const ops = moveOps(i, d, moves);
    let label = moves.length === 1 ? "move" : `move ${moves.length}`;
    if (into !== undefined) {
      const ids = new Set(moves.map((m) => m.id));
      const scope = i.diagrams.get(d)?.scopeId ?? null;
      for (const m of moves) {
        const o = i.objects.get(m.id);
        if (!o || (o.parentId && ids.has(o.parentId))) continue; // its parent moves with it
        const c = { i, d, g, sp, ex };
        const to = newParent(o, into, c, scope);
        if (to !== undefined) label = reparentOps(ops, o, to, drawnMoves, c);
      }
    }
    void r(ops, label);
  };
}
