// The keys for the model (the canvas handles its own: F, Esc, ⌘A), in the order they're tried:
// the first group that takes the key wins.
import type { Dispatch, SetStateAction } from "react";
import { type ModelIndex } from "../../shared/project.ts";
import { type Selection } from "../canvas/Scene";
import type { Store } from "../store";
import { DRAFT } from "../ui/Notes";
import { backend } from "../backend";
import { TOOL_KEYS } from "../ui/Chrome";

import { copyLink } from "../route";
import type { useTools } from "./useTools";
import type { Run, ToastFn } from "./toasts";
import type { SceneRef } from "./types";
import type { useFlow } from "./useFlow";
import type { useEditActions } from "./useEditActions";

export interface KeyCtx {
  store: Store;
  idx: ModelIndex;
  run: Run;
  toast: ToastFn;
  sel: Selection;
  diagramId: string | null;
  scene: SceneRef;
  simple: boolean;
  open: (objectId: string) => void;
  up: () => void;
  exportAs: (format: "png" | "json") => Promise<unknown>;
  duplicate: () => void;
  removeSelected: (everywhere: boolean) => void;
  groupSelection: ReturnType<typeof useEditActions>["groupSelection"];
  ungroupSelection: () => void;
  closeNote: () => void;
  noteSel: string | null;
  panel: boolean;
  setPanel: Dispatch<SetStateAction<boolean>>;
  help: boolean;
  setHelp: Dispatch<SetStateAction<boolean>>;
  setPalette: Dispatch<SetStateAction<boolean>>;
  setMinimap: Dispatch<SetStateAction<boolean>>;
  setShowNew: Dispatch<SetStateAction<boolean>>;
  setAnimate: Dispatch<SetStateAction<boolean>>;
  setPanelOn: Dispatch<SetStateAction<boolean>>;
  setSidebar: Dispatch<SetStateAction<boolean>>;
  setMarking: Dispatch<SetStateAction<string | null>>;
  tool: ReturnType<typeof useTools>["tool"];
  setTool: ReturnType<typeof useTools>["setTool"];
  connectFrom: string | null;
  setConnectFrom: Dispatch<SetStateAction<string | null>>;
  pickTool: ReturnType<typeof useTools>["pickTool"];
  activeFlow: ReturnType<typeof useFlow>["activeFlow"];
  isPath: boolean;
  setStep: Dispatch<SetStateAction<number>>;
  setFlowId: Dispatch<SetStateAction<string | null>>;
  tag: string | null;
  setTag: Dispatch<SetStateAction<string | null>>;
}

/** A note selected: Esc closes it, ⌫ deletes it. */
function noteKeys(e: KeyboardEvent, _mod: boolean, k: KeyCtx): boolean {
  const { store, noteSel, idx, run, closeNote } = k;
  if (
    noteSel &&
    (e.key === "Escape" || ((e.key === "Backspace" || e.key === "Delete") && noteSel !== DRAFT))
  ) {
    e.preventDefault();
    const n = idx.notes.get(noteSel);
    if (e.key !== "Escape" && n && store.canEdit)
      void run(
        [{ op: "note.delete", id: n.id }],
        n.kind === "link" ? "removed a link" : "deleted a note",
      );
    closeNote();
    return true;
  }
  return false;
}

/** ⌘K, undo, delete, copy a link, group. */
function modelKeys(e: KeyboardEvent, mod: boolean, k: KeyCtx): boolean {
  const {
    store,
    removeSelected,
    sel,
    idx,
    simple,
    groupSelection,
    ungroupSelection,
    diagramId,
    toast,
    setPalette,
  } = k;
  if (mod && e.key.toLowerCase() === "k") {
    e.preventDefault();
    setPalette((p) => !p);
    return true;
  }
  if (mod && e.key.toLowerCase() === "z") {
    e.preventDefault();
    void (e.shiftKey ? store.redo() : store.undo());
    return true;
  }
  if (mod && e.key.toLowerCase() === "y") {
    e.preventDefault();
    void store.redo();
    return true;
  }
  if (e.key === "Backspace" || e.key === "Delete") {
    e.preventDefault();
    // Simple mode has no "hide here": delete takes it out of the model.
    removeSelected(simple || e.shiftKey);
    return true;
  }
  if (mod && e.shiftKey && e.key.toLowerCase() === "c" && diagramId && sel.nodes.length === 1) {
    // A link to the selected box: paste it to a person, or to an agent (the MCP opens it).
    e.preventDefault();
    const o = idx.objects.get(sel.nodes[0]!);
    void copyLink({ diagramId, objectId: sel.nodes[0]! }).then((ok) =>
      toast(ok ? `Copied a link to ${o?.name ?? "it"}` : "Couldn't copy: the browser said no"),
    );
    return true;
  }
  if (simple && mod && e.key.toLowerCase() === "g") {
    e.preventDefault();
    if (e.shiftKey) ungroupSelection();
    else groupSelection();
    return true;
  }
  return false;
}

/** M, D, A, [, Esc on the card, ?. */
function toggleKeys(e: KeyboardEvent, mod: boolean, k: KeyCtx): boolean {
  const {
    store,
    simple,
    panel,
    setMinimap,
    setShowNew,
    setAnimate,
    setPanelOn,
    setSidebar,
    setPanel,
    setHelp,
  } = k;
  if (e.key === "m" && !mod) {
    setMinimap((m) => !m);
    return true;
  }
  if (e.key === "d" && !mod && !e.shiftKey && store.branch) {
    setShowNew((v) => !v);
    return true;
  }
  if (e.key === "a" && !mod) {
    setAnimate((v) => !v);
    return true;
  }
  if (e.key === "[" && !mod) {
    if (simple) setPanelOn((v) => !v);
    else setSidebar((v) => !v);
    return true;
  }
  if (e.key === "Escape" && simple && panel) {
    setPanel(false);
    return true;
  }
  if (e.key === "?") {
    setHelp((h) => !h);
    return true;
  }
  return false;
}

/** !, Esc on the sheet or a tool, C. */
function escapeKeys(e: KeyboardEvent, mod: boolean, k: KeyCtx): boolean {
  const { sel, connectFrom, help, tool, setHelp, setMarking, setConnectFrom, setTool } = k;
  if (e.key === "!" && backend.trail) {
    e.preventDefault();
    setMarking("");
    return true;
  }
  if (e.key === "Escape" && help) {
    setHelp(false);
    return true;
  }
  if (e.key === "Escape" && (connectFrom || (tool !== "select" && tool !== "view"))) {
    setConnectFrom(null);
    setTool("select");
    return true;
  }
  if (e.key.toLowerCase() === "c" && !mod) {
    setTool("connect");
    if (sel.nodes.length === 1) setConnectFrom(sel.nodes[0]!);
    return true;
  }
  return false;
}

/** Tool keys, zoom, Enter, duplicate, export, up. */
function toolKeys(e: KeyboardEvent, mod: boolean, k: KeyCtx): boolean {
  const { sel, open, up, exportAs, duplicate, pickTool, scene } = k;
  if (!mod && !e.altKey && TOOL_KEYS[e.key.toLowerCase()]) {
    pickTool(TOOL_KEYS[e.key.toLowerCase()]!);
    return true;
  }
  if (mod && (e.key === "=" || e.key === "+" || e.key === "-")) {
    e.preventDefault();
    scene.current?.zoomBy(e.key === "-" ? 1 / 1.25 : 1.25);
    return true;
  }
  if (
    e.key === "Enter" &&
    sel.nodes.length === 1 &&
    !(e.target instanceof HTMLButtonElement || e.target instanceof HTMLAnchorElement)
  ) {
    open(sel.nodes[0]!);
    return true;
  }
  if (mod && e.key.toLowerCase() === "d") {
    e.preventDefault();
    duplicate();
    return true;
  }
  if (mod && e.shiftKey && e.key.toLowerCase() === "e") {
    e.preventDefault();
    void exportAs("png");
    return true;
  }
  if (mod && e.key === "ArrowUp") {
    e.preventDefault();
    up();
    return true;
  }
  return false;
}

/** Arrows through a flow, Esc out of it or a tag. */
function flowKeys(e: KeyboardEvent, _mod: boolean, k: KeyCtx): boolean {
  const { sel, activeFlow, isPath, tag, setStep, setFlowId, setTag } = k;
  if (
    activeFlow &&
    !isPath &&
    !sel.nodes.length &&
    !sel.edge &&
    (e.key === "ArrowRight" || e.key === "ArrowLeft")
  ) {
    e.preventDefault();
    const n = activeFlow.steps.length;
    if (n) setStep((i) => (e.key === "ArrowRight" ? (i + 1) % n : i <= 0 ? n - 1 : i - 1));
    return true;
  }
  if (e.key === "Escape" && activeFlow && !sel.nodes.length && !sel.edge) {
    setFlowId(null);
    return true;
  }
  if (e.key === "Escape" && tag) {
    setTag(null);
    return true;
  }
  return false;
}

/** One key press: the first group that takes it. */
export function onKey(e: KeyboardEvent, k: KeyCtx) {
  const t = e.target as HTMLElement | null;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  const mod = e.metaKey || e.ctrlKey;
  if (noteKeys(e, mod, k)) return;
  if (modelKeys(e, mod, k) || toggleKeys(e, mod, k) || escapeKeys(e, mod, k)) return;
  if (toolKeys(e, mod, k) || flowKeys(e, mod, k)) return;
}
