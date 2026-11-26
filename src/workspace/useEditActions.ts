// Editing the selection: delete or hide it, duplicate it, group it in a frame, put it inside a
// box, take a box's insides out (ungroup).
import { useCallback, useRef } from "react";
import {
  deleteConnections,
  deleteObjects,
  removeFromDiagram,
  updateObject,
} from "../../shared/actions.ts";
import { CARD_H, CARD_W, makeObject, now } from "../../shared/model.ts";
import type { Op } from "../../shared/model.ts";
import { boundaryOf, newBoundaryOps } from "../../shared/boundaries.ts";
import { descendants, type CanvasGraph, type ModelIndex } from "../../shared/project.ts";
import { type Selection } from "../canvas/Scene";
import { foldBack } from "../ui/Inspector";
import { OPEN_FRAME } from "../../shared/explode.ts";
import { FOLD_FRAME } from "../../shared/project.ts";

import type { Run, ToastFn } from "./toasts";
import type { SceneRef } from "./types";

export function useEditActions({
  sel,
  idx,
  diagramId,
  graph,
  run,
  toast,
  openFresh,
  openHere,
  scene,
}: {
  sel: Selection;
  idx: ModelIndex;
  diagramId: string | null;
  graph: CanvasGraph | null;
  run: Run;
  toast: ToastFn;
  openFresh: (id: string) => void;
  openHere: (id: string, on: boolean) => void;
  scene: SceneRef;
}) {
  /** The group tool's drop, bound once in the canvas callbacks (set once groupSelection exists). */
  const groupRef = useRef<(ids: string[]) => void>(() => {});
  const removeSelected = useCallback(
    (everywhere: boolean) => {
      if (!diagramId) return;
      if (sel.edge) {
        const e = graph?.edges.find((x) => x.id === sel.edge);
        if (e)
          void run(
            deleteConnections(e.connectionIds),
            e.connectionIds.length === 1 ? "delete connection" : "delete connections",
          );
        return;
      }
      if (!sel.nodes.length) return;
      const n = sel.nodes.length;
      if (everywhere)
        void run(
          deleteObjects(sel.nodes),
          n === 1 ? `delete ${idx.objects.get(sel.nodes[0]!)?.name}` : `delete ${n} objects`,
        );
      else
        void run(
          removeFromDiagram(diagramId, sel.nodes),
          n === 1 ? "remove from diagram" : `remove ${n} from diagram`,
        );
    },
    [sel, diagramId, graph, idx, run],
  );
  const duplicate = useCallback(() => {
    if (!diagramId || !sel.nodes.length) return;
    const placed = idx.placements.get(diagramId);
    const ops: Op[] = [];
    const copies: string[] = [];
    for (const id of sel.nodes) {
      const o = idx.objects.get(id);
      const p = placed?.get(id);
      if (!o || !p) continue;
      // Not its key: two objects can't share one (it's their file name), the copy gets its own.
      const { id: _id, key: _k, createdAt: _c, updatedAt: _u, ...fields } = o;
      const copy = makeObject({ ...fields, name: `${o.name} copy` });
      copies.push(copy.id);
      ops.push({ op: "object.put", object: copy });
      ops.push({
        op: "placement.put",
        placement: {
          diagramId,
          objectId: copy.id,
          x: p.x + 32,
          y: p.y + 32,
          w: p.w || CARD_W,
          h: p.h || CARD_H,
        },
      });
    }
    void run(ops, copies.length === 1 ? "duplicate" : `duplicate ${copies.length}`).then(() =>
      scene.current?.select({ nodes: copies, edge: null }, true),
    );
  }, [diagramId, sel, idx, run]);
  /**
   * Group: a frame around the selection, the generic kind of frame a region is (a boundary of
   * kind group; its kind can be changed to region, project… in its card). It doesn't change
   * what's inside what: that's dragging a box into another, or "Put inside".
   */
  const groupSelection = useCallback(
    (pick?: string[]) => {
      if (!diagramId) return;
      const ids = (pick ?? sel.nodes).filter((id) => idx.objects.has(id));
      if (!ids.length) return;
      // Inside the frame they're all in already (a region), so the group sits in it.
      const around = new Set(ids.map((id) => boundaryOf(idx, id)));
      if (around.size > 1 && [...around].some(Boolean)) {
        toast(
          `These are in different frames (${[...around].map((b) => (b ? idx.boundaries.get(b)?.name : "none")).join(", ")}): a group sits inside one`,
          "error",
        );
        return;
      }
      const parentId = around.size === 1 ? [...around][0]! : null;
      const { id, ops } = newBoundaryOps(idx, { name: "New group", kind: "group", parentId }, ids);
      const d = idx.diagrams.get(diagramId);
      if (d && !d.boundaries)
        ops.push({ op: "diagram.put", diagram: { ...d, boundaries: true, updatedAt: now() } });
      void run(ops, `group ${ids.length}`).then(() => {
        scene.current?.select({ nodes: [], edge: null, boundary: id }, true);
        openFresh(id);
      });
    },
    [diagramId, sel, idx, run, openFresh, toast],
  );

  groupRef.current = groupSelection;

  /** Put the selection inside a box (in the model: every view agrees). */
  const putInside = useCallback(
    (target: string) => {
      const t = idx.objects.get(target);
      if (!t) return;
      const ops = sel.nodes.flatMap((id) => {
        const o = idx.objects.get(id);
        return o &&
          o.id !== target &&
          !descendants(idx, o.id).includes(target) &&
          !(o.parentId && sel.nodes.includes(o.parentId))
          ? updateObject(o, { parentId: target })
          : [];
      });
      if (ops.length) void run(ops, `put ${ops.length} in ${t.name}`);
    },
    [idx, sel, run],
  );

  /** Ungroup: a group frame goes (what was in it stays where it is); a box's insides come out. */
  const ungroupSelection = useCallback(() => {
    if (!diagramId) return;
    if (sel.boundary?.startsWith(OPEN_FRAME)) {
      openHere(sel.boundary.slice(OPEN_FRAME.length), false);
      return;
    }
    if (sel.boundary?.startsWith(FOLD_FRAME)) {
      const d = idx.diagrams.get(diagramId);
      if (d) void run(foldBack(d, sel.boundary.slice(FOLD_FRAME.length)), "fold back");
      return;
    }
    if (sel.boundary) {
      const b = idx.boundaries.get(sel.boundary);
      if (b) void run([{ op: "boundary.delete", id: b.id }], `ungroup ${b.name}`);
      return;
    }
    if (sel.nodes.length !== 1) return;
    const g = idx.objects.get(sel.nodes[0]!);
    const kids = g ? (idx.children.get(g.id) ?? []) : [];
    if (!g || !kids.length) return;
    void run(
      kids.flatMap((k) => updateObject(k, { parentId: g.parentId })),
      `take ${kids.length} out of ${g.name}`,
    ).then(() => scene.current?.select({ nodes: kids.map((k) => k.id), edge: null }, true));
  }, [diagramId, sel, idx, run, openHere]);
  return { removeSelected, duplicate, groupSelection, putInside, ungroupSelection, groupRef };
}
