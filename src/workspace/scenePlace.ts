// A click on the canvas with a placing tool: a note (pinned to a box or an arrow), or a new
// box, dropped into the file or folder under the pointer when it's code.
import { codeHolder, addObject } from "../../shared/actions.ts";
import { CARD_H, CARD_W } from "../../shared/model.ts";
import { type ModelIndex } from "../../shared/project.ts";
import { Scene } from "../canvas/Scene";
import { DRAFT } from "../ui/Notes";

import { NO_SELECTION } from "./constants";
import type { SceneCallbacks } from "../canvas/Scene";

import type { SceneDeps } from "./sceneCallbacks";

/** The note tool: a draft, pinned to the box or the arrow under the pointer. */
function placeNote(
  deps: SceneDeps,
  s: Scene,
  drawnAt: { x: number; y: number },
  world: { x: number; y: number },
  i: ModelIndex,
  d: string,
) {
  const { setTool, setSel, setDraft, setNoteSel } = deps;
  setTool("select");
  const over = s.nodeAt(drawnAt);
  const box = over ? i.placements.get(d)?.get(over) : undefined;
  // On an arrow (and no box), it's pinned to that arrow's connection.
  const arrow = box ? null : s.edgeAt(drawnAt);
  const conn = arrow?.connectionIds[0];
  const mid = conn ? s.connectionAnchor(conn) : null;
  const at =
    conn && mid
      ? {
          objectId: null,
          connectionId: conn,
          x: Math.round(drawnAt.x - mid.x),
          y: Math.round(drawnAt.y - mid.y),
        }
      : {
          objectId: box ? over : null,
          // A box drawn inside one opened in place has no spot of its own on this diagram to pin
          // to. The note stays where it was dropped, and still says which box it's about: without
          // that, an agent reading the notes sees only loose text.
          ...(over && !box && i.objects.has(over) ? { about: over } : {}),
          x: Math.round(world.x - (box?.x ?? 0)),
          y: Math.round(world.y - (box?.y ?? 0)),
        };
  s.select(NO_SELECTION);
  setSel(NO_SELECTION);
  setDraft({ kind: "note", diagramId: d, ...at });
  setNoteSel(DRAFT);
}

export function placeHandler(deps: SceneDeps, getScene: () => Scene): SceneCallbacks["onPlace"] {
  const { latest, setTool } = deps;
  return (drawnAt) => {
    const s = getScene();
    const { idx: i, diagramId: d, run: r, tool: t } = latest.current;
    const world = { x: drawnAt.x, y: latest.current.spread.up(drawnAt.y) };
    if (!d || t === "select" || t === "view" || t === "connect" || t === "group") return;
    if (t === "note") {
      placeNote(deps, s, drawnAt, world, i, d);
      return;
    }
    // Code is sketched by dropping it into what holds it: a function onto a file (or onto
    // another function, into that one's file), a file onto a folder, app or component.
    // Simple mode keeps it where it's dropped, on its own: nothing turns into a frame around it.
    const over =
      !latest.current.simple && (t === "module" || t === "function" || t === "table")
        ? s.nodeAt(drawnAt)
        : null;
    const holder = over ? codeHolder(i, t, over) : null;
    const { ops, object } = addObject(
      i,
      d,
      t,
      { x: world.x - CARD_W / 2, y: world.y - CARD_H / 2 },
      holder ? { parentId: holder } : {},
    );
    // The first thing into a box that's drawn as a box takes its spot: the box turns into a
    // frame around it right there, instead of jumping to wherever there was room.
    const spot = holder ? i.placements.get(d)?.get(holder) : undefined;
    const empty =
      holder && !(i.children.get(holder) ?? []).some((c) => i.placements.get(d)?.has(c.id));
    if (spot && empty)
      for (const op of ops)
        if (op.op === "placement.put") Object.assign(op.placement, { x: spot.x, y: spot.y });
    setTool("select");
    void r(ops, `add ${t}`).then(() => {
      s.select({ nodes: [object.id], edge: null }, true);
      if (latest.current.simple) latest.current.openFresh(object.id);
    });
  };
}
