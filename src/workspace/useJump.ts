// Jumping to where someone is or to a thing in the tree: the quiet "back to …" crumb it leaves,
// following a person, and the tree's click on an object (select it here, or go to a diagram
// that shows it, round them all).
import { useCallback, useEffect, useState } from "react";
import { type PeerInfo } from "../presence";
import { type ModelIndex } from "../../shared/project.ts";
import { type Selection } from "../canvas/Scene";

import type { ToastFn } from "./toasts";
import type { Navigate, SceneRef } from "./types";

export function useJump({
  diagramId,
  sel,
  idx,
  navigate,
  scene,
  toast,
}: {
  diagramId: string | null;
  sel: Selection;
  idx: ModelIndex;
  navigate: Navigate;
  scene: SceneRef;
  toast: ToastFn;
}) {
  // A jump to another diagram (to where someone is, from the navigator) leaves a quiet
  // "back to …" crumb, until you go back or come back on your own.
  const [jump, setJump] = useState<{
    diagramId: string;
    objectId: string | null;
    label: string;
  } | null>(null);
  const jumpFrom = () => {
    if (diagramId)
      setJump({
        diagramId,
        objectId: sel.nodes.length === 1 ? sel.nodes[0]! : null,
        label: idx.diagrams.get(diagramId)?.name ?? "where you were",
      });
  };
  const jumpBack = () => {
    if (!jump) return;
    setJump(null);
    navigate(jump.diagramId, jump.objectId, "back");
  };
  useEffect(() => {
    if (jump && diagramId === jump.diagramId) setJump(null);
  }, [diagramId]); // eslint-disable-line react-hooks/exhaustive-deps
  const follow = useCallback(
    (p: PeerInfo) => {
      if (p.diagram && p.diagram !== diagramId) {
        jumpFrom();
        navigate(p.diagram, null, "follow");
      }
      const target = p.selected[0];
      setTimeout(() => {
        if (target) scene.current?.centerOn(target);
      }, 80);
    },
    [diagramId, navigate, sel, idx], // eslint-disable-line react-hooks/exhaustive-deps
  );
  /** The tree's click on a thing: select it here, or go to a diagram that shows it (round them all). */
  const goToObject = (id: string) => {
    if (!diagramId) return;
    const name = idx.objects.get(id)?.name ?? "It";
    // Every diagram it's on, in a steady order: a click selects it here, and the next
    // click (with it selected) goes on to the next diagram that shows it, and round.
    const on = [...(idx.placedOn.get(id) ?? [])].sort((a, b) =>
      (idx.diagrams.get(a)?.name ?? "").localeCompare(idx.diagrams.get(b)?.name ?? ""),
    );
    const here = on.includes(diagramId);
    const picked = sel.nodes.length === 1 && sel.nodes[0] === id;
    if (here && !picked) {
      scene.current?.select({ nodes: [id], edge: null }, true);
      scene.current?.centerOn(id);
      if (on.length > 1) toast(`${name} is on ${on.length} diagrams: click it again for the next`);
      return;
    }
    if (on.length && !(here && on.length === 1)) {
      const next = here ? on[(on.indexOf(diagramId) + 1) % on.length]! : on[0]!;
      jumpFrom();
      navigate(next, id, "sidebar");
      if (on.length > 1) toast(`${name}: ${on.indexOf(next) + 1} of ${on.length} diagrams`);
      return;
    }
    if (here) return void scene.current?.centerOn(id);
    // On no diagram: one that shows the nearest thing it's inside.
    for (
      let cur: string | null | undefined = idx.objects.get(id)?.parentId;
      cur;
      cur = idx.objects.get(cur)?.parentId
    ) {
      const d = [...(idx.placedOn.get(cur) ?? [])][0];
      if (d) {
        if (d !== diagramId) jumpFrom();
        return navigate(d, cur, "sidebar");
      }
    }
    toast(`${name} isn't on a diagram yet: drag it onto the canvas`);
  };
  return { jump, jumpFrom, jumpBack, follow, goToObject };
}
