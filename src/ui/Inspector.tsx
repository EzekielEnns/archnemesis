// The panel for what's selected: one object (every field, where else it's drawn), an
// arrow (the connections under it), or several boxes.
import { useMenu } from "./ContextMenu";
import { copyLink } from "../route";
import {
  FolderClosed,
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  Check,
  Link2,
  ExternalLink,
  EyeOff,
  Pencil,
  Plus,
  FileCode2,
  FolderOpen,
  Layers,
  Lock,
  Scale,
  Spline,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { sourceLink, type FConfig } from "../../shared/files.ts";
import {
  boundaryChain,
  boundaryOf,
  moveManyToBoundaryOps,
  newBoundaryOps,
  whyIn,
} from "../../shared/boundaries.ts";
import { Dialog } from "./Dialog";
import { Story } from "./Story";
import { AgentContext } from "./AgentContext";
import { LinksField } from "./Links";
import { describeSelector, type Selector } from "../../shared/views.ts";
import { ago } from "./Notes";
import { callsOf, codeHome, packageLinks, type Call } from "../../shared/context.ts";
import type { TouchedInfo } from "../../shared/api.ts";
import { statsKey, type LibStats } from "../../shared/libstats.ts";
import { columnRef, keysOf } from "../../shared/tables.ts";
import type { LogEntry } from "../../shared/doc.ts";
import {
  createContext,
  Fragment,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import {
  freeSpot,
  openGroup,
  place,
  updateConnection,
  updateObject,
} from "../../shared/actions.ts";
import {
  type Column,
  BOUNDARY_KINDS,
  KIND_LABEL,
  OBJECT_KINDS,
  ECOSYSTEMS,
  isCodeKind,
  type Package,
  type Boundary,
  type BoundaryKind,
  STATUSES,
  cleanTags,
  now,
  nextDecisionId,
  safeUrl,
  DECISION_STATUSES,
  type Decision,
  type DecisionStatus,
  type Connection,
  type Diagram,
  type ModelObject,
  type Op,
} from "../../shared/model.ts";
import {
  descendants,
  FOLD_FRAME,
  foldKey,
  groupLabel,
  hiddenLinks,
  type CanvasGraph,
  type ModelIndex,
} from "../../shared/project.ts";
import type { Selection } from "../canvas/Scene";
import { KindDot } from "./KindDot";
import { ConnectionCard, NodeCard } from "./NodeCard";
import { canExplode, OPEN_FRAME } from "../../shared/explode.ts";
import { TagsField, TechField as PickTech, techList } from "./Pickers";
import { TechImg } from "./TechImg";
import { TextField } from "./TextField";

interface Props {
  idx: ModelIndex;
  /** The design's archnm.yaml: tag groups, protected fields, the GitHub owner sources link to. */
  config: FConfig;
  diagramId: string;
  /** Light up a connection on the canvas (or go where it's drawn). */
  onShowConnection?: (c: Connection) => void;
  /** Hovering a connection row: light it up (null: stop). */
  onHoverConnection?: (c: Connection | null) => void;
  /** Who's touched a box, and a library's stats: for the design that's open, where the backend has them. */
  insights?: DocInsights;
  graph: CanvasGraph | null;
  selection: Selection;
  run: (ops: Op[], label: string) => Promise<unknown>;
  onNavigate: (diagramId: string, objectId?: string) => void;
  onOpen: (objectId: string) => void;
  onRemove: (everywhere: boolean) => void;
  onConnect: () => void;
  /** Start a note or a link pinned to this box. */
  onAddNote: (kind: "note" | "link", objectId: string) => void;
  /** The design's recent history (who changed what), for an object's History tab. */
  log?: () => LogEntry[];
  /** What depends on the selected box (upstream) or what it depends on, while it's lit up. */
  impact?: { way: "upstream" | "downstream"; count: number; hops: number; off: number } | null;
  onImpact?: (way: "upstream" | "downstream" | null) => void;
  /** False for a viewer, or a past version: nothing to add or change. */
  canEdit?: boolean;
  /** Where a jump from this panel came from: "← AWS" at the top goes back there. */
  back?: { label: string; run: () => void } | null;
  /** The design this is in. */
  design?: { key: string; name: string };
  /** Simple mode: a smaller panel, only what fits the kind, with a close button. */
  simple?: boolean;
  onClose?: () => void;
  /** Simple mode: it was just made, so its first field takes the keyboard. */
  fresh?: string | null;
  /** Who's editing. */
  me?: string;
  /** Go to a comment's thread on the canvas. */
  onOpenNote?: (noteId: string) => void;
  /** Go to a box: selected here if it's drawn here, else on a diagram that has it. */
  onGoTo?: (objectId: string) => void;
  /** Pin a comment to this box on this diagram. */
  onComment?: (objectId: string, text: string) => void;
  /** A comment pinned on a connection's arrow here. */
  onCommentConnection?: (connectionId: string, text: string) => void;
  /** Select a frame ("fold:<group>" for an unfolded group). */
  onSelectFrame?: (boundary: string) => void;
  /** Boxes opened in place on this diagram, and opening or closing one. */
  openedHere?: string[];
  /** Is it drawn on the canvas right now (also inside a box opened here)? */
  drawnHere?: (objectId: string) => boolean;
  onOpenHere?: (objectId: string, on: boolean) => void;
}

/** Fold an unfolded group back into one box on this view. */
export function foldBack(view: Diagram, key: string): Op[] {
  const rest = (view.unfolded ?? []).filter((k) => k !== key);
  return [
    {
      op: "diagram.put",
      diagram: { ...view, unfolded: rest.length ? rest : null, updatedAt: now() },
    },
  ];
}

const Back = createContext<Props["back"]>(null);
/** Simple mode: how to close the panel (null: the full panel, closed by letting go). */
const Simple = createContext<(() => void) | null>(null);
const Fresh = createContext<string | null>(null);

/** The panel's frame: a body that scrolls, and a footer of actions that stays put. */
export function Panel({ children, footer }: { children: ReactNode; footer: ReactNode }) {
  const back = useContext(Back);
  const close = useContext(Simple);
  const fresh = useContext(Fresh);
  const ref = useRef<HTMLElement>(null);
  // Just made: type its name straight away.
  useEffect(() => {
    if (!fresh) return;
    const t = setTimeout(() => {
      const f = ref.current?.querySelector<
        HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      >(".flow-field");
      f?.focus();
      if (f && "select" in f && f.tagName !== "SELECT") (f as HTMLInputElement).select();
    }, 30);
    return () => clearTimeout(t);
  }, [fresh]);
  // Simple mode: Enter goes to the next field (Shift+Enter is a new line); after the last, done.
  const onKeyDownCapture = (e: React.KeyboardEvent) => {
    if (!close || e.key !== "Enter" || e.shiftKey) return;
    const t = e.target as HTMLElement;
    if (!t.classList.contains("flow-field")) return;
    e.preventDefault();
    e.stopPropagation();
    const all = [...(ref.current?.querySelectorAll<HTMLElement>(".flow-field") ?? [])];
    const next = all[all.indexOf(t) + 1];
    t.blur();
    if (next) next.focus();
    else close();
  };
  return (
    <aside
      ref={ref}
      className={close ? "inspector simple" : "inspector"}
      onKeyDownCapture={onKeyDownCapture}
    >
      {close && (
        <button className="icon panel-close" onClick={close} title="Close (Esc)">
          <X size={14} />
        </button>
      )}
      {back && (
        <button
          className="panel-back"
          onClick={back.run}
          title="Back to what you had selected (⌥←)"
        >
          <ArrowLeft size={12} /> <span>{back.label}</span>
        </button>
      )}
      <div className="body">{children}</div>
      {footer != null && <div className="footer">{footer}</div>}
    </aside>
  );
}

/** A small button with an icon in front of its words. */
export function Act({
  icon,
  children,
  ...rest
}: { icon: ReactNode; children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...rest} className={`act ${rest.className ?? ""}`}>
      {icon}
      <span>{children}</span>
    </button>
  );
}

export function Inspector(p: Props) {
  return (
    <Back.Provider value={p.back ?? null}>
      <Simple.Provider value={p.simple ? (p.onClose ?? (() => {})) : null}>
        <Fresh.Provider value={p.simple ? (p.fresh ?? null) : null}>
          <InspectorBody {...p} />
        </Fresh.Provider>
      </Simple.Provider>
    </Back.Provider>
  );
}

function InspectorBody(p: Props) {
  const menu = useMenu();
  if (p.selection.diagram) {
    const d = p.idx.diagrams.get(p.diagramId);
    if (!d) return null;
    const scope = d.scopeId ? p.idx.objects.get(d.scopeId) : undefined;
    return (
      <Panel footer={null}>
        <div className="eyebrow">Diagram{scope ? `: inside ${scope.name}` : ""}</div>
        <div className="title-row">
          <h3>{d.name}</h3>
        </div>
        <Story
          key={d.id}
          text={d.story ?? ""}
          onSave={(story) =>
            void p.run(
              [
                {
                  op: "diagram.put",
                  diagram: { ...d, story: story || undefined, updatedAt: now() },
                },
              ],
              story ? "rewrite the story" : "remove the story",
            )
          }
        />
        <AgentContext
          of={d.name}
          text={d.context ?? ""}
          canEdit={p.canEdit}
          onSave={(context) =>
            void p.run(
              [
                {
                  op: "diagram.put",
                  diagram: { ...d, context: context || undefined, updatedAt: now() },
                },
              ],
              context ? "write agent context" : "remove agent context",
            )
          }
        />
        <h4>Links</h4>
        <LinksField
          links={d.links ?? []}
          onChange={(links, label) =>
            void p.run(
              [
                {
                  op: "diagram.put",
                  diagram: { ...d, links: links.length ? links : undefined, updatedAt: now() },
                },
              ],
              label,
            )
          }
        />
      </Panel>
    );
  }
  if (p.selection.boundary?.startsWith(OPEN_FRAME)) {
    const o = p.idx.objects.get(p.selection.boundary.slice(OPEN_FRAME.length));
    return o ? <ObjectForm key={o.id} o={o} {...p} /> : null;
  }
  if (p.selection.boundary?.startsWith(FOLD_FRAME)) {
    const key = p.selection.boundary.slice(FOLD_FRAME.length);
    const view = p.idx.diagrams.get(p.diagramId);
    const frame = p.graph?.groups.find((g) => g.id === `boundary:${p.selection.boundary}`);
    if (!view || !frame) return null;
    const inside = (p.graph?.nodes ?? []).filter(
      (n) =>
        n.x >= frame.x &&
        n.y >= frame.y &&
        n.x + n.w <= frame.x + frame.w &&
        n.y + n.h <= frame.y + frame.h,
    );
    return (
      <Panel
        footer={
          <Act
            icon={<FolderClosed size={13} />}
            title="Fold them back into one box (⇧⌘G)"
            onClick={() => void p.run(foldBack(view, key), `fold ${frame.name}`)}
          >
            Fold back
          </Act>
        }
      >
        <div className="eyebrow">Unfolded group</div>
        <h3>{frame.name}</h3>
        <ul className="plain conn-list">
          {inside.map((n) => (
            <li key={n.id} className="pickable" onClick={() => p.onGoTo?.(n.id)}>
              <KindDot kind={n.kind} external={n.external} />
              <span className="who">{n.name}</span>
              {n.technology && <span className="muted via">{n.technology}</span>}
            </li>
          ))}
        </ul>
      </Panel>
    );
  }
  if (p.selection.boundary) {
    const b = p.idx.boundaries.get(p.selection.boundary);
    return b ? <BoundaryForm key={b.id} b={b} {...p} /> : null;
  }
  if (p.selection.edge) {
    const edge = p.graph?.edges.find((e) => e.id === p.selection.edge);
    const conns = (edge?.connectionIds ?? []).flatMap((id) => p.idx.connections.get(id) ?? []);
    const one = conns.length === 1 ? conns[0] : undefined;
    // Where what it carries was dragged to isn't a joint: resetting keeps it.
    const shaped =
      edge?.shape &&
      (edge.shape.fromSide ||
        edge.shape.toSide ||
        edge.shape.bends?.length ||
        edge.shape.label !== undefined);
    const resetJoints =
      edge && shaped
        ? () => {
            const parts = edge.shape?.parts;
            void p.run(
              [
                parts
                  ? {
                      op: "arrow.put",
                      arrow: { diagramId: p.diagramId, from: edge.from, to: edge.to, parts },
                    }
                  : { op: "arrow.delete", diagramId: p.diagramId, from: edge.from, to: edge.to },
              ],
              "reset joints",
            );
          }
        : undefined;
    if (one)
      return (
        <ConnectionCard
          key={one.id}
          c={one}
          idx={p.idx}
          diagramId={p.diagramId}
          run={p.run}
          canEdit={p.canEdit !== false}
          onClose={() => p.onClose?.()}
          onRemove={() => p.onRemove(false)}
          onGoTo={(id) => p.onGoTo?.(id)}
          onShowConnection={p.onShowConnection}
          onHoverConnection={p.onHoverConnection}
          onResetJoints={resetJoints}
          drawn={!!edge}
          onComment={(text) => p.onCommentConnection?.(one.id, text)}
          onOpenNote={(id) => p.onOpenNote?.(id)}
        />
      );
    return (
      <Panel
        footer={
          <>
            {resetJoints && (
              <Act
                icon={<Spline size={13} />}
                title="Back to the automatic route: sides, bends and label"
                onClick={resetJoints}
              >
                Reset joints
              </Act>
            )}
            <span className="spacer" />
            <Act
              icon={<Trash2 size={13} />}
              className="danger"
              title="⌫"
              onClick={() => p.onRemove(false)}
            >
              {`Delete ${conns.length}`}
            </Act>
          </>
        }
      >
        {
          <>
            {menu.node}
            <h3>{conns.length} connections</h3>
            <p className="muted small">
              Several connections land on this arrow, from the objects inside these boxes.
            </p>
            {conns.map((c) => (
              <div className="connection" key={c.id}>
                <div
                  className="ends-row"
                  title="Right-click to reverse or delete this one"
                  onContextMenu={menu.on(() => [
                    {
                      label: "Reverse",
                      icon: <ArrowLeftRight size={14} />,
                      run: () =>
                        void p.run(
                          updateConnection(c, { fromId: c.toId, toId: c.fromId }),
                          "reverse connection",
                        ),
                    },
                    {
                      label: "Delete this one",
                      icon: <Trash2 size={14} />,
                      danger: true,
                      run: () =>
                        void p.run([{ op: "connection.delete", id: c.id }], "delete connection"),
                    },
                  ])}
                >
                  <span className="ends small">
                    {p.idx.objects.get(c.fromId)?.name} <ArrowRight size={12} className="muted" />{" "}
                    {p.idx.objects.get(c.toId)?.name}
                  </span>
                </div>
                <ConnectionForm c={c} {...p} />
              </div>
            ))}
          </>
        }
      </Panel>
    );
  }

  if (p.selection.nodes.length > 1) {
    return (
      <Panel
        footer={
          <>
            {!p.simple && (
              <Act icon={<EyeOff size={13} />} title={HIDE_HINT} onClick={() => p.onRemove(false)}>
                Hide here
              </Act>
            )}
            {!p.simple && <span className="spacer" />}
            {p.simple && <span className="muted small">⌘G groups them · ⌘C copies</span>}
            {p.simple && <span className="spacer" />}
            <Act
              icon={<Trash2 size={13} />}
              className="danger"
              title={DELETE_HINT}
              onClick={() => p.onRemove(true)}
            >
              Delete
            </Act>
          </>
        }
      >
        <h3>{p.selection.nodes.length} selected</h3>
        <div className="grid">
          <RunsIn
            ids={p.selection.nodes.filter((id) => p.idx.objects.has(id))}
            idx={p.idx}
            run={p.run}
          />
        </div>
        <ul className="plain">
          {p.selection.nodes.slice(0, 12).map((id) => (
            <li key={id}>{p.idx.objects.get(id)?.name}</li>
          ))}
        </ul>
      </Panel>
    );
  }

  // The externals folded into one box: what's in it, and a way to unfold.
  const foldNode = p.graph?.nodes.find((n) => n.id === p.selection.nodes[0]);
  const folded = foldNode?.folded;
  const view = p.idx.diagrams.get(p.diagramId);
  if (folded && view) {
    const group = foldNode?.group;
    const openIt = () => {
      if (!group) return;
      const { diagramId, ops } = openGroup(p.idx, group, groupLabel(group));
      if (ops.length)
        void p.run(ops, `open ${groupLabel(group)}`).then(() => p.onNavigate(diagramId));
      else p.onNavigate(diagramId);
    };
    return (
      <Panel
        footer={
          <>
            {group && (
              <Act
                icon={<FolderOpen size={13} />}
                title="Open this group's own view, where each one is drawn (or double-click the box)"
                onClick={openIt}
              >
                Open
              </Act>
            )}
            <Act
              icon={<FolderOpen size={13} />}
              title="Draw each one here, in a frame you can fold back"
              onClick={() => {
                const key = foldKey(foldNode!);
                void p
                  .run(
                    [
                      {
                        op: "diagram.put",
                        diagram: {
                          ...view,
                          unfolded: [...new Set([...(view.unfolded ?? []), key])],
                          updatedAt: now(),
                        },
                      },
                    ],
                    `unfold ${group ? groupLabel(group) : "externals"}`,
                  )
                  .then(() => p.onSelectFrame?.(`${FOLD_FRAME}${key}`));
              }}
            >
              Unfold here
            </Act>
          </>
        }
      >
        <div className="eyebrow">Folded</div>
        <h3>{group ? groupLabel(group) : `${folded.length} external services`}</h3>
        <p className="muted small">
          {group
            ? `${folded.length} boxes in this group, folded into one so the view stays readable; their arrows meet here. Open it to trace each one.`
            : "Run by someone else. Folded into one box so the view stays readable; their arrows meet here."}
        </p>
        <ul className="plain conn-list">
          {folded.map((id) => {
            const x = p.idx.objects.get(id);
            return (
              <li key={id}>
                <KindDot kind={x?.kind ?? "system"} external={!!x?.external} />
                <span className="who">{x?.name}</span>
                {x?.technology && <span className="muted via">{x.technology}</span>}
              </li>
            );
          })}
        </ul>
      </Panel>
    );
  }

  const o = p.idx.objects.get(p.selection.nodes[0] ?? "");
  if (!o) return null;
  return <ObjectForm key={o.id} o={o} {...p} />;
}

function ObjectForm(p: Props & { o: ModelObject }) {
  if (p.simple)
    return (
      <NodeCard
        key={p.o.id}
        o={p.o}
        idx={p.idx}
        diagramId={p.diagramId}
        run={p.run}
        canEdit={p.canEdit !== false}
        fresh={p.fresh === p.o.id}
        back={p.back}
        onClose={() => p.onClose?.()}
        onRemove={() => p.onRemove(true)}
        onGoTo={(id) => p.onGoTo?.(id)}
        onNavigate={p.onNavigate}
        onHoverConnection={p.onHoverConnection}
        onComment={(text) => p.onComment?.(p.o.id, text)}
        openHere={
          p.onOpenHere &&
          (p.openedHere?.includes(p.o.id) ||
            ((p.drawnHere?.(p.o.id) ?? p.idx.placements.get(p.diagramId)?.has(p.o.id)) &&
              canExplode(p.idx, p.o.id)))
            ? {
                on: !!p.openedHere?.includes(p.o.id),
                toggle: () => p.onOpenHere!(p.o.id, !p.openedHere?.includes(p.o.id)),
              }
            : undefined
        }
        onOpenNote={(id) => p.onOpenNote?.(id)}
      />
    );
  return <FullObject {...p} />;
}

function FullObject({
  o,
  idx,
  config,
  diagramId,
  insights,
  run,
  log,
  onNavigate,
  onRemove,
  onShowConnection,
  onHoverConnection,
  impact,
  onImpact,
  canEdit,
}: Props & { o: ModelObject }) {
  const decisions = [...idx.decisions.values()]
    .filter((d) => d.affects.includes(o.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  const [deciding, setDeciding] = useState<Decision | "new" | null>(null);
  const protectedRef = (k: string) => config.protect?.includes(`refs.${k}`) ?? false;
  const save = (patch: Partial<ModelObject>, label: string) => {
    const changed = Object.entries(patch).some(([k, v]) => o[k as keyof ModelObject] !== v);
    if (changed) void run(updateObject(o, patch), label);
  };
  const on = [...(idx.placedOn.get(o.id) ?? [])].flatMap((d) => idx.diagrams.get(d) ?? []);
  // The whole-model scans, once per model change rather than once per render.
  const { inside, links, hidden } = useMemo(() => {
    const inside = new Set([o.id, ...descendants(idx, o.id)]);
    return {
      inside,
      // Its own connections and those of everything inside it: what its arrows stand for.
      links: [...idx.connections.values()].filter(
        (c) => inside.has(c.fromId) !== inside.has(c.toId),
      ),
      hidden: hiddenLinks(idx, diagramId, o.id),
    };
  }, [idx, diagramId, o.id]);
  // Every possible parent is hundreds of <option>s in a big model: only built once the
  // picker is opened.
  const [picking, setPicking] = useState(false);
  const parents = useMemo(
    () =>
      picking
        ? [...idx.objects.values()]
            .filter((x) => !inside.has(x.id) && x.kind !== "actor" && x.kind !== "component")
            .sort((a, b) => a.name.localeCompare(b.name))
        : o.parentId && idx.objects.get(o.parentId)
          ? [idx.objects.get(o.parentId)!]
          : [],
    [picking, idx, inside, o.parentId],
  );
  const addable = [...new Set(hidden.map((h) => h.add))];
  const addToDiagram = (ids: string[]) => {
    const me = idx.placements.get(diagramId)?.get(o.id);
    if (!me) return;
    const ops = [];
    const taken: { x: number; y: number; w: number; h: number }[] = [];
    for (const id of ids) {
      const at = freeSpot(idx, diagramId, { x: me.x + me.w + 96, y: me.y }, taken);
      taken.push({ x: at.x, y: at.y, w: 184, h: 72 });
      ops.push(...place(idx, diagramId, id, at));
    }
    void run(
      ops,
      ids.length === 1 ? `add ${idx.objects.get(ids[0]!)?.name}` : `add ${ids.length} objects`,
    );
  };

  const [tab, setTab] = useStoredTab();
  // Newest first; the same change by the same person in a row is one line with a count.
  const history = useMemo(() => {
    if (tab !== "history") return [];
    const out: (LogEntry & { n: number })[] = [];
    for (const e of (log?.() ?? []).filter((x) => x.ids.includes(o.id)).reverse()) {
      const last = out.at(-1);
      if (last && last.label === e.label && last.actor.id === e.actor.id) last.n++;
      else out.push({ ...e, n: 1 });
    }
    return out;
  }, [tab, log, o.id, idx]);

  return (
    <Panel
      footer={
        <>
          <Act icon={<EyeOff size={13} />} title={HIDE_HINT} onClick={() => onRemove(false)}>
            Hide here
          </Act>
          <span className="spacer" />
          <Act
            icon={<Trash2 size={13} />}
            className="danger"
            title={DELETE_HINT}
            onClick={() => onRemove(true)}
          >
            Delete
          </Act>
        </>
      }
    >
      {/* Who it is: the name, one line of what it is, and what you'd do with it. */}
      <div className="title-row">
        <HeadIcon
          tech={
            o.icon
              ? o.icon.toLowerCase() === "none"
                ? undefined
                : o.icon
              : techList(o.technology)[0]
          }
          fallback={<KindDot kind={o.kind} external={o.external} />}
        />
        <TextField
          className="title-input"
          value={o.name}
          onCommit={(name) => name.trim() && save({ name: name.trim() }, "rename")}
        />
        <CopyLinkButton to={{ diagramId, objectId: o.id }} what={o.name} />
      </div>
      <div className="head-row">
        <span className="summary">
          {KIND_LABEL[o.kind]}
          {o.technology ? ` · ${o.technology}` : ""}
          {o.external ? " · external" : ""}
          <span className={`status-dot status-${o.status}`} /> {o.status}
        </span>
      </div>
      <Description
        text={o.description}
        onSave={(description) => save({ description }, "describe")}
      />
      <AgentContext
        of={o.name}
        text={o.context ?? ""}
        canEdit={canEdit}
        onSave={(context) =>
          save(
            { context: context || undefined },
            context ? "write agent context" : "remove agent context",
          )
        }
      />

      <div className="tabs" role="tablist">
        {(["details", "connections", "history"] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={tab === t ? "on" : ""}
            onClick={() => setTab(t)}
          >
            {t === "details"
              ? "Details"
              : t === "connections"
                ? `Connections${links.length ? ` ${links.length}` : ""}`
                : "History"}
            {t === "connections" && hidden.length > 0 && (
              <span className="tab-warn" title={`${hidden.length} off this diagram`} />
            )}
          </button>
        ))}
      </div>

      {tab === "details" && (
        <>
          {/* Facts read as text; each is a picker when you click it. */}
          <div className="grid facts">
            <label>Kind</label>
            <select
              value={o.kind}
              onChange={(e) => save({ kind: e.target.value as ModelObject["kind"] }, "change kind")}
            >
              {OBJECT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
            <label>Status</label>
            <select
              value={o.status}
              onChange={(e) =>
                save({ status: e.target.value as ModelObject["status"] }, "set status")
              }
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <label>Scope</label>
            <select
              value={o.external ? "external" : "ours"}
              onChange={(e) => save({ external: e.target.value === "external" }, "set external")}
            >
              <option value="ours">Ours</option>
              <option value="external">External (someone else's)</option>
            </select>
            <label>Inside</label>
            <select
              value={o.parentId ?? ""}
              onMouseDown={() => setPicking(true)}
              onFocus={() => setPicking(true)}
              onChange={(e) => save({ parentId: e.target.value || null }, "move inside")}
            >
              <option value="">(top level)</option>
              {parents.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
            <RunsIn ids={[o.id]} idx={idx} run={run} />
          </div>

          {o.kind === "table" && (
            <TableFacts
              o={o}
              idx={idx}
              canEdit={canEdit !== false}
              save={save}
              onPick={onShowConnection}
            />
          )}
          {isCodeKind(o.kind) && (
            <CodeFacts
              o={o}
              idx={idx}
              owner={config.github}
              canEdit={canEdit !== false}
              save={save}
              onPick={onShowConnection}
              insights={insights}
            />
          )}

          {on.length > 1 && (
            <>
              <h4>Also on</h4>
              <div className="conn-list">
                {on
                  .filter((d) => d.id !== diagramId)
                  .map((d) => (
                    <button
                      key={d.id}
                      className="link-row as-button"
                      onClick={() => onNavigate(d.id, o.id)}
                      title="Open that diagram with this box selected"
                    >
                      <Layers size={12} />
                      <span className="who">{d.name}</span>
                    </button>
                  ))}
              </div>
            </>
          )}

          <h4>Tags</h4>
          <TagsField
            tags={o.tags}
            groups={config.tags ?? {}}
            idx={idx}
            onChange={(tags, label) => save({ tags: cleanTags(tags) }, label)}
            onGroup={(name, group, label) => run([{ op: "taggroup.put", name, group }], label)}
          />
          <h4>Technology</h4>
          <PickTech
            value={o.technology}
            idx={idx}
            onChange={(technology, label) => save({ technology }, label)}
          />
          <h4>Logo</h4>
          <TextField
            value={o.icon ?? ""}
            placeholder="From the technology (or: rust, none)"
            onCommit={(icon) =>
              save(
                { icon: icon.trim() || undefined },
                icon.trim() ? `logo ${icon.trim()}` : "logo from technology",
              )
            }
          />

          {o.refs && Object.keys(o.refs).length > 0 && (
            <div className="grid refs">
              {Object.entries(o.refs).map(([k, v]) => (
                <Fragment key={k}>
                  <label>{k}</label>
                  <span
                    className="ref"
                    title={
                      protectedRef(k)
                        ? "Protected in archnm.yaml: change it in the files, by hand"
                        : undefined
                    }
                  >
                    {v}
                    {protectedRef(k) && <Lock size={11} className="muted" />}
                  </span>
                </Fragment>
              ))}
            </div>
          )}

          <h4>Links</h4>
          {/* A library's start as its package's (registry, deps.dev, docs): the same list, edited the same way. */}
          <LinksField
            links={
              o.links?.length
                ? o.links
                : o.kind === "library" && o.package
                  ? packageLinks(o.package)
                  : []
            }
            canEdit={canEdit !== false}
            onChange={(links, label) => save({ links: links.length ? links : undefined }, label)}
          />

          <h4>Decisions</h4>
          {decisions.length > 0 && (
            <ul className="plain conn-list">
              {decisions.map((d) => (
                <li
                  key={d.id}
                  className="pickable"
                  title={d.text || undefined}
                  onClick={() => setDeciding(d)}
                >
                  <Scale size={12} className="dir" />
                  <span className="conn-body">
                    <span className="conn-top">
                      <span className="who">{d.title}</span>
                      <span className={`muted via decision-${d.status}`}>{d.status}</span>
                    </span>
                    {(d.date || linkIn(d.text)) && (
                      <span className="muted what">
                        {d.date}
                        {d.date && linkIn(d.text) ? " · " : ""}
                        {linkIn(d.text) && (
                          <a
                            href={linkIn(d.text)!}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {hostOf(linkIn(d.text)!)}
                          </a>
                        )}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {canEdit !== false && (
            <button className="linkish add-line" onClick={() => setDeciding("new")}>
              <Plus size={12} /> Record a decision
            </button>
          )}
          {deciding && (
            <DecisionDialog
              d={deciding === "new" ? null : deciding}
              onCancel={() => setDeciding(null)}
              onSave={(next, label) =>
                void run([{ op: "decision.put", decision: next }], label).then(() =>
                  setDeciding(null),
                )
              }
              make={(title) => ({
                id: nextDecisionId(idx.decisions.values(), title),
                title,
                status: "proposed",
                affects: [o.id],
                text: "",
                createdAt: now(),
                updatedAt: now(),
              })}
            />
          )}

          {o.kind !== "function" && o.kind !== "module" && (
            <Sources sources={o.sources} owner={config.github} />
          )}
          {insights && !!o.sources?.length && <Touched key={o.id} id={o.id} insights={insights} />}
        </>
      )}

      {tab === "connections" && (
        <Connections
          idx={idx}
          o={o}
          inside={inside}
          links={links}
          hidden={hidden}
          addable={addable}
          impact={impact}
          onImpact={onImpact}
          onAdd={() => addToDiagram(addable)}
          onAddOne={(id) => addToDiagram([id])}
          onPick={onShowConnection}
          onHover={onHoverConnection}
        />
      )}

      {tab === "history" &&
        (history.length ? (
          <ul className="plain history">
            {history.slice(0, 60).map((e, i) => (
              <li key={i}>
                <span className="what">
                  {e.label}
                  {e.n > 1 && <span className="muted"> ×{e.n}</span>}
                </span>
                <span className="muted when">
                  {e.actor.name} · {ago(e.at)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">
            No changes recorded here yet. Edits made in the files show in git's history.
          </p>
        ))}
    </Panel>
  );
}

const HIDE_HINT =
  "Take it off this diagram only. It stays in the model and on its other diagrams (⌫)";
const DELETE_HINT = "Delete it from the model: gone from every diagram, with its connections (⇧⌫)";

/** The tech's logo by the name, else the kind's dot. */
function HeadIcon({ tech, fallback }: { tech?: string; fallback: ReactNode }) {
  const [bad, setBad] = useState<string | null>(null);
  if (!tech || bad === tech) return <>{fallback}</>;
  return (
    <TechImg
      className="head-icon"
      tech={tech}
      width={22}
      height={22}
      onMissing={() => setBad(tech)}
    />
  );
}

/** Turn the object panel to a tab from outside it ("⇄ N off diagram" on the canvas). */
export function showObjectTab(t: ObjTab): void {
  try {
    localStorage.setItem("archnm.objTab", t);
  } catch {
    /* not remembered */
  }
  window.dispatchEvent(new CustomEvent("archnm:objtab", { detail: t }));
}

/** Which tab the object panel is on, remembered between selections. */
function useStoredTab(): [ObjTab, (t: ObjTab) => void] {
  useEffect(() => {
    const f = (e: Event) => set((e as CustomEvent<ObjTab>).detail);
    window.addEventListener("archnm:objtab", f);
    return () => window.removeEventListener("archnm:objtab", f);
  }, []);
  const [tab, set] = useState<ObjTab>(() => {
    try {
      const t = localStorage.getItem("archnm.objTab");
      return t === "connections" || t === "history" ? t : "details";
    } catch {
      return "details";
    }
  });
  return [
    tab,
    (t) => {
      set(t);
      try {
        localStorage.setItem("archnm.objTab", t);
      } catch {
        /* not remembered */
      }
    },
  ];
}
type ObjTab = "details" | "connections" | "history";

/** The description as text: click to edit. Long ones fold to a few lines. */
function Description({ text, onSave }: { text: string; onSave: (t: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(false);
  if (editing)
    return (
      <TextField
        multiline
        autoFocus
        className="desc-edit"
        value={text}
        placeholder="What it does, who owns it…"
        onCommit={(v) => {
          setEditing(false);
          if (v !== text) onSave(v);
        }}
      />
    );
  if (!text)
    return (
      <button className="add-line" onClick={() => setEditing(true)}>
        + Add a description
      </button>
    );
  const long = text.length > 220 || text.split("\n").length > 4;
  return (
    <div className={`desc ${long && !open ? "folded" : ""}`}>
      <div className="desc-text" title="Click to edit" onClick={() => setEditing(true)}>
        {text}
      </div>
      {long && (
        <button className="linkish" onClick={() => setOpen((v) => !v)}>
          {open ? "Less" : "More"}
        </button>
      )}
    </div>
  );
}

/** Its connections (its own and its insides'), searchable once there are many, and what's off this diagram. */
function Connections({
  idx,
  o,
  inside,
  links,
  hidden,
  addable,
  onAdd,
  onAddOne,
  onPick,
  onHover,
  impact,
  onImpact,
}: {
  idx: ModelIndex;
  o: ModelObject;
  inside: Set<string>;
  links: Connection[];
  hidden: ReturnType<typeof hiddenLinks>;
  addable: string[];
  onAdd: () => void;
  onAddOne?: (id: string) => void;
  impact?: Props["impact"];
  onImpact?: Props["onImpact"];
  onPick?: (c: Connection) => void;
  onHover?: (c: Connection | null) => void;
}) {
  const [q, setQ] = useState("");
  // A row that goes away under the pointer never gets its mouseleave: let go of the hover.
  useEffect(() => () => onHover?.(null), []); // eslint-disable-line react-hooks/exhaustive-deps
  const name = (id: string) => idx.objects.get(id)?.name ?? "";
  const off = new Set(hidden.map((h) => h.connection.id));
  const here = links.filter((c) => !off.has(c.id));
  const shown = q
    ? here.filter((c) =>
        `${name(c.fromId)} ${name(c.toId)} ${c.name}`.toLowerCase().includes(q.toLowerCase()),
      )
    : here;
  const way = (w: "upstream" | "downstream", words: string) => (
    <button
      className={`seg${impact?.way === w ? " on" : ""}`}
      onClick={() => onImpact?.(impact?.way === w ? null : w)}
      aria-pressed={impact?.way === w}
    >
      {words}
    </button>
  );
  return (
    <>
      {onImpact && links.length > 0 && (
        <div className="impact">
          <div className="segs">
            {way("upstream", "What depends on it")}
            {way("downstream", "What it depends on")}
          </div>
          {impact && (
            <p className="muted small">
              {impact.count
                ? `${impact.count} thing${impact.count === 1 ? "" : "s"}, up to ${impact.hops} hop${impact.hops === 1 ? "" : "s"} away, lit up`
                : "Nothing"}
              {impact.off ? `; ${impact.off} not on this diagram` : ""}
            </p>
          )}
        </div>
      )}
      {hidden.length > 0 && (
        <>
          <h4 className="warn">Off this diagram: {hidden.length}</h4>
          <ul className="plain conn-list">
            {hidden.map((h) => (
              <li
                key={h.connection.id}
                className={onPick ? "pickable" : undefined}
                onClick={onPick ? () => onPick(h.connection) : undefined}
                title="Open a diagram that shows it"
              >
                {h.outgoing ? (
                  <ArrowRight size={12} className="dir" />
                ) : (
                  <ArrowLeft size={12} className="dir" />
                )}
                <span className="conn-body">
                  <span className="conn-top">
                    <span className="who">{name(h.far)}</span>
                    {h.add !== h.far && <span className="muted via">in {name(h.add)}</span>}
                  </span>
                  {h.connection.name && <span className="muted what">{h.connection.name}</span>}
                </span>
                {onAddOne && (
                  <button
                    className="icon-btn row-add"
                    title={`Add ${name(h.add)} to this diagram`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onAddOne(h.add);
                    }}
                  >
                    <Plus size={12} />
                  </button>
                )}
              </li>
            ))}
          </ul>
          {addable.length > 1 && (
            <button className="linkish add-line" onClick={onAdd}>
              <Plus size={12} /> Add all {addable.length} to this diagram
            </button>
          )}
          {here.length > 0 && <h4>On this diagram</h4>}
        </>
      )}
      {links.length > 8 && (
        <input
          className="search"
          value={q}
          placeholder="Search connections"
          onChange={(e) => setQ(e.target.value)}
        />
      )}
      {links.length === 0 && (
        <p className="muted small">No connections yet. Press C to draw one.</p>
      )}
      <ul className="plain conn-list">
        {shown.map((c) => {
          const out = inside.has(c.fromId);
          const mine = out ? c.fromId : c.toId;
          return (
            <li
              key={c.id}
              className={onPick ? "pickable" : undefined}
              onClick={onPick ? () => onPick(c) : undefined}
              onMouseEnter={() => onHover?.(c)}
              onMouseLeave={() => onHover?.(null)}
              title={onPick ? "Show it on the diagram" : undefined}
            >
              {out ? (
                <ArrowRight size={12} className="dir" />
              ) : (
                <ArrowLeft size={12} className="dir" />
              )}
              <span className="conn-body">
                <span className="conn-top">
                  <span className="who">{name(out ? c.toId : c.fromId)}</span>
                  {mine !== o.id && <span className="muted via">via {name(mine)}</span>}
                </span>
                {c.name && <span className="muted what">{c.name}</span>}
              </span>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/**
 * A boundary (a project, a network…): what it is, what's in it and why, and its rules.
 * The frame follows its boxes, so it isn't moved here: its boxes are, or its rules change.
 */
function BoundaryForm({ b, idx, graph, run, onRemove: _ }: Props & { b: Boundary }) {
  const save = (patch: Partial<Boundary>, label: string) => {
    if (Object.entries(patch).some(([k, v]) => b[k as keyof Boundary] !== v))
      void run([{ op: "boundary.put", boundary: { ...b, ...patch, updatedAt: now() } }], label);
  };
  const name = (id: string) => idx.objects.get(id)?.name ?? id;
  // Not itself or anything inside it, or it'd sit inside itself.
  const below = new Set(
    [...idx.boundaries.values()]
      .filter((x) => boundaryChain(idx, x.id).includes(b.id))
      .map((x) => x.id),
  );
  const parents = [...idx.boundaries.values()]
    .filter((x) => !below.has(x.id))
    .sort((x, y) => x.name.localeCompare(y.name));
  const here = (graph?.nodes ?? []).filter((n) =>
    boundaryChain(idx, boundaryOf(idx, n.id)).includes(b.id),
  );
  // A rule as a line: the boxes it lists by name, or what it says.
  const ruleText = (s: Selector) =>
    "ids" in s
      ? s.ids.length > 4
        ? `${s.ids.slice(0, 4).map(name).join(", ")} and ${s.ids.length - 4} more`
        : s.ids.map(name).join(", ")
      : describeSelector(s, name);
  const dropRule = (part: "include" | "exclude", i: number) =>
    save(
      { rules: { ...b.rules, [part]: b.rules[part].filter((_, j) => j !== i) } },
      `change ${b.name}'s rules`,
    );
  return (
    <Panel
      footer={
        <>
          <span className="spacer" />
          <Act
            icon={<Trash2 size={13} />}
            className="danger"
            title="Delete the boundary; what was in it moves up a level"
            onClick={() =>
              void run([{ op: "boundary.delete", id: b.id }], `delete boundary ${b.name}`)
            }
          >
            Delete boundary
          </Act>
        </>
      }
    >
      <div className="eyebrow">{b.kind === "group" ? "Group" : "Boundary: where things run"}</div>
      <div className="title-row">
        <TextField
          className="title-input flow-field"
          value={b.name}
          onCommit={(v) => v.trim() && save({ name: v.trim() }, "rename boundary")}
        />
      </div>
      <div className="grid">
        <label>Kind</label>
        <select
          value={b.kind}
          onChange={(e) =>
            save({ kind: e.target.value as Boundary["kind"] }, "change boundary kind")
          }
        >
          {BOUNDARY_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <label>Inside</label>
        <select
          value={b.parentId ?? ""}
          onChange={(e) => save({ parentId: e.target.value || null }, "move boundary")}
        >
          <option value="">(none)</option>
          {parents.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
      </div>
      <TextField
        multiline
        value={b.description}
        placeholder="What it is: the project, the network's range kept out of here…"
        onCommit={(description) => save({ description }, "describe boundary")}
      />

      <h4>Picks</h4>
      <ul className="plain conn-list">
        {b.rules.include.map((s, i) => (
          <li key={`i${i}`}>
            <span className="who">{ruleText(s)}</span>
            <button
              className="icon"
              title="Take this rule off"
              onClick={() => dropRule("include", i)}
            >
              <X size={12} />
            </button>
          </li>
        ))}
        {b.rules.exclude.map((s, i) => (
          <li key={`x${i}`}>
            <span className="muted">not</span> <span className="who">{ruleText(s)}</span>
            <button
              className="icon"
              title="Take this rule off"
              onClick={() => dropRule("exclude", i)}
            >
              <X size={12} />
            </button>
          </li>
        ))}
        {!b.rules.include.length && (
          <li className="muted">Nothing yet: pick a box and set where it runs.</li>
        )}
      </ul>
      <p className="muted small">
        To put a box in it, select the box and choose this under “Runs in”. Rules by tag (env:prod)
        catch new things on their own; edit them in boundaries.yaml.
      </p>

      <h4>On this diagram: {here.length}</h4>
      <ul className="plain conn-list">
        {here.map((n) => {
          const own = boundaryOf(idx, n.id);
          return (
            <li key={n.id}>
              <span className="who">{n.name}</span>
              <span className="muted via">
                {own === b.id
                  ? whyIn(idx, b, n.id, name)
                  : `in ${idx.boundaries.get(own ?? "")?.name ?? ""}`}
              </span>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

/**
 * Where boxes run: their boundary, picked from a list, or a new one. The boundaries' rules
 * are edited to match, so boundaries.yaml stays the truth.
 */
function RunsIn({ ids, idx, run }: { ids: string[]; idx: ModelIndex; run: Props["run"] }) {
  const [making, setMaking] = useState(false);
  const [draft, setDraft] = useState<{ name: string; kind: BoundaryKind; parentId: string }>({
    name: "",
    kind: "project",
    parentId: "",
  });
  const now0 = [...new Set(ids.map((id) => boundaryOf(idx, id) ?? ""))];
  const cur = now0.length === 1 ? now0[0]! : "mixed";
  const label = (id: string) =>
    boundaryChain(idx, id)
      .reverse()
      .map((x) => idx.boundaries.get(x)?.name)
      .join(" › ");
  const all = [...idx.boundaries.keys()].sort((a, b) => label(a).localeCompare(label(b)));
  const what = ids.length === 1 ? (idx.objects.get(ids[0]!)?.name ?? "it") : `${ids.length} boxes`;
  return (
    <>
      <label>Runs in</label>
      <select
        value={cur}
        title={cur && cur !== "mixed" ? label(cur) : "Not in any boundary"}
        onChange={(e) => {
          if (e.target.value === "new") return setMaking(true);
          const to = e.target.value || null;
          const ops = moveManyToBoundaryOps(idx, ids, to);
          if (ops.length)
            void run(
              ops,
              to ? `${what} runs in ${idx.boundaries.get(to)?.name}` : `${what} in no boundary`,
            );
        }}
      >
        {cur === "mixed" && <option value="mixed">(several)</option>}
        <option value="">(none)</option>
        {all.map((id) => (
          <option key={id} value={id}>
            {label(id)}
          </option>
        ))}
        <option value="new">New boundary…</option>
      </select>
      {making && (
        <Dialog
          title="New boundary"
          confirm="Create"
          disabled={!draft.name.trim()}
          onCancel={() => setMaking(false)}
          onConfirm={() => {
            const { ops } = newBoundaryOps(
              idx,
              { name: draft.name.trim(), kind: draft.kind, parentId: draft.parentId || null },
              ids,
            );
            void run(ops, `new boundary ${draft.name.trim()}`);
            setMaking(false);
          }}
        >
          <p className="muted small">
            Where {what} run{ids.length === 1 ? "s" : ""}: a cloud project, a machine (host), a
            network, a subnet, the edge. Shown as a dashed frame on diagrams with boundaries on.
          </p>
          <div className="grid">
            <label>Name</label>
            <input
              value={draft.name}
              placeholder="acme-prod"
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
            <label>Kind</label>
            <select
              value={draft.kind}
              onChange={(e) => setDraft({ ...draft, kind: e.target.value as BoundaryKind })}
            >
              {BOUNDARY_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            <label>Inside</label>
            <select
              value={draft.parentId}
              onChange={(e) => setDraft({ ...draft, parentId: e.target.value })}
            >
              <option value="">(none)</option>
              {all.map((id) => (
                <option key={id} value={id}>
                  {label(id)}
                </option>
              ))}
            </select>
          </div>
        </Dialog>
      )}
    </>
  );
}

/** The backend's insights, for the design that's open. */
interface DocInsights {
  touched(id: string): Promise<TouchedInfo>;
  libstats(): Promise<{ enabled: boolean; stats: Record<string, LibStats | null> }>;
}

/**
 * Who's touched it: the authors of recent commits on its sources, read from git when asked
 * (it costs GitHub calls). Instead of an owner field nobody keeps up to date.
 */
function Touched({ id, insights }: { id: string; insights: DocInsights }) {
  const [info, setInfo] = useState<TouchedInfo | "loading" | { error: string } | null>(null);
  const load = () => {
    setInfo("loading");
    insights
      .touched(id)
      .then(setInfo)
      .catch((e) => setInfo({ error: e instanceof Error ? e.message : "couldn't read it" }));
  };
  const ago = (iso: string) => {
    const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
    return days < 1
      ? "today"
      : days < 31
        ? `${days}d ago`
        : days < 365
          ? `${Math.floor(days / 30)}mo ago`
          : `${Math.floor(days / 365)}y ago`;
  };
  return (
    <>
      <h4>Who's touched it</h4>
      {info === null ? (
        <button className="link-add" onClick={load}>
          <Users size={12} /> Read from git
        </button>
      ) : info === "loading" ? (
        <p className="muted small">Reading commits…</p>
      ) : "error" in info ? (
        <p className="muted small">{info.error}</p>
      ) : (
        <div className="conn-list touched">
          {info.people.slice(0, 8).map((p) => (
            <div
              key={p.login ?? p.name}
              className="link-row"
              title={
                p.withAgent
                  ? `${p.withAgent} of ${p.commits} commits had an agent co-author`
                  : undefined
              }
            >
              <span className="conn-body">
                <span className="conn-top">
                  <span className="who">{p.name}</span>
                  <span className="muted via">{ago(p.last)}</span>
                </span>
                <span className="muted what">
                  {p.commits} commit{p.commits === 1 ? "" : "s"}
                  {p.withAgent ? `, ${p.withAgent} with an agent` : ""}
                </span>
              </span>
            </div>
          ))}
          {!info.people.length && (
            <p className="muted small">
              {info.looked.length
                ? "No commits on its sources."
                : "None of its sources could be read."}
            </p>
          )}
          {info.missed.map((m) => (
            <p key={m.source} className="muted small" title={m.why}>
              Couldn't read {m.source}
            </p>
          ))}
        </div>
      )}
    </>
  );
}

/** Where the facts come from: repo@sha:path:line opens on GitHub (archnm.yaml's github). */
/**
 * The code variant: a module's path, a function's file and calls (with hops), a library's
 * package, links and who uses it. Same panel, a few facts more.
 */
/** What the stats job knows about a package: people, licence, releases, and why to look twice. */
function PackageStats({ pkg, insights }: { pkg: Package; insights: DocInsights }) {
  const key = statsKey(pkg);
  const [got, setGot] = useState<{ enabled: boolean; stats: LibStats | null } | null>(null);
  useEffect(() => {
    let gone = false;
    insights
      .libstats()
      .then((j) => !gone && setGot({ enabled: j.enabled, stats: j.stats[key] ?? null }))
      .catch(() => undefined);
    return () => {
      gone = true;
    };
    // The insights object is made fresh on each render upstream; the package is what matters.
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!got) return null;
  const s = got.stats;
  if (!s)
    return (
      <p className="muted small">
        {got.enabled
          ? "Stats arrive with the next daily fetch."
          : "No stats: the server's library stats job is off (ARCHNM_LIBSTATS=on)."}
      </p>
    );
  const n = (x: number) => (x >= 1000 ? `${(x / 1000).toFixed(x >= 10_000 ? 0 : 1)}k` : String(x));
  const day = (d?: string) => d?.slice(0, 10);
  return (
    <>
      {!!s.warnings.length && (
        <div className="lib-warn">
          {s.warnings.map((w) => (
            <span key={w} className="tag warn">
              {w}
            </span>
          ))}
        </div>
      )}
      <div className="grid facts lib-stats">
        {s.stars !== undefined && (
          <>
            <label>Stars</label>
            <span>{n(s.stars)}</span>
          </>
        )}
        {s.contributors !== undefined && (
          <>
            <label>People</label>
            <span>{n(s.contributors)}</span>
          </>
        )}
        {!!s.licenses?.length && (
          <>
            <label>Licence</label>
            <span>{s.licenses.join(", ")}</span>
          </>
        )}
        {s.versionAt && (
          <>
            <label>This version</label>
            <span>{day(s.versionAt)}</span>
          </>
        )}
        {s.latest && (
          <>
            <label>Latest</label>
            <span>
              {s.latest}
              {s.latestAt ? ` · ${day(s.latestAt)}` : ""}
            </span>
          </>
        )}
        {s.scorecard !== undefined && (
          <>
            <label>OpenSSF</label>
            <span>{s.scorecard.toFixed(1)} / 10</span>
          </>
        )}
        {!!s.advisories?.length && (
          <>
            <label>Advisories</label>
            <span>
              {s.advisories.map((a) => (
                <a
                  key={a}
                  href={`https://osv.dev/vulnerability/${encodeURIComponent(a)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {a}{" "}
                </a>
              ))}
            </span>
          </>
        )}
      </div>
      {s.repo && (
        <a
          className="link-row"
          href={s.repo}
          target="_blank"
          rel="noopener noreferrer"
          title={s.repo}
        >
          <ExternalLink size={12} />
          <span className="who">Source</span>
        </a>
      )}
      <p className="muted small">
        From deps.dev{s.contributors !== undefined ? " and GitHub" : ""}, {day(s.fetchedAt)}
        {s.error ? ` (partly: ${s.error})` : ""}
      </p>
    </>
  );
}

function CodeFacts({
  o,
  idx,
  owner,
  canEdit,
  save,
  onPick,
  insights,
}: {
  o: ModelObject;
  idx: ModelIndex;
  owner?: string;
  canEdit: boolean;
  save: (patch: Partial<ModelObject>, label: string) => void;
  onPick?: (c: Connection) => void;
  insights?: DocInsights;
}) {
  const home = codeHome(idx, o.id);
  const { calls, calledBy, libraries, usedBy } = useMemo(
    () => callsOf(idx, o.id, o.kind === "module"),
    [idx, o.id, o.kind],
  );
  const rows = (title: string, list: Call[], dir: "→" | "←") =>
    list.length > 0 && (
      <>
        <h4>
          {title} <span className="muted">{list.length}</span>
        </h4>
        <ul className="plain conn-list">
          {list.slice(0, 30).map((c) => (
            <li
              key={c.conn.id}
              className="pickable"
              onClick={() => onPick?.(c.conn)}
              title={[c.conn.name, c.conn.technology].filter(Boolean).join(" · ") || undefined}
            >
              <span className="dir">{dir}</span>
              <span className="conn-body">
                <span className="conn-top">
                  <span className={`who ${c.other.kind === "function" ? "code" : ""}`}>
                    {c.other.name}
                  </span>
                  {c.hop && <span className="hop">{c.conn.technology || "another process"}</span>}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </>
    );
  return (
    <div className="code-facts">
      {o.kind === "module" && (
        <>
          <h4>Path</h4>
          <TextField
            className="code"
            value={o.path ?? ""}
            placeholder="repo:path/to/file.rs"
            onCommit={(path) =>
              canEdit &&
              save({ path: path.trim() || undefined }, path.trim() ? "set path" : "remove path")
            }
          />
        </>
      )}
      {o.kind === "function" && !o.sources?.length && (
        <>
          <h4>Source</h4>
          <div className="code-ref" title={home ? undefined : "Put it inside a module with a path"}>
            {home?.path ?? <span className="muted">in no file yet</span>}
          </div>
        </>
      )}
      {(o.kind === "function" || o.kind === "module") && (
        <Sources sources={o.sources} owner={owner} />
      )}
      {o.kind === "library" && (
        <>
          <h4>Package</h4>
          <div className="grid facts">
            <label>Ecosystem</label>
            <select
              value={o.package?.ecosystem ?? "other"}
              disabled={!canEdit}
              onChange={(e) =>
                save(
                  {
                    package: {
                      name: o.package?.name ?? o.name,
                      ...o.package,
                      ecosystem: e.target.value as Package["ecosystem"],
                    },
                  },
                  "set ecosystem",
                )
              }
            >
              {ECOSYSTEMS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            <label>Name</label>
            <TextField
              value={o.package?.name ?? ""}
              placeholder={o.name}
              onCommit={(name) =>
                canEdit &&
                name.trim() &&
                save(
                  { package: { ecosystem: "other", ...o.package, name: name.trim() } },
                  "set package",
                )
              }
            />
            <label>Version</label>
            <TextField
              value={o.package?.version ?? ""}
              placeholder="any"
              onCommit={(v) =>
                canEdit &&
                o.package &&
                save(
                  { package: { ...o.package, version: v.trim() || undefined } },
                  v.trim() ? `version ${v.trim()}` : "any version",
                )
              }
            />
          </div>
          {o.package && insights && <PackageStats pkg={o.package} insights={insights} />}
        </>
      )}
      {rows("Calls", calls, "→")}
      {rows("Called by", calledBy, "←")}
      {rows("Uses", libraries, "→")}
      {rows("Used by", usedBy, "←")}
    </div>
  );
}

/**
 * A table's panel: its columns, one line each like its links (name, type, the keys that
 * apply, where a key points), then what points at it and what reads or writes it. It shows
 * what the files say; edit in the YAML, or right-click a column here.
 */
function TableFacts({
  o,
  idx,
  canEdit,
  save,
  onPick,
}: {
  o: ModelObject;
  idx: ModelIndex;
  canEdit: boolean;
  save: (patch: Partial<ModelObject>, label: string) => void;
  onPick?: (c: Connection) => void;
}) {
  const cols = o.columns ?? [];
  const keys = useMemo(() => keysOf(idx, o.id), [idx, o.id]);
  const users = useMemo(
    () =>
      [...idx.connections.values()].filter(
        (c) =>
          !c.column &&
          c.status !== "removed" &&
          (c.toId === o.id || c.fromId === o.id) &&
          idx.objects.get(c.toId === o.id ? c.fromId : c.toId)?.kind !== "table",
      ),
    [idx, o.id],
  );
  const [editing, setEditing] = useState<number | null>(null);
  const menu = useMenu();
  const put = (i: number, c: Column) => {
    if (cols.some((x, j) => j !== i && x.name === c.name))
      return `there's already a column ${c.name}`;
    save(
      { columns: i < 0 ? [...cols, c] : cols.map((x, j) => (j === i ? c : x)) },
      i < 0 ? `added column ${c.name}` : `changed column ${c.name}`,
    );
    setEditing(null);
    return "";
  };
  return (
    <div className="table-facts">
      {menu.node}
      <h4>Columns</h4>
      <div className="col-list col-grid">
        {cols.map((c, i) => {
          const out = keys.out.filter((k) => k.column === c.name);
          return editing === i ? (
            <ColumnForm
              key={c.name}
              value={c}
              onSave={(x) => put(i, x)}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <div
              key={c.name}
              className="col-line"
              title={c.description || undefined}
              onContextMenu={menu.on(() => [
                {
                  label: "Edit",
                  icon: <Pencil size={14} />,
                  disabled: !canEdit,
                  run: () => setEditing(i),
                },
                {
                  label: "Remove",
                  icon: <Trash2 size={14} />,
                  danger: true,
                  disabled: !canEdit,
                  run: () =>
                    save({ columns: cols.filter((_, j) => j !== i) }, `removed column ${c.name}`),
                },
              ])}
            >
              <span className="col-name">{c.name}</span>
              <span className="col-type">
                {c.type}
                {c.nullable ? "?" : ""}
              </span>
              <span className="col-marks">
                {c.pk && <span className="col-mark pk">PK</span>}
                {out.length > 0 && <span className="col-mark fk">FK</span>}
                {c.unique && <span className="col-mark uq">UQ</span>}
                {c.personal && (
                  <span className="col-mark pii" title="Personal data">
                    PII
                  </span>
                )}
              </span>
              {out.map((k) => (
                <button
                  key={k.conn.id}
                  className="linkish col-to"
                  onClick={() => onPick?.(k.conn)}
                  title="Select this key's line"
                >
                  → {columnRef(idx, k.to, k.toColumn)}
                  {k.acrossShort && (
                    <span className="col-region" title={`Across regions: ${k.across}`}>
                      {k.acrossShort}
                    </span>
                  )}
                </button>
              ))}
            </div>
          );
        })}
        {!cols.length && <p className="muted small">None listed.</p>}
        {canEdit &&
          (editing === -1 ? (
            <ColumnForm onSave={(x) => put(-1, x)} onCancel={() => setEditing(null)} />
          ) : (
            <button className="linkish add-line" onClick={() => setEditing(-1)}>
              <Plus size={12} /> Add a column
            </button>
          ))}
      </div>
      {keys.in.length > 0 && (
        <>
          <h4>Pointed at by</h4>
          <div className="col-list">
            {keys.in.map((k) => (
              <button key={k.conn.id} className="linkish col-to" onClick={() => onPick?.(k.conn)}>
                ← {columnRef(idx, k.from, k.column)}
                {k.acrossShort && (
                  <span className="col-region" title={`Across regions: ${k.across}`}>
                    {k.acrossShort}
                  </span>
                )}
              </button>
            ))}
          </div>
        </>
      )}
      {users.length > 0 && (
        <>
          <h4>Read and written by</h4>
          <div className="col-list">
            {users.map((c) => {
              const other = idx.objects.get(c.toId === o.id ? c.fromId : c.toId)!;
              return (
                <button key={c.id} className="linkish col-to" onClick={() => onPick?.(c)}>
                  {c.toId === o.id ? "←" : "→"} {other.name}
                  {c.name && <span className="muted"> · {c.name}</span>}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

/** Add or change one column: its name and type ("uuid?" for nullable), and what it is. */
function ColumnForm({
  value,
  onSave,
  onCancel,
}: {
  value?: Column;
  onSave: (c: Column) => string;
  onCancel: () => void;
}) {
  const [name, setName] = useState(value?.name ?? "");
  const [type, setType] = useState(value ? `${value.type}${value.nullable ? "?" : ""}` : "");
  const [pk, setPk] = useState(!!value?.pk);
  const [personal, setPersonal] = useState(!!value?.personal);
  const [err, setErr] = useState("");
  const submit = () => {
    if (!name.trim()) return setErr("a name");
    const t = type.trim();
    setErr(
      onSave({
        ...value,
        name: name.trim(),
        type: t.replace(/\?$/, ""),
        nullable: t.endsWith("?") || undefined,
        pk: pk || undefined,
        personal: personal || undefined,
      }),
    );
  };
  return (
    <div
      className="group-form"
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") (e.preventDefault(), submit());
        else if (e.key === "Escape") onCancel();
      }}
    >
      <input
        autoFocus
        value={name}
        placeholder="name (customer_id)"
        onChange={(e) => setName(e.target.value)}
      />
      <input
        value={type}
        placeholder="type (uuid, text; uuid? if it can be empty)"
        onChange={(e) => setType(e.target.value)}
      />
      <div className="col-form-flags">
        <label>
          <input type="checkbox" checked={pk} onChange={(e) => setPk(e.target.checked)} /> primary
          key
        </label>
        <label>
          <input
            type="checkbox"
            checked={personal}
            onChange={(e) => setPersonal(e.target.checked)}
          />{" "}
          personal data
        </label>
      </div>
      {err && <p className="err small">{err}</p>}
      <div className="group-form-acts">
        <button onClick={onCancel}>Cancel</button>
        <button className="primary" disabled={!name.trim()} onClick={submit}>
          {value ? "Save" : "Add"}
        </button>
      </div>
    </div>
  );
}

function Sources({ sources, owner }: { sources?: string[]; owner?: string }) {
  if (!sources?.length) return null;
  return (
    <>
      <h4>{sources.length === 1 ? "Source" : "Sources"}</h4>
      <div className="conn-list">
        {sources.map((s) => {
          const url = sourceLink(owner, s);
          // repo@sha:path:line reads as the path and line; the repo and commit are in the tooltip.
          const m = /^([^@:\s]+)(?:@([^:]+))?:(.+)$/.exec(s);
          const label = m ? (
            <>
              <span className="code-ref">{m[3]}</span>
            </>
          ) : (
            s
          );
          const tip = `${s}${m?.[2] ? `\n${m[1]} at ${m[2]}` : ""}${url ? `\n${url}` : owner ? "" : "\nSet github: in archnm.yaml to link these"}`;
          return url ? (
            <a
              key={s}
              className="link-row source-row"
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              title={tip}
            >
              <FileCode2 size={12} />
              <span className="who">{label}</span>
            </a>
          ) : (
            <div key={s} className="link-row source-row" title={tip}>
              <FileCode2 size={12} />
              <span className="who">{label}</span>
            </div>
          );
        })}
      </div>
    </>
  );
}

/**
 * Copy a link to it: the same link for a person and an agent (the MCP's open and context
 * read it). A tick says it's on the clipboard.
 */
export function CopyLinkButton({ to, what }: { to: Parameters<typeof copyLink>[0]; what: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1400);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button
      className={`icon-btn copy-link${done ? " done" : ""}`}
      title={`Copy a link to ${what}: for people, and for agents (the Archnemesis MCP opens it)`}
      onClick={() => void copyLink(to).then(setDone)}
    >
      {done ? <Check size={14} /> : <Link2 size={14} />}
    </button>
  );
}

function ConnectionForm({ c, idx, config, run, canEdit }: Props & { c: Connection }) {
  const via = c.viaId ? idx.objects.get(c.viaId) : undefined;
  const from = idx.objects.get(c.fromId);
  const to = idx.objects.get(c.toId);
  const save = (patch: Partial<Connection>, label: string) => {
    const changed = Object.entries(patch).some(([k, v]) => c[k as keyof Connection] !== v);
    if (changed) void run(updateConnection(c, patch), label);
  };
  return (
    <div className="connection-form">
      {from?.kind === "table" && to?.kind === "table" && (
        <div className="grid key-pick">
          <label>Key</label>
          <select
            className="flow-field"
            value={c.column ?? ""}
            onChange={(e) => save({ column: e.target.value || undefined }, "set key column")}
          >
            <option value="">{from.name}: which column?</option>
            {(from.columns ?? []).map((col) => (
              <option key={col.name} value={col.name}>
                {from.name}.{col.name}
              </option>
            ))}
          </select>
          <label>Points at</label>
          <select
            value={c.toColumn ?? ""}
            onChange={(e) => save({ toColumn: e.target.value || undefined }, "set key target")}
          >
            <option value="">
              {to.name}.{to.columns?.find((x) => x.pk)?.name ?? "id"} (its key)
            </option>
            {(to.columns ?? []).map((col) => (
              <option key={col.name} value={col.name}>
                {to.name}.{col.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <TextField
        className="flow-field"
        value={c.name}
        placeholder="What it does (shown on the arrow)"
        onCommit={(name) => save({ name }, "name connection")}
      />
      <div className="grid">
        <label>Technology</label>
        <TextField
          className="flow-field"
          value={c.technology}
          placeholder="HTTPS, gRPC…"
          onCommit={(technology) => save({ technology }, "set technology")}
        />
        <label>Status</label>
        <select
          value={c.status}
          onChange={(e) => save({ status: e.target.value as Connection["status"] }, "set status")}
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      <TextField
        multiline
        value={c.description}
        placeholder="Details…"
        onCommit={(description) => save({ description }, "describe connection")}
      />
      <AgentContext
        of={`${idx.objects.get(c.fromId)?.name ?? "?"} → ${idx.objects.get(c.toId)?.name ?? "?"}${c.name ? ` (${c.name})` : ""}`}
        text={c.context ?? ""}
        canEdit={canEdit}
        onSave={(context) =>
          save(
            { context: context || undefined },
            context ? "write agent context" : "remove agent context",
          )
        }
      />
      {via && <div className="muted small">Passes through {via.name}</div>}
      <Sources sources={c.sources} owner={config.github} />
    </div>
  );
}

/** The first link in a decision's text: its RFC, usually (ours are in Notion). */
function linkIn(text: string): string | null {
  const m = /https?:\/\/[^\s)>\]]+/.exec(text);
  return m ? safeUrl(m[0]) : null;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/**
 * Record a decision about a box, or change one: what was decided, where it stands, and a
 * link to the write-up (an RFC in Notion). Kept as an ADR-style file under decisions/.
 */
function DecisionDialog({
  d,
  make,
  onSave,
  onCancel,
}: {
  d: Decision | null;
  make: (title: string) => Decision;
  onSave: (d: Decision, label: string) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(d?.title ?? "");
  const [status, setStatus] = useState<DecisionStatus>(d?.status ?? "proposed");
  const [date, setDate] = useState(d?.date ?? "");
  const [link, setLink] = useState(d ? (linkIn(d.text) ?? "") : "");
  // The text without the link line we put at its top, if it's there.
  const [notes, setNotes] = useState(d ? d.text.replace(/^Link: \S+\n*/, "") : "");
  const url = link.trim() ? safeUrl(link.trim()) : null;
  const save = () => {
    if (!title.trim()) return;
    const base = d ?? make(title.trim());
    const text = `${url ? `Link: ${url}\n\n` : ""}${notes.trim()}`.trim();
    const next: Decision = { ...base, title: title.trim(), status, text, updatedAt: now() };
    if (date) next.date = date;
    else delete next.date;
    if (status === "accepted" && !next.date) next.date = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD, your day
    onSave(next, d ? `decision ${title.trim()}` : `recorded decision ${title.trim()}`);
  };
  return (
    <Dialog
      title={d ? "Decision" : "Record a decision"}
      confirm={d ? "Save" : "Record"}
      disabled={!title.trim() || (!!link.trim() && !url)}
      onConfirm={save}
      onCancel={onCancel}
    >
      <div className="decision-form">
        <label>
          What was decided
          <input
            value={title}
            placeholder="Use Postmark for transactional email"
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <div className="decision-row">
          <label>
            Status
            <select value={status} onChange={(e) => setStatus(e.target.value as DecisionStatus)}>
              {DECISION_STATUSES.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
          </label>
          <label>
            Decided on
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
        </div>
        <label>
          Write-up (RFC, doc)
          <input
            value={link}
            placeholder="https://www.notion.so/…"
            onChange={(e) => setLink(e.target.value)}
          />
        </label>
        <label>
          Notes
          <textarea
            rows={4}
            value={notes}
            placeholder="Why, and what it means for this box"
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>
      </div>
    </Dialog>
  );
}
