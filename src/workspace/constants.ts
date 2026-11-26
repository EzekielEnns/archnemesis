// Names and sizes the workspace shares: the drag type for dragging a box in from the tree, what
// "nothing selected" is, and how much room the panels take.
import type { Selection } from "../canvas/Scene";

export const OBJECT_DRAG_TYPE = "application/x-archnm-object";

export const NO_SELECTION: Selection = { nodes: [], edge: null };

/** Simple mode: the room kept for the left panel (its width and margins), open or not. */
export const PANEL_ROOM = 288;
/** The ☰ that opens it, when it's closed. */
export const MENU_ROOM = 64;
/** About how wide all the tools are; with less room than this, some go in the ⋮ menu. */
export const TOOLS_W = 600;
/** The drawer's width: what the canvas treats as covered while it's open. */
export const DRAWER_W = 280;
