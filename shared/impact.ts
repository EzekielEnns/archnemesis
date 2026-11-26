// What depends on a box, and what it depends on, however many hops away: the "what breaks
// if this goes down" question. Upstream: whoever calls it, anything inside it, or what it
// sits in (a call to app-service may well reach the component in it); then whoever calls
// them, and so on. Downstream mirrors it: what it, or anything inside it, calls.
import type { Connection } from "./model.ts";
import { ancestors, descendants, type ModelIndex } from "./project.ts";

/** upstream: what depends on it (calls it, directly or through others). downstream: what it depends on. */
export type ImpactWay = "upstream" | "downstream";

export interface Reached {
  id: string;
  /** 1: connected to it directly. */
  hops: number;
  /** The connection it was reached through. */
  via: Connection;
}

export function impact(idx: ModelIndex, id: string, way: ImpactWay): Reached[] {
  const self = new Set([id, ...descendants(idx, id)]);
  const near = (c: Connection) => (way === "upstream" ? c.toId : c.fromId);
  const far = (c: Connection) => (way === "upstream" ? c.fromId : c.toId);
  const byNear = new Map<string, Connection[]>();
  for (const c of idx.connections.values())
    byNear.set(near(c), [...(byNear.get(near(c)) ?? []), c]);
  const out = new Map<string, Reached>();
  // Where a reached box's connections are looked for.
  const around = (x: string) =>
    way === "upstream" ? [x, ...ancestors(idx, x)] : [x, ...descendants(idx, x)];
  let frontier = [...self, ...(way === "upstream" ? ancestors(idx, id) : [])];
  for (let hops = 1; frontier.length; hops++) {
    const next: string[] = [];
    const seen = new Set<string>();
    for (const at of frontier.flatMap((x) => (hops === 1 ? [x] : around(x))))
      for (const c of seen.has(at) ? [] : (seen.add(at), byNear.get(at) ?? [])) {
        const f = far(c);
        if (self.has(f) || out.has(f)) continue;
        out.set(f, { id: f, hops, via: c });
        next.push(f);
      }
    frontier = next;
  }
  return [...out.values()];
}
