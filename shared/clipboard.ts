// Copy and paste on the canvas, as Archnemesis YAML: what's selected (and what's inside it), the
// connections between them, and where they sit relative to each other. The same idea as
// Excalidraw's clipboard (its elements as JSON, pasted back as new ones at the pointer), in the
// format the model files and agents already use, so YAML from an agent or a model file pastes
// too (without a layout, the boxes are laid out in a row).
import YAML from "yaml";
import { techList } from "./files.ts";
import {
  CARD_H,
  CARD_W,
  OBJECT_KINDS,
  REFERENCE_KINDS,
  boxSize,
  makeConnection,
  makeObject,
  mergedContext,
  safeUrl,
  type Column,
  type Connection,
  type DocLink,
  type ModelObject,
  type ObjectKind,
  type Op,
  type Reference,
} from "./model.ts";
import { titleFromUrl } from "./notes.ts";
import { descendants, type ModelIndex } from "./project.ts";

/** The first line of what's copied: how a paste knows it's ours. */
export const CLIP_HEAD = "# Archnemesis clipboard";

/** An object as a model file has it (keyed by its id, so no id here). */
interface ClipObject {
  kind: ObjectKind;
  name?: string;
  in?: string;
  tech?: string[] | string;
  external?: boolean;
  tags?: string[];
  path?: string;
  columns?: Column[];
  context?: string;
  references?: Record<string, string>[];
  notes?: string;
  signature?: string;
  guess?: boolean;
}
interface ClipConnection {
  from: string;
  to: string;
  label?: string;
  tech?: string;
  description?: string;
  column?: string;
  to_column?: string;
  both?: true;
  guess?: boolean;
}

/** The selection (with everything inside it that's on this diagram) as YAML. */
export function copyText(idx: ModelIndex, diagramId: string, ids: string[]): string | null {
  const placed = idx.placements.get(diagramId);
  const set = new Set<string>();
  for (const id of ids) {
    if (!idx.objects.has(id)) continue;
    set.add(id);
    for (const d of descendants(idx, id)) if (placed?.has(d)) set.add(d);
  }
  if (!set.size) return null;
  const objs = [...set].map((id) => idx.objects.get(id)!);
  const ref = (o: ModelObject) => o.key ?? o.id;
  const boxes = objs.flatMap((o) => (placed?.get(o.id) ? [placed.get(o.id)!] : []));
  const x0 = boxes.length ? Math.min(...boxes.map((b) => b.x)) : 0;
  const y0 = boxes.length ? Math.min(...boxes.map((b) => b.y)) : 0;
  const references = (o: ModelObject): { references?: Record<string, string>[] } => {
    const list = [
      ...(o.links ?? []).map((l) => ({ link: l.url, title: l.title })),
      // Entities belong to the design they're in: a copy doesn't take them along.
      ...(o.references ?? [])
        .filter((r) => r.kind !== "entity")
        .map((r) => ({
          [r.kind]: r.kind === "dependency" ? (idx.objects.get(r.to)?.key ?? r.to) : r.to,
          ...(r.title ? { title: r.title } : {}),
        })),
    ];
    return list.length ? { references: list } : {};
  };
  const objects: Record<string, ClipObject> = {};
  for (const o of objs) {
    const parent = o.parentId && set.has(o.parentId) ? idx.objects.get(o.parentId) : undefined;
    const context = mergedContext(o.description, o.context);
    objects[ref(o)] = {
      kind: o.kind,
      ...(o.name !== ref(o) ? { name: o.name } : {}),
      ...(parent ? { in: ref(parent) } : {}),
      ...(context ? { context } : {}),
      ...(o.technology ? { tech: techList(o.technology) } : {}),
      ...(o.external ? { external: true } : {}),
      ...(o.tags.length ? { tags: o.tags } : {}),
      ...(o.path ? { path: o.path } : {}),
      ...(o.signature ? { signature: o.signature } : {}),
      ...(o.columns?.length ? { columns: o.columns } : {}),
      ...references(o),
      ...(o.notes ? { notes: o.notes } : {}),
      ...(o.guess ? { guess: true } : {}),
    };
  }
  const connections: ClipConnection[] = [...idx.connections.values()]
    .filter((c) => set.has(c.fromId) && set.has(c.toId) && c.status !== "removed")
    .map((c) => ({
      from: ref(idx.objects.get(c.fromId)!),
      to: ref(idx.objects.get(c.toId)!),
      ...(c.name ? { label: c.name } : {}),
      ...(c.technology ? { tech: c.technology } : {}),
      ...(c.description ? { description: c.description } : {}),
      ...(c.column ? { column: c.column } : {}),
      ...(c.toColumn ? { to_column: c.toColumn } : {}),
      ...(c.guess ? { guess: true } : {}),
      ...(c.both ? { both: true } : {}),
    }));
  const layout: Record<string, { x: number; y: number; w: number; h: number }> = {};
  for (const o of objs) {
    const b = placed?.get(o.id);
    if (b)
      layout[ref(o)] = {
        x: Math.round(b.x - x0),
        y: Math.round(b.y - y0),
        w: Math.round(b.w),
        h: Math.round(b.h),
      };
  }
  const body = YAML.stringify(
    { objects, ...(connections.length ? { connections } : {}), layout },
    { lineWidth: 0 },
  );
  return `${CLIP_HEAD}\n${body}`;
}

/**
 * Ops that add what the text holds as new objects (fresh ids; nothing is merged into what's
 * there), placed with its top-left at `at`. Null when the text isn't Archnemesis YAML.
 * Things inside something that isn't copied go in `parentId` (the view's scope, or a box
 * they were pasted into), or the object the YAML names, when it exists here.
 */
export function pasteOps(
  idx: ModelIndex,
  diagramId: string,
  text: string,
  at: { x: number; y: number },
  parentId: string | null,
): { ops: Op[]; ids: string[] } | null {
  let doc: unknown;
  try {
    doc = YAML.parse(text);
  } catch {
    return null;
  }
  const raw = (doc as { objects?: unknown })?.objects;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  // Objects by id, as in a model file; kind in any case.
  const items = Object.entries(raw as Record<string, unknown>).flatMap(([id, o]) => {
    if (!o || typeof o !== "object" || Array.isArray(o)) return [];
    const it = o as ClipObject;
    const kind = String(it.kind ?? "").toLowerCase() as ObjectKind;
    return OBJECT_KINDS.includes(kind)
      ? [{ ...it, id, kind, name: typeof it.name === "string" && it.name.trim() ? it.name : id }]
      : [];
  });
  if (!items.length) return null;
  const layout = ((doc as { layout?: Record<string, unknown> }).layout ?? {}) as Record<
    string,
    { x?: unknown; y?: unknown; w?: unknown; h?: unknown }
  >;
  const byRef = new Map<string, string>(); // the YAML's id → the new object's id
  const existing = (r: string) => [...idx.objects.values()].find((o) => o.key === r || o.id === r);
  const made: ModelObject[] = [];
  for (const it of items) {
    const o = makeObject({
      kind: it.kind,
      name: it.name,
      description: typeof it.context === "string" ? it.context.replace(/\n$/, "") : "",
      technology:
        typeof it.tech === "string"
          ? techList(it.tech).join(", ")
          : Array.isArray(it.tech)
            ? it.tech.map(String).join(", ")
            : "",
      external: it.external === true,
      tags: Array.isArray(it.tags) ? it.tags.filter((t) => typeof t === "string") : [],
      ...(typeof it.path === "string" ? { path: it.path } : {}),
      ...(typeof it.signature === "string" && it.signature.trim()
        ? { signature: it.signature.trim().slice(0, 500) }
        : {}),
      ...(Array.isArray(it.columns) ? { columns: it.columns } : {}),
      ...pastedRefs(it.references, existing),
      ...(typeof it.notes === "string" && it.notes.trim()
        ? { notes: it.notes.slice(0, 50_000) }
        : {}),
      ...(it.guess === true ? { guess: true as const } : {}),
      parentId,
    });
    byRef.set(it.id, o.id);
    made.push(o);
  }
  // Parents: one copied along with it, else one that exists here, else where it's pasted.
  items.forEach((it, i) => {
    if (it.in == null) return;
    const r = String(it.in);
    made[i]!.parentId = byRef.get(r) ?? existing(r)?.id ?? parentId;
  });
  const ops: Op[] = made.map((object) => ({ op: "object.put", object }));
  // Where they go: as they sat when copied, else a row of boxes.
  let col = 0;
  items.forEach((it, i) => {
    const b = layout[it.id];
    const size = boxSize(it.kind);
    const num = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
    const box =
      b && num(b.x) && num(b.y)
        ? {
            x: at.x + b.x,
            y: at.y + b.y,
            w: num(b.w) ? b.w : size.w || CARD_W,
            h: num(b.h) ? b.h : size.h || CARD_H,
          }
        : {
            x: at.x + col++ * ((size.w || CARD_W) + 60),
            y: at.y,
            w: size.w || CARD_W,
            h: size.h || CARD_H,
          };
    ops.push({ op: "placement.put", placement: { diagramId, objectId: made[i]!.id, ...box } });
  });
  const conns = (doc as { connections?: unknown }).connections;
  if (Array.isArray(conns))
    for (const c of conns as ClipConnection[]) {
      const from = c && byRef.get(String(c.from));
      const to = c && byRef.get(String(c.to));
      if (!from || !to) continue;
      const fields: Partial<Connection> = {
        ...(typeof c.label === "string" ? { name: c.label } : {}),
        ...(typeof c.tech === "string" ? { technology: c.tech } : {}),
        ...(typeof c.description === "string" ? { description: c.description } : {}),
        ...(typeof c.column === "string" ? { column: c.column } : {}),
        ...(typeof c.to_column === "string" ? { toColumn: c.to_column } : {}),
        ...(c.guess === true ? { guess: true as const } : {}),
        ...(c.both === true ? { both: true as const } : {}),
      };
      ops.push({
        op: "connection.put",
        connection: makeConnection({ fromId: from, toId: to, ...fields }),
      });
    }
  return { ops, ids: made.map((o) => o.id) };
}

/** References from pasted YAML: links (http(s) only) and the rest; a dependency only on a library that's here. */
function pastedRefs(
  raw: unknown,
  existing: (r: string) => ModelObject | undefined,
): { links?: DocLink[]; references?: Reference[] } {
  if (!Array.isArray(raw)) return {};
  const links: DocLink[] = [];
  const references: Reference[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    if (!r || typeof r !== "object") continue;
    const title = typeof r.title === "string" ? r.title : undefined;
    const url = typeof r.link === "string" ? safeUrl(r.link) : null;
    if (url) {
      if (!links.some((l) => l.url === url)) links.push({ title: title || titleFromUrl(url), url });
      continue;
    }
    // Entities belong to the design they're in (and an entity reference is an id): not pasted.
    for (const k of REFERENCE_KINDS.filter((k) => k !== "entity")) {
      const to = r[k];
      if (typeof to !== "string" || !to.trim()) continue;
      if (k === "dependency") {
        const lib = existing(to);
        if (lib?.kind === "library")
          references.push({ kind: k, to: lib.id, ...(title ? { title } : {}) });
      } else if (k === "image" && /^[a-z]+:/i.test(to)) {
        const u = safeUrl(to);
        if (u) references.push({ kind: k, to: u, ...(title ? { title } : {}) });
      } else if (!(
        (k === "image" || k === "doc") &&
        (to.startsWith("/") || to.split("/").includes(".."))
      ))
        references.push({ kind: k, to: to.trim(), ...(title ? { title } : {}) });
      break;
    }
  }
  return { ...(links.length ? { links } : {}), ...(references.length ? { references } : {}) };
}

/** What a group made from a selection is: a store around tables, a folder around code, an app
 * around components, else a system. */
export function groupKind(kinds: ObjectKind[]): ObjectKind {
  if (kinds.length && kinds.every((k) => k === "table")) return "store";
  if (kinds.length && kinds.every((k) => k === "module" || k === "function")) return "module";
  if (kinds.length && kinds.every((k) => k === "component")) return "app";
  return "system";
}
