// Tell everyone else which diagram this tab is on and what it has selected, and show them:
// only the people on this diagram get a cursor here.
import { useEffect } from "react";
import { usePresence, type PeerInfo } from "../presence";
import { type Selection } from "../canvas/Scene";

import type { SceneRef } from "./types";

export function usePeerSync({
  scene,
  ready,
  diagramId,
  sel,
  peers,
  setPresence,
}: {
  scene: SceneRef;
  ready: boolean;
  diagramId: string | null;
  sel: Selection;
  peers: PeerInfo[];
  setPresence: ReturnType<typeof usePresence>["set"];
}) {
  // Tell everyone else which diagram this tab is on and what it has selected.
  useEffect(
    () => setPresence({ diagram: diagramId, cursor: null, moving: [] }, true),
    [diagramId, setPresence],
  );
  useEffect(() => setPresence({ selected: sel.nodes }), [sel, setPresence]);
  // And show them: only the people on this diagram get a cursor here.
  useEffect(() => {
    scene.current?.setPeers(
      peers
        .filter((p) => p.diagram === diagramId)
        .map((p) => ({
          key: p.key,
          name: p.user.name,
          color: p.user.color,
          cursor: p.cursor,
          selected: p.selected,
          moving: p.moving,
        })),
    );
  }, [peers, diagramId, ready]);
}
