// What changed between two versions of a design, in words a reviewer reads: "Added app
// Refunds in Shop", "Rearranged 3 boxes on Landscape". Used for a fork's pull request.
//
// Both sides are built from files (stateFromFiles), so objects' and views' ids are the
// files' keys and line up. Connections and flows get fresh ids each time, so they're matched
// by what they are: from, to and label; view and name.
import * as Y from "yjs";
import { applyOps, emptyState, fill, mirror, readState, type ModelState } from "./doc.ts";
import { readFiles, toOps } from "./files.ts";
import type { Connection, ModelObject } from "./model.ts";

/**
 * A design's state from its files (ids are keys). Files with problems still give a state:
 * whatever can't be applied (a view scoped to something missing, say) is left out, so a
 * pull request on a half-broken folder can still be described.
 */
export function stateFromFiles(files: Map<string, string>): ModelState {
  const { model } = readFiles(files);
  const doc = new Y.Doc();
  const state = emptyState();
  mirror(doc, state, () => {});
  const who = { id: "diff", name: "diff", kind: "system" } as const;
  const ops = toOps(state, model);
  try {
    applyOps(doc, state, ops, who, "load", "load", { pin: false });
  } catch {
    for (const op of ops) {
      try {
        applyOps(doc, state, [op], who, "load", "load", { pin: false });
      } catch {
        // skipped: refers to something the files don't have
      }
    }
  }
  const out = emptyState();
  fill(out, readState(doc));
  return out;
}

const FIELDS: [keyof ModelObject, string][] = [
  ["description", "description"],
  ["technology", "technology"],
  ["status", "status"],
  ["kind", "kind"],
  ["external", "external"],
  ["tags", "tags"],
  ["refs", "refs"],
  ["sources", "sources"],
];
const CONN_FIELDS: [keyof Connection, string][] = [
  ["name", "label"],
  ["description", "description"],
  ["technology", "technology"],
  ["status", "status"],
  ["viaId", "via"],
  ["sources", "sources"],
];
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The changes from `a` to `b`, most important first, one line each. */
export function describeChanges(a: ModelState, b: ModelState, protect: string[] = []): string[] {
  return changeList(a, b, protect).map((x) => x.t);
}

/** What a change is about, for the headline and the order: the design's boxes first, code next, libraries last. */
type Cat =
  | "protected"
  | "boxes"
  | "connections"
  | "flows"
  | "views"
  | "entities"
  | "boundaries"
  | "decisions"
  | "code"
  | "calls"
  | "libraries"
  | "layout";
const ORDER: Cat[] = [
  "protected",
  "boxes",
  "connections",
  "flows",
  "views",
  "entities",
  "boundaries",
  "decisions",
  "code",
  "calls",
  "libraries",
  "layout",
];
const catOf = (kind: string | undefined): Cat =>
  kind === "library" ? "libraries" : kind === "module" || kind === "function" ? "code" : "boxes";

/** The changes, each with what it's about (and the view or flow's name), most important first. */
export function changeList(
  a: ModelState,
  b: ModelState,
  protect: string[] = [],
): { t: string; cat: Cat; added: boolean; name?: string }[] {
  const out: { t: string; cat: Cat; added: boolean; name?: string; i: number }[] = [];
  let cat: Cat = "protected";
  let name: string | undefined;
  const put = (t: string) =>
    out.push({ t, cat, added: /^(Added|Connected|Recorded) /.test(t), name, i: out.length });
  // Fields archnm.yaml protects come first and say so: a person has to look at these.
  const fieldOf = (o: ModelObject, p: string): unknown =>
    p.startsWith("refs.")
      ? o.refs?.[p.slice(5)]
      : p === "in"
        ? o.parentId
        : (o as unknown as Record<string, unknown>)[p];
  for (const o of b.objects.values()) {
    const was = a.objects.get(o.id);
    if (!was) continue;
    for (const p of protect)
      if (!same(fieldOf(was, p) ?? null, fieldOf(o, p) ?? null))
        put(
          `⚠ Protected: changed ${o.name}'s ${p} (${JSON.stringify(fieldOf(was, p) ?? null)} → ${JSON.stringify(fieldOf(o, p) ?? null)})`,
        );
  }
  for (const o of a.objects.values())
    if (!b.objects.has(o.id) && protect.some((p) => fieldOf(o, p) !== undefined))
      put(
        `⚠ Protected: deleted ${o.name}, which has ${protect.filter((p) => fieldOf(o, p) !== undefined).join(", ")}`,
      );
  const nameIn = (s: ModelState, id: string | null) => (id ? (s.objects.get(id)?.name ?? id) : "");
  const obj = (s: ModelState, id: string) => nameIn(s, id);

  // Objects.
  for (const o of b.objects.values()) {
    cat = catOf(o.kind);
    const was = a.objects.get(o.id);
    if (!was) {
      put(`Added ${o.kind} ${o.name}${o.parentId ? ` in ${nameIn(b, o.parentId)}` : ""}`);
      continue;
    }
    if (was.name !== o.name) put(`Renamed ${was.name} to ${o.name}`);
    if (was.parentId !== o.parentId)
      put(`Moved ${o.name} ${o.parentId ? `into ${nameIn(b, o.parentId)}` : "to the top level"}`);
    if (was.status !== o.status && (o.status === "deprecated" || o.status === "removed"))
      put(`${o.status === "removed" ? "Marked removed" : "Deprecated"} ${o.name}`);
    const changed = FIELDS.filter(
      ([f]) =>
        !same(was[f] ?? null, o[f] ?? null) &&
        !(f === "status" && (o.status === "deprecated" || o.status === "removed")),
    ).map(([, l]) => l);
    if (changed.length) put(`Changed ${o.name}'s ${changed.join(", ")}`);
  }
  for (const o of a.objects.values())
    if (!b.objects.has(o.id)) ((cat = catOf(o.kind)), put(`Removed ${o.kind} ${o.name}`));

  // Connections, matched between the same two boxes: same label first, then whatever is
  // left over pairs up as a change (a relabel), and the rest were added or removed.
  const arrow = (s: ModelState, c: Connection) =>
    `${obj(s, c.fromId)} → ${obj(s, c.toId)}${c.name ? ` (${c.name})` : ""}`;
  const byEnds = (s: ModelState) => {
    const m = new Map<string, Connection[]>();
    for (const c of s.connections.values()) {
      const k = `${c.fromId}>${c.toId}`;
      m.set(k, [...(m.get(k) ?? []), c]);
    }
    return m;
  };
  const ca = byEnds(a);
  const cb = byEnds(b);
  for (const k of new Set([...ca.keys(), ...cb.keys()])) {
    // A line to a library is the library's; between code, code's.
    const ends = k.split(">").map((id) => (b.objects.get(id) ?? a.objects.get(id))?.kind);
    cat = ends.includes("library")
      ? "libraries"
      : ends.every((x) => x === "module" || x === "function")
        ? "calls"
        : "connections";
    const before = [...(ca.get(k) ?? [])];
    const after = [...(cb.get(k) ?? [])];
    const pairs: [Connection, Connection][] = [];
    for (const c of [...after]) {
      const i = before.findIndex((x) => x.name === c.name);
      if (i >= 0) {
        pairs.push([before[i]!, c]);
        before.splice(i, 1);
        after.splice(after.indexOf(c), 1);
      }
    }
    while (before.length && after.length) pairs.push([before.shift()!, after.shift()!]);
    for (const [was, c] of pairs) {
      const changed = CONN_FIELDS.filter(([f]) => !same(was[f], c[f])).map(([, l]) => l);
      if (changed.length) put(`Changed ${arrow(b, c)}: ${changed.join(", ")}`);
    }
    for (const c of after) put(`Connected ${arrow(b, c)}`);
    for (const c of before) put(`Disconnected ${arrow(a, c)}`);
  }

  // Views.
  cat = "views";
  for (const d of b.diagrams.values()) {
    name = d.name;
    const was = a.diagrams.get(d.id);
    if (!was) put(`Added view ${d.name}`);
    else {
      if (was.name !== d.name) put(`Renamed view ${was.name} to ${d.name}`);
      if (!same(was.rules ?? null, d.rules ?? null)) put(`Changed the rules of view ${d.name}`);
      if (was.scopeId !== d.scopeId)
        put(
          `View ${d.name} now shows ${d.scopeId ? `inside ${nameIn(b, d.scopeId)}` : "the whole model"}`,
        );
    }
  }
  for (const d of a.diagrams.values())
    if (!b.diagrams.has(d.id)) ((name = d.name), put(`Removed view ${d.name}`));
  name = undefined;
  cat = "layout";

  // Boxes on views, summed up per view.
  const per = new Map<string, { shown: number; hidden: number; moved: number; arrows: number }>();
  const tally = (d: string) =>
    per.get(d) ?? (per.set(d, { shown: 0, hidden: 0, moved: 0, arrows: 0 }), per.get(d)!);
  // Arrows reshaped by hand (shaped, changed or reset), on views both sides have.
  for (const k of new Set([...a.arrows.keys(), ...b.arrows.keys()])) {
    const shape = b.arrows.get(k) ?? a.arrows.get(k)!;
    if (
      a.diagrams.has(shape.diagramId) &&
      b.diagrams.has(shape.diagramId) &&
      !same(a.arrows.get(k), b.arrows.get(k))
    )
      tally(shape.diagramId).arrows++;
  }
  const key = (p: { diagramId: string; objectId: string }) => `${p.diagramId}\u0000${p.objectId}`;
  const before = new Map([...a.placements.values()].map((p) => [key(p), p]));
  const after = new Map([...b.placements.values()].map((p) => [key(p), p]));
  for (const [k, p] of after) {
    if (!a.diagrams.has(p.diagramId)) continue; // a new view: already said
    const was = before.get(k);
    if (!was) tally(p.diagramId).shown++;
    else if (was.x !== p.x || was.y !== p.y || was.w !== p.w || was.h !== p.h)
      tally(p.diagramId).moved++;
  }
  for (const [k, p] of before)
    if (!after.has(k) && b.diagrams.has(p.diagramId)) tally(p.diagramId).hidden++;
  for (const [d, t] of per) {
    const view = b.diagrams.get(d)?.name ?? d;
    if (t.shown) put(`Showed ${plural(t.shown, "box", "boxes")} on ${view}`);
    if (t.hidden) put(`Took ${plural(t.hidden, "box", "boxes")} off ${view}`);
    if (t.moved) put(`Rearranged ${plural(t.moved, "box", "boxes")} on ${view}`);
    if (t.arrows) put(`Reshaped ${plural(t.arrows, "arrow")} on ${view}`);
  }

  // Flows, matched by view and name; steps compared without their ids.
  const flows = (s: ModelState) =>
    new Map([...s.flows.values()].map((f) => [`${f.diagramId}>${f.name}`, f]));
  const steps = (f: { steps: { fromId: string; toId: string; text: string }[] }) =>
    f.steps.map((x) => [x.fromId, x.toId, x.text]);
  const fa = flows(a);
  const fb = flows(b);
  cat = "flows";
  for (const [k, f] of fb) {
    name = f.name;
    const was = fa.get(k);
    if (!was) put(`Added flow ${f.name}`);
    else if (!same(steps(was), steps(f))) put(`Changed flow ${f.name}`);
  }
  for (const [k, f] of fa) if (!fb.has(k)) ((name = f.name), put(`Removed flow ${f.name}`));
  name = undefined;
  cat = "boundaries";

  // Boundaries (projects, networks), by key.
  for (const x of b.boundaries.values()) {
    const was = a.boundaries.get(x.id);
    if (!was) put(`Added ${x.kind} boundary ${x.name}`);
    else if (!same({ ...was, createdAt: 0, updatedAt: 0 }, { ...x, createdAt: 0, updatedAt: 0 }))
      put(`Changed boundary ${x.name}`);
  }
  for (const x of a.boundaries.values())
    if (!b.boundaries.has(x.id)) put(`Removed boundary ${x.name}`);

  // Entities (DTOs, interfaces, enums).
  cat = "entities";
  for (const x of b.entities?.values() ?? []) {
    const was = a.entities?.get(x.id);
    if (!was) put(`Added entity ${x.name}${x.fields.length || x.values?.length ? "" : " (TBD)"}`);
    else if (!same({ ...was, createdAt: 0, updatedAt: 0 }, { ...x, createdAt: 0, updatedAt: 0 }))
      put(`Changed entity ${x.name}`);
  }
  for (const x of a.entities?.values() ?? [])
    if (!b.entities?.has(x.id)) put(`Removed entity ${x.name}`);

  // Decisions, by file name.
  cat = "decisions";
  for (const x of b.decisions.values()) {
    const was = a.decisions.get(x.id);
    if (!was) put(`Recorded decision ${x.id}: ${x.title} (${x.status})`);
    else if (was.status !== x.status) put(`Decision ${x.id} is now ${x.status}: ${x.title}`);
    else if (!same({ ...was, createdAt: 0, updatedAt: 0 }, { ...x, createdAt: 0, updatedAt: 0 }))
      put(`Changed decision ${x.id}: ${x.title}`);
  }
  for (const x of a.decisions.values())
    if (!b.decisions.has(x.id)) put(`Removed decision ${x.id}: ${x.title}`);

  return out
    .sort((x, y) => ORDER.indexOf(x.cat) - ORDER.indexOf(y.cat) || x.i - y.i)
    .map(({ i: _, ...x }) => x);
}

/** The headline of a change list: how many of each, with the views' and flows' names. */
export function changeHeadline(list: { cat: Cat; added: boolean; name?: string }[]): string {
  const said: Partial<Record<Cat, string>> = {
    boxes: "boxes",
    connections: "connections",
    flows: "flows",
    views: "views",
    entities: "entities",
    boundaries: "boundaries",
    decisions: "decisions",
    code: "files and functions",
    calls: "calls between code",
    libraries: "libraries",
    layout: "layout changes",
  };
  const parts: string[] = [];
  for (const c of ORDER) {
    const xs = list.filter((x) => x.cat === c);
    if (!xs.length || !said[c]) continue;
    const added = xs.filter((x) => x.added).length;
    const names =
      c === "views" || c === "flows" ? [...new Set(xs.map((x) => x.name).filter(Boolean))] : [];
    parts.push(
      `${said[c]}: ${added ? `${added} added` : ""}${added && xs.length > added ? ", " : ""}${xs.length > added ? `${xs.length - added} changed or removed` : ""}${names.length ? ` (${names.slice(0, 8).join(", ")}${names.length > 8 ? `, … ${names.length - 8} more` : ""})` : ""}`,
    );
  }
  return parts.join("; ");
}
