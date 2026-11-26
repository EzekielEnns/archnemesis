// The little things floating over the canvas: the name being typed over a box, the name being
// typed over an arrow, the right-click menu, and the hint by the pointer while dragging.
import { useState } from "react";
import { type ContextTarget } from "../canvas/Scene";

export function useOverlays() {
  const [renaming, setRenaming] = useState<{
    id: string;
    x: number;
    y: number;
    w: number;
    scale: number;
  } | null>(null);
  const [edgeEdit, setEdgeEdit] = useState<{ connectionId: string; x: number; y: number } | null>(
    null,
  );
  const [menu, setMenu] = useState<ContextTarget | null>(null);
  /** Simple mode, while dragging: "Put inside X" / "Take out of X" by the pointer. */
  const [dropHint, setDropHint] = useState<{ text: string; x: number; y: number } | null>(null);
  return {
    renaming,
    setRenaming,
    edgeEdit,
    setEdgeEdit,
    menu,
    setMenu,
    dropHint,
    setDropHint,
  };
}
