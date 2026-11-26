// The trail of jumps made from the box panel (a connection, another diagram): remembered so
// you can walk back, and ended when the panel closes. ⌥← walks it (or the crumb).
import { useEffect, useRef, useState } from "react";
import { type CanvasGraph, type ModelIndex } from "../../shared/project.ts";
import { type Selection } from "../canvas/Scene";

import type { LatestRef } from "./latest";
import type { Navigate, SceneRef } from "./types";

export function useTrail({
  diagramId,
  sel,
  idx,
  graph,
  navigate,
  scene,
  latest,
  jumpBack,
}: {
  diagramId: string | null;
  sel: Selection;
  idx: ModelIndex;
  graph: CanvasGraph | null;
  navigate: Navigate;
  scene: SceneRef;
  latest: LatestRef;
  jumpBack: () => void;
}) {
  // Jumps made from the box panel (a connection, another diagram) leave a trail to walk back.
  const [trail, setTrail] = useState<{ diagramId: string; sel: Selection; label: string }[]>([]);
  const remember = () => {
    if (!diagramId) return;
    const one = sel.nodes.length === 1 ? idx.objects.get(sel.nodes[0]!)?.name : null;
    const edge = sel.edge ? graph?.edges.find((e) => e.id === sel.edge) : null;
    const label =
      one ??
      (edge
        ? `${idx.objects.get(edge.from)?.name ?? "?"} → ${idx.objects.get(edge.to)?.name ?? "?"}`
        : null);
    if (!label) return;
    setTrail((t) => [...t.slice(-19), { diagramId, sel, label }]);
  };
  const goBack = () => {
    const last = trail[trail.length - 1];
    if (!last) return;
    setTrail((t) => t.slice(0, -1));
    const restore = () => {
      scene.current?.select(last.sel, true);
      const e = last.sel.edge
        ? latest.current.graph?.edges.find((x) => x.id === last.sel.edge)
        : null;
      if (e) scene.current?.frameBoxes([e.from, e.to]);
      else if (last.sel.nodes[0]) scene.current?.centerOn(last.sel.nodes[0], true);
    };
    if (last.diagramId === diagramId) restore();
    else {
      navigate(last.diagramId, last.sel.nodes[0] ?? null, "back");
      if (last.sel.edge) setTimeout(restore, 400);
    }
  };
  // Closing the panel (nothing selected, on the same diagram) ends the trail. A jump to
  // another diagram clears the selection for a moment on the way: that doesn't count.
  const trailDiagram = useRef(diagramId);
  useEffect(() => {
    const same = trailDiagram.current === diagramId;
    trailDiagram.current = diagramId;
    if (same && !sel.nodes.length && !sel.edge) setTrail([]);
  }, [sel, diagramId]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (
        e.altKey &&
        e.key === "ArrowLeft" &&
        !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)
      ) {
        e.preventDefault();
        if (trail.length) goBack();
        else jumpBack();
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });
  return { trail, remember, goBack };
}
