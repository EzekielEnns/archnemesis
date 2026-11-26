// Which diagram is open: the address bar's route (and the hash changing under us), the diagram
// that follows from it, the tab's title, and the address bar following the selection.
import { useEffect, useMemo, useState } from "react";
import { showInTab } from "../favicon";
import { diagramForScope, type ModelIndex } from "../../shared/project.ts";
import { type Selection } from "../canvas/Scene";
import type { Store } from "../store";

import { hashFor, parseHash } from "../route";

export function useViewRoute({
  store,
  idx,
  diffIdx,
  sel,
}: {
  store: Store;
  idx: ModelIndex;
  diffIdx: ModelIndex | null;
  sel: Selection;
}) {
  const [route, setRoute] = useState(parseHash);
  // The tab says which design (and fork) this is.
  useEffect(
    () => showInTab(store.designKey, store.designName, store.branch),
    [store, store.designName],
  );
  const diagramId = useMemo(() => {
    // A view the fork deleted can be open while diffing (main's, drawn from the diff).
    if (
      route.diagramId &&
      (idx.diagrams.has(route.diagramId) || diffIdx?.diagrams.has(route.diagramId))
    )
      return route.diagramId;
    return diagramForScope(idx, null)?.id ?? idx.diagrams.keys().next().value ?? null;
  }, [route.diagramId, idx, diffIdx]);
  useEffect(() => {
    const f = () => setRoute(parseHash());
    window.addEventListener("hashchange", f);
    return () => window.removeEventListener("hashchange", f);
  }, []);
  // The address bar names what's selected, so it's a link to send (as Figma's node-id is).
  // replaceState: no history entry and no hashchange, so selecting never re-routes.
  useEffect(() => {
    if (!diagramId) return;
    const one = sel.nodes.length === 1 ? sel.nodes[0]! : null;
    const want = `#${hashFor({ design: parseHash().design, diagramId, objectId: one })}`;
    if (location.hash !== want) history.replaceState(history.state, "", want);
  }, [sel, diagramId]);
  return { route, diagramId };
}
