// Whole-diagram actions: export the diagram (PNG) or the model (JSON), delete a view.
import { useCallback } from "react";
import { diagramForScope, type ModelIndex } from "../../shared/project.ts";
import type { Store } from "../store";
import { backend } from "../backend";

import type { ToastFn } from "./toasts";
import type { Navigate, SceneRef } from "./types";

export function useDiagramActions({
  store,
  idx,
  diagramId,
  toast,
  navigate,
  scene,
}: {
  store: Store;
  idx: ModelIndex;
  diagramId: string | null;
  toast: ToastFn;
  navigate: Navigate;
  scene: SceneRef;
}) {
  const exportAs = useCallback(
    async (format: "png" | "json") => {
      const name = (diagramId && idx.diagrams.get(diagramId)?.name) || "archnm";
      const slug =
        name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "") || "archnm";
      const blob =
        format === "png"
          ? await scene.current?.exportPng()
          : new Blob([JSON.stringify(await backend.designs.state(store.design), null, 2)], {
              type: "application/json",
            });
      if (!blob) return toast("Nothing to export", "error");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = format === "png" ? `${slug}.png` : "archnm-model.json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    },
    [diagramId, idx, toast],
  );
  /** Delete a view (from the drawer's right-click menu). On it now: go up first. One undo step. */
  const deleteDiagram = useCallback(
    (id: string) => {
      const d = idx.diagrams.get(id);
      if (!d) return;
      if (id === diagramId) {
        const parent = d.scopeId ? (idx.objects.get(d.scopeId)?.parentId ?? null) : null;
        const target = [diagramForScope(idx, parent), diagramForScope(idx, null)].find(
          (x) => x && x.id !== id,
        );
        if (target) navigate(target.id);
      }
      store
        .send([{ op: "diagram.delete", id }], `delete view ${d.name}`)
        .then(() => toast(`Deleted ${d.name}`, { label: "Undo", run: () => void store.undo() }))
        .catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), "error"));
    },
    [idx, diagramId, navigate, toast, store],
  );
  return { exportAs, deleteDiagram };
}
