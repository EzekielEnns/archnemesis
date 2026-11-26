// What's lit by hovering or picking in the box panel: a connection, the arrows carrying an
// entity, or "what depends on it" for the selected box.
import { useEffect, useMemo, useState } from "react";
import { placedFor, type ModelIndex } from "../../shared/project.ts";
import { type Selection } from "../canvas/Scene";
import { impact, type ImpactWay } from "../../shared/impact.ts";

import type { SceneRef } from "./types";

export function useHighlights({
  sel,
  idx,
  diagramId,
  scene,
}: {
  sel: Selection;
  idx: ModelIndex;
  diagramId: string | null;
  scene: SceneRef;
}) {
  // A connection hovered in the box panel lights up over everything else, for as long as it's hovered.
  const [hoverPair, setHoverPair] = useState<[string, string] | null>(null);
  /** Arrows lit by the layer nodes: the ones carrying the entity hovered or picked. */
  const [partPairs, setPartPairs] = useState<[string, string][] | null>(null);
  // "What depends on it" / "what it depends on", lit up for the selected box.
  const [impactOn, setImpactOn] = useState<{ id: string; way: ImpactWay } | null>(null);
  useEffect(() => {
    if (impactOn && !(sel.nodes.length === 1 && sel.nodes[0] === impactOn.id)) setImpactOn(null);
  }, [sel]); // eslint-disable-line react-hooks/exhaustive-deps
  const impactNow = useMemo(() => {
    if (!impactOn || !diagramId) return null;
    const reached = impact(idx, impactOn.id, impactOn.way);
    const me = placedFor(idx, diagramId, impactOn.id) ?? impactOn.id;
    const boxes = new Set<string>([me]);
    const pairs: [string, string][] = [];
    let off = 0;
    for (const r of reached) {
      const b = placedFor(idx, diagramId, r.id);
      if (!b) off++;
      else boxes.add(b);
      const a = placedFor(idx, diagramId, r.via.fromId);
      const z = placedFor(idx, diagramId, r.via.toId);
      if (a && z && a !== z) pairs.push([a, z]);
    }
    return {
      way: impactOn.way,
      count: reached.length,
      hops: reached.length ? Math.max(...reached.map((r) => r.hops)) : 0,
      off,
      nodes: [...boxes],
      pairs,
    };
  }, [impactOn, idx, diagramId]);
  // Switching it on (or over) brings everything lit into view.
  useEffect(() => {
    if (impactNow && impactNow.nodes.length > 1) scene.current?.frameBoxes(impactNow.nodes);
  }, [impactOn]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setHoverPair(null), [sel, diagramId]);
  return { hoverPair, setHoverPair, partPairs, setPartPairs, impactOn, setImpactOn, impactNow };
}
