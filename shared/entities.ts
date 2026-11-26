// Entities: the shapes nodes point at (DTOs, interfaces, enums). A node uses one through an
// entity reference; a function's signature makes those by itself, and a type nobody has
// defined yet becomes a TBD entity (just a name) without stopping anyone. See
// docs/entities-plan.md.
import {
  TYPE_NAME,
  TYPE_NAME_RULE,
  isTbd,
  newId,
  now,
  type Connection,
  type Entity,
  type ModelObject,
  type Op,
  type Reference,
} from "./model.ts";
import type { ModelIndex } from "./project.ts";
import type { RefRow } from "./references.ts";

export { isTbd };

/** The entities a node points at, in the order it lists them. */
export function entitiesOf(idx: ModelIndex, o: ModelObject): Entity[] {
  return (o.references ?? []).flatMap((r) =>
    r.kind === "entity" && idx.entities.has(r.to) ? [idx.entities.get(r.to)!] : [],
  );
}

/** Every node that points at an entity. */
export function usersOf(idx: ModelIndex, entityId: string): ModelObject[] {
  return [...idx.objects.values()].filter(
    (o) =>
      o.status !== "removed" && o.references?.some((r) => r.kind === "entity" && r.to === entityId),
  );
}

/** Every connection that carries an entity (has it in its references). */
export function carriersOf(idx: ModelIndex, entityId: string): Connection[] {
  return [...idx.connections.values()].filter(
    (c) =>
      c.status !== "removed" && c.references?.some((r) => r.kind === "entity" && r.to === entityId),
  );
}

/** Capitalised names that are the language's own, not a design's shapes: wrappers are seen through. */
const BUILTIN = new Set(
  "String Str Self Vec Option Result Box Rc Arc HashMap HashSet BTreeMap Map Set List Array Promise Record Partial Readonly Uuid UUID DateTime Date Instant Duration Value Json JSON Bytes Error Number Boolean Object Any Unit Void Int Float Double Long Bool Char Byte Iterable Iterator Stream Future Task Optional Nullable".split(
    " ",
  ),
);

/** The design types a signature names: "(cart: Cart, UserId) -> Result<Order, ApiError>" → Cart, UserId, Order, ApiError. */
export function signatureTypes(sig: string | undefined): string[] {
  if (!sig) return [];
  const out: string[] = [];
  // A capitalised word that isn't an input's name (the word before a colon) or the language's own.
  for (const m of sig.matchAll(/\b([A-Z][A-Za-z0-9_]*)\b(?!\s*:(?!:))/g)) {
    const t = m[1]!;
    if (!BUILTIN.has(t) && !out.includes(t)) out.push(t);
  }
  return out;
}

/** A new entity: just a name until it gets fields (TBD), defined in `sourceId` if it's given.
 * The name is a type name (PaidOrder); anything else throws, with the rule. */
export function makeEntity(
  name: string,
  sourceId: string | null = null,
  fields: string[] = [],
): Entity {
  if (!TYPE_NAME.test(name)) throw new Error(`"${name}": ${TYPE_NAME_RULE}`);
  const t = now();
  return {
    id: newId("e"),
    name,
    fields,
    sourceId,
    description: "",
    createdAt: t,
    updatedAt: t,
  };
}

/** The entity with this name, if there is one. */
export const entityNamed = (idx: ModelIndex, name: string): Entity | undefined =>
  [...idx.entities.values()].find((e) => e.name === name);

/**
 * A node's new signature, with its links: an entity reference for each type it names (a TBD
 * entity made for a name nothing has yet), and the ones only the old signature named let go.
 * Entities it points at for other reasons are kept.
 */
export function signatureOps(
  idx: ModelIndex,
  o: ModelObject,
  signature: string | undefined,
): { ops: Op[]; references: Reference[] | undefined } {
  const ops: Op[] = [];
  const idOf = (name: string): string => {
    const e =
      entityNamed(idx, name) ??
      ops.flatMap((op) =>
        op.op === "entity.put" && op.entity.name === name ? [op.entity] : [],
      )[0];
    if (e) return e.id;
    const made = makeEntity(name);
    ops.push({ op: "entity.put", entity: made });
    return made.id;
  };
  const was = new Set(signatureTypes(o.signature).flatMap((n) => entityNamed(idx, n)?.id ?? []));
  const named = signatureTypes(signature).map(idOf);
  const refs = o.references ?? [];
  const kept = refs.filter((r) => r.kind !== "entity" || !was.has(r.to) || named.includes(r.to));
  const added = named
    .filter((id) => !kept.some((r) => r.kind === "entity" && r.to === id))
    .map((to): Reference => ({ kind: "entity", to }));
  const references = [...kept, ...added];
  // A TBD entity only the old signature named (a typo, a type renamed) goes with it: it has no
  // fields, no home, nothing else points at it, and no entity's field or parent names it.
  for (const id of was) {
    const e = idx.entities.get(id);
    if (!e || named.includes(id) || !isTbd(e) || e.sourceId) continue;
    if (usersOf(idx, id).some((u) => u.id !== o.id)) continue;
    const word = new RegExp(`\\b${e.name}\\b`);
    if (
      [...idx.entities.values()].some(
        (x) => x.extends?.includes(id) || x.fields.some((f) => word.test(f)),
      )
    )
      continue;
    ops.push({ op: "entity.delete", id });
  }
  return { ops, references: references.length ? references : undefined };
}

/** "PaidOrder : Order, Auditable" → its name and what it extends; `error` when a name isn't a type name. */
export function parseEntityName(raw: string): {
  name: string;
  extends: string[];
  error?: string;
} {
  const [name, rest] = raw.split(/\s*:(?!:)\s*/, 2) as [string, string | undefined];
  const out = {
    name: name.trim(),
    extends: (rest ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
  const bad = [out.name, ...out.extends].find((n) => !TYPE_NAME.test(n));
  return bad === undefined ? out : { ...out, error: `"${bad}": ${TYPE_NAME_RULE}` };
}

/** What kind of shape it is, from what it has: values make an enum, a method an interface. */
export function entityShape(
  e: Pick<Entity, "fields" | "values">,
): "TBD" | "enum" | "interface" | "type" {
  if (isTbd(e)) return "TBD";
  if (e.values?.length) return "enum";
  return e.fields.some((f) => /^\s*[\w$]+\(/.test(f)) ? "interface" : "type";
}

/** A field line as name and type, for the grid: "items [OrderItem]" → ["items", "[OrderItem]"]; a method (name( with no space) stays whole. */
export function splitField(line: string): [string, string] {
  const t = line.trim();
  if (/^[\w$]+\(/.test(t)) return [t, ""];
  const m = t.match(/^(\S+)\s+(.*)$/);
  return m ? [m[1]!, m[2]!.trim()] : [t, ""];
}

/** A node's entities as rows to draw beside it with its references (kind "entity", `at` its place in references). */
export function entityRows(idx: ModelIndex, o: Pick<ModelObject, "references">): RefRow[] {
  return (o.references ?? []).flatMap((r, at) => {
    const e = r.kind === "entity" ? idx.entities.get(r.to) : undefined;
    return e ? [{ kind: "entity" as const, to: e.id, title: e.name, at }] : [];
  });
}

/** What an entity is, in a few words: "TBD", "type · 3 fields", "enum · 2 values". */
export function entitySummary(e: Pick<Entity, "fields" | "values">): string {
  const shape = entityShape(e);
  if (shape === "TBD") return "TBD";
  const n = e.values?.length ?? e.fields.length;
  return `${shape} · ${n} ${e.values?.length ? "value" : "field"}${n === 1 ? "" : "s"}`;
}

/**
 * The type being typed at the cursor in a signature: a capitalised word the cursor is at the end
 * of, after the "(" (so a name like Cart::total isn't one). "(cart: Ca|" → {word: "Ca", start: 12}.
 */
export function typeAt(text: string, cursor: number): { word: string; start: number } | null {
  const before = text.slice(0, cursor);
  const m = /(^|[^A-Za-z0-9_])([A-Z][A-Za-z0-9_]*)$/.exec(before);
  if (!m || /^[A-Za-z0-9_]/.test(text.slice(cursor))) return null;
  const start = cursor - m[2]!.length;
  if (!text.slice(0, start).includes("(")) return null;
  return { word: m[2]!, start };
}

/** Entities to suggest for a half-typed type: names starting with it first, then containing it; the most used first. */
export function suggestTypes(idx: ModelIndex, word: string, limit = 6): Entity[] {
  const w = word.toLowerCase();
  const uses = (e: Entity) => usersOf(idx, e.id).length;
  // Not the one already typed in full: there's nothing to complete.
  const all = [...idx.entities.values()].filter((e) => e.name !== word);
  const starts = all.filter((e) => e.name.toLowerCase().startsWith(w));
  const has = all.filter(
    (e) => !e.name.toLowerCase().startsWith(w) && e.name.toLowerCase().includes(w),
  );
  const rank = (a: Entity, b: Entity) => uses(b) - uses(a) || a.name.localeCompare(b.name);
  return [...starts.sort(rank), ...has.sort(rank)].slice(0, limit);
}

/** Put a picked name in place of the word being typed; the cursor goes after it. */
export function completeType(
  text: string,
  at: { word: string; start: number },
  name: string,
): { text: string; cursor: number } {
  return {
    text: text.slice(0, at.start) + name + text.slice(at.start + at.word.length),
    cursor: at.start + name.length,
  };
}
