// What's drawn over the canvas: the colour legend, the layer nodes (references, what arrows
// carry), the diff markers and the notes.
import { now } from "../../shared/model.ts";
import type { ArrowShape } from "../../shared/model.ts";
import { EDGE_PARTS, PartsLayer } from "../ui/Layers";
import { DRAFT, NotesLayer } from "../ui/Notes";
import { notesOn } from "../../shared/project.ts";
import { DiffLayer } from "../ui/DiffLayer";

import type { WorkspaceBag } from "./useInteraction";

/** The element the canvas is made in; a click on it lets go of the drawer and of a note. */
export function CanvasHost({
  noteSel,
  closeNote,
  host,
  sidebar,
  setSidebar,
  pinned,
}: Pick<WorkspaceBag, "noteSel" | "closeNote" | "host" | "sidebar" | "setSidebar" | "pinned">) {
  return (
    <>
      <div
        ref={host}
        className="canvas"
        onPointerDownCapture={() => {
          // The left panel stays open while you work; X, ☰ or [ closes it.
          if (sidebar && !pinned) setSidebar(false);
          // A click on the canvas lets go of a note (placing a new one picks it again).
          if (noteSel) closeNote();
        }}
      />
    </>
  );
}

/** The key to the colours, when the view is coloured by a tag group. */
export function Legend({ colorBy, legend }: Pick<WorkspaceBag, "colorBy" | "legend">) {
  return (
    <>
      {legend.length > 0 && (
        <div className="legend" aria-label={`Coloured by ${colorBy}`}>
          <div className="legend-title">{colorBy}</div>
          {legend.map((r) => (
            <div key={r.value ?? ""} className="legend-row">
              <span className="swatch" style={{ background: r.color }} />
              <span className={r.value ? "" : "muted"}>{r.value ?? "not set"}</span>
              <span className="muted count">{r.count}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/** The layer nodes: references beside boxes and what arrows carry. */
export function PartsHost({
  goToObject,
  setPartPairs,
  graph,
  drawn,
  setPanel,
  scene,
  ready,
  store,
  idx,
  run,
  diagramId,
  layers,
}: Pick<
  WorkspaceBag,
  | "goToObject"
  | "setPartPairs"
  | "graph"
  | "drawn"
  | "setPanel"
  | "scene"
  | "ready"
  | "store"
  | "idx"
  | "run"
  | "diagramId"
  | "layers"
>) {
  return (
    <>
      {diagramId && ready && graph && (
        <PartsLayer
          scene={scene.current}
          idx={idx}
          nodes={drawn?.nodes ?? graph.nodes}
          layers={layers}
          onOpen={(id, from) => {
            const on = graph.nodes.some((n) => n.id === id) ? id : from;
            scene.current?.select({ nodes: [on], edge: null }, true);
            setPanel(true);
          }}
          edges={drawn?.edges ?? graph.edges}
          onLightPairs={setPartPairs}
          onOpenEdge={(id) => {
            scene.current?.select({ nodes: [], edge: id }, true);
            setPanel(true);
          }}
          spotOf={(id) => (diagramId ? idx.placements.get(diagramId)?.get(id)?.parts : undefined)}
          onMoveParts={
            store.canEdit
              ? (id, spot) => {
                  // What an arrow carries: its spot is kept on the arrow's shape for this diagram.
                  if (id.startsWith(EDGE_PARTS)) {
                    const e = (drawn?.edges ?? graph.edges).find(
                      (x) => x.id === id.slice(EDGE_PARTS.length),
                    );
                    if (!e || !diagramId) return;
                    const {
                      parts: _was,
                      diagramId: _d,
                      from: _f,
                      to: _t,
                      ...shape
                    } = e.shape ?? ({} as ArrowShape);
                    const next = { ...shape, ...(spot ? { parts: spot } : {}) };
                    const empty = !Object.values(next).some((v) => v !== undefined);
                    void run(
                      [
                        empty
                          ? { op: "arrow.delete", diagramId, from: e.from, to: e.to }
                          : {
                              op: "arrow.put",
                              arrow: { diagramId, from: e.from, to: e.to, ...next },
                            },
                      ],
                      spot ? "move what it carries" : "put what it carries back",
                    );
                    return;
                  }
                  const prev = diagramId ? idx.placements.get(diagramId)?.get(id) : undefined;
                  if (!prev) return;
                  const { parts: _was, ...rest } = prev;
                  void run(
                    [{ op: "placement.put", placement: spot ? { ...rest, parts: spot } : rest }],
                    spot ? "move its references" : "put its references back",
                  );
                }
              : undefined
          }
          onGo={(id) => {
            // Drawn here, or folded into something that is: glide there and open its card.
            const here = new Set(
              (drawn?.nodes ?? graph.nodes).filter((n) => !n.folded).map((n) => n.id),
            );
            let on: string | null | undefined = id;
            while (on && !here.has(on)) on = idx.objects.get(on)?.parentId;
            if (!on) return goToObject(id);
            scene.current?.select({ nodes: [on], edge: null }, true);
            scene.current?.centerOn(on, true);
            setPanel(true);
          }}
        />
      )}
    </>
  );
}

/** The diff markers over the canvas, while diffing a fork. */
export function DiffHost({
  graph,
  drawn,
  whatsNew,
  showNew,
  goneIds,
  scene,
  ready,
  store,
  diagramId,
}: Pick<
  WorkspaceBag,
  "graph" | "drawn" | "whatsNew" | "showNew" | "goneIds" | "scene" | "ready" | "store" | "diagramId"
>) {
  return (
    <>
      {diagramId && ready && graph && store.branch && showNew && whatsNew && (
        <DiffLayer
          scene={scene.current}
          diagramId={diagramId}
          nodes={drawn?.nodes ?? graph.nodes}
          diff={whatsNew}
          gone={new Set(goneIds.keys())}
        />
      )}
    </>
  );
}

/** Notes and links pinned on the diagram. */
export function NotesHost({
  noteSel,
  draft,
  selectNote,
  spread,
  scene,
  ready,
  store,
  idx,
  run,
  diagramId,
  layers,
}: Pick<
  WorkspaceBag,
  | "noteSel"
  | "draft"
  | "selectNote"
  | "spread"
  | "scene"
  | "ready"
  | "store"
  | "idx"
  | "run"
  | "diagramId"
  | "layers"
>) {
  return (
    <>
      {diagramId && ready && (
        <NotesLayer
          scene={scene.current}
          idx={idx}
          diagramId={diagramId}
          notes={notesOn(idx, diagramId, { resolved: true }).filter(
            (n) =>
              (!n.note.resolved || n.note.id === noteSel) &&
              (layers.comments || n.note.kind !== "note" || n.note.id === noteSel),
          )}
          draft={noteSel === DRAFT ? draft : null}
          me={store.me}
          selected={noteSel}
          canEdit={store.canEdit}
          onSelect={selectNote}
          spread={spread}
          onMove={(id, to) => {
            const n = idx.notes.get(id);
            if (n)
              void run(
                [{ op: "note.put", note: { ...n, ...to, updatedAt: now() } }],
                n.kind === "link" ? "moved a link" : "moved a note",
              );
          }}
        />
      )}
    </>
  );
}
