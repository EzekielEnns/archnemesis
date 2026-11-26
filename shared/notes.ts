// Notes and links for agents and the app alike: where a new one goes when nobody says
// (agents never send coordinates), titles from addresses, and a thread as plain text.
import { LINK_H, type DocLink, type Note, type Op } from "./model.ts";
import type { ModelState } from "./doc.ts";
import { descendants, notesOn, type ModelIndex } from "./project.ts";

export function hostOf(url?: string): string {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, "") : "";
  } catch {
    return "";
  }
}

/** A readable title from an address: "notion.so/RFC-12-Payment-retries-1a2b…" → "RFC 12 Payment retries". */
export function titleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() ?? "");
    const words = last
      .replace(/\.[a-z0-9]{2,5}$/i, "")
      .replace(/-?[0-9a-f]{32}$/i, "")
      .replace(/[-_+]+/g, " ")
      .trim();
    return words && !/^[0-9a-f-]{8,}$/i.test(words)
      ? words.slice(0, 120)
      : u.hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Where a link pinned to a box goes: under it, below the links already there. */
export function dockUnder(
  idx: ModelIndex,
  diagramId: string,
  objectId: string,
  except?: string,
): { objectId: string; x: number; y: number } {
  const box = idx.placements.get(diagramId)?.get(objectId);
  const below = [...idx.notes.values()]
    .filter(
      (n) =>
        n.diagramId === diagramId &&
        n.kind === "link" &&
        n.objectId === objectId &&
        n.id !== except,
    )
    .map((n) => n.y + LINK_H);
  return { objectId, x: 0, y: Math.max((box?.h ?? 0) + 14, ...below.map((b) => b + 8)) };
}

/**
 * Where a new note or link goes when no one says: a note on a box sits at its top-right
 * corner (fanned out if there are several), a link docks under the box; loose ones go in
 * a column to the right of everything on the diagram.
 */
export function spotFor(
  idx: ModelIndex,
  diagramId: string,
  kind: Note["kind"],
  objectId: string | null,
): { objectId: string | null; x: number; y: number } {
  const box = objectId ? idx.placements.get(diagramId)?.get(objectId) : undefined;
  if (box && objectId) {
    if (kind === "link") return dockUnder(idx, diagramId, objectId);
    const there = [...idx.notes.values()].filter(
      (n) =>
        n.diagramId === diagramId && n.kind === "note" && n.objectId === objectId && !n.resolved,
    ).length;
    return { objectId, x: box.w - 10 - there * 26, y: 6 };
  }
  const placed = [...(idx.placements.get(diagramId)?.values() ?? [])];
  const right = placed.length ? Math.max(...placed.map((p) => p.x + p.w)) + 60 : 0;
  const top = placed.length ? Math.min(...placed.map((p) => p.y)) : 0;
  const loose = notesOn(idx, diagramId, { resolved: true }).filter(
    (n) => !n.note.objectId && !n.note.connectionId && n.x >= right - 1,
  );
  const y = loose.length
    ? Math.max(...loose.map((n) => n.y + (n.note.kind === "link" ? LINK_H : 30))) + 16
    : top;
  return { objectId: null, x: right, y: kind === "link" ? y : y + 30 };
}

/** Every note and link on the design (or one view, or one box), as text an agent can read. */
/** When a note last changed hands: written, or last replied to. */
export function lastActivity(idx: ModelIndex, n: Note): string {
  const r = idx.replies.get(n.id) ?? [];
  return r.length ? [n.createdAt, ...r.map((x) => x.at)].sort().at(-1)! : n.createdAt;
}

/** Notes (and replies) others wrote after `since`: what an agent hasn't seen yet. */
export function newNotes(
  idx: ModelIndex,
  since: string,
  me: string,
): { notes: number; replies: number } {
  let notes = 0;
  let replies = 0;
  for (const n of idx.notes.values()) {
    if (n.kind !== "note") continue;
    if (n.createdAt > since && n.author.id !== me) notes++;
    for (const r of idx.replies.get(n.id) ?? []) if (r.at > since && r.author.id !== me) replies++;
  }
  return { notes, replies };
}

export function notesText(
  idx: ModelIndex,
  opts: {
    diagramId?: string;
    objectId?: string;
    forAgent?: boolean;
    resolved?: boolean;
    since?: string;
    url: (diagramId: string) => string;
  },
): string {
  // About an object: what's pinned to it or about it, and about anything inside it.
  const mine = opts.objectId ? new Set([opts.objectId, ...descendants(idx, opts.objectId)]) : null;
  // On a view: what's on it, and what's pinned to a box it draws (wherever the note sits).
  const drawn = opts.diagramId ? (idx.placements.get(opts.diagramId) ?? new Map()) : null;
  const keep = [...idx.notes.values()].filter(
    (n) =>
      (!opts.diagramId ||
        n.diagramId === opts.diagramId ||
        (n.kind === "note" && drawn!.has(n.about ?? n.objectId ?? ""))) &&
      (!opts.since || lastActivity(idx, n) > opts.since) &&
      (!mine || mine.has(n.about ?? n.objectId ?? "")) &&
      (!opts.forAgent || (n.kind === "note" && n.forAgent)) &&
      (n.kind === "link" || opts.resolved || !n.resolved),
  );
  if (!keep.length)
    return opts.since
      ? `Nothing new since ${opts.since}.`
      : opts.resolved
        ? "No notes or links."
        : "No open notes or links (pass resolved: true for resolved ones too).";
  const byView = new Map<string, Note[]>();
  for (const n of keep.sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const g = byView.get(n.diagramId);
    if (g) g.push(n);
    else byView.set(n.diagramId, [n]);
  }
  const on = (n: Note) => {
    const id = n.about ?? n.objectId;
    return id ? ` on ${idx.objects.get(id)?.name ?? "?"}` : "";
  };
  const when = (iso: string) => iso.slice(0, 16).replace("T", " ");
  const out: string[] = [];
  for (const [d, list] of byView) {
    out.push(`${idx.diagrams.get(d)?.name ?? d}: ${opts.url(d)}`);
    for (const n of list) {
      if (n.kind === "link") {
        out.push(`  link ${n.id}${on(n)}: ${n.text || hostOf(n.url)} <${n.url}>`);
        continue;
      }
      const elsewhere =
        opts.diagramId && n.diagramId !== opts.diagramId
          ? ` (left on ${idx.diagrams.get(n.diagramId)?.key ?? idx.diagrams.get(n.diagramId)?.name ?? "another view"}, on a box drawn here too)`
          : "";
      out.push(
        `  ${n.forAgent ? "flag" : "note"} ${n.id}${on(n)}${elsewhere}${n.resolved ? " (resolved)" : ""} · ${n.author.name}${n.author.kind === "agent" ? " (agent)" : ""}, ${when(n.createdAt)}`,
      );
      for (const line of n.text.split("\n")) out.push(`    ${line}`);
      for (const r of idx.replies.get(n.id) ?? []) {
        const [first, ...rest] = r.text.split("\n");
        out.push(
          `    ↳ ${r.author.name}${r.author.kind === "agent" ? " (agent)" : ""}, ${when(r.at)}: ${first}`,
        );
        for (const line of rest) out.push(`      ${line}`);
      }
    }
  }
  return out.join("\n");
}

/**
 * Links used to be notes on the canvas. Each one moves to its box's links (or, loose, its
 * diagram's), and the note goes. Empty when there's nothing left to move.
 */
export function linkNoteOps(state: ModelState): Op[] {
  const objects = new Map<string, DocLink[]>();
  const diagrams = new Map<string, DocLink[]>();
  const ops: Op[] = [];
  for (const n of state.notes.values()) {
    if (n.kind !== "link") continue;
    ops.push({ op: "note.delete", id: n.id });
    if (!n.url) continue;
    const l = { title: n.text || titleFromUrl(n.url), url: n.url };
    if (n.objectId && state.objects.has(n.objectId))
      objects.set(n.objectId, [
        ...(objects.get(n.objectId) ?? state.objects.get(n.objectId)!.links ?? []),
        l,
      ]);
    else if (state.diagrams.has(n.diagramId))
      diagrams.set(n.diagramId, [
        ...(diagrams.get(n.diagramId) ?? state.diagrams.get(n.diagramId)!.links ?? []),
        l,
      ]);
  }
  const uniq = (ls: DocLink[]) =>
    ls.filter((l, i) => ls.findIndex((x) => x.url === l.url) === i).slice(0, 50);
  const put: Op[] = [
    ...[...objects].map(([id, ls]): Op => ({
      op: "object.put",
      object: { ...state.objects.get(id)!, links: uniq(ls) },
    })),
    ...[...diagrams].map(([id, ls]): Op => ({
      op: "diagram.put",
      diagram: { ...state.diagrams.get(id)!, links: uniq(ls) },
    })),
  ];
  return ops.length ? [...put, ...ops] : [];
}
