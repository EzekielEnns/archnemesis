// read {diff}: what a fork changed against its main, for whoever manages the agents writing to
// it. Grouped (boxes, connections, entities, views), each line added / changed (with the
// fields) / removed, with a ref that works in the other tools; capped, with counts. `in`
// keeps one box's subtree; `by` keeps what one agent session (or worker name) touched.
//
// Both sides go through the files, so they line up by key whatever the ids are.
import type { ModelState } from "../doc.ts";
import { readFiles, writeFiles, type FConnection, type FileModel } from "../files.ts";
import { ToolError, ok, plural, type Host, type Out } from "./host.ts";
import { matchesBy } from "./refs.ts";
import { changedWithContext } from "../whatsnew.ts";

type Rec = Record<string, unknown>;
interface Item {
  ref: string;
  sign: "+" | "~" | "-";
  line: string;
  /** The box it's about, for in: (a box itself, a connection's ends, an entity's box, a view's scope). */
  under: string[];
  /** State ids it could be logged under, for by:. */
  ids: string[];
}

const connRef = (c: FConnection) => `${c.from}>${c.to}${c.label ? `:${c.label}` : ""}`;
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const short = (v: unknown) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s === undefined ? "—" : s.length > 40 ? `${s.slice(0, 37)}…` : s;
};

/** What changed between two records: each field, with the value when it's short. */
function fields(a: Rec, b: Rec, skip: string[] = []): string {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(
    (k) => !skip.includes(k) && !same(a[k], b[k]),
  );
  return keys
    .map((k) => {
      const x = a[k];
      const y = b[k];
      const small = (v: unknown) =>
        v === undefined ||
        typeof v === "boolean" ||
        typeof v === "number" ||
        (typeof v === "string" && v.length <= 40 && !v.includes("\n"));
      return small(x) && small(y) ? `${k} (${short(x)} → ${short(y)})` : k;
    })
    .join(", ");
}

const modelOf = (state: ModelState, host: Host): FileModel =>
  readFiles(writeFiles(state, host.config())).model;

/** What a fork added or changed, for a lens to look at only that: boxes (ids here) and views (keys). Null when it isn't a fork. */
export interface ForkFocus {
  objects: Set<string>;
  views: Set<string>;
  /** What it's compared with: "its main", or the fork it's stacked on. */
  against: string;
}
export async function forkFocus(host: Host): Promise<ForkFocus | null> {
  if (!host.branch || !host.base) return null;
  const baseState = await host.base();
  if (!baseState) return null;
  const now = host.state();
  const w = changedWithContext(baseState, now);
  const objects = new Set(w.changed);
  // A new connection is about its ends (a finding about it names them).
  for (const id of w.addedConnections ?? []) {
    const c = now.connections.get(id);
    if (c) (objects.add(c.fromId), objects.add(c.toId));
  }
  // A view as its file has it: its settings, its flows, and the boxes picked for it (writing out and reading back the whole design, twice, on every lens took seconds).
  const sigs = (s: ModelState) => {
    const flows = new Map<string, unknown[]>();
    for (const f of s.flows.values())
      flows.set(f.diagramId, [
        ...(flows.get(f.diagramId) ?? []),
        { n: f.name, k: f.kind, s: f.steps.map((x) => [x.fromId, x.toId, x.text]) },
      ]);
    const boxes = new Map<string, string[]>();
    for (const p of s.placements.values())
      boxes.set(p.diagramId, [...(boxes.get(p.diagramId) ?? []), p.objectId]);
    const out = new Map<string, string>();
    for (const d of s.diagrams.values()) {
      const {
        updatedAt: _u,
        createdAt: _c,
        ...rest
      } = d as typeof d & { updatedAt?: string; createdAt?: string };
      out.set(
        d.key ?? d.id,
        JSON.stringify([
          rest,
          flows.get(d.id) ?? [],
          d.rules ? [] : (boxes.get(d.id) ?? []).sort(),
        ]),
      );
    }
    return out;
  };
  const was = sigs(baseState);
  const views = new Set([...sigs(now)].filter(([k, v]) => was.get(k) !== v).map(([k]) => k));
  const parent = host.baseName?.() ?? null;
  return { objects, views, against: parent ? `${parent} (the fork it's stacked on)` : "its main" };
}

export async function diff(
  host: Host,
  a: { in?: string; by?: string; limit?: number },
): Promise<Out> {
  if (!host.branch || !host.base)
    throw new ToolError(
      `${host.key} isn't a fork, so there's nothing to compare it with: diff is for a fork against its main (design {action: "list"} shows forks)`,
    );
  const baseState = await host.base();
  if (!baseState) throw new ToolError(`couldn't read ${host.key}'s main to compare with`);
  const was = modelOf(baseState, host);
  const now = modelOf(host.state(), host);
  const limit = Math.max(1, Math.min(a.limit ?? 20, 500));

  // State ids by key, both sides, so by: can match the history's ids.
  const objId = new Map<string, string[]>();
  for (const s of [baseState, host.state()])
    for (const o of s.objects.values())
      objId.set(o.key ?? o.id, [...(objId.get(o.key ?? o.id) ?? []), o.id]);
  const viewId = new Map<string, string[]>();
  for (const s of [baseState, host.state()])
    for (const d of s.diagrams.values())
      viewId.set(d.key ?? d.id, [...(viewId.get(d.key ?? d.id) ?? []), d.id]);
  const connIds = new Map<string, string[]>();
  for (const s of [baseState, host.state()]) {
    const key = (id: string) => s.objects.get(id)?.key ?? id;
    for (const c of s.connections.values()) {
      const r = `${key(c.fromId)}>${key(c.toId)}${c.name ? `:${c.name}` : ""}`;
      connIds.set(r, [...(connIds.get(r) ?? []), c.id]);
    }
  }
  const entId = new Map<string, string[]>();
  for (const s of [baseState, host.state()])
    for (const e of s.entities.values()) entId.set(e.name, [...(entId.get(e.name) ?? []), e.id]);

  const groups: { name: string; items: Item[] }[] = [];
  const pair = <T extends object>(
    name: string,
    as: T[],
    bs: T[],
    key: (x: T) => string,
    line: (x: T) => string,
    under: (x: T) => string[],
    ids: (k: string) => string[],
    skip: string[] = [],
  ) => {
    const A = new Map(as.map((x) => [key(x), x]));
    const B = new Map(bs.map((x) => [key(x), x]));
    const items: Item[] = [];
    for (const [k, x] of B) {
      const old = A.get(k);
      if (!old) items.push({ ref: k, sign: "+", line: line(x), under: under(x), ids: ids(k) });
      else if (
        !same(
          { ...old, ...Object.fromEntries(skip.map((s) => [s, 0])) },
          { ...x, ...Object.fromEntries(skip.map((s) => [s, 0])) },
        )
      ) {
        const f = fields(old as Rec, x as Rec, skip);
        if (f)
          items.push({
            ref: k,
            sign: "~",
            line: `${k}: ${f}`,
            under: [...under(old), ...under(x)],
            ids: ids(k),
          });
      }
    }
    for (const [k, x] of A)
      if (!B.has(k)) items.push({ ref: k, sign: "-", line: line(x), under: under(x), ids: ids(k) });
    groups.push({ name, items });
  };

  pair(
    "boxes",
    was.objects,
    now.objects,
    (o) => o.id,
    (o) => `${o.id} (${o.kind})${o.in ? ` in ${o.in}` : ""}`,
    (o) => [o.id],
    (k) => objId.get(k) ?? [],
  );
  pair(
    "connections",
    was.connections,
    now.connections,
    connRef,
    (c) => `${connRef(c)}${c.tech ? ` (${c.tech})` : ""}`,
    (c) => [c.from, c.to],
    (k) => connIds.get(k) ?? [],
  );
  pair(
    "entities",
    was.entities,
    now.entities,
    (e) => e.id,
    (e) => `${e.id}${e.in ? ` in ${e.in}` : ""}`,
    (e) => (e.in ? [e.in] : []),
    (k) => entId.get(k) ?? [],
  );
  pair(
    "views",
    was.views,
    now.views,
    (v) => v.key,
    (v) => `view:${v.key}  ${v.name}${v.scope ? ` (inside ${v.scope})` : ""}`,
    (v) => (v.scope ? [v.scope] : []),
    (k) => viewId.get(k) ?? [],
  );
  // Decisions too, as propose lists them (a decision's id is its file name on both sides).
  pair(
    "decisions",
    was.decisions,
    now.decisions,
    (d) => d.id,
    (d) => `decision:${d.id}  "${d.title}" (${d.status})`,
    (d) => d.affects ?? [],
    (k) => [k],
  );

  // in: one box's subtree, by the tree on either side.
  let within: Set<string> | null = null;
  if (a.in) {
    const parent = new Map<string, string>();
    for (const o of [...was.objects, ...now.objects]) if (o.in) parent.set(o.id, o.in);
    if (![...was.objects, ...now.objects].some((o) => o.id === a.in))
      throw new ToolError(`no box ${a.in} on ${host.key} or its main`);
    const inside = (id: string) => {
      for (let cur: string | undefined = id, n = 0; cur && n < 100; cur = parent.get(cur), n++)
        if (cur === a.in) return true;
      return false;
    };
    within = new Set([...was.objects, ...now.objects].map((o) => o.id).filter(inside));
  }
  // by: what that session's history touched.
  // Something added counts as theirs only if they made it (the first change to it was theirs);
  // changed or removed, if they touched it at all.
  let touched: Set<string> | null = null;
  let made: Set<string> | null = null;
  if (a.by) {
    const log = host.recent?.(100_000) ?? [];
    const entries = log.filter((e) => matchesBy(e.actor, a.by!));
    if (!entries.length)
      throw new ToolError(
        `no changes by ${a.by} on ${host.key}; read {history: true} shows who did what`,
      );
    touched = new Set(entries.flatMap((e) => e.ids));
    const first = new Map<string, boolean>();
    for (const e of log)
      for (const id of e.ids) if (!first.has(id)) first.set(id, matchesBy(e.actor, a.by!));
    made = new Set([...first].filter(([, mine]) => mine).map(([id]) => id));
  }
  const theirs = (it: Item) =>
    !touched || it.ids.some((i) => (it.sign === "+" ? made! : touched!).has(i));
  for (const g of groups)
    g.items = g.items.filter(
      (it) => (!within || it.under.some((u) => within!.has(u))) && theirs(it),
    );

  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const filters = [a.in ? `in ${a.in}` : "", a.by ? `by ${a.by}` : ""].filter(Boolean).join(", ");
  const parent = host.baseName?.() ?? null;
  const head = `${host.key} against ${parent ? `${parent} (the fork it's stacked on)` : "its main"}${filters ? ` (${filters})` : ""}: `;
  if (!total)
    return ok(
      `${head}no changes (compared ${plural(now.objects.length, "box", "boxes")}, ${plural(now.connections.length, "connection")}, ${plural(now.entities.length, "entity", "entities")}, ${plural(now.views.length, "view")}).`,
      { total: 0 },
    );
  const count = (g: { items: Item[] }) =>
    (["+", "~", "-"] as const)
      .map((s) => [s, g.items.filter((i) => i.sign === s).length] as const)
      .filter(([, n]) => n)
      .map(([s, n]) => `${s}${n}`)
      .join(" ");
  const out = [
    head +
      groups
        .filter((g) => g.items.length)
        .map((g) => `${g.name} ${count(g)}`)
        .join(", "),
  ];
  for (const g of groups) {
    if (!g.items.length) continue;
    const order = { "+": 0, "~": 1, "-": 2 };
    const sorted = [...g.items].sort(
      (x, y) => order[x.sign] - order[y.sign] || x.ref.localeCompare(y.ref),
    );
    out.push(
      `${g.name} (${g.items.length}):`,
      ...sorted.slice(0, limit).map((i) => `  ${i.sign} ${i.line}`),
    );
    if (sorted.length > limit)
      out.push(
        `  … ${sorted.length - limit} more: read {diff: true${a.in ? `, in: "${a.in}"` : ""}${a.by ? `, by: "${a.by}"` : ""}, limit: ${sorted.length}}`,
      );
  }
  out.push(
    'Look closer: read {ref}; who did it: read {history: true, by}. Ready: design {action: "propose"}.',
  );
  return ok(out.join("\n"), { total });
}
