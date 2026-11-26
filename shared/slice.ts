// One view, cut out of a design with what it shows, so it can be moved: files of just that
// view and its boxes (and what's inside them), ready for write into another design.
import { emptyState, type ModelState } from "./doc.ts";
import { ancestors, descendants, type ModelIndex } from "./project.ts";
import { resolve } from "./views.ts";

export function viewSlice(
  state: ModelState,
  idx: ModelIndex,
  diagramId: string,
  opts: { deep?: boolean } = {},
): ModelState {
  const d = idx.diagrams.get(diagramId);
  const out = emptyState();
  if (!d) return out;
  const shown = new Set<string>();
  for (const p of state.placements.values()) if (p.diagramId === diagramId) shown.add(p.objectId);
  if (d.rules) for (const id of resolve(idx, d).ids) shown.add(id);
  if (d.scopeId) shown.add(d.scopeId);
  const keep = new Set<string>();
  for (const id of shown) {
    keep.add(id);
    // What it's in, so `in` still points somewhere; what's inside it, so it still opens.
    for (const a of ancestors(idx, id)) keep.add(a);
    if (opts.deep !== false) for (const c of descendants(idx, id)) keep.add(c);
  }
  for (const id of keep) {
    const o = state.objects.get(id);
    if (o) out.objects.set(id, o);
  }
  for (const [k, c] of state.connections)
    if (keep.has(c.fromId) && keep.has(c.toId)) out.connections.set(k, c);
  out.diagrams.set(d.id, d);
  for (const [k, p] of state.placements)
    if (p.diagramId === diagramId && keep.has(p.objectId)) out.placements.set(k, p);
  for (const [k, f] of state.flows) if (f.diagramId === diagramId) out.flows.set(k, f);
  for (const [k, a] of state.arrows) if (a.diagramId === diagramId) out.arrows.set(k, a);
  // The entities it uses, defined in full (and what they extend), and the ones its boxes define:
  // a box points at an entity by name, and that name has to be defined in the files.
  const want: string[] = [];
  for (const x of [...out.objects.values(), ...out.connections.values()])
    for (const r of x.references ?? []) if (r.kind === "entity") want.push(r.to);
  for (const e of state.entities.values()) if (e.sourceId && keep.has(e.sourceId)) want.push(e.id);
  for (let id = want.pop(); id !== undefined; id = want.pop()) {
    const e = state.entities.get(id);
    if (!e || out.entities.has(id)) continue;
    out.entities.set(id, e);
    want.push(...(e.extends ?? []));
  }
  return out;
}
