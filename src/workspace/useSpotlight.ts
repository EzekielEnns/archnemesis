import type { Flow } from "../../shared/model.ts";
import { DRAWER_W } from "./constants";
// What's lit on the canvas, in order of who's asking: a hovered connection, the arrows carrying
// an entity, "what depends on it", a flow (or its path), the diff, or a tag.
import { useEffect } from "react";
import {
  boxesWithTag,
  placedFor,
  type CanvasGraph,
  type ModelIndex,
} from "../../shared/project.ts";
import type { WhatsNew } from "../../shared/whatsnew.ts";
import { type Selection } from "../canvas/Scene";

import type { SceneRef } from "./types";
import type { useHighlights } from "./useHighlights";

/** The two ends of each step of the flow (or of the step being played), as drawn here. */
function flowEndsOf(
  activeFlow: Flow | undefined,
  step: number,
  idx: ModelIndex,
  diagramId: string,
) {
  return activeFlow
    ? (step === -1 ? activeFlow.steps : activeFlow.steps.slice(step, step + 1)).map((st, i) => ({
        a: placedFor(idx, diagramId, st.fromId),
        b: placedFor(idx, diagramId, st.toId),
        n: (step === -1 ? 0 : step) + i + 1,
      }))
    : [];
}

export function useSpotlight({
  scene,
  ready,
  diagramId,
  activeFlow,
  isPath,
  step,
  tag,
  idx,
  graph,
  hoverPair,
  partPairs,
  impactNow,
  showNew,
  whatsNew,
  sidebar,
  sel,
}: {
  scene: SceneRef;
  ready: boolean;
  diagramId: string | null;
  activeFlow: Flow | undefined;
  isPath: boolean;
  step: number;
  tag: string | null;
  idx: ModelIndex;
  graph: CanvasGraph | null;
  hoverPair: [string, string] | null;
  partPairs: [string, string][] | null;
  impactNow: ReturnType<typeof useHighlights>["impactNow"];
  showNew: boolean;
  whatsNew: WhatsNew | null;
  sidebar: boolean;
  sel: Selection;
}) {
  // A flow step, the whole flow, or a tag: light it up.
  useEffect(() => {
    const s = scene.current;
    if (!s || !ready || !diagramId) return;
    // A playing flow keeps its dots running under a hover or the impact view.
    const flowEnds = flowEndsOf(activeFlow, step, idx, diagramId);
    const flowSteps = isPath
      ? []
      : flowEnds.flatMap(({ a, b, n }) => (a && b ? [{ from: a, to: b, n }] : []));
    if (hoverPair) {
      s.spotlight({ nodes: [], pairs: [hoverPair], steps: flowSteps });
    } else if (partPairs) {
      s.spotlight({ nodes: [...new Set(partPairs.flat())], pairs: partPairs, steps: flowSteps });
    } else if (impactNow) {
      s.spotlight({ nodes: impactNow.nodes, pairs: impactNow.pairs, steps: flowSteps });
    } else if (activeFlow) {
      const ends = flowEnds;
      const pairs = ends.flatMap(({ a, b }) =>
        a && b && a !== b ? [[a, b] as [string, string]] : [],
      );
      const inside = ends.flatMap(({ a, b }) => (a && a === b ? [a] : []));
      s.spotlight({
        nodes: inside,
        pairs,
        steps: flowSteps,
        ...(isPath ? { tone: "path" as const } : {}),
      });
      if (step !== -1 && !pairs[0] && inside[0])
        s.reveal([inside[0], inside[0]], {
          left: 20 + (sidebar ? DRAWER_W + 40 : 0),
          right: sel.nodes.length || sel.edge ? 330 : 20,
          top: 70,
          bottom: 60,
        });
      // Keep the step clear of the flow panel (left) and the inspector (right).
      if (step !== -1 && pairs[0])
        s.reveal(pairs[0], {
          left: 20 + (sidebar ? DRAWER_W + 40 : 0),
          right: sel.nodes.length || sel.edge ? 330 : 20,
          top: 70,
          bottom: 60,
        });
    } else if (showNew && whatsNew) {
      // The new things and what they plug into, drawn as whatever box stands for each here.
      const at = (id: string) => placedFor(idx, diagramId, id);
      const nodes = [
        ...new Set([...whatsNew.changed, ...whatsNew.context].flatMap((id) => at(id) ?? [])),
      ];
      const pairs = whatsNew.connections.flatMap((cid) => {
        const c = idx.connections.get(cid);
        const a = c && at(c.fromId);
        const b = c && at(c.toId);
        return a && b && a !== b ? [[a, b] as [string, string]] : [];
      });
      s.spotlight({
        nodes,
        pairs,
        marked: [...new Set(whatsNew.changed.flatMap((id) => at(id) ?? []))],
      });
    } else if (tag) {
      s.spotlight({ nodes: boxesWithTag(idx, diagramId, tag), pairs: [] });
    } else {
      s.spotlight(null);
    }
  }, [
    activeFlow,
    step,
    tag,
    idx,
    diagramId,
    ready,
    graph,
    hoverPair,
    partPairs,
    impactNow,
    showNew,
    whatsNew,
  ]); // eslint-disable-line react-hooks/exhaustive-deps
}
