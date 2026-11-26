// "Diff with main" on a fork: what changed since it started (asked of the server), the
// switch that draws it, the index with main's deleted things put back, and the leave-it-alone
// rules (off when you leave the fork, its list in the branches view).
import type { Dispatch, SetStateAction } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { type ModelIndex } from "../../shared/project.ts";
import type { WhatsNew } from "../../shared/whatsnew.ts";
import type { Store } from "../store";
import { type PanelView } from "../ui/LeftPanel";
import { backend } from "../backend";

export function useDiffMode({
  store,
  idx,
  setPanelView,
}: {
  store: Store;
  idx: ModelIndex;
  setPanelView: Dispatch<SetStateAction<PanelView>>;
}) {
  // On a fork: what's new since it started, and where it plugs in (✦), asked of the server.
  const [whatsNew, setWhatsNew] = useState<WhatsNew | null>(null);
  // "Diff with main" (on a fork): the changes drawn like a file diff, lit, and the only rows in the tree.
  const [showNew, setShowNew] = useState(false);
  // Diffing a fork: drawn as one graph with main's deleted things put back, marked removed.
  const diffIdx = useMemo(() => {
    if (
      !store.branch ||
      !showNew ||
      !whatsNew ||
      !(
        whatsNew.removed?.length ||
        whatsNew.removedConnections?.length ||
        whatsNew.removedViews?.length
      )
    )
      return null;
    const gone = (whatsNew.removed ?? []).map((r) => r.restore);
    return store.indexWith({
      objects: gone.map((g) => ({ ...g.object, status: "removed" as const })),
      placements: [
        ...gone.flatMap((g) => g.placements),
        ...(whatsNew.removedViews ?? []).flatMap((v) => v.placements),
      ],
      diagrams: (whatsNew.removedViews ?? []).map((v) => v.diagram),
      connections: (whatsNew.removedConnections ?? []).map((c) => ({
        ...c.connection,
        status: "removed" as const,
      })),
    });
  }, [store, idx, showNew, whatsNew]);
  /** What's drawn but deleted on this fork (still on main), by object id. */
  const goneIds = useMemo(
    () => new Map((diffIdx ? (whatsNew?.removed ?? []) : []).map((r) => [r.restore.object.id, r])),
    [diffIdx, whatsNew],
  );
  // A fork's changes, again a moment after each edit settles.
  useEffect(() => {
    if (!store.branch) {
      setWhatsNew(null);
      return;
    }
    let gone = false;
    const t = setTimeout(() => {
      (
        backend.git?.whatsNew(store.design) ??
        backend.portable?.whatsNew(store.design) ??
        Promise.resolve(null)
      )
        .then(
          (w) =>
            !gone &&
            setWhatsNew(
              w && (w.changed.length || w.context.length || w.removed?.length) ? w : null,
            ),
        )
        .catch(() => undefined);
    }, 700);
    return () => {
      gone = true;
      clearTimeout(t);
    };
  }, [store, store.branch, idx]);
  const diffCount = (whatsNew?.changed.length ?? 0) + (whatsNew?.removed?.length ?? 0);
  // Leaving the fork turns the diff off.
  useEffect(() => setShowNew(false), [store.branch]);
  // A fork opened from GitHub comes up with its changes shown, once: that's why it was shared.
  const autoShown = useRef(false);
  useEffect(() => {
    if (whatsNew && store.from && !autoShown.current) {
      autoShown.current = true;
      setShowNew(true);
    }
  }, [whatsNew, store.from]);
  // Diffing (D, ⌘K, or the button) shows its list of changes in the branches view, if the panel's open.
  useEffect(() => void (showNew && setPanelView("branches")), [showNew]);
  const newSets = useMemo(
    () =>
      whatsNew ? { changed: new Set(whatsNew.changed), context: new Set(whatsNew.context) } : null,
    [whatsNew],
  );

  return { whatsNew, showNew, setShowNew, diffIdx, goneIds, diffCount, newSets };
}
