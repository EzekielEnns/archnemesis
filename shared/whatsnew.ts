// What a fork changes, and where it slots in: the things added or changed, plus the
// existing things they plug into (what they call, what calls them, what they're inside)
// and the lines between them, so a reviewer can follow how the change fits.
//
// Matched by file key, so a fork's live state lines up with its base commit read from files.
import type { Connection, Diagram, ModelObject, Placement } from "./model.ts";
import type { ModelState } from "./doc.ts";
import { connectionYaml, objectYaml } from "./files.ts";

const keyOf = (o: { id: string; key?: string }) => o.key ?? o.id;

export interface WhatsNew {
  /** Objects added or changed on the fork (ids in `now`). */
  changed: string[];
  /** Existing objects they plug into: their neighbours and what they're inside. */
  context: string[];
  /** Connections added or changed, and the ones joining the change to its context. */
  connections: string[];
  /** For drawing it like a file diff: what's new, and each changed thing's old and new lines. */
  added?: string[];
  lines?: Record<string, DiffLine[]>;
  /** What the fork deleted that's still on main, and where it sat on each diagram (by diagram id). */
  removed?: Removed[];
  /** Connections the fork added (ids in `now`). */
  addedConnections?: string[];
  /** Connections the fork deleted that are still on main. */
  removedConnections?: RemovedConnection[];
  /** Views the fork deleted (main's ids), with their boxes: a deleted thing can still be opened. */
  removedViews?: RemovedView[];
}

export interface RemovedView {
  /** As on main, its scope as it is here (a deleted scope keeps its id from main). */
  diagram: Diagram;
  placements: Placement[];
}

type DiffLine = ["+" | "-", string];

/** One end of a deleted connection: something still here (its id), or something deleted too (its key). */
type End = { id: string } | { gone: string };

export interface Removed {
  key: string;
  name: string;
  kind: ModelObject["kind"];
  technology?: string;
  at: Record<string, { x: number; y: number; w: number; h: number }>;
  /** As it's written on main. */
  yaml: string;
  /** What putting it back takes: the object (its links to things still here), its boxes, its lines. */
  restore: { object: ModelObject; placements: Placement[]; connections: Connection[] };
}

interface RemovedConnection {
  key: string;
  from: End;
  to: End;
  label: string;
  yaml: string;
  /** As it was, with its ends as they are here (a deleted end keeps its id from main). */
  connection: Connection;
  /** Both ends are still here, so it can be put back by itself (else it comes back with its object). */
  restorable: boolean;
}

/** Two texts' lines, -/+ for what went and came (in order), the unchanged ones left out. */
function lineDiff(a: string[], b: string[]): DiffLine[] {
  // The longest common run of lines, then a walk through both.
  const n = a.length,
    m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      L[i]![j] = a[i] === b[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
  const out: DiffLine[] = [];
  let i = 0,
    j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) (i++, j++);
    // What went comes before what came, as in git.
    else if (i < n && (j === m || L[i + 1]![j]! >= L[i]![j + 1]!)) out.push(["-", a[i++]!]);
    else out.push(["+", b[j++]!]);
  }
  return out;
}
const linesOf = (t: string) => t.replace(/\n$/, "").split("\n");

export function changedWithContext(base: ModelState, now: ModelState): WhatsNew {
  const baseByKey = new Map([...base.objects.values()].map((o) => [keyOf(o), o]));
  const baseKeyOfId = new Map([...base.objects.values()].map((o) => [o.id, keyOf(o)]));
  const nowKeyOfId = new Map([...now.objects.values()].map((o) => [o.id, keyOf(o)]));
  const nowIdOfKey = new Map([...now.objects.values()].map((o) => [keyOf(o), o.id]));
  const keyWas = (id: string) => baseKeyOfId.get(id) ?? id;
  const keyNow = (id: string) => nowKeyOfId.get(id) ?? id;
  // Entities by name, as the files have them (what a signature names is left to it).
  const entWas = (id: string) => base.entities.get(id)?.name;
  const entNow = (id: string) => now.entities.get(id)?.name;
  // Each thing as it's written in the files: what changed is what reads differently.
  const yamlWas = new Map<string, string>();
  const changed = new Set<string>();
  for (const o of now.objects.values()) {
    const was = baseByKey.get(keyOf(o));
    if (!was) {
      changed.add(o.id);
      continue;
    }
    const y = objectYaml(was, keyWas, entWas);
    if (y !== objectYaml(o, keyNow, entNow)) (changed.add(o.id), yamlWas.set(o.id, y));
  }

  // Connections by their ends' keys and label.
  const sig = (c: Connection, k: (id: string) => string) => `${k(c.fromId)}>${k(c.toId)}|${c.name}`;
  const baseConns = new Map([...base.connections.values()].map((c) => [sig(c, keyWas), c]));
  const nowSigs = new Set([...now.connections.values()].map((c) => sig(c, keyNow)));
  const conns = new Set<string>();
  const addedConnections: string[] = [];
  const ends: string[] = [];
  for (const c of now.connections.values()) {
    const was = baseConns.get(sig(c, keyNow));
    if (!was) addedConnections.push(c.id);
    if (!was || connectionYaml(was, keyWas, entWas) !== connectionYaml(c, keyNow, entNow)) {
      conns.add(c.id);
      // A new line between two old things: both ends are where it plugs in.
      ends.push(c.fromId, c.toId);
    }
  }

  // Where it plugs in: one hop out along connections, and what each change is inside.
  const context = new Set<string>(ends);
  for (const c of now.connections.values()) {
    const a = changed.has(c.fromId);
    const b = changed.has(c.toId);
    if (a === b) continue;
    context.add(a ? c.toId : c.fromId);
    conns.add(c.id);
  }
  for (const id of changed) {
    const p = now.objects.get(id)?.parentId;
    if (p && !changed.has(p)) context.add(p);
  }
  for (const id of changed) context.delete(id);

  // Drawn like a file diff: new things, changed things' lines (their YAML), and deleted things' ghosts.
  const added: string[] = [];
  const lines: Record<string, DiffLine[]> = {};
  for (const id of changed) {
    const was = yamlWas.get(id);
    if (was === undefined) added.push(id);
    else
      lines[id] = lineDiff(linesOf(was), linesOf(objectYaml(now.objects.get(id)!, keyNow, entNow)));
  }

  // Ids on main, as they'd be here: the same thing by key, or (for something deleted too) its own.
  const here = (id: string) => nowIdOfKey.get(keyWas(id));
  const diagramIdOfKey = new Map([...now.diagrams.values()].map((d) => [d.key ?? d.id, d.id]));
  const removedConnections: RemovedConnection[] = [];
  const connsOf = new Map<string, Connection[]>();
  for (const c of base.connections.values()) {
    if (nowSigs.has(sig(c, keyWas))) continue;
    const end = (id: string): End => (here(id) ? { id: here(id)! } : { gone: keyWas(id) });
    const from = end(c.fromId),
      to = end(c.toId);
    const mapped: Connection = {
      ...c,
      fromId: here(c.fromId) ?? c.fromId,
      toId: here(c.toId) ?? c.toId,
      ...(c.viaId ? { viaId: here(c.viaId) } : {}),
    };
    removedConnections.push({
      key: sig(c, keyWas),
      from,
      to,
      label: c.name,
      yaml: connectionYaml(c, keyWas, entWas),
      connection: mapped,
      restorable: "id" in from && "id" in to,
    });
    // A line to something deleted comes back with it.
    for (const e of [c.fromId, c.toId])
      if (!here(e)) connsOf.set(e, [...(connsOf.get(e) ?? []), mapped]);
  }
  // Views gone too: drawn from main, so opening a deleted thing shows what was inside it.
  const nowDiagramKeys = new Set([...now.diagrams.values()].map((d) => d.key ?? d.id));
  const removedViews: RemovedView[] = [];
  for (const d of base.diagrams.values()) {
    if (nowDiagramKeys.has(d.key ?? d.id)) continue;
    const placements = [...base.placements.values()]
      .filter((pl) => pl.diagramId === d.id)
      .map((pl) => ({ ...pl, objectId: here(pl.objectId) ?? pl.objectId }));
    removedViews.push({
      diagram: { ...d, ...(d.scopeId ? { scopeId: here(d.scopeId) ?? d.scopeId } : {}) },
      placements,
    });
  }
  const removed: Removed[] = [];
  for (const o of base.objects.values()) {
    if (here(o.id)) continue;
    const at: Removed["at"] = {};
    const placements: Placement[] = [];
    for (const pl of base.placements.values()) {
      if (pl.objectId !== o.id) continue;
      const d = base.diagrams.get(pl.diagramId);
      const id = diagramIdOfKey.get(d?.key ?? pl.diagramId);
      if (!id) continue;
      at[id] = { x: pl.x, y: pl.y, w: pl.w, h: pl.h };
      placements.push({ ...pl, diagramId: id });
    }
    const object: ModelObject = {
      ...o,
      // Inside something still here, or something deleted too (its id from main: it comes back first).
      parentId: o.parentId ? (here(o.parentId) ?? o.parentId) : null,
      ...(o.references
        ? {
            references: o.references.flatMap((r) =>
              r.kind !== "dependency" ? [r] : here(r.to) ? [{ ...r, to: here(r.to)! }] : [],
            ),
          }
        : {}),
    };
    removed.push({
      key: keyOf(o),
      name: o.name,
      kind: o.kind,
      ...(o.technology ? { technology: o.technology } : {}),
      at,
      yaml: objectYaml(o, keyWas, entWas),
      restore: { object, placements, connections: connsOf.get(o.id) ?? [] },
    });
  }
  return {
    changed: [...changed],
    context: [...context],
    connections: [...conns],
    added,
    lines,
    removed,
    addedConnections,
    removedConnections,
    removedViews,
  };
}
