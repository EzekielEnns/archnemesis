// A box's card (docs/prototypes/node-card.html, "A · read, then drill in"). It's for reading:
// what it is in a line, what it connects to, and a row per thing hung on it, each with a count.
// A row opens its list in place of the card, with an input made for it on top; the card never
// scrolls. Everything is written back to the model, so to the YAML (and notes as markdown).
import { SignatureField } from "./TypeSuggest";
import {
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  ChevronRight,
  Layers,
  Maximize2,
  Minimize2,
  Pencil,
  Spline,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { updateConnection, updateObject } from "../../shared/actions.ts";
import { callsOf, codeHome, type Call } from "../../shared/context.ts";
import {
  CARD_H,
  KIND_LABEL,
  makeObject,
  mergedContext,
  safeUrl,
  STATUSES,
  type Column,
  type Connection,
  type Ecosystem,
  type ModelObject,
  type Op,
} from "../../shared/model.ts";
import { notesAbout } from "../../shared/context.ts";
import { NewWalk } from "./NewWalk";
import {
  addNote,
  detectRef,
  linkName,
  noteItems,
  parsePackage,
  removeNote,
} from "../../shared/nodecard.ts";
import {
  descendants,
  logoOf,
  tableOpenHeight,
  tableShowsColumns,
  type ModelIndex,
} from "../../shared/project.ts";
import {
  designTechs,
  libraryDocs,
  referencedBy,
  referencesOf,
  sharingTech,
  techsOf,
  type RefRow,
} from "../../shared/references.ts";
import {
  entitiesOf,
  entityNamed,
  entityShape,
  isTbd,
  makeEntity,
  parseEntityName,
  signatureOps,
  signatureTypes,
  splitField,
  usersOf,
} from "../../shared/entities.ts";
import type { Entity } from "../../shared/model.ts";
import { CopyLinkButton } from "./Inspector";
import { KindDot } from "./KindDot";
import { TextField } from "./TextField";

type Run = (ops: Op[], label: string) => Promise<unknown>;

export interface NodeCardProps {
  o: ModelObject;
  idx: ModelIndex;
  diagramId: string;
  run: Run;
  canEdit: boolean;
  /** It was just made: its first field takes the keyboard. */
  fresh?: boolean;
  onClose: () => void;
  onRemove: () => void;
  /** Go to another box: selected here if it's drawn here, else on a diagram that has it. */
  onGoTo: (id: string) => void;
  /** Go to a diagram, with this box selected there. */
  onNavigate: (diagramId: string, objectId?: string) => void;
  onHoverConnection?: (c: Connection | null) => void;
  /** Pin a comment to it on this diagram. */
  onComment: (text: string) => void;
  onOpenNote: (noteId: string) => void;
  /** Open its inside right here (looking only), or close it again. */
  openHere?: { on: boolean; toggle: () => void };
  /** "← AWS": back to where a jump came from. */
  back?: { label: string; run: () => void } | null;
}

type Row =
  | "tech"
  | "tags"
  | "refs"
  | "libs"
  | "entities"
  | "notes"
  | "comments"
  | "columns"
  | "connects"
  | "context"
  | "carries"
  | "before"
  | "next";
/** What an empty row's chip adds: "+ library". */
const ROW_ONE: Record<Row, string> = {
  tech: "tech",
  tags: "tag",
  refs: "reference",
  libs: "library",
  entities: "entity",
  notes: "note",
  comments: "comment",
  columns: "column",
  connects: "connection",
  context: "context",
  carries: "what it carries",
  before: "call",
  next: "call",
};
const ROW_NAME: Record<Row, string> = {
  tech: "Tech",
  tags: "Tags",
  refs: "References",
  libs: "Libraries",
  entities: "Entities",
  notes: "Notes",
  comments: "Comments",
  columns: "Columns",
  connects: "Connections",
  context: "Context",
  carries: "Carries",
  before: "Before",
  next: "Next",
};

/** Connections shown on the card before "+n more". */
const LINKS_SHOWN = 4;

export function NodeCard(p: NodeCardProps) {
  const { o, idx } = p;
  const [view, setView] = useState<Row | null>(null);
  // Just placed: the card walks through what it needs first (once per box).
  const [walked, setWalked] = useState<string | null>(null);
  const walking = !!p.fresh && p.canEdit && walked !== o.id;
  const save = (patch: Partial<ModelObject>, label: string) => {
    // A signature links the entities it names (new names become TBD entities).
    if ("signature" in patch) {
      const { ops, references } = signatureOps(idx, o, patch.signature);
      return void p.run([...ops, ...updateObject(o, { ...patch, references })], label);
    }
    void p.run(updateObject(o, patch), label);
  };
  const links = useMemo(() => linksOf(idx, o.id), [idx, o.id]);
  // On the card, one row per box and direction: two calls to Menu Service are one line.
  const merged = useMemo(() => {
    const by = new Map<string, Link & { via: string[] }>();
    for (const l of links) {
      const k = `${l.dir}${l.other.id}`;
      const label = l.keys ?? [l.c.name, l.c.technology].filter(Boolean).join(" · ");
      const had = by.get(k);
      if (had) label && !had.via.includes(label) && had.via.push(label);
      else by.set(k, { ...l, via: label ? [label] : [] });
    }
    return [...by.values()];
  }, [links]);
  const parts = partsOf(idx, o);
  // Columns added while they're on the canvas: the box grows to keep showing them all.
  const box = idx.placements.get(p.diagramId)?.get(o.id);
  const count = o.columns?.length ?? 0;
  useEffect(() => {
    if (
      o.kind === "table" &&
      box &&
      p.canEdit &&
      tableShowsColumns(box.h) &&
      box.h < tableOpenHeight(count)
    )
      void p.run(
        [{ op: "placement.put", placement: { ...box, h: tableOpenHeight(count) } }],
        "fit columns",
      );
  }, [count]); // eslint-disable-line react-hooks/exhaustive-deps
  // Esc in a list goes back to the card; on the card it closes it (the canvas handles that).
  return (
    <aside
      className="inspector simple node-card"
      onKeyDown={(e) => e.key !== "Escape" && e.stopPropagation()}
    >
      <div className={`nc-stack${view ? " in" : ""}`}>
        <div className="nc-view nc-main">
          <Head {...p} />
          {walking ? (
            // Named and good to go: the card gets out of the way, for the next box.
            <NewWalk o={o} idx={idx} save={save} done={() => (setWalked(o.id), p.onClose())} />
          ) : (
            <>
              <Summary
                o={o}
                canEdit={p.canEdit}
                fresh={p.fresh}
                onEdit={() => setView("context")}
                save={save}
              />
              <Middle {...p} save={save} openRow={setView} />
              <div className="nc-grow">
                {links.length > 0 && (
                  <button
                    className="nc-sect"
                    onClick={() => setView("connects")}
                    data-tip="All of them"
                  >
                    {o.kind === "library" ? "Used by" : "Connects"}
                    <span className="sp" />
                    <span className="nc-n">{links.length}</span>
                  </button>
                )}
                {merged.slice(0, LINKS_SHOWN).map((l) => (
                  <LinkRow key={l.key} l={l} {...p} />
                ))}
                {merged.length > LINKS_SHOWN && (
                  <button className="nc-more" onClick={() => setView("connects")}>
                    +{merged.length - LINKS_SHOWN} more
                  </button>
                )}
              </div>
              <Rows parts={parts} canEdit={p.canEdit} open={setView} />
            </>
          )}
          <Foot {...p} />
        </div>
        <div className="nc-view nc-sub">
          {view && (
            <Sub key={view} row={view} name={o.name} back={() => setView(null)}>
              <RowView {...p} row={view} save={save} links={links} done={() => setView(null)} />
            </Sub>
          )}
        </div>
      </div>
    </aside>
  );
}

// ---- the card ----------------------------------------------------------------------------

function Head(p: NodeCardProps) {
  const { o, idx } = p;
  const parent = o.parentId ? idx.objects.get(o.parentId) : undefined;
  const [logo, setLogo] = useState(false);
  return (
    <div className="nc-head">
      <button
        className="nc-icon"
        data-tip={`Logo: ${logoOf(o) || "none"} (click to change)`}
        disabled={!p.canEdit}
        onClick={() => setLogo(!logo)}
      >
        <KindDot kind={o.kind} external={o.external} />
      </button>
      <div className="nc-title">
        <TextField
          className={`nc-name flow-field${o.kind === "function" || o.kind === "module" || o.kind === "library" || o.kind === "table" ? " mono" : ""}`}
          value={o.name}
          placeholder="Name it"
          onCommit={(name) =>
            p.canEdit &&
            name.trim() &&
            name.trim() !== o.name &&
            void p.run(updateObject(o, { name: name.trim() }), "rename")
          }
        />
        <div className="nc-kind">
          {p.back && (
            <button
              className="linkish"
              onClick={p.back.run}
              data-tip="Back to what you had selected (⌥←)"
            >
              <ArrowLeft size={11} /> {p.back.label} ·{" "}
            </button>
          )}
          {KIND_LABEL[o.kind]}
          {o.external ? " · outside" : ""}
          {o.guess ? " · a guess" : ""}
          {parent && (
            <>
              {" · in "}
              <button
                className="linkish"
                onClick={() => p.onGoTo(parent.id)}
                data-tip={`Go to ${parent.name}`}
              >
                {parent.name}
              </button>
            </>
          )}
        </div>
        {logo && (
          <TextField
            className="nc-logo flow-field"
            value={o.icon ?? ""}
            placeholder="Logo: from its tech (or rust, none)"
            onCommit={(icon) => {
              setLogo(false);
              if ((icon.trim() || undefined) !== o.icon)
                void p.run(
                  updateObject(o, { icon: icon.trim() || undefined }),
                  icon.trim() ? `logo ${icon.trim()}` : "logo from tech",
                );
            }}
          />
        )}
      </div>
      <div className="nc-acts">
        {p.openHere && (
          <button
            className={`ib${p.openHere.on ? " on" : ""}`}
            onClick={p.openHere.toggle}
            data-tip={
              p.openHere.on
                ? "Close its diagram here (⇧⌘G)"
                : "Open its diagram right here, inside this one (nothing changes)"
            }
          >
            {p.openHere.on ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
        )}
        <CopyLinkButton to={{ diagramId: p.diagramId, objectId: o.id }} what={o.name} />
        <button className="ib" data-tip="Close (Esc)" onClick={p.onClose}>
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

/** One line: the context's first line. Click it to change that line; the pencil opens all of it. */
function Summary({
  o,
  canEdit,
  fresh,
  onEdit,
  save,
}: {
  o: ModelObject;
  canEdit: boolean;
  fresh?: boolean;
  onEdit: () => void;
  save: (p: Partial<ModelObject>, l: string) => void;
}) {
  const all = mergedContext(o.description, o.context);
  const [first, ...rest] = all.split("\n");
  const more = rest.join("\n").trim();
  return (
    <div className="nc-sum">
      <TextField
        className="nc-sum-line flow-field"
        value={first ?? ""}
        placeholder={canEdit ? "What it does, in a line" : ""}
        onCommit={(line) => {
          if (!canEdit || line.trim() === (first ?? "").trim()) return;
          const text = [line.trim(), more].filter(Boolean).join("\n");
          save({ description: text, context: undefined }, "set context");
        }}
      />
      {(canEdit || more) && !fresh && (
        <button
          className="ib nc-pen"
          data-tip={more ? "Read or edit all of its context" : "Write more context"}
          onClick={onEdit}
        >
          <Pencil size={12} />
          {more && <span className="nc-pen-more">more</span>}
        </button>
      )}
    </div>
  );
}

/** What only its kind has, in a line or two: tech, a file's path, a function's file, a library's package. */
function Middle(
  p: NodeCardProps & {
    save: (patch: Partial<ModelObject>, label: string) => void;
    openRow: (r: Row) => void;
  },
) {
  const { o, idx } = p;
  if (o.kind === "module")
    return (
      <div className="nc-facts">
        <span className="nc-fk">Path</span>
        <TextField
          className="mono nc-fv"
          value={o.path ?? ""}
          placeholder="repo:path/to/file.rs"
          onCommit={(path) =>
            p.canEdit &&
            p.save({ path: path.trim() || undefined }, path.trim() ? "set path" : "remove path")
          }
        />
      </div>
    );
  if (o.kind === "function") {
    const home = codeHome(idx, o.id);
    return (
      <div className="nc-facts">
        <span className="nc-fk">Takes</span>
        <SignatureField
          idx={idx}
          className="mono nc-fv"
          value={o.signature ?? ""}
          placeholder="(Cart, UserId) -> Order"
          onCommit={(v) => {
            const t = v.trim().replace(/\s*(?:->|→|=>)\s*/, " -> ");
            if (p.canEdit && t !== (o.signature ?? ""))
              p.save({ signature: t || undefined }, t ? "set signature" : "remove signature");
          }}
        />
        <span className="nc-fk">File</span>
        <span className="mono nc-fv" title={home?.path}>
          {home?.path ?? <span className="muted">in no file yet</span>}
        </span>
      </div>
    );
  }
  if (o.kind === "library") {
    const docs = libraryDocs(o);
    const pkg = o.package;
    return (
      <div className="nc-facts">
        <span className="nc-fk">Package</span>
        <span className="nc-fv">
          {[pkg?.ecosystem, pkg?.version].filter(Boolean).join(" ") || "library"}
          {docs && (
            <>
              {" · "}
              <a href={docs} target="_blank" rel="noreferrer noopener">
                docs
              </a>
            </>
          )}
        </span>
      </div>
    );
  }
  return <TechLine o={o} idx={idx} open={p.openRow} canEdit={p.canEdit} />;
}

interface Link {
  key: string;
  c: Connection;
  dir: "→" | "←";
  /** The thing at the other end. */
  other: ModelObject;
  /** The table column → column it keys, when it's a key. */
  keys?: string;
}

/** What it's connected to: its own connections, and for a box with insides, the ones crossing in or out. */
function linksOf(idx: ModelIndex, id: string): Link[] {
  const inside = new Set([id, ...descendants(idx, id)]);
  const out: Link[] = [];
  for (const c of idx.connections.values()) {
    if (c.status === "removed") continue;
    const fromIn = inside.has(c.fromId);
    if (fromIn === inside.has(c.toId)) continue;
    const other = idx.objects.get(fromIn ? c.toId : c.fromId);
    if (!other) continue;
    out.push({
      key: c.id,
      c,
      dir: fromIn ? "→" : "←",
      other,
      ...(c.column ? { keys: `${c.column} → ${c.toColumn ?? "id"}` } : {}),
    });
  }
  return out.sort((a, b) =>
    a.dir === b.dir ? a.other.name.localeCompare(b.other.name) : a.dir === "←" ? -1 : 1,
  );
}

function LinkRow({ l, ...p }: { l: Link & { via: string[] } } & NodeCardProps) {
  const label = l.via.join(", ");
  return (
    <button
      className="nc-link"
      onClick={() => p.onGoTo(l.other.id)}
      onMouseEnter={() => p.onHoverConnection?.(l.c)}
      onMouseLeave={() => p.onHoverConnection?.(null)}
      data-tip={`Go to ${l.other.name}`}
    >
      <span className="nc-dir">{l.dir}</span>
      <KindDot kind={l.other.kind} external={l.other.external} />
      <span
        className={`nc-who${l.other.kind === "function" || l.other.kind === "table" ? " mono" : ""}`}
      >
        {l.other.name}
      </span>
      <span className={`nc-via${l.keys ? " mono" : ""}`}>{label}</span>
    </button>
  );
}

interface Parts {
  rows: { row: Row; n: number; peek: string }[];
}

/** The rows a box has: each with a count and a peek at what's in it. Empty ones aren't rows. */
function partsOf(idx: ModelIndex, o: ModelObject): Parts {
  const refs = referencesOf(idx, o);
  const libs = refs.filter((r) => r.kind === "dependency");
  const other = refs.filter((r) => r.kind !== "dependency");
  const notes = noteItems(o.notes ?? "");
  const comments = commentsOf(idx, o.id);
  const rows: Parts["rows"] = [];
  if (o.kind === "table")
    rows.push({
      row: "columns",
      n: o.columns?.length ?? 0,
      peek: (o.columns ?? []).map((c) => c.name).join(", "),
    });
  rows.push({ row: "tags", n: o.tags.length, peek: o.tags.map((t) => `#${t}`).join(", ") });
  rows.push({ row: "refs", n: other.length, peek: other.map((r) => r.title).join(", ") });
  if (o.kind !== "library")
    rows.push({ row: "libs", n: libs.length, peek: libs.map((r) => r.title).join(", ") });
  const ents = entitiesOf(idx, o);
  if (o.kind !== "library" && o.kind !== "actor")
    rows.push({ row: "entities", n: ents.length, peek: ents.map((e) => e.name).join(", ") });
  rows.push({ row: "notes", n: notes.length, peek: notes[0] ?? "" });
  rows.push({ row: "comments", n: comments.length, peek: comments[0]?.text ?? "" });
  return { rows };
}

function Rows({
  parts,
  canEdit,
  open,
}: {
  parts: Parts;
  canEdit: boolean;
  open: (r: Row) => void;
}) {
  const shown = parts.rows.filter((r) => r.n > 0 || r.row === "columns");
  const empty = parts.rows.filter((r) => r.n === 0 && r.row !== "columns");
  return (
    <>
      {shown.length > 0 && (
        <div className="nc-rows">
          {shown.map((r) => (
            <button key={r.row} className="nc-row" onClick={() => open(r.row)}>
              <span>{ROW_NAME[r.row]}</span>
              <span className="nc-peek">{r.peek}</span>
              <span className="nc-n">{r.n}</span>
              <ChevronRight size={14} className="nc-chev" />
            </button>
          ))}
        </div>
      )}
      {canEdit && empty.length > 0 && (
        <div className="nc-addbar">
          {empty.map((r) => (
            <button key={r.row} onClick={() => open(r.row)}>
              + {ROW_ONE[r.row]}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function Foot(p: NodeCardProps) {
  const [open, setOpen] = useState(false);
  const on = [...(p.idx.placedOn.get(p.o.id) ?? [])].flatMap((id) => p.idx.diagrams.get(id) ?? []);
  const others = on.filter((d) => d.id !== p.diagramId).length;
  return (
    <div className="nc-foot">
      {on.length > 1 ? (
        <button
          className="act"
          onClick={() => setOpen(!open)}
          data-tip="The other diagrams it's on: jump to one"
        >
          <Layers size={13} />
          <span>
            Also on {others} diagram{others === 1 ? "" : "s"}
          </span>
        </button>
      ) : (
        <span className="muted small">Only on this diagram</span>
      )}
      <span className="spacer" />
      {p.canEdit && (
        <button className="act danger" onClick={p.onRemove} data-tip="Delete it, everywhere (⌫)">
          <Trash2 size={13} />
          <span>Delete</span>
        </button>
      )}
      {open && <AlsoOn {...p} close={() => setOpen(false)} />}
    </div>
  );
}

/** The diagrams it's on: where each lives, how many of its connections are drawn there. */
function AlsoOn(p: NodeCardProps & { close: () => void }) {
  const { idx, o } = p;
  const rows = useMemo(() => {
    const mine = linksOf(idx, o.id);
    return [...(idx.placedOn.get(o.id) ?? [])].flatMap((id) => {
      const d = idx.diagrams.get(id);
      if (!d) return [];
      const placed = idx.placements.get(id);
      const drawn = mine.filter((l) => placed?.has(l.other.id)).length;
      const path: string[] = [];
      for (
        let s = d.scopeId ? idx.objects.get(d.scopeId) : undefined;
        s;
        s = s.parentId ? idx.objects.get(s.parentId) : undefined
      )
        path.unshift(s.name);
      return [{ d, drawn, path: path.join(" / ") || "the top level", here: id === p.diagramId }];
    });
  }, [idx, o.id, p.diagramId]);
  const others = rows.filter((r) => !r.here);
  const [pick, setPick] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: PointerEvent) =>
      !ref.current?.contains(e.target as Node) &&
      !(e.target as HTMLElement).closest(".nc-foot .act") &&
      p.close();
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") (e.stopPropagation(), p.close());
      else if (e.key === "ArrowDown")
        (e.preventDefault(), setPick((i) => Math.min(i + 1, others.length - 1)));
      else if (e.key === "ArrowUp") (e.preventDefault(), setPick((i) => Math.max(i - 1, 0)));
      else if (e.key === "Enter" && others[pick])
        (e.preventDefault(), p.onNavigate(others[pick]!.d.id, o.id));
    };
    window.addEventListener("pointerdown", down);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", down);
      window.removeEventListener("keydown", key, true);
    };
  });
  return (
    <div className="nc-also" ref={ref}>
      <div className="nc-also-h">On these diagrams</div>
      {rows.map((r) => (
        <button
          key={r.d.id}
          className={`nc-also-d${!r.here && others.indexOf(r) === pick ? " on" : ""}`}
          disabled={r.here}
          onClick={() => p.onNavigate(r.d.id, o.id)}
        >
          <span className="nc-also-t">
            <span>{r.d.name}</span>
            <span className="nc-also-p">{r.path}</span>
          </span>
          {r.here ? (
            <span className="nc-here">here</span>
          ) : (
            <span className="nc-also-n">
              {r.drawn ? `${r.drawn} connection${r.drawn === 1 ? "" : "s"}` : "no connections"}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

// ---- a row, opened -----------------------------------------------------------------------

function Sub({
  row,
  name,
  back,
  children,
}: {
  row: Row;
  name: string;
  back: () => void;
  children: ReactNode;
}) {
  return (
    <>
      <button className="nc-crumb" onClick={back} data-tip={`Back to ${name} (Esc)`}>
        <ArrowLeft size={14} />
        <span className="nc-crumb-from">{name}</span>/<b>{ROW_NAME[row]}</b>
      </button>
      <div className="nc-subbody">{children}</div>
    </>
  );
}

interface Suggestion {
  /** What's put in: the name, the package… */
  value: string;
  label?: ReactNode;
  /** On the right: "4 others", "cargo 0.7.5"… */
  meta?: string;
  /** A new one (made on Enter), not something that's there: Tab doesn't complete it. */
  isNew?: boolean;
}

/**
 * The input on top of a row's list. Suggestions under it: arrows to move, Tab finishes the word
 * with the highlighted one, Enter adds (it, or what's typed). Backspace on empty, or Esc, goes back.
 */
function AddInput({
  placeholder,
  suggest,
  onAdd,
  back,
  mono,
  multiline,
  autoFocus = true,
  before,
  after,
  complete,
}: {
  placeholder: string;
  suggest?: (q: string) => Suggestion[];
  onAdd: (value: string, picked?: Suggestion) => void | string | false;
  back: () => void;
  mono?: boolean;
  multiline?: boolean;
  autoFocus?: boolean;
  before?: ReactNode;
  after?: (q: string) => ReactNode;
  /** What Tab puts in the field for a suggestion (default: its value). */
  complete?: (q: string, s: Suggestion) => string;
}) {
  const [q, setQ] = useState("");
  const [pick, setPick] = useState(0);
  const [err, setErr] = useState("");
  const list = useMemo(() => suggest?.(q) ?? [], [q, suggest]);
  const at = Math.min(pick, Math.max(0, list.length - 1));
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  useEffect(() => {
    if (autoFocus) setTimeout(() => ref.current?.focus(), 30);
  }, [autoFocus]);
  const add = (picked?: Suggestion) => {
    const r = onAdd(picked && !picked.isNew ? picked.value : q.trim(), picked);
    if (typeof r === "string") return setErr(r);
    if (r === false) return;
    setQ("");
    setErr("");
    setPick(0);
  };
  const keys = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "ArrowDown" && list.length)
      return (e.preventDefault(), setPick(Math.min(at + 1, list.length - 1)));
    if (e.key === "ArrowUp" && list.length)
      return (e.preventDefault(), setPick(Math.max(at - 1, 0)));
    if (e.key === "Tab" && list[at] && !list[at]!.isNew)
      return (
        e.preventDefault(),
        setQ(complete ? complete(q, list[at]!) : list[at]!.value),
        setPick(0)
      );
    if (e.key === "Escape" || (e.key === "Backspace" && !q)) return (e.preventDefault(), back());
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (list[at] && !list[at]!.isNew) return add(list[at]);
      if (q.trim()) add(list[at]?.isNew ? list[at] : undefined);
    }
  };
  const field = multiline ? (
    <textarea
      ref={ref}
      className="nc-in"
      rows={2}
      value={q}
      placeholder={placeholder}
      onChange={(e) => (setQ(e.target.value), setErr(""))}
      onKeyDown={keys}
    />
  ) : (
    <input
      ref={ref}
      className={`nc-in${mono ? " mono" : ""}`}
      value={q}
      placeholder={placeholder}
      autoComplete="off"
      spellCheck={false}
      onChange={(e) => (setQ(e.target.value), setErr(""))}
      onKeyDown={keys}
    />
  );
  return (
    <div className="nc-add">
      <div className="nc-add-row">
        {before}
        {field}
        {after?.(q)}
      </div>
      {list.length > 0 && (
        <div className="nc-sugg">
          {list.map((s, i) => (
            <button
              key={`${s.value}${s.isNew ? "+" : ""}`}
              className={i === at ? "on" : ""}
              onMouseDown={(e) => (e.preventDefault(), add(s))}
              onMouseEnter={() => setPick(i)}
            >
              <span className="nc-sugg-v">{s.label ?? s.value}</span>
              {s.meta && <span className="nc-sugg-m">{s.meta}</span>}
            </button>
          ))}
        </div>
      )}
      {err && <div className="nc-err">{err}</div>}
    </div>
  );
}

/** One more quick field after adding something that needs it: a guess filled in and selected; Enter keeps it, Esc skips. */
function FollowUp({
  label,
  guess,
  done,
}: {
  label: string;
  guess: string;
  done: (v: string | null) => void;
}) {
  const [v, setV] = useState(guess);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setTimeout(() => (ref.current?.focus(), ref.current?.select()), 30);
  }, []);
  return (
    <div className="nc-add">
      <div className="nc-add-row">
        <span className="nc-follow">{label}</span>
        <input
          ref={ref}
          className="nc-in"
          value={v}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") (e.preventDefault(), done(v.trim() || guess));
            else if (e.key === "Escape" || (e.key === "Backspace" && !v))
              (e.preventDefault(), done(null));
          }}
        />
      </div>
      <div className="nc-hint">Enter keeps it · Esc skips</div>
    </div>
  );
}

function RowView(
  p: NodeCardProps & {
    row: Row;
    save: (patch: Partial<ModelObject>, label: string) => void;
    links: Link[];
    done: () => void;
  },
) {
  switch (p.row) {
    case "tech":
      return <TechView {...p} />;
    case "tags":
      return <TagsView {...p} />;
    case "refs":
      return <RefsView {...p} />;
    case "libs":
      return <LibsView {...p} />;
    case "entities":
      return <EntitiesView {...p} />;
    case "notes":
      return <NotesView {...p} />;
    case "comments":
      return <CommentsView {...p} />;
    case "connects":
      return <ConnectsView {...p} />;
    case "columns":
      return <ColumnsView {...p} />;
    case "context":
      return <ContextView {...p} />;
  }
}

type ViewProps = NodeCardProps & {
  save: (patch: Partial<ModelObject>, label: string) => void;
  links: Link[];
  done: () => void;
  /** The ops a change makes (a box's update, unless it's a connection's). */
  update?: (patch: Partial<ModelObject>) => Op[];
  /** These rows are a connection's: its entities are what it carries. */
  on?: "connection";
  /** A connection's arrow is drawn on this diagram (so a comment can pin to it). */
  drawn?: boolean;
};

function Item({
  children,
  onRemove,
  onClick,
  tip,
}: {
  children: ReactNode;
  onRemove?: () => void;
  onClick?: () => void;
  tip?: string;
}) {
  return (
    <div className={`nc-item${onClick ? " click" : ""}`} onClick={onClick} data-tip={tip}>
      {children}
      {onRemove && (
        <button
          className="nc-x"
          aria-label="Remove"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}

const None = ({ children }: { children?: ReactNode }) => (
  <div className="nc-none">{children ?? "Nothing yet."}</div>
);

/** Its tech on the card: chips to read; a click opens them to change. Nothing yet: a "+ tech" chip. */
function TechLine({
  o,
  idx,
  open,
  canEdit,
}: {
  o: ModelObject;
  idx: ModelIndex;
  open: (r: Row) => void;
  canEdit: boolean;
}) {
  const have = techsOf(o.technology);
  if (!have.length)
    return canEdit ? (
      <div className="nc-addbar nc-tech">
        <button onClick={() => open("tech")}>
          {o.kind === "actor" ? "+ who: a role, a team" : "+ tech"}
        </button>
      </div>
    ) : null;
  return (
    <div className="nc-tech">
      {have.map((t) => {
        const n = sharingTech(idx, t).length;
        return (
          <button
            key={t}
            className="nc-chip"
            onClick={() => open("tech")}
            data-tip={n > 1 ? `${n} things use ${t}` : `Only this uses ${t}`}
          >
            {t}
          </button>
        );
      })}
    </div>
  );
}

/** Tech: the design's list first (so it joins up), then a new one. */
function TechView(p: ViewProps) {
  const { o, idx } = p;
  const have = techsOf(o.technology);
  const all = useMemo(() => designTechs(idx), [idx]);
  const set = (list: string[], label: string) => p.save({ technology: list.join(", ") }, label);
  return (
    <>
      {p.canEdit && (
        <AddInput
          placeholder={
            o.kind === "actor" ? "Who: a role, a team…" : "Tech: Postgres, Rust, Stripe…"
          }
          back={p.done}
          suggest={(q) => {
            const t = q.trim().toLowerCase();
            if (!t) return [];
            const hits = all.filter(
              (x) =>
                x.name.toLowerCase().startsWith(t) &&
                !have.some((h) => h.toLowerCase() === x.name.toLowerCase()),
            );
            return hits.length
              ? hits.slice(0, 6).map((x) => ({ value: x.name, meta: `${x.count} use it` }))
              : [{ value: q.trim(), meta: "new", isNew: true }];
          }}
          onAdd={(v) => {
            const name =
              all.find((x) => x.name.toLowerCase() === v.toLowerCase())?.name ?? v.trim();
            if (!name) return false;
            if (have.some((h) => h.toLowerCase() === name.toLowerCase())) return "Already there";
            set([...have, name], `add ${name}`);
          }}
        />
      )}
      {have.map((t) => {
        const n = sharingTech(idx, t).length - 1;
        return (
          <Item
            key={t}
            onRemove={
              p.canEdit
                ? () =>
                    set(
                      have.filter((h) => h !== t),
                      `remove ${t}`,
                    )
                : undefined
            }
          >
            <span className="nc-chip static">{t}</span>
            <span className="nc-meta">{n ? `${n} other${n === 1 ? "" : "s"}` : "only this"}</span>
          </Item>
        );
      })}
      {!have.length && <None>What it's built with or runs on. The first one picks its logo.</None>}
    </>
  );
}

/** Tags: like references, a shared list across the design. A tag is made by typing it. */
function TagsView(p: ViewProps) {
  const { o, idx } = p;
  const all = useMemo(() => {
    const n = new Map<string, number>();
    for (const x of idx.objects.values())
      if (x.status !== "removed") for (const t of x.tags) n.set(t, (n.get(t) ?? 0) + 1);
    return n;
  }, [idx]);
  const clean = (t: string) => t.trim().replace(/^#/, "").replace(/\s+/g, "-");
  return (
    <>
      {p.canEdit && (
        <AddInput
          placeholder="A tag: team-orders, owner:sam, pci…"
          back={p.done}
          suggest={(q) => {
            const t = clean(q).toLowerCase();
            if (!t) return [];
            const have = [...all]
              .filter(([x]) => x.toLowerCase().startsWith(t) && !o.tags.includes(x))
              .map(([x, n]) => ({
                value: x,
                label: `#${x}`,
                meta: `${n - (o.tags.includes(x) ? 1 : 0)} other${n === 1 ? "" : "s"}`,
              }));
            return have.length
              ? have.slice(0, 6)
              : [{ value: clean(q), label: `#${clean(q)}`, meta: "new", isNew: true }];
          }}
          onAdd={(v) => {
            const t = clean(v);
            if (!t) return false;
            if (o.tags.includes(t)) return "Already tagged";
            p.save({ tags: [...o.tags, t] }, `tag ${t}`);
          }}
        />
      )}
      {o.tags.map((t) => (
        <Item
          key={t}
          onRemove={
            p.canEdit
              ? () => p.save({ tags: o.tags.filter((x) => x !== t) }, `untag ${t}`)
              : undefined
          }
        >
          <span className="nc-tag">#{t}</span>
          <span className="nc-meta">
            {(all.get(t) ?? 1) - 1
              ? `${(all.get(t) ?? 1) - 1} other${(all.get(t) ?? 1) - 1 === 1 ? "" : "s"}`
              : "only this"}
          </span>
        </Item>
      ))}
      {!o.tags.length && (
        <None>
          Tags say who owns it, or what it's subject to (pci, team-orders). Each tag lights up
          everything that has it.
        </None>
      )}
    </>
  );
}

const REF_NAME: Record<RefRow["kind"], string> = {
  link: "link",
  image: "image",
  doc: "doc",
  code: "code",
  dependency: "library",
  entity: "entity",
};

/** References: paste anything; what it is shows before Enter. A link gets a name after (a guess, Enter keeps it). */
function RefsView(p: ViewProps) {
  const { o, idx } = p;
  const rows = referencesOf(idx, o).filter((r) => r.kind !== "dependency");
  const [naming, setNaming] = useState<string | null>(null);
  const remove = (r: RefRow) => {
    if (r.kind === "link")
      p.save({ links: (o.links ?? []).filter((_, i) => i !== r.at) }, `unlink ${r.title}`);
    else
      p.save(
        { references: (o.references ?? []).filter((_, i) => i !== r.at) },
        `remove ${r.title}`,
      );
  };
  const add = (raw: string): string | void => {
    const to = raw.trim();
    const kind = detectRef(to);
    if (!kind) return "A link (https://…), a doc (.md), an image, or code (repo:path)";
    if (kind === "link") {
      const url = safeUrl(to);
      if (!url) return "An http or https address";
      if (o.links?.some((l) => l.url === url)) return "Already linked";
      setNaming(url);
      return;
    }
    if (kind === "image" && /^[a-z]+:/i.test(to) && !safeUrl(to)) return "An http or https address";
    if (
      (kind === "image" || kind === "doc") &&
      !/^https?:/i.test(to) &&
      (to.startsWith("/") || to.split("/").includes(".."))
    )
      return "A path inside the design (docs/x.md)";
    p.save(
      {
        references: [
          ...(o.references ?? []),
          { kind, to: kind === "image" && /^https?:/i.test(to) ? safeUrl(to)! : to },
        ],
      },
      `add ${kind} ${to}`,
    );
  };
  return (
    <>
      {p.canEdit &&
        (naming ? (
          <FollowUp
            label="Name"
            guess={linkName(naming)}
            done={(title) => {
              p.save(
                { links: [...(o.links ?? []), { title: title ?? linkName(naming), url: naming }] },
                `link ${title ?? linkName(naming)}`,
              );
              setNaming(null);
            }}
          />
        ) : (
          <AddInput
            autoFocus={!p.on}
            placeholder="Paste a link, a doc, an image, a path to code…"
            back={p.done}
            onAdd={(v) => add(v) ?? undefined}
            after={(q) => {
              const k = detectRef(q);
              return k && <span className={`nc-badge ref-${k}`}>{REF_NAME[k]}</span>;
            }}
          />
        ))}
      {rows.map((r) => (
        <Item key={`${r.kind}:${r.to}`} onRemove={p.canEdit ? () => remove(r) : undefined}>
          <span className="nc-it-t">
            {r.kind === "link" || /^https?:/.test(r.to) ? (
              <a
                href={r.to}
                target="_blank"
                rel="noreferrer noopener"
                onClick={(e) => e.stopPropagation()}
              >
                {r.title}
              </a>
            ) : (
              <span>{r.title}</span>
            )}
            {r.title !== r.to && (
              <span className="nc-meta ellipsis">{r.to.replace(/^https?:\/\//, "")}</span>
            )}
          </span>
          <span className={`nc-badge ref-${r.kind}`}>{REF_NAME[r.kind]}</span>
        </Item>
      ))}
      {!rows.length && <None />}
    </>
  );
}

const ECO_GUESS = (name: string): Ecosystem =>
  name.startsWith("@") || /^(react|next|express|vue|svelte|lodash|zod)/.test(name)
    ? "npm"
    : "other";
const REGISTRY: Partial<Record<Ecosystem, (n: string) => string>> = {
  cargo: (n) => `https://docs.rs/${n}`,
  npm: (n) => `https://www.npmjs.com/package/${n}`,
  pypi: (n) => `https://pypi.org/project/${n}`,
  go: (n) => `https://pkg.go.dev/${n}`,
};

/** Libraries: the design's own first (so it joins up), then a new one; a new one asks where its docs are. */
/**
 * The shapes it uses, owns or implements. Typing a name links one (a new name makes it, with
 * this box as where it's defined, and opens its fields); each opens to its fields, the
 * table's grid. See docs/entities-plan.md.
 */
function EntitiesView(p: ViewProps) {
  const { o, idx } = p;
  const mine = entitiesOf(idx, o);
  const all = useMemo(() => [...idx.entities.values()], [idx]);
  const [open, setOpen] = useState<string | null>(null);
  const editing = open ? idx.entities.get(open) : undefined;
  if (editing) return <EntityEditor {...p} e={editing} close={() => setOpen(null)} />;
  const link = (e: Entity, extra: Op[] = []) => {
    if (o.references?.some((r) => r.kind === "entity" && r.to === e.id)) return "Already listed";
    void p.run(
      [
        ...extra,
        ...(p.update ?? ((x) => updateObject(o, x)))({
          references: [...(o.references ?? []), { kind: "entity", to: e.id }],
        }),
      ],
      p.on ? `carries ${e.name}` : `uses ${e.name}`,
    );
  };
  const meta = (e: Entity) => {
    const shape = entityShape(e);
    const n = e.values?.length ?? e.fields.length;
    const src = e.sourceId && e.sourceId !== o.id ? idx.objects.get(e.sourceId)?.name : null;
    return [
      shape === "TBD"
        ? "TBD"
        : `${shape} · ${n} ${e.values?.length ? "value" : "field"}${n === 1 ? "" : "s"}`,
      src ? `from ${src}` : null,
      `${usersOf(idx, e.id).length} use it`,
    ]
      .filter(Boolean)
      .join(" · ");
  };
  return (
    <>
      {p.canEdit && (
        <AddInput
          mono
          autoFocus={!p.on}
          placeholder={p.on ? "What it carries: Order" : "An entity: Order, or PaidOrder : Order"}
          back={p.done}
          suggest={(q) => {
            const t = q.trim().toLowerCase();
            if (!t || t.includes(":")) return [];
            return all
              .filter((e) => e.name.toLowerCase().startsWith(t) && !mine.some((m) => m.id === e.id))
              .sort((a, b) => a.name.localeCompare(b.name))
              .slice(0, 6)
              .map((e) => ({ value: e.id, label: e.name, meta: meta(e) }));
          }}
          complete={(_, s) => String(s.label)}
          onAdd={(v, picked) => {
            const have = picked ? idx.entities.get(picked.value) : entityNamed(idx, v.trim());
            if (have) return link(have);
            const { name, extends: parents, error } = parseEntityName(v);
            if (error) return `A name as code would write it (Order, PaymentProvider): ${error}`;
            // Parents that don't exist yet become TBD entities, like any new type.
            const made: Op[] = [];
            const ext = parents.map((n) => {
              const e = entityNamed(idx, n) ?? makeEntity(n);
              if (!idx.entities.has(e.id)) made.push({ op: "entity.put", entity: e });
              return e.id;
            });
            // Made on a connection: defined where it comes from (the caller).
            const e = {
              ...makeEntity(name, p.on ? (o as unknown as Connection).fromId : o.id),
              ...(ext.length ? { extends: ext } : {}),
            };
            link(e, [...made, { op: "entity.put", entity: e }]);
            setOpen(e.id);
          }}
        />
      )}
      {mine.map((e) => (
        <Item
          key={e.id}
          onRemove={
            p.canEdit
              ? () =>
                  p.save(
                    {
                      references: (o.references ?? []).filter(
                        (r) => !(r.kind === "entity" && r.to === e.id),
                      ),
                    },
                    p.on ? `stop carrying ${e.name}` : `stop using ${e.name}`,
                  )
              : undefined
          }
          onClick={() => setOpen(e.id)}
          tip={
            isTbd(e) ? `${e.name} is just a name so far: give it fields` : `${e.name}: its fields`
          }
        >
          <span className="nc-it-t">
            <span className={`mono${isTbd(e) ? " nc-tbd" : ""}`}>
              {e.name}
              {e.extends?.length ? (
                <span className="nc-meta">
                  {" "}
                  : {e.extends.map((x) => idx.entities.get(x)?.name ?? x).join(", ")}
                </span>
              ) : null}
            </span>
            <span className="nc-meta">{meta(e)}</span>
          </span>
        </Item>
      ))}
      {!mine.length && (
        <None>
          {p.on
            ? "What travels over it: Order, PaidOrder."
            : "The shapes it passes, returns, stores or implements: Order, PaymentProvider. A function's signature adds them by itself."}
        </None>
      )}
    </>
  );
}

/** One entity: its name (": Parent" for what it extends), where it's defined, and its fields in the table's grid. */
function EntityEditor(p: ViewProps & { e: Entity; close: () => void }) {
  const { e, idx, o } = p;
  // Saves build on the entity as it is now: the grid saves once more as it goes, after other edits.
  const latest = useRef({ e, idx });
  latest.current = { e: idx.entities.get(e.id) ?? e, idx };
  const put = (next: Partial<Entity>, label: string, extra: Op[] = []) => {
    const cur = latest.current.e;
    // Types its fields name that aren't entities yet become TBD ones, like a signature's.
    const made = (next.fields ?? []).flatMap((f) =>
      signatureTypes(splitField(f)[1] || (/\(/.test(f) ? f.replace(/^[^(]*/, "") : "")),
    );
    const fresh = [...new Set(made)].filter(
      (n) =>
        n !== (next.name ?? cur.name) &&
        !entityNamed(latest.current.idx, n) &&
        !extra.some((x) => x.op === "entity.put" && x.entity.name === n),
    );
    void p.run(
      [
        ...extra,
        ...fresh.map((n): Op => ({ op: "entity.put", entity: makeEntity(n) })),
        { op: "entity.put", entity: { ...cur, ...next, updatedAt: new Date().toISOString() } },
      ],
      label,
    );
  };
  const source = e.sourceId ? idx.objects.get(e.sourceId) : undefined;
  const parents = (e.extends ?? []).map((x) => idx.entities.get(x)?.name ?? x);
  const shape = entityShape(e);
  // An enum: its values, one a row; otherwise its fields as name and type.
  const isEnum = !!e.values?.length;
  return (
    <>
      <button className="nc-crumb nc-crumb-in" onClick={p.close} data-tip="Back to the list">
        <ArrowLeft size={14} />
        <span className="nc-crumb-from">Entities</span>/<b>{e.name}</b>
      </button>
      <div className="nc-facts">
        <span className="nc-fk">Name</span>
        <TextField
          className="mono nc-fv"
          value={parents.length ? `${e.name} : ${parents.join(", ")}` : e.name}
          placeholder="Order, or PaidOrder : Order"
          onCommit={(v) => {
            if (!p.canEdit) return;
            const { name, extends: names, error } = parseEntityName(v);
            // Not a type name (PaidOrder): left as it was.
            if (error || (entityNamed(idx, name) && entityNamed(idx, name)!.id !== e.id)) return;
            const made: Op[] = [];
            const ext = names
              .map((n) => {
                const x = entityNamed(idx, n) ?? makeEntity(n);
                if (!idx.entities.has(x.id)) made.push({ op: "entity.put", entity: x });
                return x.id;
              })
              .filter((x) => x !== e.id);
            put({ name, extends: ext.length ? ext : undefined }, `rename ${e.name}`, made);
          }}
        />
        <span className="nc-fk">Is</span>
        <span className="nc-fv">
          {shape === "TBD" ? <span className="nc-tbd">TBD: just a name so far</span> : shape}
        </span>
        <span className="nc-fk">From</span>
        <span className="nc-fv">
          {source ? (
            source.id === o.id ? (
              <span>{source.name} (here)</span>
            ) : (
              <button
                className="nc-src"
                onClick={() => p.onGoTo(source.id)}
                data-tip={`Go to ${source.name}, where ${e.name} is defined`}
              >
                {source.name} ↗
              </button>
            )
          ) : (
            <span className="muted">nothing yet</span>
          )}
          {p.canEdit && !p.on && e.sourceId !== o.id && (
            <button
              className="nc-src nc-move"
              onClick={() => put({ sourceId: o.id }, `${e.name} is defined in ${o.name}`)}
              data-tip={`Make ${o.name} where ${e.name} is defined`}
            >
              Move here
            </button>
          )}
        </span>
      </div>
      <FieldGrid
        key={`${e.id}:${isEnum}`}
        head={isEnum ? ["value", ""] : ["field", "type"]}
        rows={isEnum ? e.values!.map((v) => [v, ""] as [string, string]) : e.fields.map(splitField)}
        canEdit={p.canEdit}
        onDone={p.close}
        onSave={(rows) => {
          const lines = rows.map(([n, t]) => `${n} ${t}`.trim()).filter(Boolean);
          // "pending, paid, cancelled" as the only line: an enum.
          if (!isEnum && lines.length === 1 && /,/.test(lines[0]!) && !/[()]/.test(lines[0]!)) {
            const values = lines[0]!
              .split(",")
              .map((x) => x.trim())
              .filter(Boolean);
            return put({ fields: [], values }, `${e.name} is an enum`);
          }
          if (isEnum) {
            const values = rows.map(([n]) => n.trim()).filter(Boolean);
            if (JSON.stringify(values) !== JSON.stringify(e.values))
              put({ values: values.length ? values : undefined }, `edit ${e.name}`);
            return;
          }
          if (JSON.stringify(lines) !== JSON.stringify(e.fields))
            put({ fields: lines }, `edit ${e.name}`);
        }}
      />
    </>
  );
}

function LibsView(p: ViewProps) {
  const { o, idx } = p;
  const rows = referencesOf(idx, o).filter((r) => r.kind === "dependency");
  const libs = useMemo(
    () => [...idx.objects.values()].filter((x) => x.kind === "library" && x.status !== "removed"),
    [idx],
  );
  const [docsFor, setDocsFor] = useState<ModelObject | null>(null);
  const link = (lib: ModelObject, extra: Op[] = []) => {
    if (o.references?.some((r) => r.kind === "dependency" && r.to === lib.id))
      return "Already listed";
    void p.run(
      [
        ...extra,
        ...updateObject(o, {
          references: [...(o.references ?? []), { kind: "dependency", to: lib.id }],
        }),
      ],
      `uses ${lib.name}`,
    );
  };
  return (
    <>
      {p.canEdit &&
        (docsFor ? (
          <FollowUp
            label="Docs"
            guess={libraryDocs(docsFor) ?? ""}
            done={(url) => {
              const safe = url && safeUrl(url);
              const lib = {
                ...docsFor,
                ...(safe ? { links: [{ title: "Docs", url: safe }] } : {}),
              };
              link(lib, [{ op: "object.put", object: lib }]);
              setDocsFor(null);
            }}
          />
        ) : (
          <AddInput
            mono
            placeholder="A package: axum, react@18, cargo:sqlx"
            back={p.done}
            suggest={(q) => {
              const t = q.trim().toLowerCase();
              if (!t || /[:@]/.test(t.slice(1))) return [];
              return libs
                .filter(
                  (l) => l.name.toLowerCase().startsWith(t) && !rows.some((r) => r.to === l.id),
                )
                .slice(0, 6)
                .map((l) => ({
                  value: l.id,
                  label: l.name,
                  meta: [
                    [l.package?.ecosystem, l.package?.version].filter(Boolean).join(" "),
                    `${referencedBy(idx, l.id).length} use it`,
                  ]
                    .filter(Boolean)
                    .join(" · "),
                }));
            }}
            complete={(_, s) => String(s.label)}
            onAdd={(v, picked) => {
              const have = picked
                ? libs.find((l) => l.id === picked.value)
                : libs.find((l) => l.name.toLowerCase() === v.toLowerCase());
              if (have) return link(have);
              const pkg = parsePackage(v);
              if (!pkg) return "A package name: axum, react@18, cargo:sqlx";
              const eco = pkg.ecosystem ?? ECO_GUESS(pkg.name);
              const lib = makeObject({
                kind: "library",
                name: pkg.name,
                package: {
                  ecosystem: eco,
                  name: pkg.name,
                  ...(pkg.version ? { version: pkg.version } : {}),
                },
              });
              // Where its docs are: the registry's page is the guess (Enter keeps it).
              if (!libraryDocs(lib) && REGISTRY[eco])
                lib.links = [{ title: "Docs", url: REGISTRY[eco]!(pkg.name) }];
              setDocsFor(lib);
            }}
          />
        ))}
      {rows.map((r) => {
        const lib = idx.objects.get(r.to);
        const docs = lib && libraryDocs(lib);
        return (
          <Item
            key={r.to}
            onRemove={
              p.canEdit
                ? () =>
                    p.save(
                      { references: (o.references ?? []).filter((_, i) => i !== r.at) },
                      `stop using ${r.title}`,
                    )
                : undefined
            }
            onClick={() => p.onGoTo(r.to)}
            tip={`Go to ${r.title}`}
          >
            <span className="nc-it-t">
              <span className="mono">{r.title}</span>
              <span className="nc-meta">
                {[lib?.package?.ecosystem, lib?.package?.version].filter(Boolean).join(" ") ||
                  "library"}
                {" · "}
                {docs ? (
                  <a
                    href={docs}
                    target="_blank"
                    rel="noreferrer noopener"
                    onClick={(e) => e.stopPropagation()}
                  >
                    docs
                  </a>
                ) : (
                  <span className="nc-warn">no docs link</span>
                )}
                {` · ${referencedBy(idx, r.to).length} use it`}
              </span>
            </span>
          </Item>
        );
      })}
      {!rows.length && <None />}
    </>
  );
}

function NotesView(p: ViewProps) {
  const { o } = p;
  const items = noteItems(o.notes ?? "");
  const set = (md: string, label: string) => p.save({ notes: md.trim() || undefined }, label);
  return (
    <>
      {p.canEdit && (
        <AddInput
          multiline
          placeholder="A note (Enter adds it, Shift+Enter for a new line)"
          back={p.done}
          onAdd={(v) => (v ? set(addNote(o.notes ?? "", v), "add a note") : false)}
        />
      )}
      {items.map((t, i) => (
        <Item
          key={`${i}:${t.slice(0, 20)}`}
          onRemove={
            p.canEdit ? () => set(removeNote(o.notes ?? "", i), "remove a note") : undefined
          }
        >
          <span className="nc-note">{t}</span>
        </Item>
      ))}
      {!items.length && (
        <None>
          {p.on === "connection"
            ? "Notes stay on the connection: what's still needed, open questions. They aren't drawn."
            : "Notes stay in the box: what's still needed, open questions. They aren't drawn."}
        </None>
      )}
    </>
  );
}

function commentsOf(idx: ModelIndex, id: string, on?: "connection") {
  if (on === "connection")
    return [...idx.notes.values()]
      .filter((n) => n.kind === "note" && !n.resolved && n.connectionId === id)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return notesAbout(idx, id)
    .filter((n) => n.kind === "note" && (n.objectId === id || n.about === id))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function CommentsView(p: ViewProps) {
  const all = commentsOf(p.idx, p.o.id, p.on);
  const people = useMemo(() => {
    const s = new Set<string>();
    for (const n of p.idx.notes.values()) s.add(n.author.name);
    return [...s].filter(Boolean);
  }, [p.idx]);
  const arrow = p.on === "connection";
  const placed = arrow ? !!p.drawn : !!p.idx.placements.get(p.diagramId)?.has(p.o.id);
  return (
    <>
      {p.canEdit && placed && (
        <AddInput
          multiline
          placeholder={`Comment… (@ to mention; it's pinned on the ${arrow ? "arrow" : "box"})`}
          back={p.done}
          suggest={(q) => {
            const m = q.match(/@(\w*)$/);
            return m
              ? people
                  .filter((n) => n.toLowerCase().startsWith(m[1]!.toLowerCase()))
                  .map((n) => ({ value: n, label: `@${n}` }))
              : [];
          }}
          complete={(q, s) => q.replace(/@\w*$/, `@${s.value} `)}
          onAdd={(v, picked) => {
            if (picked) return false; // picking a person finishes the mention (Tab does the same)
            if (!v) return false;
            p.onComment(v);
          }}
        />
      )}
      {all.map((n) => {
        const replies = p.idx.replies.get(n.id)?.length ?? 0;
        return (
          <Item key={n.id} onClick={() => p.onOpenNote(n.id)} tip="Open the thread on the canvas">
            <span className="nc-it-t">
              <span className="nc-note">{n.text}</span>
              <span className="nc-meta">
                {n.author.name} · {n.updatedAt.slice(0, 10)}
                {replies ? ` · ${replies} repl${replies === 1 ? "y" : "ies"}` : ""}
                {n.resolved ? " · resolved" : ""}
              </span>
            </span>
          </Item>
        );
      })}
      {!all.length && (
        <None>
          {placed
            ? `Comments are threads pinned ${arrow ? "on the arrow" : "beside the box"} on the canvas.`
            : `Comments are pinned on a diagram: open one ${arrow ? "its arrow is drawn" : "it's"} on to comment.`}
        </None>
      )}
    </>
  );
}

/** Connections: every one, its label editable in place. New ones are drawn on the canvas (C). */
function ConnectsView(p: ViewProps) {
  return (
    <>
      {p.links.map((l) => (
        <Item
          key={l.key}
          onRemove={
            p.canEdit
              ? () =>
                  void p.run(
                    [{ op: "connection.delete", id: l.c.id }],
                    `disconnect ${l.other.name}`,
                  )
              : undefined
          }
        >
          <span className="nc-dir">{l.dir}</span>
          <KindDot kind={l.other.kind} external={l.other.external} />
          <button className="linkish nc-who" onClick={() => p.onGoTo(l.other.id)}>
            {l.other.name}
          </button>
          {l.keys ? (
            <span className="nc-via mono">{l.keys}</span>
          ) : (
            <ViaField c={l.c} run={p.run} canEdit={p.canEdit} />
          )}
        </Item>
      ))}
      {!p.links.length && <None />}
    </>
  );
}

function ViaField({ c, run, canEdit }: { c: Connection; run: Run; canEdit: boolean }) {
  const [v, setV] = useState(c.name);
  const ref = useRef<HTMLInputElement>(null);
  const commit = () =>
    v.trim() !== c.name && void run(updateConnection(c, { name: v.trim() }), "name connection");
  return (
    <input
      ref={ref}
      className="nc-via-in"
      value={v}
      readOnly={!canEdit}
      placeholder="what for"
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") (e.preventDefault(), commit(), ref.current?.blur());
      }}
    />
  );
}

/** Its whole context, in markdown. */
function ContextView(p: ViewProps) {
  const text = mergedContext(p.o.description, p.o.context);
  return (
    <div className="nc-context">
      <TextField
        multiline
        className="nc-context-in"
        value={text}
        placeholder="What it does, why, anything that helps… (markdown). The first line is what the card shows."
        onCommit={(t) =>
          p.canEdit &&
          t.trim() !== text.trim() &&
          p.save({ description: t.trim(), context: undefined }, "set context")
        }
      />
      <div className="nc-hint">The first line is its summary on the card.</div>
    </div>
  );
}

/** A table's columns: the grid (name, type; `?` when it can be empty). */
function ColumnsView(p: ViewProps) {
  const { o, idx } = p;
  const box = idx.placements.get(p.diagramId)?.get(o.id);
  const showing = !!box && tableShowsColumns(box.h);
  const setShowing = (on: boolean) => {
    if (!box || on === showing) return;
    void p.run(
      [
        {
          op: "placement.put",
          placement: {
            ...box,
            h: on ? tableOpenHeight(o.columns?.length ?? 0) : CARD_H,
            w: on ? Math.max(box.w, 240) : box.w,
          },
        },
      ],
      on ? "show columns" : "fold columns",
    );
  };
  const cols = o.columns ?? [];
  return (
    <>
      <FieldGrid
        head={["column", "type"]}
        rows={cols.map((c) => [c.name, `${c.type}${c.nullable ? "?" : ""}`])}
        canEdit={p.canEdit}
        keepFirst
        onDone={p.done}
        onSave={(rows) => {
          const next: Column[] = rows.map(([name, type]) => {
            const was = cols.find((c) => c.name === name);
            const t = type.trim();
            return {
              ...was,
              name,
              type: t.replace(/\?$/, "") || "text",
              ...(t.endsWith("?") ? { nullable: true } : { nullable: undefined }),
            };
          });
          if (JSON.stringify(next) !== JSON.stringify(cols))
            p.save({ columns: next }, "edit columns");
        }}
      />
      {box && (
        <div className="nc-seg" role="radiogroup" aria-label="Columns on the canvas">
          <button
            className={showing ? "on" : ""}
            disabled={!p.canEdit}
            onClick={() => setShowing(true)}
          >
            Columns on the canvas
          </button>
          <button
            className={showing ? "" : "on"}
            disabled={!p.canEdit}
            onClick={() => setShowing(false)}
          >
            Folded
          </button>
        </div>
      )}
    </>
  );
}

/**
 * The grid a table's columns (and an entity's fields) are edited in. Enter: next; arrows move;
 * Backspace on an empty type goes back to its name, on an empty row takes the row away (never the
 * first, with keepFirst); Enter on an empty row: done. Saved as you go.
 */
export function FieldGrid({
  head,
  rows: initial,
  canEdit,
  keepFirst,
  onSave,
  onDone,
}: {
  head: [string, string];
  rows: [string, string][];
  canEdit: boolean;
  keepFirst?: boolean;
  onSave: (rows: [string, string][]) => void;
  onDone: () => void;
}) {
  const [rows, setRows] = useState<[string, string][]>(() => [
    ...initial.map((r) => [...r] as [string, string]),
    ["", ""],
  ]);
  const [focus, setFocus] = useState<[number, number] | null>(() =>
    canEdit ? [initial.length, 0] : null,
  );
  const box = useRef<HTMLDivElement>(null);
  const filled = (rs: [string, string][]) =>
    rs.filter(([a]) => a.trim()).map(([a, b]) => [a.trim(), b.trim()] as [string, string]);
  const commit = (rs = rows) => onSave(filled(rs));
  useEffect(() => {
    if (!focus) return;
    const el = box.current?.querySelector<HTMLInputElement>(
      `input[data-r="${focus[0]}"][data-c="${focus[1]}"]`,
    );
    if (el && document.activeElement !== el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [focus, rows.length]);
  const latest = useRef(rows);
  latest.current = rows;
  // Leaving the grid (back, or the card closes) saves what's there.
  useEffect(() => () => onSave(filled(latest.current)), []); // eslint-disable-line react-hooks/exhaustive-deps
  const key = (e: KeyboardEvent<HTMLInputElement>, r: number, c: number) => {
    e.stopPropagation();
    const el = e.currentTarget;
    const go = (rr: number, cc: number) => {
      if (rr < 0 || rr >= rows.length) return;
      e.preventDefault();
      setFocus([rr, cc]);
    };
    if (e.key === "ArrowUp") return go(r - 1, c);
    if (e.key === "ArrowDown") return go(r + 1, c);
    if (e.key === "ArrowRight" && c === 0 && el.selectionStart === el.value.length) return go(r, 1);
    if (e.key === "ArrowLeft" && c === 1 && el.selectionStart === 0) return go(r, 0);
    if (e.key === "Escape") return (e.preventDefault(), commit(), onDone());
    if (e.key === "Backspace" && !el.value && c === 1 && rows[r]![0]) return go(r, 0);
    if (
      e.key === "Backspace" &&
      !el.value &&
      c === 0 &&
      !rows[r]![1] &&
      rows.length > 1 &&
      !(keepFirst && r === 0)
    ) {
      e.preventDefault();
      const next = rows.filter((_, i) => i !== r);
      setRows(next);
      commit(next);
      setFocus([Math.max(0, r - 1), 1]);
      return;
    }
    if (e.key !== "Enter") return;
    e.preventDefault();
    const [a, b] = rows[r]!;
    if (!a.trim() && !b.trim()) return (commit(), onDone());
    if (c === 0 && !b.trim()) return setFocus([r, 1]);
    commit();
    if (r === rows.length - 1) setRows([...rows, ["", ""]]);
    setFocus([r + 1, 0]);
  };
  return (
    <div className="nc-grid" ref={box}>
      <div className="nc-gr h">
        <span>{head[0]}</span>
        <span>{head[1]}</span>
      </div>
      {rows.map(([a, b], r) => (
        <div className="nc-gr" key={r}>
          {[a, b].map((v, c) => (
            <input
              key={c}
              data-r={r}
              data-c={c}
              value={v}
              readOnly={!canEdit}
              placeholder={r === rows.length - 1 ? (c ? "type" : "name") : ""}
              spellCheck={false}
              onFocus={() => setFocus([r, c])}
              onChange={(e) =>
                setRows(
                  rows.map((row, i) =>
                    i === r
                      ? ((c ? [row[0], e.target.value] : [e.target.value, row[1]]) as [
                          string,
                          string,
                        ])
                      : row,
                  ),
                )
              }
              onKeyDown={(e) => key(e, r, c)}
            />
          ))}
        </div>
      ))}
      {canEdit && (
        <div className="nc-hint">
          Enter: next · arrows move · Enter on an empty row: done · <code>?</code> after a type: can
          be empty
        </div>
      )}
    </div>
  );
}

// ---- a connection's card ------------------------------------------------------------------

export interface ConnectionCardProps {
  c: Connection;
  idx: ModelIndex;
  diagramId: string;
  run: Run;
  canEdit: boolean;
  onClose: () => void;
  onRemove: () => void;
  onGoTo: (id: string) => void;
  /** Open another connection's card (from Before / Next). */
  onShowConnection?: (c: Connection) => void;
  onHoverConnection?: (c: Connection | null) => void;
  /** Back to the automatic route, when it has a hand-made one. */
  onResetJoints?: () => void;
  /** Post a comment pinned on its arrow here. */
  onComment?: (text: string) => void;
  onOpenNote?: (noteId: string) => void;
  /** Its arrow is drawn on this diagram. */
  drawn?: boolean;
}

/**
 * A connection's card: the box card's shape (docs/prototypes/node-card.html). What it does on
 * top, its ends where a box has its connections, then a row per thing hung on it.
 */
export function ConnectionCard(p: ConnectionCardProps) {
  const { c, idx } = p;
  const [view, setView] = useState<Row | null>(null);
  const from = idx.objects.get(c.fromId);
  const to = idx.objects.get(c.toId);
  const via = c.viaId ? idx.objects.get(c.viaId) : undefined;
  const save = (patch: Partial<Connection>, label: string) => {
    if (Object.entries(patch).some(([k, v]) => c[k as keyof Connection] !== v))
      void p.run(updateConnection(c, patch), label);
  };
  const update = (patch: Partial<ModelObject>) => updateConnection(c, patch as Partial<Connection>);
  const noop = () => {};
  // The box card's list views read only what a connection has too (links, references, context).
  const view$: ViewProps = {
    o: c as unknown as ModelObject,
    idx,
    run: p.run,
    canEdit: p.canEdit,
    diagramId: p.diagramId,
    onClose: p.onClose,
    onRemove: p.onRemove,
    onGoTo: p.onGoTo,
    onNavigate: noop,
    onComment: p.onComment ?? noop,
    onOpenNote: p.onOpenNote ?? noop,
    save: (patch, label) => save(patch as Partial<Connection>, label),
    links: [],
    done: () => setView(null),
    update,
    on: "connection",
    drawn: p.drawn,
  };
  const before = useMemo(
    () => callsOf(idx, c.fromId).calledBy.filter((x) => x.conn.id !== c.id),
    [idx, c.fromId, c.id],
  );
  const next = useMemo(() => {
    const n = callsOf(idx, c.toId);
    return [...n.calls, ...n.libraries].filter((x) => x.conn.id !== c.id);
  }, [idx, c.toId, c.id]);
  const refs = referencesOf(idx, c);
  const comments = commentsOf(idx, c.id, "connection");
  const carried = (c.references ?? []).flatMap((r) =>
    r.kind === "entity" && idx.entities.get(r.to) ? [idx.entities.get(r.to)!] : [],
  );
  const rows: Parts["rows"] = [
    { row: "carries", n: carried.length, peek: carried.map((e) => e.name).join(", ") },
    { row: "refs", n: refs.length, peek: refs.map((r) => r.title).join(", ") },
    { row: "notes", n: noteItems(c.notes ?? "").length, peek: noteItems(c.notes ?? "")[0] ?? "" },
    { row: "comments", n: comments.length, peek: comments[0]?.text ?? "" },
  ];
  const walk: Parts["rows"] = (
    [
      {
        row: "before",
        n: before.length,
        peek: [...new Set(before.map((x) => x.other.name))].join(", "),
      },
      { row: "next", n: next.length, peek: [...new Set(next.map((x) => x.other.name))].join(", ") },
    ] as Parts["rows"]
  ).filter((r) => r.n > 0);
  const tables = from?.kind === "table" && to?.kind === "table";
  const name = c.name || `${from?.name ?? "?"} → ${to?.name ?? "?"}`;
  return (
    <aside
      className="inspector simple node-card conn-card"
      onKeyDown={(e) => e.key !== "Escape" && e.stopPropagation()}
    >
      <div className={`nc-stack${view ? " in" : ""}`}>
        <div className="nc-view nc-main">
          <div className="nc-head">
            <span className="nc-icon cc-icon">
              <ArrowRight size={15} />
            </span>
            <div className="nc-title">
              <TextField
                className="nc-name flow-field"
                value={c.name}
                placeholder="What it does"
                onCommit={(n) => p.canEdit && save({ name: n.trim() }, "name connection")}
              />
              <div className="nc-kind">
                {"Connection"}
                {c.guess ? " · a guess" : ""}
              </div>
            </div>
            <div className="nc-acts">
              <button className="ib" data-tip="Close (Esc)" onClick={p.onClose}>
                <X size={14} />
              </button>
            </div>
          </div>
          <Summary
            o={c as unknown as ModelObject}
            canEdit={p.canEdit}
            onEdit={() => setView("context")}
            save={(patch, l) => save(patch as Partial<Connection>, l)}
          />
          <div className="nc-facts">
            <span className="nc-fk">Tech</span>
            <TextField
              className="nc-fv flow-field"
              value={c.technology}
              placeholder={p.canEdit ? "HTTPS, gRPC, SQL…" : ""}
              onCommit={(t) => p.canEdit && save({ technology: t.trim() }, "set technology")}
            />
            <span className="nc-fk">Status</span>
            <select
              className="nc-fv cc-select"
              value={c.status}
              disabled={!p.canEdit}
              onChange={(e) =>
                save({ status: e.target.value as Connection["status"] }, "set status")
              }
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            {tables && (
              <>
                <span className="nc-fk">Key</span>
                <span className="nc-fv cc-key">
                  <select
                    className="cc-select mono"
                    value={c.column ?? ""}
                    disabled={!p.canEdit}
                    onChange={(e) =>
                      save({ column: e.target.value || undefined }, "set key column")
                    }
                  >
                    <option value="">which column?</option>
                    {(from.columns ?? []).map((col) => (
                      <option key={col.name} value={col.name}>
                        {col.name}
                      </option>
                    ))}
                  </select>
                  <ArrowRight size={11} className="muted" />
                  <select
                    className="cc-select mono"
                    value={c.toColumn ?? ""}
                    disabled={!p.canEdit}
                    onChange={(e) =>
                      save({ toColumn: e.target.value || undefined }, "set key target")
                    }
                  >
                    <option value="">{to.columns?.find((x) => x.pk)?.name ?? "id"}</option>
                    {(to.columns ?? []).map((col) => (
                      <option key={col.name} value={col.name}>
                        {col.name}
                      </option>
                    ))}
                  </select>
                </span>
              </>
            )}
            {via && (
              <>
                <span className="nc-fk">Through</span>
                <button className="nc-fv linkish" onClick={() => p.onGoTo(via.id)}>
                  {via.name}
                </button>
              </>
            )}
          </div>
          <div className="nc-grow">
            <div className="nc-sect cc-sect">Between</div>
            {[
              { o: from, dir: "from" },
              { o: to, dir: "to" },
            ].map(({ o, dir }) =>
              o ? (
                <button
                  key={dir}
                  className="nc-link"
                  onClick={() => p.onGoTo(o.id)}
                  data-tip={`Go to ${o.name}`}
                >
                  <span className="nc-dir cc-dir">{dir}</span>
                  <KindDot kind={o.kind} external={o.external} />
                  <span
                    className={`nc-who${o.kind === "function" || o.kind === "table" ? " mono" : ""}`}
                  >
                    {o.name}
                  </span>
                  <span className="nc-via">{KIND_LABEL[o.kind]}</span>
                </button>
              ) : null,
            )}
          </div>
          <Rows parts={{ rows: [...rows, ...walk] }} canEdit={p.canEdit} open={setView} />
          <div className="nc-foot">
            {p.canEdit && (
              <button
                className="act"
                onClick={() =>
                  void p.run(
                    updateConnection(c, { fromId: c.toId, toId: c.fromId }),
                    "reverse connection",
                  )
                }
                data-tip="Swap its ends"
              >
                <ArrowLeftRight size={13} />
                <span>Reverse</span>
              </button>
            )}
            {p.canEdit && p.onResetJoints && (
              <button
                className="act"
                onClick={p.onResetJoints}
                data-tip="Back to the automatic route: sides, bends and label"
              >
                <Spline size={13} />
                <span>Reset joints</span>
              </button>
            )}
            <span className="spacer" />
            {p.canEdit && (
              <button className="act danger" onClick={p.onRemove} data-tip="Delete it (⌫)">
                <Trash2 size={13} />
                <span>Delete</span>
              </button>
            )}
          </div>
        </div>
        <div className="nc-view nc-sub">
          {view && (
            <Sub key={view} row={view} name={name} back={() => setView(null)}>
              {view === "carries" && <EntitiesView {...view$} />}
              {view === "refs" && <RefsView {...view$} />}
              {view === "context" && <ContextView {...view$} />}
              {view === "notes" && <NotesView {...view$} />}
              {view === "comments" && <CommentsView {...view$} />}
              {(view === "before" || view === "next") && (
                <CallList
                  calls={view === "before" ? before : next}
                  dir={view === "before" ? "←" : "→"}
                  {...p}
                />
              )}
            </Sub>
          )}
        </div>
      </div>
    </aside>
  );
}

/** The calls into its start (Before) or out of its end (Next): each opens that connection's card. */
function CallList({
  calls,
  dir,
  onShowConnection,
  onHoverConnection,
}: { calls: Call[]; dir: "←" | "→" } & ConnectionCardProps) {
  return (
    <div className="nc-list">
      {calls.map((x) => (
        <button
          key={x.conn.id}
          className="nc-link"
          onClick={() => onShowConnection?.(x.conn)}
          onMouseEnter={() => onHoverConnection?.(x.conn)}
          onMouseLeave={() => onHoverConnection?.(null)}
          data-tip="Open it"
        >
          <span className="nc-dir">{dir}</span>
          <KindDot kind={x.other.kind} external={x.other.external} />
          <span className={`nc-who${x.other.kind === "function" ? " mono" : ""}`}>
            {x.other.name}
          </span>
          <span className="nc-via">
            {[x.conn.name, x.hop ? x.conn.technology || "another process" : ""]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </button>
      ))}
    </div>
  );
}
