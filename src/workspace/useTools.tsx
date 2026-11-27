// The tool in hand (select, view, connect, note, group, or a kind of box to place), what the
// tool decides on the canvas, the hint under the toolbar, and picking a kind in the toolbar.
import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useState } from "react";
import { updateObject } from "../../shared/actions.ts";
import { boxSize, KIND_LABEL, OBJECT_KINDS } from "../../shared/model.ts";
import type { ObjectKind, Op } from "../../shared/model.ts";
import { type ModelIndex } from "../../shared/project.ts";
import { type Selection } from "../canvas/Scene";
import { type ToolId } from "../ui/Chrome";

import { defaultName, isBlank, isDefaultName } from "./names";
import type { Run } from "./toasts";
import type { SceneRef } from "./types";

export function useTools({
  simple,
  sel,
  idx,
  diagramId,
  run,
  openFresh,
  setFresh,
  scene,
  ready,
}: {
  simple: boolean;
  sel: Selection;
  idx: ModelIndex;
  diagramId: string | null;
  run: Run;
  openFresh: (id: string) => void;
  setFresh: Dispatch<SetStateAction<string | null>>;
  scene: SceneRef;
  ready: boolean;
}) {
  /** "Connect to…": the next box clicked gets a connection from this one. */
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [tool, setTool] = useState<ToolId>("select");
  /** Simple mode: the kind last picked in the toolbar; an arrow dragged into space makes one. */
  const [lastKind, setLastKind] = useState<ObjectKind | null>(null);
  const toolHint =
    tool === "connect" ? (
      connectFrom ? (
        <>
          Click the box <b>{idx.objects.get(connectFrom)?.name}</b> connects to · Esc to cancel
        </>
      ) : (
        "Drag from a box to connect it, or from an arrow to branch it · Esc to cancel"
      )
    ) : tool === "note" ? (
      "Click where the note goes (on a box pins it to the box) · Esc to cancel"
    ) : tool === "view" ? (
      "Viewing: drag to look around · click a box to read it · V to edit"
    ) : tool === "group" ? (
      "Drag a frame around boxes to group them · Esc to cancel"
    ) : tool !== "select" ? (
      <>Click to place {KIND_LABEL[tool].toLowerCase()} · Esc to cancel</>
    ) : null;

  // The tool decides what a click on the canvas does.
  useEffect(() => {
    scene.current?.setTool(
      tool === "view"
        ? "view"
        : tool === "select" || tool === "connect" || tool === "group"
          ? "select"
          : "place",
    );
    scene.current?.setGroupDraw(tool === "group");
    scene.current?.setConnecting(tool === "connect");
    scene.current?.setSimple(simple);
    if (tool !== "connect") setConnectFrom(null);
  }, [tool, ready, simple]);

  /**
   * Simple mode: picking a kind while one new, blank box is selected (its default name, no
   * description, no connections) makes that box this kind instead of placing another.
   */
  const pickTool = useCallback(
    (t: ToolId) => {
      const kind = (OBJECT_KINDS as readonly string[]).includes(t) ? (t as ObjectKind) : null;
      if (kind) setLastKind(kind);
      const o =
        simple && kind && sel.nodes.length === 1 ? idx.objects.get(sel.nodes[0]!) : undefined;
      if (
        o &&
        kind &&
        o.kind !== kind &&
        isBlank(idx, o) &&
        !(
          idx.children.get(o.id)?.length && ["table", "function", "library", "actor"].includes(kind)
        )
      ) {
        const p = diagramId ? idx.placements.get(diagramId)?.get(o.id) : undefined;
        const named = o.name.trim() === "" || isDefaultName(o.name);
        const ops: Op[] = [
          ...updateObject(o, {
            kind,
            ...(named ? { name: defaultName(kind) } : {}),
            ...(kind === "actor" ? { parentId: null } : {}),
          }),
        ];
        // A box keeps its size if it was drawn bigger; a frame's own box is never seen.
        if (p && !idx.children.get(o.id)?.length)
          ops.push({
            op: "placement.put",
            placement: { ...p, ...boxSize(kind), w: Math.max(p.w, boxSize(kind).w) },
          });
        void run(ops, `make it ${KIND_LABEL[kind].toLowerCase()}`).then(() => {
          setFresh(null);
          setTimeout(() => openFresh(o.id), 0);
        });
        return;
      }
      setTool(t);
    },
    [simple, sel, idx, diagramId, run, openFresh],
  );
  return { tool, setTool, connectFrom, setConnectFrom, lastKind, toolHint, pickTool };
}
