// Boxes opened in place on a diagram (this browser only: looking, not editing), and opening and
// closing them.
import type { Dispatch, SetStateAction } from "react";
import { useCallback, useState } from "react";
import { isInside } from "../../shared/project.ts";

import type { LatestRef } from "./latest";
import type { SceneRef } from "./types";

export function useOpened({
  diagramId,
  latest,
  scene,
  setPanel,
}: {
  diagramId: string | null;
  latest: LatestRef;
  scene: SceneRef;
  setPanel: Dispatch<SetStateAction<boolean>>;
}) {
  /** Boxes opened in place, per diagram (this browser only: looking, not editing). */
  const [opened, setOpened] = useState<Record<string, string[]>>({});
  const openHere = useCallback(
    (id: string, on: boolean) => {
      if (!diagramId) return;
      setOpened((o) => {
        const was = o[diagramId] ?? [];
        // Closing one closes what's open inside it too.
        const i = latest.current.idx;
        return {
          ...o,
          [diagramId]: on
            ? [...was.filter((x) => x !== id), id]
            : was.filter((x) => x !== id && !isInside(i, x, id)),
        };
      });
      // Opened: the card gets out of the way, to look at what opened (its tab brings it back).
      // Closed: the box is selected again.
      setTimeout(() => {
        if (on) {
          scene.current?.select({ nodes: [], edge: null }, true);
          setPanel(false);
        } else scene.current?.select({ nodes: [id], edge: null }, true);
      }, 0);
    },
    [diagramId],
  );
  return { opened, openHere };
}
