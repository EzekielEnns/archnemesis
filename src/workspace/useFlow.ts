import type { Dispatch, SetStateAction } from "react";
// Flows and tags lit on the diagram: which flow is open, its step, the tag shown, "new flow",
// what's selected as a step, and the path being framed once it opens.
import { useEffect, useMemo, useState } from "react";
import { makeFlow } from "../../shared/model.ts";
import { flowsOf, placedFor, type CanvasGraph, type ModelIndex } from "../../shared/project.ts";
import { type Selection } from "../canvas/Scene";

import type { Run } from "./toasts";
import type { SceneRef } from "./types";

export function useFlow({
  idx,
  diagramId,
  run,
  sel,
  graph,
}: {
  idx: ModelIndex;
  diagramId: string | null;
  run: Run;
  sel: Selection;
  graph: CanvasGraph | null;
}) {
  const [flowId, setFlowId] = useState<string | null>(null);
  const [step, setStep] = useState(-1);
  const [tag, setTag] = useState<string | null>(null);
  const flow = flowId ? idx.flows.get(flowId) : undefined;
  const activeFlow = flow && flow.diagramId === diagramId ? flow : undefined;
  // A path lights a route at once: no steps to walk, no panel, no numbers.
  const isPath = activeFlow?.kind === "path";
  const startFlow = () => {
    if (!diagramId) return;
    const f = makeFlow({ diagramId, name: `Flow ${flowsOf(idx, diagramId).length + 1}` });
    void run([{ op: "flow.put", flow: f }], "new flow").then(() => {
      setFlowId(f.id);
      setStep(-1);
      setTag(null);
    });
  };
  // What's selected, as a flow step: an arrow, one box, or two boxes in the order picked.
  const pick = useMemo(() => {
    if (sel.edge) {
      const e = graph?.edges.find((x) => x.id === sel.edge);
      return e
        ? { fromId: e.from, toId: e.to, text: e.connectionIds.length === 1 ? e.label : "" }
        : null;
    }
    if (sel.nodes.length === 1) return { fromId: sel.nodes[0]!, toId: sel.nodes[0]!, text: "" };
    if (sel.nodes.length === 2) return { fromId: sel.nodes[0]!, toId: sel.nodes[1]!, text: "" };
    return null;
  }, [sel, graph]);
  return { flowId, setFlowId, step, setStep, tag, setTag, activeFlow, isPath, startFlow, pick };
}

/**
 * The effects of a flow: its path framed once it opens, and closing it on leaving its diagram.
 * (Called after the tour's effects, which can set the flow in the same commit.)
 */
export function useFlowEffects({
  idx,
  diagramId,
  scene,
  ready,
  activeFlow,
  isPath,
  setFlowId,
}: {
  idx: ModelIndex;
  diagramId: string | null;
  scene: SceneRef;
  ready: boolean;
  activeFlow: ReturnType<typeof useFlow>["activeFlow"];
  isPath: boolean;
  setFlowId: Dispatch<SetStateAction<string | null>>;
}) {
  // Opening a path brings its whole route into view, once.
  useEffect(() => {
    if (!activeFlow || !isPath || !diagramId || !ready) return;
    const ids = activeFlow.steps
      .flatMap((st) => [placedFor(idx, diagramId, st.fromId), placedFor(idx, diagramId, st.toId)])
      .filter((x): x is string => !!x);
    if (ids.length) scene.current?.frameBoxes([...new Set(ids)]);
  }, [activeFlow?.id, ready]); // eslint-disable-line react-hooks/exhaustive-deps
  // Leaving a diagram closes its flow.
  useEffect(() => {
    setFlowId((f) => (f && idx.flows.get(f)?.diagramId === diagramId ? f : null));
  }, [diagramId]); // eslint-disable-line react-hooks/exhaustive-deps
}
