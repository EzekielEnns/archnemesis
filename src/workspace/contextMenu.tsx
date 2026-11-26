// The right-click menu: on a box (or several), on an arrow, on empty canvas.
import type { Dispatch, SetStateAction } from "react";
import { insideAction, addObject, updateConnection } from "../../shared/actions.ts";
import { KIND_LABEL, OBJECT_KINDS } from "../../shared/model.ts";
import type { Op } from "../../shared/model.ts";
import { descendants, type CanvasGraph, type ModelIndex } from "../../shared/project.ts";
import {
  ArrowLeftRight,
  Cable,
  Copy,
  FolderOpen,
  Link,
  Map as MapIcon,
  Maximize,
  MessageSquarePlus,
  Pencil,
  Spline,
  Trash2,
  Waypoints,
  X,
} from "lucide-react";
import { type ContextTarget, type Selection } from "../canvas/Scene";
import { type MenuItem } from "../ui/ContextMenu";
import { KindDot } from "../ui/KindDot";
import type { Store } from "../store";
import { type ToolId } from "../ui/Chrome";

import { copyLink } from "../route";
import type { Run, ToastFn } from "./toasts";
import type { SceneRef } from "./types";
import type { Spread } from "../canvas/spread";
import type { useOverlays } from "./useOverlays";
import type { useEditActions } from "./useEditActions";
import type { useNotes } from "./useNotes";

export interface MenuCtx {
  idx: ModelIndex;
  diagramId: string | null;
  sel: Selection;
  graph: CanvasGraph | null;
  simple: boolean;
  store: Store;
  upItem: MenuItem[];
  spread: Spread;
  run: Run;
  toast: ToastFn;
  scene: SceneRef;
  open: (objectId: string) => void;
  setTool: Dispatch<SetStateAction<ToolId>>;
  setConnectFrom: Dispatch<SetStateAction<string | null>>;
  setRenaming: ReturnType<typeof useOverlays>["setRenaming"];
  setEdgeEdit: ReturnType<typeof useOverlays>["setEdgeEdit"];
  setMinimap: Dispatch<SetStateAction<boolean>>;
  groupSelection: ReturnType<typeof useEditActions>["groupSelection"];
  putInside: ReturnType<typeof useEditActions>["putInside"];
  duplicate: () => void;
  removeSelected: (everywhere: boolean) => void;
  noteOnBox: ReturnType<typeof useNotes>["noteOnBox"];
  noteOnConnection: ReturnType<typeof useNotes>["noteOnConnection"];
  startFlow: () => void;
}

/** The right-click menu on a box (or on several picked boxes). */
function nodeMenu(
  t: ContextTarget & { id: string },
  c: MenuCtx,
  diagramId: string,
): (MenuItem | "sep")[] {
  const {
    idx,
    sel,
    graph,
    simple,
    store,
    upItem,
    toast,
    scene,
    open,
    setTool,
    setConnectFrom,
    setRenaming,
    groupSelection,
    putInside,
    duplicate,
    removeSelected,
    noteOnBox,
  } = c;
  const o = idx.objects.get(t.id);
  const many = sel.nodes.length > 1;
  if (simple && many) {
    // What can hold them: the boxes on this diagram that aren't picked (nor inside them).
    const picked = new Set(sel.nodes.flatMap((id) => [id, ...descendants(idx, id)]));
    const holders = (graph?.nodes ?? [])
      .map((n) => n.id)
      .concat((graph?.groups ?? []).filter((g) => g.container).map((g) => g.id))
      .filter(
        (id) =>
          !picked.has(id) &&
          !["actor", "table", "library"].includes(idx.objects.get(id)?.kind ?? "actor"),
      )
      .slice(0, 8);
    return [
      {
        label: `Group ${sel.nodes.length}`,
        icon: <Waypoints size={14} />,
        hint: "⌘G",
        run: groupSelection,
      },
      ...holders.map((h) => ({
        label: `Put inside ${idx.objects.get(h)?.name ?? "?"}`,
        icon: <FolderOpen size={14} />,
        run: () => putInside(h),
      })),
      "sep" as const,
      {
        label: `Duplicate ${sel.nodes.length}`,
        icon: <Copy size={14} />,
        hint: "⌘D",
        run: duplicate,
      },
      {
        label: `Delete ${sel.nodes.length}`,
        icon: <Trash2 size={14} />,
        hint: "⌫",
        danger: true,
        run: () => removeSelected(true),
      },
      ...(upItem.length ? ["sep" as const, ...upItem] : []),
    ];
  }
  return [
    {
      label: o && insideAction(idx, o.id) === "start" ? "Start its inside" : "Open inside",
      icon: <FolderOpen size={14} />,
      hint: "↵",
      disabled: !o || !insideAction(idx, o.id) || many,
      run: () => open(t.id!),
    },
    {
      label: "Copy link",
      icon: <Link size={14} />,
      disabled: many || !o,
      // To this box on this diagram: paste it to a person, or to an agent (it reads it with the MCP).
      run: () =>
        void copyLink({ diagramId, objectId: t.id! }).then((ok) =>
          toast(ok ? `Copied a link to ${o!.name}` : "Couldn't copy: the browser said no"),
        ),
    },
    {
      label: "Rename",
      icon: <Pencil size={14} />,
      hint: "F2",
      disabled: many,
      run: () => {
        const r = scene.current?.clientRectOf(t.id!);
        if (r) setRenaming({ id: t.id!, x: r.x, y: r.y, w: r.w, scale: r.scale });
      },
    },
    {
      label: "Connect to…",
      icon: <Cable size={14} />,
      hint: "C",
      disabled: many,
      run: () => (setTool("connect"), setConnectFrom(t.id!)),
    },
    {
      label: "Add a note",
      icon: <MessageSquarePlus size={14} />,
      disabled: many || !store.canEdit,
      run: () => noteOnBox("note", t.id!),
    },
    {
      label: many ? `Duplicate ${sel.nodes.length}` : "Duplicate",
      icon: <Copy size={14} />,
      hint: "⌘D",
      run: duplicate,
    },
    "sep",
    {
      label: "Remove from diagram",
      icon: <X size={14} />,
      hint: "⌫",
      run: () => removeSelected(false),
    },
    {
      label: "Delete everywhere",
      icon: <Trash2 size={14} />,
      hint: "⇧⌫",
      danger: true,
      run: () => removeSelected(true),
    },
  ];
}

/** The right-click menu on an arrow. */
function edgeMenu(
  t: ContextTarget & { id: string },
  c: MenuCtx,
  diagramId: string,
): (MenuItem | "sep")[] {
  const { idx, graph, store, run, scene, setEdgeEdit, removeSelected, noteOnConnection } = c;
  const e = graph?.edges.find((x) => x.id === t.id);
  const one = e?.connectionIds.length === 1 ? idx.connections.get(e.connectionIds[0]!) : undefined;
  return [
    {
      label: "Rename",
      icon: <Pencil size={14} />,
      disabled: !one,
      run: () => {
        const at = scene.current?.edgeLabelClient(t.id!);
        if (one && at) setEdgeEdit({ connectionId: one.id, x: at.x, y: at.y });
      },
    },
    {
      label: "Reverse",
      icon: <ArrowLeftRight size={14} />,
      disabled: !one,
      run: () =>
        one &&
        void run(
          updateConnection(one, { fromId: one.toId, toId: one.fromId }),
          "reverse connection",
        ),
    },
    {
      label: "Add a comment",
      icon: <MessageSquarePlus size={14} />,
      disabled: !e?.connectionIds.length || !store.canEdit,
      run: () => e && noteOnConnection(e.connectionIds[0]!),
    },
    {
      label: "Reset joints",
      icon: <Spline size={14} />,
      disabled: !e?.shape || !store.canEdit,
      run: () =>
        e &&
        diagramId &&
        void run([{ op: "arrow.delete", diagramId, from: e.from, to: e.to }], "reset arrow"),
    },
    "sep",
    {
      label:
        e && e.connectionIds.length > 1 ? `Delete ${e.connectionIds.length} connections` : "Delete",
      icon: <Trash2 size={14} />,
      danger: true,
      run: () => removeSelected(false),
    },
  ];
}

/** The right-click menu on empty canvas. */
function canvasMenu(t: ContextTarget, c: MenuCtx, diagramId: string): (MenuItem | "sep")[] {
  const { idx, graph, simple, store, upItem, spread, run, toast, scene, setMinimap, startFlow } = c;
  return [
    ...(upItem.length ? [...upItem, "sep" as const] : []),
    // Simple mode: a library isn't a box of its own; it's a dependency reference on what uses it.
    ...OBJECT_KINDS.filter((k) => !(simple && k === "library")).map((k) => ({
      label: `Add ${KIND_LABEL[k].toLowerCase()} here`,
      icon: <KindDot kind={k} />,
      run: () => {
        const { ops, object } = addObject(idx, diagramId, k, {
          x: t.world.x - 92,
          y: spread.up(t.world.y) - 36,
        });
        void run(ops, `add ${k}`).then(() =>
          scene.current?.select({ nodes: [object.id], edge: null }, true),
        );
      },
    })),
    "sep",
    { label: "New flow", icon: <Waypoints size={14} />, run: startFlow },
    {
      label: "Fit to screen",
      icon: <Maximize size={14} />,
      hint: "F",
      run: () => scene.current?.fit(),
    },
    ...(graph?.edges.some((e) => e.shape) && store.canEdit && diagramId
      ? [
          {
            label: "Reset all joints",
            icon: <Spline size={14} />,
            run: () => {
              const ops: Op[] = graph.edges
                .filter((e) => e.shape)
                .map((e) => ({ op: "arrow.delete", diagramId, from: e.from, to: e.to }));
              void run(ops, "reset joints").then(() =>
                toast(
                  `Reset the joints of ${ops.length} arrow${ops.length === 1 ? "" : "s"}. ⌘Z undoes it`,
                ),
              );
            },
          },
        ]
      : []),
    {
      label: "Toggle minimap",
      icon: <MapIcon size={14} />,
      hint: "M",
      run: () => setMinimap((m) => !m),
    },
  ];
}

export function menuItems(t: ContextTarget, c: MenuCtx): (MenuItem | "sep")[] {
  const { diagramId } = c;
  if (!diagramId) return [];
  if (t.kind === "node" && t.id) return nodeMenu({ ...t, id: t.id }, c, diagramId);
  if (t.kind === "edge" && t.id) return edgeMenu({ ...t, id: t.id }, c, diagramId);
  return canvasMenu(t, c, diagramId);
}
