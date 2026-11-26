// Moving between diagrams: every move says how it was made (for the navigation trail), and
// "open" goes into a box (its own view, the code it runs, a folded group).
import { useCallback, useEffect } from "react";
import { codeFor, insideAction, openCode, openGroup, openInside } from "../../shared/actions.ts";
import { diagramForScope } from "../../shared/project.ts";
import { groupLabel } from "../../shared/project.ts";

import { go } from "../route";
import { note as trailNote, via, wireTrail } from "../trail";
import type { How } from "../../shared/trail";
import type { LatestRef } from "./latest";
import type { ToastFn } from "./toasts";

export function useNavigation({ latest, toast }: { latest: LatestRef; toast: ToastFn }) {
  useEffect(() => wireTrail(() => latest.current.graph?.nodes.length), []);
  // Every move says how it was made, for the navigation trail (when it's recording).
  const navigate = useCallback(
    (id: string, objectId?: string | null, how: How = "other", created?: boolean) => {
      via(how, created);
      go(id, objectId);
    },
    [],
  );

  const open = useCallback(
    (objectId: string) => {
      const { idx: i, graph: g } = latest.current;
      // A folded group opens into its own view, where each member can be traced.
      const node = g?.nodes.find((n) => n.id === objectId);
      if (node?.group) {
        const { diagramId: target, ops } = openGroup(i, node.group, groupLabel(node.group));
        if (ops.length)
          void latest.current
            .run(ops, `open ${groupLabel(node.group)}`)
            .then(() => navigate(target, null, "open", true));
        else navigate(target, null, "open");
        return;
      }
      // Deleted on this fork: open its view as it is on main, if it had one (never make one).
      const { gone, diffIdx: di } = latest.current;
      if (gone.has(objectId) && di) {
        const v = diagramForScope(di, objectId);
        if (v && v.scopeId === objectId) navigate(v.id, null, "open");
        else toast(`${gone.get(objectId)!.name} had no view of its own on main`);
        return;
      }
      const o = i.objects.get(objectId);
      if (!o) return;
      // A person, a store, a component, a vendor with nothing in it: nothing to open, and
      // opening would make an empty diagram.
      if (!insideAction(i, objectId))
        return void (
          trailNote({ kind: "dead-end", object: objectId }),
          toast(`Nothing inside ${o.name}`)
        );
      // A running box with no inside of its own opens the code its process runs: straight
      // into it when that's one module, else a view of all of it.
      const code = codeFor(i, objectId);
      const { diagramId: target, ops } =
        code.length === 1
          ? openInside(i, code[0]!)
          : code.length
            ? openCode(i, objectId, code)
            : openInside(i, objectId);
      if (ops.length)
        void latest.current
          .run(ops, `open ${o.name}`)
          .then(() => navigate(target, null, "open", true));
      else navigate(target, null, "open");
    },
    [navigate],
  );
  return { navigate, open };
}
