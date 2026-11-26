// Keys for the model, on the window; see keys.ts for what each does.
import { useEffect } from "react";

import { onKey, type KeyCtx } from "./keys";

export function useKeyboard(k: KeyCtx) {
  const {
    store,
    removeSelected,
    sel,
    open,
    up,
    exportAs,
    duplicate,
    activeFlow,
    tag,
    connectFrom,
    help,
    tool,
    noteSel,
    idx,
    run,
    closeNote,
    simple,
    panel,
    pickTool,
    groupSelection,
    ungroupSelection,
  } = k;
  useEffect(() => {
    const handle = (e: KeyboardEvent) => onKey(e, k);
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [
    store,
    removeSelected,
    sel,
    open,
    up,
    exportAs,
    duplicate,
    activeFlow,
    tag,
    connectFrom,
    help,
    tool,
    noteSel,
    idx,
    run,
    closeNote,
    simple,
    panel,
    pickTool,
    groupSelection,
    ungroupSelection,
  ]);
}
