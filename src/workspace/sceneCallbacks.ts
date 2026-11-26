import { backend } from "../backend";
import { defaultName } from "./names";
// What the canvas tells us (clicks, drags, drops, right-clicks) and what we do about it: each
// one becomes an edit, a selection, a card or a menu. Bound once, so they read the latest model
// and tool through a ref.
import type { Dispatch, SetStateAction } from "react";
import { addObject, connect } from "../../shared/actions.ts";
import { boxSize } from "../../shared/model.ts";
import type { ModelObject, ObjectKind, Op } from "../../shared/model.ts";
import { iconOf } from "../../shared/navtree.ts";
import { Scene, type Selection } from "../canvas/Scene";
import type { Store } from "../store";
import { showObjectTab } from "../ui/Inspector";
import { type NoteDraft } from "../ui/Notes";
import { notePerf } from "../ui/Perf";
import { type ToolId } from "../ui/Chrome";

import type { MutableRefObject } from "react";
import type { SceneCallbacks } from "../canvas/Scene";
import type { LatestRef } from "./latest";
import { moveHandler } from "./sceneMove";
import { placeHandler } from "./scenePlace";
import { selectHandler } from "./sceneSelect";
import type { useOverlays } from "./useOverlays";

export interface SceneDeps {
  store: Store;
  latest: LatestRef;
  open: (objectId: string) => void;
  makeConnection: (from: string, to: string, s: Scene) => void;
  pointer: MutableRefObject<{ x: number; y: number } | null>;
  groupRef: MutableRefObject<(ids: string[]) => void>;
  setNoteSel: Dispatch<SetStateAction<string | null>>;
  setDraft: Dispatch<SetStateAction<NoteDraft | null>>;
  setConnectFrom: Dispatch<SetStateAction<string | null>>;
  setTool: Dispatch<SetStateAction<ToolId>>;
  setSel: Dispatch<SetStateAction<Selection>>;
  setPanel: Dispatch<SetStateAction<boolean>>;
  setFresh: Dispatch<SetStateAction<string | null>>;
  setEdgeEdit: ReturnType<typeof useOverlays>["setEdgeEdit"];
  setDropHint: ReturnType<typeof useOverlays>["setDropHint"];
  setRenaming: ReturnType<typeof useOverlays>["setRenaming"];
  setMenu: ReturnType<typeof useOverlays>["setMenu"];
  setZoom: Dispatch<SetStateAction<number>>;
}

export function sceneCallbacks(deps: SceneDeps, getScene: () => Scene): SceneCallbacks {
  const { store, latest, open, makeConnection, pointer, groupRef } = deps;
  const { setEdgeEdit, setDropHint, setRenaming, setMenu, setZoom, setPanel } = deps;
  return {
    onStats: notePerf,
    onSelect: selectHandler(deps, getScene),
    onResize: (id, w, h) => {
      const { idx: i, diagramId: d, run: r } = latest.current;
      const prev = d ? i.placements.get(d)?.get(id) : undefined;
      if (prev) void r([{ op: "placement.put", placement: { ...prev, w, h } }], "resize");
    },
    onEditEdge: (id, x, y) => {
      const s = getScene();
      const e = latest.current.graph?.edges.find((g) => g.id === id);
      if (e?.connectionIds.length === 1) setEdgeEdit({ connectionId: e.connectionIds[0]!, x, y });
      else s.select({ nodes: [], edge: id }, true);
    },
    onArrowShape: (from, to, drawnShape) => {
      const { diagramId: d, run: r, spread: sp } = latest.current;
      const shape = drawnShape?.bends
        ? { ...drawnShape, bends: drawnShape.bends.map((b) => ({ x: b.x, y: sp.up(b.y) })) }
        : drawnShape;
      if (!d || !store.canEdit) return false;
      const op: Op = shape
        ? { op: "arrow.put", arrow: { diagramId: d, from, to, ...shape } }
        : { op: "arrow.delete", diagramId: d, from, to };
      void r([op], shape ? "shape arrow" : "reset arrow");
      return true;
    },
    // Simple mode: right-click on a box or an arrow opens its panel instead of the menu.
    onDropHint: setDropHint,
    onGroupDraw: (ids) => {
      latest.current.setTool("select");
      if (!ids.length)
        return latest.current.toast("Draw the frame around some boxes to group them", "error");
      groupRef.current(ids);
    },
    onContext: (t) => {
      const several =
        t.kind === "node" &&
        latest.current.sel.nodes.length > 1 &&
        latest.current.sel.nodes.includes(t.id ?? "");
      if (latest.current.simple && (t.kind === "node" || t.kind === "edge") && !several) {
        setMenu(null);
        setPanel(true);
        return;
      }
      setMenu(t);
    },
    onPointer: (cursor) => {
      if (cursor) pointer.current = cursor;
      latest.current.setPresence({ cursor });
    },
    onDragging: (moving) => latest.current.setPresence({ moving: moving ?? [] }, !moving),
    onZoom: (z) => setZoom(Math.round(z * 100) / 100),
    // Technology logos come from the backend, so the canvas makes no request of its own.
    loadIcon: (technology, color) => backend.icons.svg(technology, color),
    onPlace: placeHandler(deps, getScene),
    onMove: moveHandler(latest),
    onConnect: (from, to) => makeConnection(from, to, getScene()),
    onOpen: open,
    onOffDiagram: () => showObjectTab("connections"),
    onRename: (id) => {
      const s = getScene();
      const r = s.clientRectOf(id);
      if (r) setRenaming({ id, x: r.x, y: r.y, w: r.w, scale: r.scale });
    },
    onConnectNew: (from, at, frame) => {
      const s = getScene();
      const { idx: i, diagramId: d, run: r } = latest.current;
      const src = i.objects.get(from);
      if (!d || !src || !store.canEdit) return;
      // What the new box is: dropped in a file, a function in that file; from a function,
      // another function in its file; otherwise the same kind as where the arrow started.
      const inFrame = frame ? i.objects.get(frame) : undefined;
      const fields: Partial<ModelObject> = {};
      let kind: ObjectKind = src.kind === "actor" ? "app" : src.kind;
      if (inFrame && iconOf(inFrame) === "file") {
        kind = "function";
        fields.parentId = inFrame.id;
      } else if (inFrame) {
        fields.parentId = inFrame.id;
        if (kind === "function") kind = "module";
      } else if (src.kind === "function" && src.parentId) fields.parentId = src.parentId;
      else if (src.kind === "library") kind = "library";
      // Simple mode: the kind last picked in the toolbar, whatever the arrow started from.
      const picked = latest.current.simple ? latest.current.lastKind : null;
      if (picked) kind = picked;
      fields.name = defaultName(kind);
      const size = boxSize(kind);
      const { ops, object } = addObject(
        i,
        d,
        kind,
        { x: at.x - size.w / 2, y: at.y - size.h / 2 },
        fields,
      );
      const c = connect(from, object.id);
      void r([...ops, ...c.ops], `add ${fields.name} from ${src.name}`).then(() => {
        s.select({ nodes: [object.id], edge: null }, true);
        if (latest.current.simple) return latest.current.openFresh(object.id);
        // Straight into naming it.
        setTimeout(() => {
          const rect = s.clientRectOf(object.id);
          if (rect)
            setRenaming({ id: object.id, x: rect.x, y: rect.y, w: rect.w, scale: rect.scale });
        }, 80);
      });
    },
  };
}
