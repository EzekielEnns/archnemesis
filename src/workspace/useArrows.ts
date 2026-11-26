// Arrow style: the diagram's own (in its file, for everyone) unless you've picked one for
// yourself (this browser), pushed to the canvas.
import { useEffect } from "react";
import { ARROW_STYLES, type ArrowStyle } from "../../shared/model.ts";
import { type ModelIndex } from "../../shared/project.ts";

import type { SceneRef } from "./types";
import { useStoredChoice } from "./useStored";

export function useArrows({
  idx,
  diagramId,
  scene,
  ready,
}: {
  idx: ModelIndex;
  diagramId: string | null;
  scene: SceneRef;
  ready: boolean;
}) {
  // Arrows: the diagram's style (in its file, for everyone), unless you've picked your own.
  const [myArrows, setMyArrows] = useStoredChoice<ArrowStyle>("archnm.arrows", ARROW_STYLES);
  const diagramArrows: ArrowStyle =
    (diagramId ? idx.diagrams.get(diagramId)?.arrows : undefined) ?? "curved";
  const arrows = myArrows ?? diagramArrows;
  useEffect(() => scene.current?.setArrowStyle(arrows), [arrows, ready]);
  return { myArrows, setMyArrows, diagramArrows, arrows };
}
