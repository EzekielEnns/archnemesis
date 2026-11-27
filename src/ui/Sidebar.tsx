import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  isCodeKind,
  now,
  type Diagram,
  type Flow,
  type ModelObject,
  type Op,
} from "../../shared/model.ts";
import {
  Boxes,
  ChevronRight,
  FileCode,
  Folder,
  FolderOpen,
  Hash,
  Search,
  Sparkles,
  SquareFunction,
  Package,
  Table2,
  Pencil,
  Layers,
  Pin,
  Plus,
  Trash2,
  Route,
  Waypoints,
  X,
  Globe,
} from "lucide-react";
import { ancestors, diagramForScope, type ModelIndex } from "../../shared/project.ts";
import { useMenu, type MenuItem } from "./ContextMenu";
import { deleteObjects, updateObject } from "../../shared/actions.ts";
import { OBJECT_DRAG_TYPE } from "../Workspace";
import { KindDot } from "./KindDot";
import { LIBS, navRows, rowLabel, type NavRow } from "../../shared/navtree.ts";
import { libraryDocs } from "../../shared/references.ts";

interface Props {
  idx: ModelIndex;
  diagramId: string | null;
  /** What's selected on the canvas: the model tree opens to it and marks it. */
  selected?: string[];
  /** Search everything (the ⌘K palette). */
  onSearch?: () => void;
  /** Pinned: stays open while you work. Unpinned: closes when you click the canvas. */
  pinned: boolean;
  onPin: () => void;
  onClose: () => void;
  onNavigate: (diagramId: string) => void;
  onSelectObject: (objectId: string) => void;
  /** Put an object on the current diagram, beside what it connects to. */
  onAddObject: (objectId: string) => void;
  /** ✦ is on: what's new is lit on the diagram and the tree lists only it. */
  showNew?: boolean;
  onShowNew?: () => void;
  /** What's new on this fork (and what it plugs into), for ✦; empty on main. */
  changed?: Set<string>;
  /** What the new things plug into: shown with them when narrowed to what's new. */
  context?: Set<string>;
  /** Git-style marks on a fork: new (+) or changed (±n) things, by id. */
  diffMark?: (id: string) => { added: true } | { plus: number; minus: number } | null;
  onOpen: (objectId: string) => void;
  onNewDiagram: () => void;
  /** Delete a view (right-click on it). The top level can't be deleted. */
  onDeleteDiagram: (diagramId: string) => void;
  /** Change the model (rename, delete from a row's right-click menu); `done` says so with an Undo. */
  run: (ops: Op[], label: string) => Promise<unknown>;
  done: (text: string) => void;
  canEdit: boolean;
  flows: Flow[];
  activeFlow: string | null;
  onOpenFlow: (id: string) => void;
  onNewFlow: () => void;
  tags: { tag: string; count: number }[];
  activeTag: string | null;
  onTag: (tag: string) => void;
  /**
   * The left panel (simple mode) instead of the drawer: its own head, no tabs, just the tree
   * (only the code with `code`). A click on a folder opens its diagram and unfolds it.
   */
  /** The left panel: its head, the code-only tree, or a body of its own instead of the tree (branches). */
  panel?: { head: ReactNode; code?: boolean; body?: ReactNode };
}

const TAGS_SHOWN = 12;

export function Sidebar(props: Props) {
  const { idx, diagramId, onNavigate, onNewDiagram } = props;
  // Many tags: the most used first, a few at a time, with a filter.
  const [tagQ, setTagQ] = useState("");
  const [allTags, setAllTags] = useState(false);
  const shownTags = useMemo(() => {
    const byUse = [...props.tags].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
    if (tagQ) return byUse.filter((t) => t.tag.toLowerCase().includes(tagQ.toLowerCase()));
    const head = allTags ? byUse : byUse.slice(0, TAGS_SHOWN);
    const active =
      props.activeTag && !head.some((t) => t.tag === props.activeTag)
        ? byUse.filter((t) => t.tag === props.activeTag)
        : [];
    return [...head, ...active];
  }, [props.tags, props.activeTag, tagQ, allTags]);
  const [drawerTab, setTab] = useState<"diagrams" | "model">(() => {
    try {
      return localStorage.getItem("archnm.drawerTab") === "model" ? "model" : "diagrams";
    } catch {
      return "diagrams";
    }
  });
  const tab = props.panel ? "model" : drawerTab;
  const pick = (t: "diagrams" | "model") => {
    setTab(t);
    // The model list is a new element each time it's shown, starting at the top.
    setScroll(0);
    try {
      localStorage.setItem("archnm.drawerTab", t);
    } catch {
      /* not remembered */
    }
  };

  // Diagrams as a tree: the landscape first, each scoped diagram under its scope's diagram.
  const diagrams = useMemo(() => {
    const rows = [...idx.diagrams.values()].map((d) => {
      const trail = d.scopeId ? [...ancestors(idx, d.scopeId).reverse(), d.scopeId] : [];
      const sortKey = [
        d.scopeId ? "1" : "0",
        ...trail.map((id) => idx.objects.get(id)?.name ?? ""),
        d.name,
      ].join("\u0000");
      return { d, depth: d.scopeId ? trail.length : 0, sortKey };
    });
    return rows.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  }, [idx]);

  // Folded until opened; going to a diagram opens the way to what it's inside.
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  // ✦: what's new on this fork, both in this tree and lit on the diagram (Workspace holds it).
  const onlyNew = !!props.showNew;
  const changed = props.changed;
  const context = props.context;
  useEffect(() => {
    const scope = diagramId ? idx.diagrams.get(diagramId)?.scopeId : null;
    if (!scope) return;
    setOpen((cur) => {
      const want = [scope, ...ancestors(idx, scope)];
      if (want.every((id) => cur.has(id))) return cur;
      return new Set([...cur, ...want]);
    });
  }, [diagramId, idx]);
  const toggle = (id: string) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const codeOnly = !!props.panel?.code;
  const tree = useMemo((): NavRow[] => {
    const finding = !!onlyNew && !!(changed?.size || context?.size);
    let only = finding ? new Set([...(changed ?? []), ...(context ?? [])]) : undefined;
    if (codeOnly) {
      const code = [...idx.objects.values()].filter((o) => isCodeKind(o.kind)).map((o) => o.id);
      only = new Set(only ? code.filter((id) => only!.has(id)) : code);
    }
    // Just the code is the same tree, narrowed: it folds and opens like the tree does.
    return navRows(idx, open, only, { unfold: finding, libraries: codeOnly });
  }, [idx, open, onlyNew, changed, context, codeOnly]);

  // What's selected on the canvas, found in the tree: its folders open (and it, so what's
  // inside shows), its row marked and scrolled into view, like a code editor's explorer.
  const picked = useMemo(() => new Set(props.selected ?? []), [props.selected]);
  const focus = props.selected?.length === 1 ? props.selected[0]! : null;
  useEffect(() => {
    if (!focus || !idx.objects.has(focus)) return;
    setOpen((cur) => {
      const want = [focus, ...ancestors(idx, focus)];
      if (want.every((id) => cur.has(id))) return cur;
      return new Set([...cur, ...want]);
    });
  }, [focus, idx]);
  const revealed = useRef<string | null>(null);
  useEffect(() => {
    if (!focus || tab !== "model" || revealed.current === focus || !list.current) return;
    const at = tree.findIndex((r) => r.o.id === focus || r.chain?.some((c) => c.id === focus));
    if (at < 0) return;
    revealed.current = focus;
    const el = list.current;
    const top = at * ROW_H;
    if (top < el.scrollTop + ROW_H || top > el.scrollTop + el.clientHeight - 2 * ROW_H)
      el.scrollTo({ top: Math.max(0, top - el.clientHeight / 3), behavior: "smooth" });
  }, [focus, tree, tab]);
  useEffect(() => {
    if (!focus) revealed.current = null;
  }, [focus]);

  // Right-click a row (a view, a flow, an object) for what you can do with it.
  const menu = useMenu();
  const [renaming, setRenaming] = useState<string | null>(null);
  const top = diagramForScope(idx, null)?.id;
  const ro = !props.canEdit;
  const rename = async (id: string, name: string) => {
    setRenaming(null);
    const next = name.trim();
    const d = idx.diagrams.get(id);
    const f = props.flows.find((x) => x.id === id);
    const o = idx.objects.get(id);
    if (!next) return;
    // A refusal is said in a toast already (run); nothing else to do here.
    await renameTo(next, d, f, o).catch(() => undefined);
  };
  const renameTo = async (next: string, d?: Diagram, f?: Flow, o?: ModelObject) => {
    if (d && next !== d.name)
      await props.run(
        [{ op: "diagram.put", diagram: { ...d, name: next, updatedAt: now() } }],
        `rename view ${d.name}`,
      );
    else if (f && next !== f.name)
      await props.run(
        [{ op: "flow.put", flow: { ...f, name: next, updatedAt: now() } }],
        `rename flow ${f.name}`,
      );
    else if (o && next !== o.name)
      await props.run(updateObject(o, { name: next }), `rename ${o.name}`);
  };
  const viewItems = (id: string): MenuItem[] => [
    { label: "Open", icon: <Layers size={14} />, run: () => onNavigate(id) },
    { label: "Rename", icon: <Pencil size={14} />, disabled: ro, run: () => setRenaming(id) },
    {
      label: id === top ? "Delete view (it's the top level)" : "Delete view",
      icon: <Trash2 size={14} />,
      danger: true,
      disabled: ro || id === top,
      run: () => props.onDeleteDiagram(id),
    },
  ];
  const flowItems = (f: Flow): MenuItem[] => [
    {
      label: f.kind === "path" ? "Light it up" : "Play",
      icon: f.kind === "path" ? <Route size={14} /> : <Waypoints size={14} />,
      run: () => props.onOpenFlow(f.id),
    },
    {
      // A story is told step by step; a path lights the whole route at once.
      label: f.kind === "path" ? "Make it a story (step by step)" : "Make it a path (lit at once)",
      icon: f.kind === "path" ? <Waypoints size={14} /> : <Route size={14} />,
      disabled: ro,
      run: () => {
        const { kind: _, ...rest } = f;
        void props.run(
          [
            {
              op: "flow.put",
              flow: {
                ...rest,
                ...(f.kind === "path" ? {} : { kind: "path" as const }),
                updatedAt: now(),
              },
            },
          ],
          f.kind === "path" ? `make ${f.name} a story` : `make ${f.name} a path`,
        );
      },
    },
    { label: "Rename", icon: <Pencil size={14} />, disabled: ro, run: () => setRenaming(f.id) },
    {
      label: "Delete flow",
      icon: <Trash2 size={14} />,
      danger: true,
      disabled: ro,
      run: () =>
        void props.run([{ op: "flow.delete", id: f.id }], `delete flow ${f.name}`).then(
          () => props.done(`Deleted the flow ${f.name}`),
          () => undefined,
        ),
    },
  ];
  const objectItems = (o: ModelObject): (MenuItem | "sep")[] => [
    { label: "Show it", icon: <Boxes size={14} />, run: () => cb.current.onSelectObject(o.id) },
    ...(diagramId && !idx.placements.get(diagramId)?.has(o.id)
      ? [
          {
            label: "Add to this diagram",
            icon: <Plus size={14} />,
            disabled: ro,
            run: () => cb.current.onAddObject(o.id),
          },
        ]
      : []),
    { label: "Open inside", icon: <Layers size={14} />, run: () => cb.current.onOpen(o.id) },
    { label: "Rename", icon: <Pencil size={14} />, disabled: ro, run: () => setRenaming(o.id) },
    "sep",
    {
      label: "Delete everywhere",
      icon: <Trash2 size={14} />,
      danger: true,
      disabled: ro,
      run: () =>
        void props.run(deleteObjects([o.id]), `delete ${o.name}`).then(
          () => props.done(`Deleted ${o.name} everywhere`),
          () => undefined,
        ),
    },
  ];
  /** A row's name, or the box to rename it in. */
  const nameOf = (id: string, name: string) =>
    renaming === id ? (
      <input
        className="row-rename"
        autoFocus
        defaultValue={name}
        onClick={(e) => e.stopPropagation()}
        onBlur={(e) => void rename(id, e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") void rename(id, e.currentTarget.value);
          if (e.key === "Escape") setRenaming(null);
        }}
      />
    ) : (
      <span className="name">{name}</span>
    );

  const here = diagramId ? idx.placements.get(diagramId) : undefined;

  // A big model is a thousand rows: build them only when the model, the filter or the
  // diagram changes, not on every selection. Handlers go through a ref so the rows can
  // be reused as they are.
  const cb = useRef(props);
  cb.current = props;
  const menuRef = useRef(menu);
  menuRef.current = menu;
  const objectItemsRef = useRef(objectItems);
  objectItemsRef.current = objectItems;
  const nameOfRef = useRef(nameOf);
  nameOfRef.current = nameOf;
  const toggleRef = useRef(toggle);
  toggleRef.current = toggle;
  const renamingRef = useRef(renaming);
  renamingRef.current = renaming;
  // Only the rows in view are rendered (plus a screenful either side).
  const list = useRef<HTMLUListElement>(null);
  const [scroll, setScroll] = useState(0);
  const [viewH, setViewH] = useState(800);
  // The list comes and goes (another tab, the panel's branches): watch whichever is there,
  // and never take a list that's gone (0 high) as the view's height.
  const hasBody = !!props.panel?.body;
  useEffect(() => {
    const el = list.current;
    if (!el) return;
    setScroll(el.scrollTop);
    const ro = new ResizeObserver(() => el.clientHeight > 0 && setViewH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [tab, hasBody]);
  const first = Math.max(0, Math.floor(scroll / ROW_H) - 20);
  const last = Math.min(tree.length, Math.ceil((scroll + viewH) / ROW_H) + 20);
  const modelRows = useMemo(
    () =>
      tree.slice(first, last).map((r) => {
        const { o } = r;
        // A box's Libraries folder: it only folds and unfolds.
        if (r.group)
          return (
            <li key={`${LIBS}${r.usedBy}`}>
              <button
                className="row nav"
                style={{ paddingLeft: 6 }}
                onClick={() => toggleRef.current(LIBS + r.usedBy)}
                title={
                  r.usedBy
                    ? `The ${r.count} librar${r.count === 1 ? "y" : "ies"} ${o.name} uses.`
                    : `${r.count} librar${r.count === 1 ? "y" : "ies"} nothing in the design is connected to yet.`
                }
              >
                <Guides row={r} />
                <span className={`twist ${r.open ? "open" : ""}`}>
                  <ChevronRight size={12} />
                </span>
                <NavIcon row={r} />
                <span className="name">Libraries</span>
                <span className="count">{r.count}</span>
              </button>
            </li>
          );
        const docs = r.icon === "library" ? libraryDocs(o) : null;
        const on = idx.placedOn.get(o.id)?.size ?? 0;
        const isHere = !!here?.has(o.id);
        // ✦ on the outermost new row only: what's inside a new folder is new with it.
        const rowIds = [...(r.chain ?? []).map((x) => x.id), o.id];
        const topParent = (r.chain?.[0] ?? o).parentId;
        const parentNew = !!topParent && !!changed?.has(topParent);
        const isNew = !parentNew && rowIds.some((id) => changed?.has(id));
        const plugs = !isNew && !parentNew && rowIds.some((id) => context?.has(id));
        // How many diagrams it's on besides this one: ● already says "this one".
        const elsewhere = on - (isHere ? 1 : 0);
        return (
          <li key={r.usedBy !== undefined ? `${r.usedBy}/${o.id}` : o.id}>
            <button
              className={`row nav ${isHere ? "here" : ""} ${o.external ? "external" : ""} ${rowIds.some((id) => picked.has(id)) ? "picked" : ""}`}
              style={{ paddingLeft: 6 }}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(OBJECT_DRAG_TYPE, o.id);
                e.dataTransfer.effectAllowed = "copy";
              }}
              // Click goes to it: here, or on a diagram that shows it (opening its row too).
              // Placing it is a drag onto the canvas; the twist folds and unfolds.
              onClick={() => {
                // A library opens its docs in a new tab (double-click goes to it on the canvas).
                if (docs) return void window.open(docs, "_blank", "noopener,noreferrer");
                // The panel: a folder opens its diagram and unfolds (the one you're in folds again).
                if (cb.current.panel && r.branch) {
                  const scope = diagramId ? idx.diagrams.get(diagramId)?.scopeId : null;
                  if (scope === o.id && r.open) return toggleRef.current(o.id);
                  if (!r.open) toggleRef.current(o.id);
                  return cb.current.onOpen(o.id);
                }
                cb.current.onSelectObject(o.id);
                if (r.branch && !r.open) toggleRef.current(o.id);
              }}
              onDoubleClick={() => cb.current.onOpen(o.id)}
              onContextMenu={menuRef.current.on(() => objectItemsRef.current(o))}
              title={`${docs ? `Click opens its docs (${docs}); double-click goes to it. ` : ""}${o.path ?? o.name}: on ${on} diagram${on === 1 ? "" : "s"}${isHere ? ", this one too" : ""}. Click to go to it; drag onto the canvas to place it here; right-click for more.`}
            >
              <Guides row={r} />
              <span
                className={`twist ${r.branch ? "" : "leaf"} ${r.open ? "open" : ""}`}
                onClick={(e) => {
                  if (!r.branch) return;
                  e.stopPropagation();
                  toggleRef.current(o.id);
                }}
              >
                {r.branch && <ChevronRight size={12} />}
              </span>
              <NavIcon row={r} />
              {renamingRef.current === o.id ? (
                nameOfRef.current(o.id, o.name)
              ) : (
                <span
                  className={`name ${r.icon === "function" || r.icon === "file" || r.icon === "folder" ? "code" : ""}`}
                >
                  {rowLabel(r)}
                </span>
              )}
              {isNew &&
                (() => {
                  const m = props.diffMark?.(rowIds.find((id) => changed?.has(id)) ?? o.id);
                  if (m && "added" in m)
                    return (
                      <span className="diff-mark added" title="new on this fork">
                        +
                      </span>
                    );
                  if (m)
                    return (
                      <span className="diff-mark changed" title="changed on this fork">
                        {m.plus > 0 && <b className="plus">+{m.plus}</b>}
                        {m.minus > 0 && <b className="minus">−{m.minus}</b>}
                      </span>
                    );
                  return (
                    <span className="new" title="new or changed on this fork">
                      ✦
                    </span>
                  );
                })()}
              {plugs && (
                <span className="new plugs" title="the change plugs in here">
                  ✧
                </span>
              )}
              {isHere && (
                <span className="here-dot" title="on this diagram">
                  ●
                </span>
              )}
              {elsewhere > 0 && (
                <span
                  className="count"
                  title={`on ${elsewhere} ${isHere ? "other " : ""}diagram${elsewhere === 1 ? "" : "s"}`}
                >
                  {isHere ? `+${elsewhere}` : elsewhere}
                </span>
              )}
            </button>
          </li>
        );
      }),
    [tree, idx, here, first, last, renaming, changed, context, ro, diagramId, picked],
  );

  return (
    <aside
      className={
        props.panel
          ? "drawer left-panel tab-model pinned"
          : `drawer tab-${tab}${props.pinned ? " pinned" : ""}`
      }
    >
      {menu.node}
      {props.panel ? (
        props.panel.head
      ) : (
        <div className="drawer-head">
          <div className="drawer-tabs" role="tablist">
            <button
              role="tab"
              aria-selected={tab === "diagrams"}
              className={tab === "diagrams" ? "on" : ""}
              onClick={() => pick("diagrams")}
            >
              <Layers size={14} /> Diagrams
            </button>
            <button
              role="tab"
              aria-selected={tab === "model"}
              className={tab === "model" ? "on" : ""}
              onClick={() => pick("model")}
            >
              <Boxes size={14} /> Model <span className="count">{idx.objects.size}</span>
            </button>
          </div>
          <span className="grow" />
          <button
            className={props.pinned ? "icon-btn on" : "icon-btn"}
            onClick={props.onPin}
            title={props.pinned ? "Unpin: close when I click the canvas" : "Keep open"}
          >
            <Pin size={14} />
          </button>
          <button className="icon-btn" onClick={props.onClose} title="Close ([)">
            <X size={14} />
          </button>
        </div>
      )}

      {tab === "diagrams" && (
        <div className="drawer-body">
          <section>
            <div className="section-head">
              <span>Diagrams</span>
              <button className="icon-btn" onClick={onNewDiagram} title="New diagram">
                <Plus size={14} />
              </button>
            </div>
            <ul className="list">
              {diagrams.map(({ d, depth }) => (
                <li key={d.id}>
                  <button
                    className={`row ${d.id === diagramId ? "active" : ""}`}
                    style={{ paddingLeft: 10 + depth * 14 }}
                    onClick={() => onNavigate(d.id)}
                    onContextMenu={menu.on(() => viewItems(d.id))}
                    title="Right-click to rename or delete"
                  >
                    <span className="glyph">{d.scopeId ? "▸" : "◆"}</span>
                    {nameOf(d.id, d.name)}
                    <span className="count">{idx.placements.get(d.id)?.size ?? 0}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <div className="section-head">
              <span>Flows</span>
              <button
                className="icon-btn"
                onClick={props.onNewFlow}
                title="New flow on this diagram"
              >
                <Plus size={14} />
              </button>
            </div>
            <ul className="list">
              {props.flows.map((f) => (
                <li key={f.id}>
                  <button
                    className={`row ${f.id === props.activeFlow ? "active" : ""}`}
                    onClick={() => props.onOpenFlow(f.id)}
                    onContextMenu={menu.on(() => flowItems(f))}
                    title="Right-click to rename or delete"
                  >
                    {f.kind === "path" ? (
                      <Route size={12} className="glyph-icon path" />
                    ) : (
                      <Waypoints size={12} className="glyph-icon" />
                    )}
                    {nameOf(f.id, f.name)}
                    <span className="count">{f.steps.length}</span>
                  </button>
                </li>
              ))}
              {props.flows.length === 0 && (
                <li className="muted small empty-row">None on this diagram</li>
              )}
            </ul>
          </section>

          {props.tags.length > 0 && (
            <section>
              <div className="section-head">
                <span>Tags</span>
              </div>
              {props.tags.length > 20 && (
                <input
                  className="tag-filter"
                  value={tagQ}
                  placeholder={`Filter ${props.tags.length} tags`}
                  onChange={(e) => setTagQ(e.target.value)}
                />
              )}
              <div className="tag-list">
                {shownTags.map((t) => (
                  <button
                    key={t.tag}
                    title={t.tag}
                    className={`tag ${t.tag === props.activeTag ? "active" : ""}`}
                    onClick={() => props.onTag(t.tag)}
                  >
                    <Hash size={10} />
                    <span className="tag-name">{t.tag}</span>
                    <span className="count">{t.count}</span>
                  </button>
                ))}
                {!tagQ && props.tags.length > TAGS_SHOWN && (
                  <button className="tag more" onClick={() => setAllTags((v) => !v)}>
                    {allTags ? "Fewer" : `Show all ${props.tags.length}`}
                  </button>
                )}
              </div>
            </section>
          )}
        </div>
      )}

      {props.panel?.body && (
        <section className="grow drawer-body panel-body">{props.panel.body}</section>
      )}
      {tab === "model" && !props.panel?.body && (
        <section className="grow drawer-body">
          {!props.panel && (
            <div className="nav-head">
              <button
                className="search search-btn"
                onClick={() => props.onSearch?.()}
                title="Find anything: objects, paths, packages, views (⌘K)"
              >
                <Search size={13} />
                <span>Search</span>
                <kbd>⌘K</kbd>
              </button>
              {!!(changed?.size || context?.size) && (
                <button
                  className={`icon-btn ${onlyNew ? "on" : ""}`}
                  title={
                    onlyNew
                      ? "Show everything"
                      : `What's new on this fork: ${changed?.size ?? 0} new and ${context?.size ?? 0} it plugs into, lit on the diagram and listed here`
                  }
                  onClick={() => props.onShowNew?.()}
                >
                  <Sparkles size={14} />
                </button>
              )}
              <button
                className="icon-btn"
                title="Fold everything"
                onClick={() => setOpen(new Set())}
              >
                <ChevronRight size={14} style={{ transform: "rotate(-90deg)" }} />
              </button>
            </div>
          )}
          {props.panel && !codeOnly && top && (
            // The top level isn't a box, so it has no row in the tree: it gets its own, on top.
            <ul className="list nav-top">
              <li>
                <button
                  className={`row nav ${diagramId === top ? "here" : ""}`}
                  style={{ paddingLeft: 6 }}
                  onClick={() => onNavigate(top)}
                  title="The top level: everything else is inside it"
                >
                  <span className="twist leaf" />
                  <Globe size={11} className="nav-top-icon" />
                  <span className="name">{idx.diagrams.get(top)?.name ?? "Landscape"}</span>
                </button>
              </li>
            </ul>
          )}
          <ul
            ref={list}
            className="list scroll virtual"
            onScroll={(e) => setScroll(e.currentTarget.scrollTop)}
          >
            <li style={{ height: first * ROW_H }} aria-hidden />
            {modelRows}
            <li style={{ height: (tree.length - last) * ROW_H }} aria-hidden />
          </ul>
        </section>
      )}
    </aside>
  );
}

/** The tree's guide lines, like `lsd --tree`: a bar for each open ancestor, an elbow for the row. */
function Guides({ row }: { row: NavRow }) {
  if (row.depth === 0) return null;
  return (
    <span className="guides" aria-hidden>
      {row.lastAt.slice(1).map((last, i) => (
        <span key={i} className={`g ${last ? "" : "bar"}`} />
      ))}
      <span className={`g ${row.last ? "elbow" : "tee"}`} />
    </span>
  );
}

function NavIcon({ row }: { row: NavRow }) {
  if (row.icon === "folder")
    return row.open ? (
      <FolderOpen size={14} className="nav-icon folder" />
    ) : (
      <Folder size={14} className="nav-icon folder" />
    );
  if (row.icon === "file") return <FileCode size={14} className="nav-icon file" />;
  if (row.icon === "function") return <SquareFunction size={14} className="nav-icon fn" />;
  if (row.icon === "table") return <Table2 size={14} className="nav-icon table" />;
  if (row.icon === "library") return <Package size={14} className="nav-icon lib" />;
  return <KindDot kind={row.o.kind} external={row.o.external} />;
}

/** Every row in the model list is this tall, so the list can render just what's in view. */
const ROW_H = 28;
