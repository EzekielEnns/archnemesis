// The diagram as drawn: the model projected onto the open diagram (coloured by a tag group,
// with boxes opened in place), the room made for rows under boxes, and the frames grown to hold
// references.
import { useMemo } from "react";
import {
  projectDiagram,
  colorGraph,
  type LegendRow,
  type CanvasGraph,
  type CanvasGroup,
  type ModelIndex,
} from "../../shared/project.ts";
import { growFrames, hasRow, layoutParts, ROW_ROOM } from "../ui/Layers";
import { makeSpread, NO_SPREAD, spreadGraph } from "../canvas/spread";
import type { Store } from "../store";
import { explode, PARTS_GUTTER } from "../../shared/explode.ts";
import { FOLD_FRAME } from "../../shared/project.ts";

import type { LayerState } from "../ui/Layers";

export function useDiagram({
  store,
  idx,
  diffIdx,
  diagramId,
  simple,
  made,
  opened,
  layers,
}: {
  store: Store;
  idx: ModelIndex;
  diffIdx: ModelIndex | null;
  diagramId: string | null;
  simple: boolean;
  made: ReadonlySet<string>;
  opened: Record<string, string[]>;
  layers: LayerState;
}) {
  // Coloured by a tag group when the view says so (archnm.yaml's colours, else a palette).
  const colorBy = diagramId ? (idx.diagrams.get(diagramId)?.colorBy ?? null) : null;
  const tagGroups = store.config.tags;
  const { graph, legend, exploded } = useMemo(() => {
    if (!diagramId)
      return { graph: null as CanvasGraph | null, legend: [] as LegendRow[], exploded: null };
    const from = diffIdx ?? idx;
    // With references drawn beside boxes, an opened box leaves them room inside its frame.
    const ex = explode(from, diagramId, opened[diagramId] ?? [], {
      gutter: layers.references || layers.entities ? PARTS_GUTTER : 0,
    });
    const g = projectDiagram(ex?.idx ?? from, diagramId, {
      frames: !simple,
      removedToo: !!diffIdx,
      loose: made,
    });
    if (ex) g.groups.push(...ex.frames);
    return { ...colorGraph(g, from, colorBy, tagGroups), exploded: ex };
  }, [
    idx,
    diffIdx,
    diagramId,
    colorBy,
    tagGroups,
    simple,
    opened,
    layers.references,
    layers.entities,
    made,
  ]);
  // A box showing a row under it (tech, notes) pushes what's below it down, for drawing only.
  const spread = useMemo(
    () =>
      graph
        ? makeSpread(
            graph.nodes
              .filter((n) => hasRow(idx, n, layers))
              .map((n) => ({ y: n.y + n.h, by: ROW_ROOM })),
          )
        : NO_SPREAD,
    [graph, idx, layers],
  );
  // Then frames grow to hold the references drawn beside their boxes.
  const drawn = useMemo(() => {
    if (!graph) return graph;
    // Groups off hides boundaries, but never a box opened here or a group unfolded here: those
    // frames are how you close them again.
    const keep = (x: CanvasGroup) =>
      !x.boundary || !!x.inset || x.id.startsWith(`boundary:${FOLD_FRAME}`);
    const g = spreadGraph(
      layers.groups ? graph : { ...graph, groups: graph.groups.filter(keep) },
      spread,
    );
    const refs = layoutParts(idx, g.nodes, layers, undefined, (id) =>
      diagramId ? idx.placements.get(diagramId)?.get(id)?.parts : undefined,
    );
    return refs.size ? { ...g, groups: growFrames(g.groups, g.nodes, refs) } : g;
  }, [graph, idx, layers, spread, diagramId]);
  return { colorBy, graph, legend, exploded, spread, drawn };
}
