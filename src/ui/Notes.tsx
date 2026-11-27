// Notes and links, drawn over the canvas (HTML, not Pixi: they're few, they're text, and a
// thread wants real inputs). A note is a pin that stays the same size at any zoom, like
// Figma's comments; a link is a small card that zooms with the boxes. Either can be pinned
// to a box and moves with it, live while the box is dragged.
import { useMenu } from "./ContextMenu";
import {
  AtSign,
  Bot,
  Check,
  ExternalLink,
  Link2,
  MessageSquare,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { worldToScreen, type Camera } from "../canvas/camera";
import { NO_SPREAD, type Spread } from "../canvas/spread";
import type { Scene, SceneView } from "../canvas/Scene";
import {
  LINK_H,
  LINK_W,
  makeNote,
  makeReply,
  now,
  safeUrl,
  type Author,
  type Note,
  type NoteKind,
  type Op,
} from "../../shared/model.ts";
import type { ModelIndex, PlacedNote } from "../../shared/project.ts";
import { colorFor } from "../presence";
import { Act, CopyLinkButton, Panel } from "./Inspector";
import { ANY_AGENT, mentionsAgent, OLD_AGENT, type Mentionable } from "../../shared/mentions.ts";
export { type Mentionable };
import { initials } from "./Peers";
import { dockUnder, hostOf, titleFromUrl } from "../../shared/notes.ts";

export { hostOf, titleFromUrl };
import { TechImg } from "./TechImg";
import { TextField } from "./TextField";

/** A note or link being written: not in the model until it's posted. */
export interface NoteDraft {
  kind: NoteKind;
  diagramId: string;
  objectId: string | null;
  /** Pinned to an arrow instead (x, y from its middle). */
  connectionId?: string;
  /** The box it's about when it can't be pinned to it: one drawn inside a box opened in place. */
  about?: string;
  x: number;
  y: number;
}

export const DRAFT = "draft";

// --- on the canvas ------------------------------------------------------------------------

interface LayerProps {
  scene: Scene | null;
  idx: ModelIndex;
  diagramId: string;
  notes: PlacedNote[];
  draft: NoteDraft | null;
  me: Author;
  selected: string | null;
  canEdit: boolean;
  onSelect: (id: string) => void;
  /** Dropped somewhere new: pinned to a box (x, y from its corner), to an arrow (from its middle) or neither. */
  onMove: (
    id: string,
    to: { objectId: string | null; connectionId?: string; x: number; y: number },
  ) => void;
  /** Room made under boxes for a layer's rows (drawn lower than saved); see canvas/spread. */
  spread?: Spread;
}

const PIN = 30;

export function NotesLayer(p: LayerProps) {
  const [view, setView] = useState<SceneView | null>(null);
  const layer = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const off = p.scene?.watch((v) => setView({ camera: v.camera, moving: v.moving }));
    return () => void off?.();
  }, [p.scene]);
  // A scroll over a note scrolls the canvas (non-passive, so it can stop the page zooming).
  useEffect(() => {
    const el = layer.current;
    const s = p.scene;
    if (!el || !s) return;
    const fn = (e: WheelEvent) => s.forwardWheel(e);
    el.addEventListener("wheel", fn, { passive: false });
    return () => el.removeEventListener("wheel", fn);
  }, [p.scene]);
  const [dragging, setDragging] = useState<{ id: string; dx: number; dy: number } | null>(null);
  const sp = p.spread ?? NO_SPREAD;

  if (!view) return <div className="notes-layer" ref={layer} />;
  const cam = view.camera;
  const placed = p.idx.placements.get(p.diagramId);
  const boxOf = (id: string | null) => {
    if (!id) return null;
    const b = placed?.get(id);
    if (!b) return null;
    const m = view.moving.get(id);
    return m ? { ...b, x: m.x, y: m.y } : { ...b, y: sp.down(b.y) };
  };
  /** The middle of the arrow a note is pinned to, live; null when that arrow isn't drawn here. */
  const arrowOf = (n: Note) =>
    n.connectionId ? (p.scene?.connectionAnchor(n.connectionId) ?? null) : null;
  /** Where it was put: on its box or arrow (live), or loose. */
  const base = (n: Note) => {
    const arrow = arrowOf(n);
    if (arrow) return { x: n.x + arrow.x, y: n.y + arrow.y };
    const box = boxOf(n.objectId);
    return { x: n.x + (box?.x ?? 0), y: box ? n.y + box.y : sp.down(n.y) };
  };
  /** Where it is on the diagram now: where it was put, plus a drag in progress. */
  const at = (n: Note) => {
    const b = base(n);
    const d = dragging?.id === n.id ? dragging : null;
    return { x: b.x + (d ? d.dx / cam.scale : 0), y: b.y + (d ? d.dy / cam.scale : 0) };
  };
  // Pinned to an arrow that isn't drawn on this view (rolled into another): not shown here.
  const hidden = (n: Note) => !!n.connectionId && !arrowOf(n);
  const all: Note[] = p.notes.map((n) => n.note);
  if (p.draft)
    all.push({ ...makeNote({ ...p.draft, author: p.me, text: "", url: "https://" }), id: DRAFT });
  const replies = new Map(p.notes.map((n) => [n.note.id, n.replies]));

  const press = (n: Note) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    const start = { x: e.clientX, y: e.clientY };
    let moved = false;
    const canDrag = p.canEdit && n.id !== DRAFT;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) < 3) return;
      moved = true;
      if (canDrag) setDragging({ id: n.id, dx, dy });
    };
    const up = (ev: PointerEvent) => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      setDragging(null);
      if (!moved || !canDrag || !p.scene) {
        if (!moved) p.onSelect(n.id);
        return;
      }
      const s = p.scene;
      const was = base(n);
      const to = {
        x: was.x + (ev.clientX - start.x) / cam.scale,
        y: was.y + (ev.clientY - start.y) / cam.scale,
      };
      const world = s.clientToWorld(ev.clientX, ev.clientY);
      const over = s.nodeAt(world);
      // A comment dropped on an arrow pins to it (to the same connection, when it's on this one).
      const arrow = n.kind === "note" && !over ? s.edgeAt(world) : null;
      if (arrow?.connectionIds.length) {
        const conn =
          n.connectionId && arrow.connectionIds.includes(n.connectionId)
            ? n.connectionId
            : arrow.connectionIds[0]!;
        const mid = s.connectionAnchor(conn) ?? to;
        p.onMove(n.id, {
          objectId: null,
          connectionId: conn,
          x: Math.round(to.x - mid.x),
          y: Math.round(to.y - mid.y),
        });
        return;
      }
      const dropped =
        n.kind === "note" ? pinNote(to, over, boxOf) : pinLink(p.idx, n, to, over, boxOf);
      // Loose, it's saved where it'd be without the room made for rows.
      p.onMove(n.id, {
        ...(dropped.objectId ? dropped : { ...dropped, y: Math.round(sp.up(dropped.y)) }),
        connectionId: undefined,
      });
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  return (
    <div className="notes-layer" ref={layer}>
      <svg className="notes-tethers">
        {all
          .filter((n) => n.kind === "link" && n.objectId)
          .map((n) => {
            const box = boxOf(n.objectId);
            if (!box) return null;
            const card = rectOnScreen(cam, { ...at(n), w: LINK_W, h: LINK_H });
            const b = rectOnScreen(cam, box);
            const [a, z] = closestPoints(card, b);
            return <line key={n.id} x1={a.x} y1={a.y} x2={z.x} y2={z.y} />;
          })}
      </svg>
      {all.map((n) => {
        if (hidden(n)) return null;
        const pos = worldToScreen(cam, at(n));
        const on = p.selected === n.id;
        const cls = `${on ? " on" : ""}${dragging?.id === n.id ? " dragging" : ""}${n.resolved ? " resolved" : ""}`;
        if (n.kind === "link") {
          return (
            <div
              key={n.id}
              className={`link-card${cls}`}
              style={{
                transform: `translate(${pos.x}px, ${pos.y}px) scale(${cam.scale})`,
                width: LINK_W,
                height: LINK_H,
              }}
              onPointerDown={press(n)}
              onDoubleClick={() =>
                n.url && n.id !== DRAFT && window.open(n.url, "_blank", "noopener,noreferrer")
              }
              title={
                n.id === DRAFT
                  ? "New link"
                  : `${n.text || hostOf(n.url)}\n${n.url}\nDouble-click to open`
              }
            >
              <LinkIcon url={n.url} />
              <span className="link-words">
                <span className="link-title">
                  {n.id === DRAFT ? "New link" : n.text || hostOf(n.url)}
                </span>
                <span className="link-host">
                  {n.id === DRAFT ? "paste an address" : hostOf(n.url)}
                </span>
              </span>
            </div>
          );
        }
        const count = replies.get(n.id) ?? 0;
        return (
          <div
            key={n.id}
            className={`note-pin${cls}`}
            style={{ transform: `translate(${pos.x}px, ${pos.y - PIN}px)` }}
            onPointerDown={press(n)}
          >
            <span className="bubble" style={{ background: colorFor(n.author.id) }}>
              {n.author.kind === "agent" ? <Bot size={14} /> : initials(n.author.name)}
            </span>
            {count > 0 && <span className="count">{count}</span>}
            {n.id !== DRAFT && !on && (
              <span className="peek">
                <b>{n.author.name}</b> <i>{ago(n.createdAt)}</i>
                {n.forAgent && <span className="note-flag">flag</span>}
                {n.about && n.about !== n.objectId && (
                  <span className="note-flag">on {p.idx.objects.get(n.about)?.name ?? "?"}</span>
                )}
                {n.connectionId && (
                  <span className="note-flag">on {connName(p.idx, n.connectionId)}</span>
                )}
                <span className="peek-text">{n.text}</span>
                {count > 0 && (
                  <span className="peek-more">{count === 1 ? "1 reply" : `${count} replies`}</span>
                )}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** A connection as people say it: its label, else its ends. */
export function connName(idx: ModelIndex, id: string): string {
  const c = idx.connections.get(id);
  if (!c) return "an arrow";
  return (
    c.name || `${idx.objects.get(c.fromId)?.name ?? "?"} → ${idx.objects.get(c.toId)?.name ?? "?"}`
  );
}

type BoxAt = (id: string | null) => { x: number; y: number; w: number; h: number } | null;

/** A note dropped on a box pins to it; anywhere else it's loose. */
function pinNote(to: { x: number; y: number }, over: string | null, boxOf: BoxAt) {
  const b = boxOf(over);
  return b
    ? { objectId: over, x: Math.round(to.x - b.x), y: Math.round(to.y - b.y) }
    : { objectId: null, x: Math.round(to.x), y: Math.round(to.y) };
}

/**
 * A link dropped on a box docks under it (below its other links); moved near its own box
 * it stays pinned there; dropped further off it's loose.
 */
function pinLink(
  idx: ModelIndex,
  n: Note,
  to: { x: number; y: number },
  over: string | null,
  boxOf: BoxAt,
) {
  if (over && boxOf(over) && over !== n.objectId) return dockUnder(idx, n.diagramId, over, n.id);
  const own = boxOf(n.objectId);
  if (own && n.objectId) {
    const gap = Math.max(
      own.x - (to.x + LINK_W),
      to.x - (own.x + own.w),
      own.y - (to.y + LINK_H),
      to.y - (own.y + own.h),
      0,
    );
    if (gap < 200 && !over)
      return { objectId: n.objectId, x: Math.round(to.x - own.x), y: Math.round(to.y - own.y) };
  }
  return { objectId: null, x: Math.round(to.x), y: Math.round(to.y) };
}

function rectOnScreen(c: Camera, r: { x: number; y: number; w: number; h: number }) {
  const a = worldToScreen(c, r);
  return { x: a.x, y: a.y, w: r.w * c.scale, h: r.h * c.scale };
}

/** The nearest points of two rectangles (for the tether from a link to its box). */
function closestPoints(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
) {
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  const pb = { x: clamp(ac.x, b.x, b.x + b.w), y: clamp(ac.y, b.y, b.y + b.h) };
  const pa = { x: clamp(pb.x, a.x, a.x + a.w), y: clamp(pb.y, a.y, a.y + a.h) };
  return [pa, pb] as const;
}

// --- links ------------------------------------------------------------------------------

/** The site's logo when Archnemesis has one (notion, github, linear …), else a link icon. No outside requests. */
export function LinkIcon({ url }: { url?: string }) {
  const host = hostOf(url);
  const brand = host.split(".").slice(-2, -1)[0] ?? "";
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
  }, [brand]);
  return (
    <span className="link-icon">
      {brand && !failed ? (
        <TechImg tech={brand} onMissing={() => setFailed(true)} />
      ) : (
        <Link2 size={15} />
      )}
    </span>
  );
}

// --- the side panel -----------------------------------------------------------------------

/** "just now", "5m", "3h", "2d", then the date. */
export function ago(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function Avatar({ who }: { who: Author }) {
  return (
    <span
      className="avatar"
      style={{ background: colorFor(who.id) }}
      title={who.kind === "agent" ? `${who.name} (agent)` : who.name}
    >
      {who.kind === "agent" ? <Bot size={13} /> : initials(who.name)}
    </span>
  );
}

const escape = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Text with its web addresses made into links, and its @mentions marked. */
function Linked({ text, people = [] }: { text: string; people?: Mentionable[] }) {
  const parts = text.split(/(https?:\/\/[^\s<>"]+)/g);
  const names = [...people]
    .sort((a, b) => b.name.length - a.name.length)
    .map((p) => escape(p.name));
  const at = names.length ? new RegExp(`(@(?:${names.join("|")}))(?![\\w-])`, "gi") : null;
  return (
    <>
      {parts.map((part, i) =>
        i % 2 && safeUrl(part) ? (
          <a key={i} href={safeUrl(part)!} target="_blank" rel="noopener noreferrer">
            {part}
          </a>
        ) : at ? (
          part.split(at).map((bit, j) =>
            j % 2 ? (
              <span key={`${i}.${j}`} className="mention">
                {bit}
              </span>
            ) : (
              bit
            ),
          )
        ) : (
          part
        ),
      )}
    </>
  );
}

function Message({
  who,
  at,
  text,
  people,
  onDelete,
}: {
  who: Author;
  at: string;
  text: string;
  people?: Mentionable[];
  onDelete?: () => void;
}) {
  const menu = useMenu();
  return (
    <div
      className="msg"
      title={onDelete ? "Right-click to delete your reply" : undefined}
      onContextMenu={
        onDelete
          ? menu.on(() => [
              {
                label: "Delete your reply",
                icon: <Trash2 size={14} />,
                danger: true,
                run: onDelete,
              },
            ])
          : undefined
      }
    >
      {menu.node}
      <Avatar who={who} />
      <div className="msg-body">
        <div className="msg-head">
          <b>{who.name}</b>
          <i>{ago(at)}</i>
        </div>
        <div className="msg-text">
          <Linked text={text} people={people} />
        </div>
      </div>
    </div>
  );
}

/**
 * Write something: Enter sends, Shift+Enter is a new line, @ mentions someone (or an
 * agent). The box grows with the text; the buttons sit under it, out of its way.
 */
function Composer(p: {
  placeholder: string;
  onSend: (text: string) => void;
  people: Mentionable[];
  sendLabel: string;
  onCancel?: () => void;
  autoFocus?: boolean;
  disabled?: boolean;
}) {
  const [text, setText] = useState("");
  const box = useLaterFocus<HTMLTextAreaElement>(!!p.autoFocus);
  // The @word being typed (from its @ to the caret), and the pick in the list.
  const [query, setQuery] = useState<{ start: number; word: string } | null>(null);
  const [pick, setPick] = useState(0);
  const grow = () => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  };
  useEffect(grow, [text]); // eslint-disable-line react-hooks/exhaustive-deps
  const matches = query
    ? [...p.people.filter((x) => x.kind === "human"), ANY_AGENT]
        .filter((x) => x.name.toLowerCase().startsWith(query.word.toLowerCase()))
        .slice(0, 6)
    : [];
  const look = (value: string, caret: number) => {
    const m = /(^|\s)@([\w.-]{0,30})$/.exec(value.slice(0, caret));
    setQuery(m ? { start: caret - m[2]!.length - 1, word: m[2]! } : null);
    setPick(0);
  };
  const choose = (who: Mentionable) => {
    if (!query) return;
    const el = box.current;
    const caret = el?.selectionStart ?? text.length;
    const next = `${text.slice(0, query.start)}@${who.name} ${text.slice(caret)}`;
    setText(next);
    setQuery(null);
    const at = query.start + who.name.length + 2;
    setTimeout(() => {
      el?.focus();
      el?.setSelectionRange(at, at);
    }, 0);
  };
  const send = () => {
    if (!text.trim() || p.disabled) return;
    p.onSend(text.trim());
    setText("");
    setQuery(null);
  };
  const mentionAgent = mentionsAgent(text, p.people);
  return (
    <div className={`composer${p.disabled ? " disabled" : ""}`}>
      <textarea
        ref={box}
        value={text}
        disabled={p.disabled}
        placeholder={p.placeholder}
        rows={2}
        onChange={(e) => {
          setText(e.target.value);
          look(e.target.value, e.target.selectionStart);
        }}
        onKeyDown={(e) => {
          if (matches.length) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setPick(
                (i) => (i + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length,
              );
              return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              choose(matches[pick]!);
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              setQuery(null);
              return;
            }
          }
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          } else if (e.key === "Escape") {
            if (p.onCancel && !text) p.onCancel();
            else e.currentTarget.blur();
          }
        }}
      />
      {matches.length > 0 && (
        <ul className="mention-list" role="listbox">
          {matches.map((m, i) => (
            <li
              key={m.id}
              role="option"
              aria-selected={i === pick}
              className={i === pick ? "on" : ""}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(m);
              }}
              onMouseEnter={() => setPick(i)}
            >
              <span className="avatar small" style={{ background: colorFor(m.id) }}>
                {m.kind === "agent" ? <Bot size={11} /> : initials(m.name)}
              </span>
              <span className="mention-name">{m.name}</span>
              {m.hint && <span className="mention-hint">{m.hint}</span>}
            </li>
          ))}
        </ul>
      )}
      <div className="composer-bar">
        <button
          className="icon-btn small"
          title="Mention someone, or an agent (@)"
          disabled={p.disabled}
          onClick={() => {
            const el = box.current;
            const caret = el?.selectionStart ?? text.length;
            const pad = caret > 0 && !/\s$/.test(text.slice(0, caret)) ? " " : "";
            const next = `${text.slice(0, caret)}${pad}@${text.slice(caret)}`;
            setText(next);
            setTimeout(() => {
              el?.focus();
              const at = caret + pad.length + 1;
              el?.setSelectionRange(at, at);
              look(next, at);
            }, 0);
          }}
        >
          <AtSign size={14} />
        </button>
        <span className="composer-hint">
          {mentionAgent ? "Flags it for agents" : "⏎ to send · ⇧⏎ new line"}
        </span>
        <span className="spacer" />
        {p.onCancel && (
          <button className="btn ghost" onClick={p.onCancel}>
            Cancel
          </button>
        )}
        <button className="btn primary" disabled={!text.trim() || p.disabled} onClick={send}>
          {p.sendLabel}
        </button>
      </div>
    </div>
  );
}

/**
 * Focus once mounted, a moment later: a panel opened by a click on the canvas mounts during
 * that press, and the press's own mousedown would take the focus straight back.
 */
function useLaterFocus<T extends HTMLElement>(on: boolean) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!on) return;
    const t = setTimeout(() => ref.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [on]);
  return ref;
}

interface PanelProps {
  idx: ModelIndex;
  me: Author;
  /** Who can be @mentioned. */
  people: Mentionable[];
  canEdit: boolean;
  run: (ops: Op[], label: string) => Promise<unknown>;
  onClose: () => void;
}

// What it's about: the function inside the box it's pinned to, when it says, else the box.
const where = (
  idx: ModelIndex,
  n: { objectId: string | null; about?: string; connectionId?: string },
) => {
  if (n.connectionId) return connName(idx, n.connectionId);
  const id = n.about ?? n.objectId;
  return id ? idx.objects.get(id)?.name : undefined;
};

/** A note's thread: the note, its replies, a reply box; resolve or delete it. */
export function NotePanel(p: PanelProps & { note: Note }) {
  const n = p.note;
  const replies = p.idx.replies.get(n.id) ?? [];
  const on = where(p.idx, n);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Braces: newer browsers return a promise from scrollIntoView, and an effect mustn't.
    void end.current?.scrollIntoView({ block: "nearest" });
  }, [replies.length]);
  const subject = clip(n.text, 40);
  // @agent, and the old @Claude, marked in what was written before.
  const everyone = [...p.people, ANY_AGENT, OLD_AGENT];
  const reply = (text: string) => {
    const ops: Op[] = [{ op: "reply.put", reply: makeReply({ noteId: n.id, text, author: p.me }) }];
    // Mentioning an agent in a reply flags the thread for agents (and opens it again).
    if (mentionsAgent(text, everyone) && (!n.forAgent || n.resolved))
      ops.push({
        op: "note.put",
        note: { ...n, forAgent: true, resolved: false, updatedAt: now() },
      });
    void p.run(ops, `replied on “${subject}”${on ? ` (${on})` : ""}`);
  };
  return (
    <Panel
      footer={
        <>
          <Act
            icon={n.resolved ? <RotateCcw size={13} /> : <Check size={13} />}
            disabled={!p.canEdit}
            onClick={() =>
              void p
                .run(
                  [{ op: "note.put", note: { ...n, resolved: !n.resolved, updatedAt: now() } }],
                  `${n.resolved ? "reopened" : "resolved"} the note “${subject}”`,
                )
                .then(() => !n.resolved && p.onClose())
            }
          >
            {n.resolved ? "Reopen" : "Resolve"}
          </Act>
          <CopyLinkButton to={{ diagramId: n.diagramId, noteId: n.id }} what="this note" />
          <span className="spacer" />
          <Act
            icon={<Trash2 size={13} />}
            className="danger"
            disabled={!p.canEdit}
            title="⌫"
            onClick={() =>
              void p
                .run([{ op: "note.delete", id: n.id }], `deleted the note “${subject}”`)
                .then(p.onClose)
            }
          >
            Delete
          </Act>
        </>
      }
    >
      <div className="note-head">
        <div className="eyebrow">
          {n.forAgent ? "Flag" : "Note"}
          {on ? ` · on ${on}` : ""}
          {n.resolved && <span className="resolved-chip">Resolved</span>}
        </div>
        <button className="icon-btn small" title="Close (Esc)" onClick={p.onClose}>
          <X size={14} />
        </button>
      </div>
      <div className="thread">
        <Message who={n.author} at={n.createdAt} text={n.text} people={everyone} />
        {replies.map((r) => (
          <Message
            key={r.id}
            who={r.author}
            at={r.at}
            text={r.text}
            people={everyone}
            onDelete={
              p.canEdit && r.author.id === p.me.id
                ? () => void p.run([{ op: "reply.delete", id: r.id }], "deleted a reply")
                : undefined
            }
          />
        ))}
        <div ref={end} />
      </div>
      {p.canEdit && (
        <Composer
          placeholder="Reply… (@ to mention)"
          sendLabel="Reply"
          people={p.people}
          onSend={reply}
        />
      )}
    </Panel>
  );
}

/** A link: its title and address, what it's pinned to; open it or delete it. */
export function LinkPanel(p: PanelProps & { note: Note; diagramId: string }) {
  const n = p.note;
  const put = (patch: Partial<Note>, label: string) =>
    void p.run([{ op: "note.put", note: { ...n, ...patch, updatedAt: now() } }], label);
  const boxes = [...(p.idx.placements.get(p.diagramId)?.keys() ?? [])]
    .flatMap((id) => p.idx.objects.get(id) ?? [])
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <Panel
      footer={
        <>
          <Act
            icon={<ExternalLink size={13} />}
            onClick={() => n.url && window.open(n.url, "_blank", "noopener,noreferrer")}
          >
            Open
          </Act>
          <span className="spacer" />
          <Act
            icon={<Trash2 size={13} />}
            className="danger"
            disabled={!p.canEdit}
            title="⌫"
            onClick={() =>
              void p
                .run(
                  [{ op: "note.delete", id: n.id }],
                  `removed the link “${n.text || hostOf(n.url)}”`,
                )
                .then(p.onClose)
            }
          >
            Delete
          </Act>
        </>
      }
    >
      <div className="eyebrow">Link</div>
      <div className="fields">
        <TextField
          className="title-input"
          value={n.text}
          placeholder={titleFromUrl(n.url ?? "") || "Title"}
          onCommit={(text) => put({ text: text.trim().slice(0, 200) }, "renamed a link")}
        />
        <label className="row">
          <span>Address</span>
          <TextField
            value={n.url ?? ""}
            placeholder="https://…"
            onCommit={(v) => {
              const url = safeUrl(v);
              if (url) put({ url }, "changed a link");
            }}
          />
        </label>
        <label className="row">
          <span>Pinned to</span>
          <select
            value={n.objectId ?? ""}
            disabled={!p.canEdit}
            onChange={(e) => {
              const id = e.target.value || null;
              const cur = n.objectId
                ? p.idx.placements.get(p.diagramId)?.get(n.objectId)
                : undefined;
              const abs = { x: n.x + (cur?.x ?? 0), y: n.y + (cur?.y ?? 0) };
              put(
                id ? dockUnder(p.idx, p.diagramId, id, n.id) : { objectId: null, ...abs },
                id ? `pinned a link to ${p.idx.objects.get(id)?.name}` : "unpinned a link",
              );
            }}
          >
            <option value="">Nothing (loose on the diagram)</option>
            {boxes.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
      </div>
    </Panel>
  );
}

/** A note or link being written. Nothing's saved until it's posted. */
export function DraftPanel(p: PanelProps & { draft: NoteDraft; onPosted: (id: string) => void }) {
  const d = p.draft;
  const on = where(p.idx, d);
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const first = useLaterFocus<HTMLInputElement>(d.kind === "link");
  const post = (note: Note, label: string) =>
    void p.run([{ op: "note.put", note }], label).then(() => p.onPosted(note.id));
  if (d.kind === "note") {
    return (
      <Panel footer={null}>
        <div className="note-head">
          <div className="eyebrow">New note{on ? ` · on ${on}` : ""}</div>
        </div>
        <Composer
          autoFocus
          placeholder="Say something… (@ to mention someone, @agent for an agent)"
          sendLabel="Post"
          people={p.people}
          onCancel={p.onClose}
          onSend={(text) => {
            // @agent makes it a flag: agents and the curator pick it up.
            const forAgent = mentionsAgent(text, p.people);
            post(
              makeNote({ ...d, author: p.me, text, ...(forAgent ? { forAgent: true } : {}) }),
              `${forAgent ? "flagged" : "left a note"}${on ? ` on ${on}` : ""}`,
            );
          }}
        />
      </Panel>
    );
  }
  const clean = safeUrl(url);
  const add = () =>
    clean &&
    post(
      makeNote({ ...d, author: p.me, text: title.trim() || titleFromUrl(clean), url: clean }),
      `added a link${on ? ` to ${on}` : ""}`,
    );
  return (
    <Panel
      footer={
        <>
          <Act icon={<X size={13} />} onClick={p.onClose}>
            Cancel
          </Act>
          <span className="spacer" />
          <Act icon={<Link2 size={13} />} disabled={!clean} onClick={add}>
            Add link
          </Act>
        </>
      }
    >
      <div className="eyebrow">New link{on ? ` · on ${on}` : ""}</div>
      <div className="fields">
        <input
          ref={first}
          value={url}
          placeholder="Paste an address (an RFC, a runbook…)"
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <input
          value={title}
          placeholder={(clean && titleFromUrl(clean)) || "Title (optional)"}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        {url && !clean && (
          <p className="hint">That isn't a web address yet (it needs http:// or https://).</p>
        )}
      </div>
    </Panel>
  );
}

// --- every note, from the top right -------------------------------------------------------

type Filter = "open" | "resolved";

/** The notes button by the people at the top right: every thread and link in the design. */
export function NotesMenu(p: {
  idx: ModelIndex;
  diagramId: string | null;
  onOpen: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<Filter>("open");
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);
  const notes = [...p.idx.notes.values()];
  const openCount = notes.filter((n) => n.kind === "note" && !n.resolved).length;
  const shown = useMemo(() => {
    const keep = notes.filter((n) => n.kind === "note" && n.resolved === (filter === "resolved"));
    // This diagram first, then the rest by name; newest first in each.
    const groups = new Map<string, Note[]>();
    for (const n of keep.sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
      const g = groups.get(n.diagramId);
      if (g) g.push(n);
      else groups.set(n.diagramId, [n]);
    }
    const name = (id: string) => p.idx.diagrams.get(id)?.name ?? "";
    return [...groups].sort(([a], [b]) =>
      a === p.diagramId ? -1 : b === p.diagramId ? 1 : name(a).localeCompare(name(b)),
    );
  }, [p.idx, filter, p.diagramId]);

  return (
    <div className="notes-menu" ref={box}>
      <button
        className={`notes-btn${open ? " on" : ""}`}
        title="Notes and links"
        onClick={() => setOpen((o) => !o)}
      >
        <MessageSquare size={15} />
        {openCount > 0 && <span>{openCount}</span>}
      </button>
      {open && (
        <div className="notes-pop">
          <div className="notes-tabs">
            {(["open", "resolved"] as Filter[]).map((f) => (
              <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
                {f === "open" ? "Open" : f === "resolved" ? "Resolved" : "Links"}
              </button>
            ))}
          </div>
          <div className="notes-list">
            {shown.length === 0 && (
              <p className="notes-empty">
                {filter === "open"
                  ? "No open notes. Place one with the note tool (N)."
                  : "Nothing resolved yet."}
              </p>
            )}
            {shown.map(([diagramId, list]) => (
              <div key={diagramId}>
                <div className="notes-group">{p.idx.diagrams.get(diagramId)?.name}</div>
                {list.map((n) => {
                  const count = p.idx.replies.get(n.id)?.length ?? 0;
                  const on = where(p.idx, n);
                  return (
                    <button
                      key={n.id}
                      className="notes-row"
                      onClick={() => {
                        setOpen(false);
                        p.onOpen(n.id);
                      }}
                    >
                      {n.kind === "link" ? <LinkIcon url={n.url} /> : <Avatar who={n.author} />}
                      <span className="notes-row-body">
                        <span className="notes-row-head">
                          <b>{n.kind === "link" ? n.text || hostOf(n.url) : n.author.name}</b>
                          <i>{n.kind === "link" ? hostOf(n.url) : ago(n.createdAt)}</i>
                        </span>
                        {n.kind === "note" && <span className="notes-row-text">{n.text}</span>}
                        {(on || count > 0) && (
                          <span className="notes-row-meta">
                            {on && <>on {on}</>}
                            {on && count > 0 && " · "}
                            {count > 0 && (count === 1 ? "1 reply" : `${count} replies`)}
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
