// Copy, cut and paste through the system clipboard (no permission needed in these events):
// the selection as Archnemesis YAML, pasted at the pointer.
import { useCallback, useEffect } from "react";
import { CLIP_HEAD, copyText, pasteOps } from "../../shared/clipboard.ts";
import { type ModelIndex } from "../../shared/project.ts";
import { type Selection } from "../canvas/Scene";
import type { Store } from "../store";

import type { MutableRefObject } from "react";
import type { Run, ToastFn } from "./toasts";
import type { SceneRef } from "./types";

export function useClipboard({
  simple,
  sel,
  idx,
  diagramId,
  store,
  run,
  toast,
  removeSelected,
  scene,
  pointer,
}: {
  simple: boolean;
  sel: Selection;
  idx: ModelIndex;
  diagramId: string | null;
  store: Store;
  run: Run;
  toast: ToastFn;
  removeSelected: (everywhere: boolean) => void;
  scene: SceneRef;
  pointer: MutableRefObject<{ x: number; y: number } | null>;
}) {
  /** Copy: the selection, with what's inside it, as Archnemesis YAML (see shared/clipboard.ts). */
  const copySelection = useCallback(
    (): string | null =>
      diagramId && sel.nodes.length ? copyText(idx, diagramId, sel.nodes) : null,
    [idx, diagramId, sel],
  );

  /** Paste Archnemesis YAML as new boxes, at the pointer (or the middle of the view). */
  const pasteText = useCallback(
    (text: string): boolean => {
      if (!diagramId || !store.canEdit) return false;
      const at = pointer.current ?? scene.current?.viewCenter?.() ?? { x: 0, y: 0 };
      const scope = idx.diagrams.get(diagramId)?.scopeId ?? null;
      const made = pasteOps(
        idx,
        diagramId,
        text,
        { x: Math.round(at.x), y: Math.round(at.y) },
        scope,
      );
      if (!made) return false;
      void run(made.ops, made.ids.length === 1 ? "paste" : `paste ${made.ids.length}`).then(() =>
        scene.current?.select(
          {
            nodes: made.ids.filter((id) => !made.ids.includes(idx.objects.get(id)?.parentId ?? "")),
            edge: null,
          },
          true,
        ),
      );
      return true;
    },
    [idx, diagramId, run, store],
  );
  // Copy, cut and paste through the system clipboard (no permission needed in these events).
  useEffect(() => {
    if (!simple) return;
    const typing = () => {
      const t = document.activeElement as HTMLElement | null;
      return !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    };
    const onCopy = (e: ClipboardEvent, cut: boolean) => {
      if (typing() || window.getSelection()?.toString()) return;
      const text = copySelection();
      if (!text || !e.clipboardData) return;
      e.preventDefault();
      e.clipboardData.setData("text/plain", text);
      toast(
        cut
          ? "Cut"
          : `Copied ${sel.nodes.length === 1 ? (idx.objects.get(sel.nodes[0]!)?.name ?? "1") : sel.nodes.length}`,
      );
      if (cut) removeSelected(true);
    };
    const copy = (e: ClipboardEvent) => onCopy(e, false);
    const cut = (e: ClipboardEvent) => onCopy(e, true);
    const paste = (e: ClipboardEvent) => {
      if (typing()) return;
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (!text.trim()) return;
      if (pasteText(text)) e.preventDefault();
      else if (text.startsWith(CLIP_HEAD) || /^objects:/m.test(text))
        toast("That YAML has no objects Archnemesis can read", "error");
    };
    document.addEventListener("copy", copy);
    document.addEventListener("cut", cut);
    document.addEventListener("paste", paste);
    return () => {
      document.removeEventListener("copy", copy);
      document.removeEventListener("cut", cut);
      document.removeEventListener("paste", paste);
    };
  }, [simple, copySelection, pasteText, removeSelected, toast, sel, idx]);
}
