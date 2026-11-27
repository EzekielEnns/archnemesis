// What the gestures mean, as ops: shared so the browser and the MCP make the same edits.
import {
  boxSize,
  CARD_H,
  CARD_W,
  makeConnection,
  makeDiagram,
  makeObject,
  now,
  type Connection,
  type Diagram,
  type ModelObject,
  type ObjectKind,
  type Op,
  type Placement,
} from "./model.ts";
import { descendants, diagramForScope, processOf, type ModelIndex } from "./project.ts";
import { intersectsRect, type Box } from "./rect.ts";
import { insideRules, nearestPlacedNeighbour, resolve } from "./views.ts";

const GAP_X = 72;
const GAP_Y = 56;
const SNAP = 8;

const snap = (v: number) => Math.round(v / SNAP) * SNAP;

/** The first free card-sized spot at or right of `at` on a diagram, so new boxes never land on old ones. */
export function freeSpot(
  idx: ModelIndex,
  diagramId: string,
  at: { x: number; y: number },
  taken: Box[] = [],
): { x: number; y: number } {
  const boxes = [...(idx.placements.get(diagramId)?.values() ?? []), ...taken];
  let x = snap(at.x);
  let y = snap(at.y);
  for (let tries = 0; tries < 200; tries++) {
    const candidate = { x: x - 12, y: y - 12, w: CARD_W + 24, h: CARD_H + 24 };
    if (!boxes.some((b) => intersectsRect(candidate, b))) return { x, y };
    x += CARD_W + GAP_X;
    if (tries % 6 === 5) {
      x = snap(at.x);
      y += CARD_H + GAP_Y;
    }
  }
  // Crowded: below everything, which is always free.
  const bottom = boxes.reduce((m, b) => Math.max(m, b.y + b.h), -Infinity);
  return { x: snap(at.x), y: snap(Number.isFinite(bottom) ? bottom + GAP_Y : at.y) };
}

/** A new object, inside the diagram's scope (actors and externals stay at the top). */
/** What a new file or function dropped on a box goes inside, or null to leave it where it's dropped. */
export function codeHolder(idx: ModelIndex, kind: ObjectKind, overId: string): string | null {
  const o = idx.objects.get(overId);
  if (!o) return null;
  if (kind === "function") {
    if (o.kind === "module") return o.id;
    if (o.kind === "function")
      return o.parentId && idx.objects.get(o.parentId)?.kind === "module" ? o.parentId : null;
    return null;
  }
  if (kind === "module")
    return o.kind === "module" || o.kind === "app" || o.kind === "component" || o.kind === "system"
      ? o.id
      : null;
  // A table goes in a store (dropped on another table: into that one's store).
  if (kind === "table") return o.kind === "store" ? o.id : o.kind === "table" ? o.parentId : null;
  return null;
}

export function addObject(
  idx: ModelIndex,
  diagramId: string,
  kind: ObjectKind,
  at: { x: number; y: number },
  fields: Partial<ModelObject> = {},
): { ops: Op[]; object: ModelObject } {
  const scopeId = idx.diagrams.get(diagramId)?.scopeId ?? null;
  const inside = kind !== "actor" && !fields.external;
  const object = makeObject({
    kind,
    name: kind === "store" ? "New service" : `New ${kind}`,
    parentId: inside ? scopeId : null,
    ...fields,
  });
  const spot = freeSpot(idx, diagramId, at);
  return {
    object,
    ops: [
      { op: "object.put", object },
      {
        op: "placement.put",
        placement: { diagramId, objectId: object.id, x: spot.x, y: spot.y, ...boxSize(kind) },
      },
    ],
  };
}

export function place(
  idx: ModelIndex,
  diagramId: string,
  objectId: string,
  at: { x: number; y: number },
): Op[] {
  const prev = idx.placements.get(diagramId)?.get(objectId);
  const size = boxSize(idx.objects.get(objectId)?.kind ?? "app");
  return [
    {
      op: "placement.put",
      placement: {
        diagramId,
        objectId,
        x: snap(at.x),
        y: snap(at.y),
        w: prev?.w ?? size.w,
        h: prev?.h ?? size.h,
      },
    },
  ];
}

/**
 * Put an object on a diagram without saying where: beside something it connects to that's
 * already there, else to the right of everything.
 */
export function placeBeside(idx: ModelIndex, diagramId: string, objectId: string): Op[] {
  const near = nearestPlacedNeighbour(idx, diagramId, objectId);
  const boxes = [...(idx.placements.get(diagramId)?.values() ?? [])];
  const at = near
    ? { x: near.x + near.w + 96, y: near.y }
    : boxes.length
      ? { x: Math.max(...boxes.map((b) => b.x + b.w)) + 96, y: Math.min(...boxes.map((b) => b.y)) }
      : { x: 0, y: 0 };
  return place(idx, diagramId, objectId, freeSpot(idx, diagramId, at));
}

export function moveOps(
  idx: ModelIndex,
  diagramId: string,
  moves: { id: string; x: number; y: number }[],
): Op[] {
  return moves.flatMap(({ id, x, y }) => {
    const prev = idx.placements.get(diagramId)?.get(id);
    return prev ? [{ op: "placement.put", placement: { ...prev, x, y } } satisfies Op] : [];
  });
}

export function connect(
  fromId: string,
  toId: string,
  fields: Partial<Connection> = {},
): { ops: Op[]; connection: Connection } {
  const connection = makeConnection({ fromId, toId, ...fields });
  return { connection, ops: [{ op: "connection.put", connection }] };
}

export function updateObject(o: ModelObject, patch: Partial<ModelObject>): Op[] {
  return [{ op: "object.put", object: { ...o, ...patch, id: o.id, updatedAt: now() } }];
}

export function updateConnection(c: Connection, patch: Partial<Connection>): Op[] {
  return [{ op: "connection.put", connection: { ...c, ...patch, id: c.id } }];
}

/** Make a connection go both ways, or one way again (the flag is left out, not written as false). */
export function setBoth(c: Connection, both: boolean): Op[] {
  const { both: _was, ...rest } = c;
  return [{ op: "connection.put", connection: both ? { ...rest, both: true } : rest }];
}

export function removeFromDiagram(diagramId: string, objectIds: string[]): Op[] {
  return objectIds.map((objectId) => ({ op: "placement.delete", diagramId, objectId }) as Op);
}

export function deleteObjects(ids: string[]): Op[] {
  return ids.map((id) => ({ op: "object.delete", id }) as Op);
}

export function deleteConnections(ids: string[]): Op[] {
  return ids.map((id) => ({ op: "connection.delete", id }) as Op);
}

/**
 * The diagram that shows an object's inside: the existing one, or a new one with its
 * children laid out in a grid and whatever they connect to outside placed around them.
 */
/** A folded group's own view: the one about it (include tag: group:x), or a new one. */
export function openGroup(
  idx: ModelIndex,
  group: string,
  name: string,
): { diagramId: string; ops: Op[] } {
  const tag = `group:${group}`;
  const existing = [...idx.diagrams.values()].find((d) =>
    d.rules?.include.some((s) => "tag" in s && s.tag === tag),
  );
  if (existing) return { diagramId: existing.id, ops: [] };
  const members = [...idx.objects.values()].filter((o) => o.tags.includes(tag)).map((o) => o.id);
  const diagram = makeDiagram({
    name: `Group: ${name}`,
    scopeId: null,
    rules: {
      include: [{ tag }, ...members.map((id) => ({ neighbours: id }))],
      exclude: [{ status: "removed" }],
    },
    fold: "groups",
    tidy: "right",
    keepTidy: true,
  });
  return { diagramId: diagram.id, ops: [{ op: "diagram.put", diagram }] };
}

export function openInside(idx: ModelIndex, objectId: string): { diagramId: string; ops: Op[] } {
  const existing = diagramForScope(idx, objectId);
  if (existing) return { diagramId: existing.id, ops: [] };
  const scope = idx.objects.get(objectId);
  // It follows the model: whatever moves into the object later shows up here too.
  const diagram: Diagram = makeDiagram({
    name: scope?.name ?? "Inside",
    scopeId: objectId,
    rules: insideRules(objectId),
  });
  const ops: Op[] = [{ op: "diagram.put", diagram }];
  const children = idx.children.get(objectId) ?? [];
  const cols = Math.max(1, Math.ceil(Math.sqrt(children.length)));
  const placed = new Set<string>();
  const put = (id: string, x: number, y: number) => {
    placed.add(id);
    const placement: Placement = {
      diagramId: diagram.id,
      objectId: id,
      x,
      y,
      ...boxSize(idx.objects.get(id)?.kind ?? "app"),
    };
    ops.push({ op: "placement.put", placement });
  };
  children.forEach((c, i) =>
    put(c.id, 320 + (i % cols) * (CARD_W + GAP_X), Math.floor(i / cols) * (CARD_H + GAP_Y)),
  );

  // Neighbours: whatever the rules add besides the children, left if it calls in, right
  // if it's called (so the opening layout and the rules agree on what's there).
  const { ids } = resolve(idx, diagram);
  const inside = new Set([objectId, ...descendants(idx, objectId)]);
  const left: string[] = [];
  const right: string[] = [];
  for (const id of ids) {
    if (placed.has(id)) continue;
    const calls = [...idx.connections.values()].some(
      (c) => inside.has(c.fromId) && isUnder(idx, c.toId, id),
    );
    (calls ? right : left).push(id);
  }
  const width = cols * (CARD_W + GAP_X);
  left.forEach((id, i) => put(id, 0, i * (CARD_H + GAP_Y)));
  right.forEach((id, i) => put(id, 320 + width + 120, i * (CARD_H + GAP_Y)));
  return { diagramId: diagram.id, ops };
}

/** `id` is `top` or inside it. */
function isUnder(idx: ModelIndex, id: string, top: string): boolean {
  let cur: string | null = id;
  while (cur) {
    if (cur === top) return true;
    cur = idx.objects.get(cur)?.parentId ?? null;
  }
  return false;
}

export function newDiagram(
  name: string,
  scopeId: string | null = null,
): { ops: Op[]; diagram: Diagram } {
  const diagram = makeDiagram({ name, scopeId });
  return { diagram, ops: [{ op: "diagram.put", diagram }] };
}

export type { ObjectKind };

/**
 * What "open inside" means for an object: open its diagram (it has an inside, or one is
 * already drawn), start one (an empty system or app: that makes a diagram), or nothing (a
 * person, a store, a component, someone else's system with nothing in it).
 */
/**
 * The code a running box runs, when it has no inside of its own: the top-level modules that
 * its process boundary also holds. A runtime tree (apps) and a code tree (modules) are
 * usually modelled apart, tied by the process that runs them; opening the app follows that.
 */
export function codeFor(idx: ModelIndex, objectId: string): string[] {
  if (idx.children.get(objectId)?.length || diagramForScope(idx, objectId)) return [];
  const o = idx.objects.get(objectId);
  if (!o || o.kind === "module" || o.kind === "function" || o.kind === "library") return [];
  const p = processOf(idx, objectId);
  if (!p) return [];
  const mods = [...idx.objects.values()].filter(
    (m) => m.kind === "module" && m.status !== "deprecated" && processOf(idx, m.id) === p,
  );
  const ids = new Set(mods.map((m) => m.id));
  return mods.filter((m) => !(m.parentId && ids.has(m.parentId))).map((m) => m.id);
}

/** Open the code a running box runs (codeFor): a view of it, scoped to the box, following the model. */
export function openCode(
  idx: ModelIndex,
  objectId: string,
  code: string[],
): { diagramId: string; ops: Op[] } {
  const scope = idx.objects.get(objectId);
  const diagram: Diagram = makeDiagram({
    name: `${scope?.name ?? "It"}: code`,
    scopeId: objectId,
    rules: { include: [{ ids: code }], exclude: [] },
  });
  const cols = Math.max(1, Math.ceil(Math.sqrt(code.length)));
  const ops: Op[] = [
    { op: "diagram.put", diagram },
    ...code.map((id, i): Op => ({
      op: "placement.put",
      placement: {
        diagramId: diagram.id,
        objectId: id,
        x: (i % cols) * (CARD_W + GAP_X),
        y: Math.floor(i / cols) * (CARD_H + GAP_Y),
        ...boxSize(idx.objects.get(id)?.kind ?? "module"),
      },
    })),
  ];
  return { diagramId: diagram.id, ops };
}

export function insideAction(idx: ModelIndex, objectId: string): "open" | "start" | null {
  const o = idx.objects.get(objectId);
  if (!o) return null;
  if (
    idx.children.get(objectId)?.length ||
    diagramForScope(idx, objectId) ||
    codeFor(idx, objectId).length
  )
    return "open";
  return !o.external && (o.kind === "system" || o.kind === "app") ? "start" : null;
}
