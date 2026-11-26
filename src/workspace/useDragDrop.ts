import { OBJECT_DRAG_TYPE } from "./constants";
// Dropping a box dragged in from the tree onto the canvas places it where it was let go.
import { place } from "../../shared/actions.ts";
import { type ModelIndex } from "../../shared/project.ts";

import type { Run } from "./toasts";
import type { SceneRef } from "./types";
import type { Spread } from "../canvas/spread";

export function useDragDrop({
  scene,
  idx,
  diagramId,
  run,
  spread,
}: {
  scene: SceneRef;
  idx: ModelIndex;
  diagramId: string | null;
  run: Run;
  spread: Spread;
}) {
  const onDrop = (e: React.DragEvent) => {
    const id = e.dataTransfer.getData(OBJECT_DRAG_TYPE);
    const s = scene.current;
    if (!id || !s || !diagramId) return;
    e.preventDefault();
    const at = s.clientToWorld(e.clientX, e.clientY);
    const name = idx.objects.get(id)?.name ?? "object";
    void run(
      place(idx, diagramId, id, { x: at.x - 92, y: spread.up(at.y) - 36 }),
      `place ${name}`,
    ).then(() => s.select({ nodes: [id], edge: null }, true));
  };
  return onDrop;
}
