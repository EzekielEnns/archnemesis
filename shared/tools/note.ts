// note: threads on anything, for people and for other agents. A flag says something's wrong
// or missing; a claim is what an agent learned about a box it doesn't own (a field, the value
// it believes, the evidence), left for that box's owner to accept or reject.
import { NOTE_MAX, makeNote, makeReply, now, type Note } from "../model.ts";
import { lastActivity, spotFor } from "../notes.ts";
import { descendants, type ModelIndex } from "../project.ts";
import { ToolError, clip, fail, more, ok, plural, type Host, type Out } from "./host.ts";
import { findView } from "../agent.ts";
import { noteLine, refOf, resolve, viewFor, viewId } from "./refs.ts";

export const NOTE_ACTIONS = ["add", "reply", "resolve", "reopen", "list"] as const;

export interface NoteArgs {
  action?: (typeof NOTE_ACTIONS)[number];
  text?: string;
  /** What it's about: any ref. */
  about?: string;
  /** The view it goes on (default: where `about` is drawn). */
  view?: string;
  /** The note replied to, resolved or reopened. */
  note?: string;
  flag?: boolean;
  claim?: { field: string; value: string; evidence?: string };
  /** list: only notes new since you last listed. */
  unread?: boolean;
  /** list: resolved ones too. */
  resolved?: boolean;
  /** list: only flags and claims (notes for agents). */
  flags?: boolean;
  limit?: number;
}

export async function note(host: Host, a: NoteArgs): Promise<Out> {
  const idx = host.index();
  const action = a.action ?? (a.note && a.text ? "reply" : a.text || a.claim ? "add" : "list");
  if (action === "list") return list(host, idx, a);
  if (!host.canEdit) return fail(`${host.actor.name} can read this design but not leave notes`);
  if (action === "reply") {
    const n = byId(idx, a.note);
    if (n.kind !== "note") throw new ToolError(`${n.id} is a link; only notes have threads`);
    const text = body(a.text);
    await host.commit(
      [{ op: "reply.put", reply: makeReply({ noteId: n.id, text, author: host.actor }) }],
      `replied on “${clip(n.text, 40)}”`,
      { undo: false },
    );
    return ok(`Replied on ${n.id}: ${host.url(n.diagramId)}`, { note: n.id });
  }
  if (action === "resolve" || action === "reopen") {
    const n = byId(idx, a.note);
    if (n.kind !== "note") throw new ToolError(`${n.id} is a link, not a note`);
    const reopen = action === "reopen";
    if (n.resolved === !reopen) return ok(`${n.id} is already ${reopen ? "open" : "resolved"}.`);
    const ops = [{ op: "note.put" as const, note: { ...n, resolved: !reopen, updatedAt: now() } }];
    if (a.text?.trim())
      ops.unshift({
        op: "reply.put",
        reply: makeReply({ noteId: n.id, text: body(a.text), author: host.actor }),
      } as never);
    await host.commit(ops, `${reopen ? "reopened" : "resolved"} the note “${clip(n.text, 40)}”`, {
      undo: false,
    });
    return ok(`${reopen ? "Reopened" : "Resolved"} ${n.id}.`, { note: n.id });
  }
  // add
  let text = a.text?.trim() ?? "";
  if (a.claim) {
    const { field, value, evidence } = a.claim;
    if (!a.about)
      throw new ToolError(
        "a claim is about something: pass about (the box, connection or entity it's about)",
      );
    text = `${text ? `${text}\n\n` : ""}claim: ${field} = ${value}${evidence ? `\nevidence: ${evidence}` : ""}`;
  }
  text = body(text);
  const { diagramId, objectId, about, connectionId } = where(idx, a.about, a.view);
  // About a connection whose arrow is drawn here: pinned on that arrow, beside its label.
  const spot = connectionId
    ? {
        objectId: null,
        connectionId,
        x:
          14 +
          [...idx.notes.values()].filter(
            (x) => x.diagramId === diagramId && x.connectionId === connectionId && !x.resolved,
          ).length *
            26,
        y: -10,
      }
    : spotFor(idx, diagramId, "note", objectId);
  const n = makeNote({
    diagramId,
    kind: "note",
    text,
    author: host.actor,
    ...(a.flag || a.claim ? { forAgent: true } : {}),
    ...(about && about !== objectId && !connectionId ? { about } : {}),
    ...spot,
  });
  const on = connectionId ? null : (about ?? objectId);
  const said = connectionId ? a.about!.trim() : on ? refOf(idx, on) : "";
  await host.commit(
    [{ op: "note.put", note: n }],
    `${a.claim ? "claimed" : a.flag ? "flagged" : "left a note"}${said ? ` on ${connectionId ? said : (idx.objects.get(on!)?.name ?? on)}` : ""}`,
    { undo: false },
  );
  return ok(
    `Left ${a.claim ? "a claim" : a.flag ? "a flag" : "a note"} ${n.id}${said ? ` on ${said}` : ""}: ${host.url(diagramId, objectId ?? undefined)}`,
    { note: n.id },
  );
}

function body(text?: string): string {
  const t = text?.trim() ?? "";
  if (!t) throw new ToolError("say something: text");
  if (t.length > NOTE_MAX)
    throw new ToolError(
      `a note is at most ${NOTE_MAX} characters (this is ${t.length}); link to a doc for more`,
    );
  return t;
}

function byId(idx: ModelIndex, id?: string): Note {
  if (!id) throw new ToolError('which note? pass note: its id (note {action: "list"} shows them)');
  const n = idx.notes.get(id.trim());
  if (!n) throw new ToolError(`no note ${id} (note {action: "list"} shows them)`);
  return n;
}

/** The view a note goes on and the box it's pinned to, from what it's about. */
function where(
  idx: ModelIndex,
  about?: string,
  view?: string,
): { diagramId: string; objectId: string | null; about: string | null; connectionId?: string } {
  let target: string | null = null;
  if (about) {
    const r = resolve(idx, about);
    if (r.kind === "connection") {
      // Its arrow is drawn where both its ends are: the view asked for, else the first such.
      const c = r.c;
      const both = (id: string) =>
        !!idx.placements.get(id)?.has(c.fromId) && !!idx.placements.get(id)?.has(c.toId);
      const d = view ? findView(idx, view) : [...idx.diagrams.values()].find((x) => both(x.id));
      if (d && both(d.id))
        return { diagramId: d.id, objectId: null, about: null, connectionId: c.id };
    }
    target =
      r.kind === "object"
        ? r.o.id
        : r.kind === "connection"
          ? r.c.fromId
          : r.kind === "entity"
            ? r.e.sourceId
            : null;
    if (r.kind === "view" && !view) return { diagramId: r.d.id, objectId: null, about: null };
    if (r.kind === "entity" && !target && !view)
      throw new ToolError(`${r.e.name} has no home box to pin to: pass view`);
  }
  if (view) {
    const d = findView(idx, view);
    const pin = target && idx.placements.get(d.id)?.has(target) ? target : null;
    return { diagramId: d.id, objectId: pin, about: target };
  }
  if (!target) throw new ToolError("say where: about (a ref) or view");
  const at = viewFor(idx, target);
  if (!at)
    throw new ToolError(
      `${refOf(idx, target)} isn't drawn on any view, nor is anything it's inside: pass view`,
    );
  return { diagramId: at.d.id, objectId: at.objectId, about: target };
}

/** A list of notes this long or shorter prints every thread whole. */
const FULL_LIST = 6000;

function list(host: Host, idx: ModelIndex, a: NoteArgs): Out {
  const limit = a.limit ?? 20;
  const since = a.unread ? (host.seen?.get() ?? "") : "";
  const within = a.about
    ? (() => {
        const r = resolve(idx, a.about!);
        if (r.kind === "connection") return new Set([r.c.id]);
        const id = r.kind === "object" ? r.o.id : r.kind === "entity" ? r.e.sourceId : null;
        return id ? new Set([id, ...descendants(idx, id)]) : null;
      })()
    : null;
  const d = a.view ? findView(idx, a.view) : null;
  const all = [...idx.notes.values()]
    .filter((n) => (a.resolved ? true : !n.resolved || n.kind === "link"))
    .filter((n) => !a.flags || (n.kind === "note" && n.forAgent))
    .filter(
      (n) =>
        !d || n.diagramId === d.id || (n.objectId && idx.placements.get(d.id)?.has(n.objectId)),
    )
    .filter(
      (n) =>
        !within ||
        within.has(n.about ?? "") ||
        within.has(n.objectId ?? "") ||
        within.has(n.connectionId ?? ""),
    )
    .filter((n) => !since || lastActivity(idx, n) > since)
    .sort((x, y) => lastActivity(idx, y).localeCompare(lastActivity(idx, x)));
  host.seen?.set(new Date().toISOString());
  if (!all.length)
    return ok(
      `no ${a.resolved ? "" : "open "}${a.flags ? "flags" : "notes"}${since ? " new since you last looked" : ""}${a.about ? ` about ${a.about}` : ""}${d ? ` on ${viewId(d)}` : ""}`,
      { notes: [] },
    );
  const shown = all.slice(0, limit);
  // Every thread whole (each note's full text and all its replies) when that's short enough to
  // print: an agent read 11 comments with 12 more calls, one per thread. Past that, the first
  // 120 characters and the latest reply, and the thread is a read away.
  const whole = shown.flatMap((n) => [
    noteLine(idx, n, 4000),
    ...(idx.replies.get(n.id) ?? []).map((r) => `    ${r.author.name}: ${clip(r.text, 4000)}`),
  ]);
  const full = whole.join("\n").length <= FULL_LIST;
  const lines = full
    ? whole
    : shown.flatMap((n) => {
        const replies = idx.replies.get(n.id) ?? [];
        const last = replies[replies.length - 1];
        return [
          noteLine(idx, n),
          ...(last ? [`    latest, ${last.author.name}: ${clip(last.text, 120)}`] : []),
        ];
      });
  return ok(
    [
      `${plural(all.length, "note")}:`,
      ...lines,
      more(all.length, shown.length, `note {action: "list", limit: ${all.length}}`),
      full ? "" : `A whole thread: read {ref: "<note id>"}.`,
    ]
      .filter(Boolean)
      .join("\n"),
    { notes: shown.map((n) => n.id) },
  );
}
