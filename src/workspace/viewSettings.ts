// Settings → Layout and Arrows act on the open view, for everyone (one undo each).
import { now, type ArrowStyle } from "../../shared/model.ts";
import type { Op } from "../../shared/model.ts";
import { type CanvasGraph, type ModelIndex } from "../../shared/project.ts";
import type { Store } from "../store";

import type { Run, ToastFn } from "./toasts";
import type { SceneRef } from "./types";

export function viewSettingsOf({
  diagramId,
  idx,
  store,
  graph,
  toast,
  run,
  scene,
  diagramArrows,
}: {
  diagramId: string | null;
  idx: ModelIndex;
  store: Store;
  graph: CanvasGraph | null;
  toast: ToastFn;
  run: Run;
  scene: SceneRef;
  diagramArrows: ArrowStyle;
}) {
  const d = diagramId ? idx.diagrams.get(diagramId) : undefined;
  if (!d || !store.canEdit || !graph) return null;
  const layoutNow = async (dir: "right" | "down") => {
    const { layoutOps } = await import("../../shared/layout.ts");
    const ops = await layoutOps(idx, d.id, dir, store.config.tags);
    if (!ops.length) return toast("Already laid out that way");
    await run(ops, "lay out");
    scene.current?.fit();
    toast(`Laid out ${d.name}. ⌘Z undoes it`);
  };
  return {
    layout: {
      view: d.name,
      keep: d.keepTidy ? (d.tidy ?? "right") : null,
      onLayout: (dir: "right" | "down") => void layoutNow(dir),
      onKeep: (dir: "right" | "down" | null) =>
        void (async () => {
          if (!dir)
            return void run(
              [{ op: "diagram.put", diagram: { ...d, keepTidy: false, updatedAt: now() } }],
              "stop keeping tidy",
            );
          const { layoutOps } = await import("../../shared/layout.ts");
          await run(
            [
              {
                op: "diagram.put",
                diagram: { ...d, tidy: dir, keepTidy: true, updatedAt: now() },
              },
              ...(await layoutOps(idx, d.id, dir, store.config.tags)),
            ],
            "keep tidy",
          );
          scene.current?.fit();
        })(),
      onTidyAll: () =>
        void (async () => {
          const { layoutOps } = await import("../../shared/layout.ts");
          const ops: Op[] = [];
          for (const v of idx.diagrams.values())
            ops.push(...(await layoutOps(idx, v.id, v.tidy ?? "right", store.config.tags)));
          if (!ops.length) return toast("Every view is already tidy");
          await run(ops, "tidy every view");
          scene.current?.fit();
          toast(`Tidied all ${idx.diagrams.size} views. ⌘Z undoes it`);
        })(),
    },
    arrows: {
      view: d.name,
      style: diagramArrows,
      onStyle: (st: ArrowStyle) =>
        void run(
          [{ op: "diagram.put", diagram: { ...d, arrows: st, updatedAt: now() } }],
          `arrows ${st}`,
        ),
      shaped: graph.edges.filter((e) => e.shape).length,
      onReset: () =>
        void run(
          graph.edges
            .filter((e) => e.shape)
            .map((e) => ({ op: "arrow.delete", diagramId: d.id, from: e.from, to: e.to }) as Op),
          "reset joints",
        ),
    },
  };
}
