// The rules a new design's Landscape view follows: everything at the top level, so whatever is
// drawn first shows up, whatever kind it is. Code (files, functions, libraries, tables) has its
// own views and stays off.
import type { Rules } from "./views.ts";

export const LANDSCAPE_RULES: Rules = {
  include: [{ top: true }],
  exclude: [
    { kind: "module" },
    { kind: "function" },
    { kind: "library" },
    { kind: "table" },
    { status: "removed" },
  ],
};
