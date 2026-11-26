// What the server does to a live document after people edit it, for a document with no
// server: views that follow rules are brought in line with the model, references left
// dangling are swept up, old-style links move onto their boxes, and diagrams that keep
// themselves tidy are laid out again. (server/live.ts does the same for the server's
// documents, with the same shared/ functions.)
import type * as Y from "yjs";
import {
  applyOps,
  emptyState,
  fill,
  mirror,
  readState,
  sweep,
  type Actor,
  type ModelState,
} from "../../shared/doc.ts";
import type { FConfig } from "../../shared/files.ts";
import { linkNoteOps } from "../../shared/notes.ts";
import type { Placement } from "../../shared/model.ts";
import { buildIndex, projectDiagram, type ModelIndex } from "../../shared/project.ts";
import { viewOps } from "../../shared/views.ts";

/** Our own edits: never in anyone's undo, and they don't set off another round. */
export const SYSTEM: Actor = { id: "archnm", name: "archnm", kind: "system" };

const SETTLE_MS = 400;

function indexOf(state: ModelState): ModelIndex {
  return buildIndex({
    objects: state.objects.values(),
    connections: state.connections.values(),
    diagrams: state.diagrams.values(),
    placements: state.placements.values(),
    flows: state.flows.values(),
    arrows: state.arrows.values(),
    notes: state.notes.values(),
    replies: state.replies.values(),
    boundaries: state.boundaries.values(),
    decisions: state.decisions.values(),
    entities: state.entities.values(),
  });
}

function configOf(doc: Y.Doc): FConfig {
  try {
    return JSON.parse(doc.getMap<string>("meta").get("config") ?? "{}") as FConfig;
  } catch {
    return {};
  }
}

/**
 * Keep `doc` tidy the way the server does: a moment after someone else's edit settles, sweep,
 * move links, follow the rules, keep diagrams tidy. Start it once the document has loaded.
 * Returns a function that stops it.
 */
export function followRules(doc: Y.Doc): () => void {
  const state = emptyState();
  fill(state, readState(doc));
  // Where a diagram that follows rules last had each box it dropped ("diagram|object").
  const dropped = new Map<string, Placement>();
  // What each keep-tidy diagram looked like when last laid out; the first look only takes note.
  const tidied = new Map<string, string>();
  let tidySeen = false;
  let tidying = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const applyRules = () => {
    const idx = indexOf(state);
    const recall = (d: string, id: string) => dropped.get(`${d}|${id}`);
    const ops = [...idx.diagrams.values()]
      .filter((d) => d.rules)
      .flatMap((d) => viewOps(idx, d.id, recall));
    for (const op of ops) {
      if (op.op === "placement.delete") {
        const was = idx.placements.get(op.diagramId)?.get(op.objectId);
        if (was) dropped.set(`${op.diagramId}|${op.objectId}`, was);
      } else if (op.op === "placement.put")
        dropped.delete(`${op.placement.diagramId}|${op.placement.objectId}`);
    }
    if (!ops.length) return;
    try {
      applyOps(doc, state, ops, SYSTEM, "diagrams followed the model", SYSTEM, { pin: false });
    } catch (e) {
      console.error("applying diagram rules:", e);
    }
  };

  const keepTidy = async () => {
    if (tidying) return;
    tidying = true;
    try {
      const { layoutOps, structureOf } = await import("../../shared/layout.ts");
      const idx = indexOf(state);
      for (const d of idx.diagrams.values()) {
        if (!d.tidy || !d.keepTidy) {
          tidied.delete(d.id);
          continue;
        }
        const sig = `${d.tidy}|${structureOf(projectDiagram(idx, d.id))}`;
        const was = tidied.get(d.id);
        tidied.set(d.id, sig);
        if (was === sig || (was === undefined && !tidySeen)) continue;
        const ops = await layoutOps(indexOf(state), d.id, d.tidy, configOf(doc).tags);
        if (!ops.length) continue;
        try {
          applyOps(doc, state, ops, SYSTEM, `kept ${d.name} tidy`, SYSTEM, { pin: false });
        } catch (e) {
          console.error("keeping a diagram tidy:", e);
        }
      }
      tidySeen = true;
    } finally {
      tidying = false;
    }
  };

  const settle = () => {
    timer = null;
    if (stopped) return;
    sweep(doc, state, SYSTEM);
    const moved = linkNoteOps(state);
    if (moved.length) {
      try {
        applyOps(doc, state, moved, SYSTEM, "moved links onto their boxes", SYSTEM, { pin: false });
      } catch (e) {
        console.error("moving links:", e);
      }
    }
    applyRules();
    void keepTidy();
  };

  const unmirror = mirror(doc, state, (tr) => {
    if (!tr.changed.size || tr.origin === SYSTEM) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(settle, SETTLE_MS);
  });
  void keepTidy();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    unmirror();
  };
}
