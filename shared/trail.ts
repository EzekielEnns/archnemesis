// Where someone went in a design, and how: the record behind "I get lost drilling in".
// The page records moves (opt-in, per browser) and sends them to the server; `trail` reads
// them back, names the views, and points at the moves that look like being lost.
import type { ModelIndex as Index } from "./project";

/** How a move was made. */
export type How =
  | "open" // double-click or Enter on a box: into what's inside it
  | "up" // the up arrow or ⌘↑
  | "home" // the house: the top level
  | "crumb" // a level in the breadcrumb
  | "sibling" // the breadcrumb's list of other views at this level
  | "sidebar" // the drawer's list of views, or a box picked in it
  | "search" // ⌘K
  | "panel" // a link in the box or arrow panel (a connection, another view)
  | "back" // the panel's back trail, or "jump back"
  | "note" // opening a note
  | "follow" // following someone
  | "guide" // an agent's pointer
  | "new" // a view just made
  | "history" // the browser's back/forward, or a pasted link
  | "other";

export interface TrailEvent {
  at: string;
  /** "move" between views (or to a box), or something that went nowhere. */
  kind: "move" | "dead-end" | "mark" | "edit";
  how?: How;
  from?: { d: string | null; o: string | null };
  to?: { d: string | null; o: string | null };
  /** Opening it made a new view (there wasn't one for what was opened). */
  created?: boolean;
  /** dead-end: the box that had nothing inside. */
  object?: string;
  /** mark: what the person wrote ("trying to find where invites are sent"). */
  text?: string;
  /** edit: its history label ("connect A → B", "undo"), and how many of each op. */
  label?: string;
  ops?: Record<string, number>;
  /** mark, edit: the view it happened on. */
  on?: string | null;
  /** What the view arrived at showed: boxes and lines. */
  boxes?: number;
}

export interface TrailRow {
  session: string;
  user: string;
  doc: string;
  event: TrailEvent;
}

const secs = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 1000;

/** The view's name and how deep it is (0 = the landscape). */
function viewLabel(idx: Index, id: string | null | undefined): { name: string; depth: number } {
  if (!id) return { name: "(none)", depth: 0 };
  const d = idx.diagrams.get(id);
  if (!d) return { name: `(deleted view ${id})`, depth: 0 };
  let depth = 0;
  for (
    let cur = d.scopeId ? idx.objects.get(d.scopeId) : undefined;
    cur;
    cur = cur.parentId ? idx.objects.get(cur.parentId) : undefined
  )
    depth++;
  return { name: d.key ?? d.name, depth };
}

/** Findings: patterns that look like someone lost. */
export function trailFindings(rows: TrailRow[], idx: Index): string[] {
  const out: string[] = [];
  const bySession = new Map<string, TrailRow[]>();
  for (const r of rows) bySession.set(r.session, [...(bySession.get(r.session) ?? []), r]);
  let bounces = 0;
  let upChains = 0;
  let deadEnds = 0;
  let created = 0;
  let searchAfterDrill = 0;
  let quickLeave = 0;
  const visits = new Map<string, number>();
  for (const list of bySession.values()) {
    const moves = list.filter((r) => r.event.kind === "move");
    let ups = 0;
    let opens = 0;
    for (let i = 0; i < list.length; i++) {
      const e = list[i]!.event;
      if (e.kind === "dead-end") deadEnds++;
      if (e.kind !== "move") continue;
      if (e.how === "search" && opens >= 2) searchAfterDrill++;
      if (e.created) created++;
      if (e.to?.d) visits.set(e.to.d, (visits.get(e.to.d) ?? 0) + 1);
      if (e.how === "up") (ups++, ups === 3 && upChains++);
      else ups = 0;
      if (e.how === "open") opens++;
      else if (e.how === "home" || e.how === "search") opens = 0;
    }
    for (let i = 1; i < moves.length; i++) {
      const a = moves[i - 1]!.event;
      const b = moves[i]!.event;
      if (a.from?.d && a.to?.d !== a.from.d && b.to?.d === a.from.d && secs(a.at, b.at) < 20)
        bounces++;
      if (a.to?.d !== a.from?.d && secs(a.at, b.at) < 4) quickLeave++;
    }
  }
  // Building by hand: undos straight after an edit (a mistake), long pauses between edits.
  let edits = 0;
  let undos = 0;
  let quickUndo = 0;
  const undone: string[] = [];
  let stalls = 0;
  for (const list of bySession.values()) {
    let lastEdit: TrailEvent | null = null;
    for (const r of list) {
      const e = r.event;
      if (e.kind !== "edit") continue;
      if (e.label === "undo") {
        undos++;
        if (
          lastEdit &&
          lastEdit.label !== "undo" &&
          lastEdit.label !== "redo" &&
          secs(lastEdit.at, e.at) < 15
        )
          (quickUndo++, undone.push(lastEdit.label ?? "?"));
      } else if (e.label !== "redo") {
        edits++;
        if (lastEdit && secs(lastEdit.at, e.at) > 90 && lastEdit.on === e.on) stalls++;
      }
      lastEdit = e;
    }
  }
  if (edits) out.push(`${edits} edit(s) by hand, ${undos} undo(s).`);
  if (quickUndo)
    out.push(
      `${quickUndo} edit(s) undone within 15 s, a sign the tool did something unexpected: ${[...new Set(undone)].slice(0, 6).join("; ")}.`,
    );
  if (stalls)
    out.push(
      `${stalls} pause(s) over 90 s between edits on the same view: stuck working out how to do the next thing?`,
    );
  if (bounces)
    out.push(
      `${bounces} bounce(s): into a view and straight back out within 20 s. The box's name didn't say what was inside, or the inside wasn't what was wanted.`,
    );
  if (quickLeave)
    out.push(`${quickLeave} view(s) left within 4 s of arriving: not the view that was expected.`);
  if (upChains)
    out.push(
      `${upChains} time(s) went up 3+ levels in a row: deep and climbing back out, a sign the way across was missing.`,
    );
  if (deadEnds)
    out.push(`${deadEnds} double-click(s) on a box with nothing inside: it looked openable.`);
  if (created)
    out.push(
      `${created} open(s) made a brand-new view on the spot: there was no view for that box yet.`,
    );
  if (searchAfterDrill)
    out.push(
      `${searchAfterDrill} search(es) after drilling 2+ levels: gave up on clicking through.`,
    );
  const top = [...visits.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .filter(([, n]) => n >= 3);
  if (top.length)
    out.push(
      `Most revisited: ${top.map(([d, n]) => `${viewLabel(idx, d).name} (${n}×)`).join(", ")}: a hub people come back to, so its exits matter most.`,
    );
  return out;
}

/** The trail as text, one line per move, for a person or an agent. */
export function trailText(rows: TrailRow[], idx: Index): string {
  if (!rows.length)
    return 'No trail recorded. It\'s off by default: ⌘K → "Record my navigation" in the browser you use.';
  const name = (id: string | null | undefined) => (id ? (idx.objects.get(id)?.name ?? id) : "");
  const lines: string[] = [];
  let session = "";
  let prev = "";
  for (const r of rows) {
    const e = r.event;
    if (r.session !== session) {
      session = r.session;
      lines.push(
        "",
        `session ${session.slice(0, 8)} (${r.user}, ${r.doc}), from ${e.at.slice(0, 16).replace("T", " ")}`,
      );
      prev = e.at;
    }
    const dt = Math.round(secs(prev, e.at));
    prev = e.at;
    const t = `  +${String(dt).padStart(3)}s`;
    if (e.kind === "dead-end") lines.push(`${t}  ✗ nothing inside ${name(e.object)}`);
    else if (e.kind === "mark")
      lines.push(`${t}  ★ "${e.text ?? ""}" (on ${viewLabel(idx, e.on).name})`);
    else if (e.kind === "edit") {
      const ops = Object.entries(e.ops ?? {})
        .map(([k, n]) => `${n} ${k}`)
        .join(", ");
      lines.push(`${t}  ✎ ${e.label ?? "?"}${ops ? ` [${ops}]` : ""}`);
    } else {
      const from = viewLabel(idx, e.from?.d);
      const to = viewLabel(idx, e.to?.d);
      const same = e.from?.d === e.to?.d;
      const target = same
        ? `(same view) → ${name(e.to?.o) || "?"}`
        : `${from.name} [${from.depth}] → ${to.name} [${to.depth}]${e.to?.o ? ` at ${name(e.to.o)}` : ""}`;
      lines.push(
        `${t}  ${(e.how ?? "?").padEnd(7)} ${target}${e.created ? " (new view)" : ""}${e.boxes !== undefined ? `, ${e.boxes} boxes` : ""}`,
      );
    }
  }
  const f = trailFindings(rows, idx);
  const marks = rows.filter((r) => r.event.kind === "mark");
  const head = marks.length
    ? [
        "",
        `Marked as confusing (${marks.length}): what they were trying to do, worth reading first:`,
        ...marks.map(
          (r) =>
            `- ${r.event.at.slice(0, 16).replace("T", " ")} on ${viewLabel(idx, r.event.on).name}: ${r.event.text ?? ""}`,
        ),
      ]
    : [];
  return [
    `${rows.length} events. [n] is depth: 0 is the top level. ★ marks the person's own "this is confusing", ✎ an edit.`,
    ...head,
    ...lines,
    "",
    "Looks like being lost:",
    ...(f.length ? f.map((x) => `- ${x}`) : ["- nothing stands out"]),
  ].join("\n");
}
