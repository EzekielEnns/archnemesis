// Recording where you go (opt-in, this browser only): each move between views and how it
// was made, sent to the server in batches. ⌘K → "Record my navigation" turns it on.
import type { How, TrailEvent } from "../shared/trail";
import { backend } from "./backend";
import { parseHash } from "./route";

const KEY = "archnm.trail";
let on = (() => {
  try {
    return localStorage.getItem(KEY) === "on";
  } catch {
    return false;
  }
})();
const session = Math.random().toString(16).slice(2, 10) + Date.now().toString(16);
let pending: TrailEvent[] = [];
let nextHow: { how: How; created?: boolean } | null = null;
let last = parseHash();
let boxesNow: () => number | undefined = () => undefined;

export const recording = () => on;
export function setRecording(v: boolean): void {
  on = v;
  try {
    localStorage.setItem(KEY, v ? "on" : "off");
  } catch {
    /* private window: on for this tab only */
  }
}
/** A way to count what's on screen. */
export function wireTrail(boxes: () => number | undefined): void {
  boxesNow = boxes;
}
/** Say how the next move is being made (just before changing the URL). */
export function via(how: How, created?: boolean): void {
  nextHow = { how, ...(created ? { created } : {}) };
}
export function note(e: Omit<TrailEvent, "at">): void {
  if (on) pending.push({ at: new Date().toISOString(), ...e });
}

/** An edit made here (a batch of ops, or undo / redo). */
export function noteEdit(label: string, ops?: { op: string }[]): void {
  if (!on) return;
  const counts: Record<string, number> = {};
  for (const o of ops ?? []) counts[o.op] = (counts[o.op] ?? 0) + 1;
  pending.push({
    at: new Date().toISOString(),
    kind: "edit",
    label: label.slice(0, 120),
    ...(ops ? { ops: counts } : {}),
    on: parseHash().diagramId,
  });
}

/** "This is confusing": always kept (the person asked), and sent straight away. */
export function mark(text: string): void {
  pending.push({
    at: new Date().toISOString(),
    kind: "mark",
    text: text.slice(0, 500),
    on: parseHash().diagramId,
  });
  flush();
}

window.addEventListener("hashchange", () => {
  const r = parseHash();
  const how = nextHow;
  nextHow = null;
  const from = last;
  last = r;
  if (!on || r.design !== from.design) return;
  if (r.diagramId === from.diagramId && r.objectId === from.objectId) return;
  const ev: TrailEvent = {
    at: new Date().toISOString(),
    kind: "move",
    how: how?.how ?? "history",
    from: { d: from.diagramId, o: from.objectId },
    to: { d: r.diagramId, o: r.objectId },
  };
  if (how?.created) ev.created = true;
  pending.push(ev);
  // What the view shows, once it's drawn.
  setTimeout(() => {
    const b = boxesNow();
    if (b !== undefined) ev.boxes = b;
  }, 600);
});

function flush(beacon = false): void {
  if (!pending.length) return;
  const doc = parseHash().design;
  if (!doc) return;
  const events = pending;
  pending = [];
  // keepalive lets the last batch go out as the tab closes.
  backend.trail?.send(doc, session, events, beacon);
}
setInterval(() => flush(), 5000);
window.addEventListener("pagehide", () => flush(true));
