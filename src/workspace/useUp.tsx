// Going up: back the way you came, else up the tree of boxes, else to the landscape.
import { useCallback, useEffect, useRef, useState } from "react";
import { diagramForScope, type ModelIndex } from "../../shared/project.ts";
import { ArrowUp } from "lucide-react";
import { type MenuItem } from "../ui/ContextMenu";

import type { Navigate } from "./types";

export function useUp({
  diagramId,
  idx,
  navigate,
}: {
  diagramId: string | null;
  idx: ModelIndex;
  navigate: Navigate;
}) {
  // The diagrams you came through, newest last: up goes back the way you came (to the box you
  // opened, centred), and only climbs the tree when there's nowhere to go back to. Up by the
  // tree alone took you somewhere you'd never been (a sibling view, the landscape).
  const [cameFrom, setCameFrom] = useState<{ diagramId: string; focus: string | null }[]>([]);
  const backing = useRef(false);
  const lastDiagram = useRef<string | null>(null);
  useEffect(() => {
    const was = lastDiagram.current;
    lastDiagram.current = diagramId;
    if (backing.current) {
      backing.current = false;
      return;
    }
    if (!was || !diagramId || was === diagramId || !idx.diagrams.has(was)) return;
    // Back to it, centred on what you opened (the box this one is of), when it's drawn there.
    const scope = idx.diagrams.get(diagramId)?.scopeId ?? null;
    const focus = scope && idx.placements.get(was)?.has(scope) ? scope : null;
    setCameFrom((st) => [
      ...st.filter((x) => x.diagramId !== diagramId).slice(-29),
      { diagramId: was, focus },
    ]);
  }, [diagramId]); // eslint-disable-line react-hooks/exhaustive-deps
  const backTo = [...cameFrom]
    .reverse()
    .find((x) => idx.diagrams.has(x.diagramId) && x.diagramId !== diagramId);

  const up = useCallback(() => {
    const d = diagramId ? idx.diagrams.get(diagramId) : undefined;
    if (!d) return;
    if (backTo) {
      backing.current = true;
      setCameFrom((st) => st.slice(0, st.indexOf(backTo)));
      navigate(backTo.diagramId, backTo.focus, "back");
      return;
    }
    // A view with no scope of its own (a group's, a story) goes up to the landscape.
    if (!d.scopeId) {
      const home = diagramForScope(idx, null);
      if (home && home.id !== d.id) navigate(home.id, null, "up");
      return;
    }
    const parent = idx.objects.get(d.scopeId)?.parentId ?? null;
    const target = diagramForScope(idx, parent) ?? diagramForScope(idx, null);
    if (target) navigate(target.id, d.scopeId, "up");
  }, [diagramId, idx, navigate, backTo]);
  const canUp = !!diagramId && (!!backTo || diagramForScope(idx, null)?.id !== diagramId);
  /** Where up goes: back where you came from, else the box this diagram's box is in, else the landscape. */
  const upName = (() => {
    if (backTo) return idx.diagrams.get(backTo.diagramId)?.name ?? "where you were";
    const d = diagramId ? idx.diagrams.get(diagramId) : undefined;
    const p = d?.scopeId ? idx.objects.get(d.scopeId)?.parentId : null;
    return (p && idx.objects.get(p)?.name) || "Landscape";
  })();
  const upItem: MenuItem[] = canUp
    ? [
        {
          label: `${backTo ? "Back to" : "Up to"} ${upName}`,
          icon: <ArrowUp size={14} />,
          hint: "⌘↑",
          run: up,
        },
      ]
    : [];
  return { backTo, up, canUp, upName, upItem };
}
