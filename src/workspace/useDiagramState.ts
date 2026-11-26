// The state behind the open diagram, in the order it's needed: the model, toasts and dialogs,
// the layout around the canvas, the selection, which diagram is open (and the diff), who else is
// here, the tool in hand, the card, what's drawn, arrows and flows. Everything it makes is handed
// on flat, to useCanvasSession and useInteraction, which build on it.
import { useMemo, useState, useSyncExternalStore } from "react";
import { usePresence } from "../presence";
import { type Selection } from "../canvas/Scene";
import { useLayers } from "../ui/Layers";
import type { Store } from "../store";

import { NO_SELECTION } from "./constants";
import { useToasts, useRun } from "./toasts";
import { useDialogs } from "./useDialogs";
import { useOverlays } from "./useOverlays";
import { useDocking } from "./useDocking";
import { useSceneRefs } from "./useSceneRefs";
import { useDiffMode } from "./useDiffMode";
import { useViewRoute } from "./useViewRoute";
import { useCardState } from "./useCard";
import { useTools } from "./useTools";
import { useLatestRef } from "./latest";
import { useOpened } from "./useOpened";
import { useDiagram } from "./useDiagram";
import { useArrows } from "./useArrows";
import { useFlow } from "./useFlow";

export function useDiagramState(store: Store, simple: boolean) {
  const version = useSyncExternalStore(store.subscribe, store.getVersion);
  const idx = useMemo(() => store.index(), [store, version]);
  const toasts = useToasts();
  const { toast } = toasts;
  const run = useRun(store, toast);
  const dialogs = useDialogs();
  const overlays = useOverlays();
  const docking = useDocking(simple);
  const [sel, setSel] = useState<Selection>(NO_SELECTION);
  const refs = useSceneRefs();
  const { scene, ready } = refs;
  const diff = useDiffMode({ store, idx, setPanelView: docking.setPanelView });
  const { route, diagramId } = useViewRoute({ store, idx, diffIdx: diff.diffIdx, sel });
  const { peers, ownTabs, set: setPresence } = usePresence(store, version);
  const card = useCardState();
  const tools = useTools({ simple, sel, idx, diagramId, run, ...card, scene, ready });
  const latest = useLatestRef();
  const [layers, toggleLayer, setAllLayers] = useLayers();
  const opened = useOpened({ diagramId, latest, scene, setPanel: card.setPanel });
  const { opened: openedBoxes } = opened;
  const view = useDiagram({
    store,
    idx,
    diffIdx: diff.diffIdx,
    diagramId,
    simple,
    made: card.made,
    opened: openedBoxes,
    layers,
  });
  const arrows = useArrows({ idx, diagramId, scene, ready });
  const flow = useFlow({ idx, diagramId, run, sel, graph: view.graph });
  // The latest model and diagram, for the canvas callbacks (bound once).
  latest.current = {
    gone: diff.goneIds,
    diffIdx: diff.diffIdx,
    idx,
    diagramId,
    run,
    graph: view.graph,
    flow: flow.activeFlow,
    connectFrom: tools.connectFrom,
    toast,
    tool: tools.tool,
    setPresence,
    simple,
    openFresh: card.openFresh,
    lastKind: tools.lastKind,
    sel,
    setTool: tools.setTool,
    spread: view.spread,
    exploded: view.exploded,
  };
  return {
    store,
    version,
    idx,
    simple,
    run,
    sel,
    setSel,
    route,
    diagramId,
    latest,
    peers,
    ownTabs,
    setPresence,
    layers,
    toggleLayer,
    setAllLayers,
    ...toasts,
    ...dialogs,
    ...overlays,
    ...docking,
    ...refs,
    ...diff,
    ...card,
    ...tools,
    ...opened,
    ...view,
    ...arrows,
    ...flow,
  };
}

export type DiagramState = ReturnType<typeof useDiagramState>;
