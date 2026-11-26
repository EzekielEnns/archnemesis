// The controls floating over the canvas, laid out like Excalidraw: the sidebar toggle and
// where you are top-left, the tools top-centre, zoom, history and the minimap bottom-left, help
// bottom-right.
import type { How } from "../../shared/trail";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import {
  Layers,
  AppWindow,
  Boxes,
  Cable,
  CircleHelp,
  Crosshair,
  Database,
  Map as MapIcon,
  Maximize,
  Minus,
  MoreVertical,
  MousePointer2,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Puzzle,
  Search,
  User,
  CloudOff,
  Eye,
  LoaderCircle,
  MessageSquarePlus,
  Activity,
  FileCode,
  Package,
  SquareFunction,
  Table2,
  Undo2,
  House,
  ArrowUp,
  SquareDashed,
} from "lucide-react";
import {
  isCodeKind,
  now,
  OBJECT_KINDS,
  KIND_LABEL,
  type ObjectKind,
  type Op,
} from "../../shared/model.ts";
import { diagramForScope, scopeTrail, type ModelIndex } from "../../shared/project.ts";
import type { Connectivity } from "../store";
import { KIND_CSS } from "./KindDot";
import { backend } from "../backend";
import { DesignMenu } from "./DesignMenu";
import { BranchMenu } from "./BranchMenu";
import type { Store } from "../store";

/** What a click on the canvas does. */
/** view: look around and read (drag pans, a click opens a box's panel), nothing moves. */
export type ToolId = "select" | "view" | "connect" | "note" | "group" | ObjectKind;

const KIND_ICON: Record<ObjectKind, ReactNode> = {
  actor: <User size={16} />,
  system: <Boxes size={16} />,
  app: <AppWindow size={16} />,
  store: <Database size={16} />,
  component: <Puzzle size={16} />,
  module: <FileCode size={16} />,
  function: <SquareFunction size={16} />,
  library: <Package size={16} />,
  table: <Table2 size={16} />,
};

/** The toolbar places the architecture kinds, then files and functions for sketching code by
 * hand. Libraries come from an importer or an agent (or the canvas menu). */
const ARCH_KINDS = OBJECT_KINDS.filter((k) => !isCodeKind(k) && k !== "table");
const CODE_TOOLS: ObjectKind[] = ["module", "function"];
/** A table, dropped onto the store that holds it (its columns are in its panel). */
const DATA_TOOLS: ObjectKind[] = ["table"];
const TOOL_KINDS = [...ARCH_KINDS, ...CODE_TOOLS, ...DATA_TOOLS];
const TOOL_TITLE: Partial<Record<ObjectKind, string>> = {
  module: "Place a file or folder (module)",
  function: "Place a function",
  table: "Place a table (drop it on a store)",
};

/** Number keys, as in Excalidraw: 1 select, then the kinds. */
export const TOOL_KEYS: Record<string, ToolId> = {
  v: "select",
  "1": "select",
  ...Object.fromEntries(TOOL_KINDS.map((k, i) => [String(i + 2), k])),
  n: "note",
  g: "group",
};
const keyOf = (t: ToolId) =>
  t === "select"
    ? "1"
    : t === "view"
      ? "H"
      : t === "connect"
        ? "C"
        : t === "note"
          ? "N"
          : t === "group"
            ? "G"
            : String(TOOL_KINDS.indexOf(t) + 2);

// --- top left ---------------------------------------------------------------------------

interface TopLeftProps {
  idx: ModelIndex;
  diagramId: string;
  sidebar: boolean;
  connectivity: Connectivity;
  viewOnly?: boolean;
  onSidebar: () => void;
  onNavigate: (diagramId: string, how?: How) => void;
  /** Up one level (to the diagram of what this one is inside); null on the landscape. */
  onUp: (() => void) | null;
  run: (ops: Op[], label: string) => Promise<unknown>;
  design: { key: string; name: string };
  store: Store;
  toast: (text: string, tone?: "info" | "error") => void;
  /** After a jump to another diagram: a quiet way back to where you were. */
  jumpBack?: { label: string; run: () => void } | null;
}

export function TopLeft(p: TopLeftProps) {
  const diagram = p.idx.diagrams.get(p.diagramId);
  const trail = scopeTrail(p.idx, p.diagramId);
  const landscape = diagramForScope(p.idx, null);
  const [editing, setEditing] = useState(false);
  // Every level above this one: the landscape, then what this view is inside, outermost first.
  const levels = [
    ...(landscape && landscape.id !== p.diagramId
      ? [
          {
            objectId: null as string | null,
            name: landscape.name,
            diagramId: landscape.id as string | undefined,
          },
        ]
      : []),
    ...trail.slice(0, -1),
  ];
  // Top level / … / here: "…" is one level up (the nearest parent's view), not a list of
  // the levels between. Directly under the landscape there's nothing between, so no "…".
  const top = levels[0]?.objectId === null ? levels[0] : undefined;
  const between = levels.slice(top ? 1 : 0);
  const upTo = between[between.length - 1]?.name;
  // Views at this level that aren't this one: Deployment beside the landscape, a second view
  // of the same box. Drilling down never reaches them, so they're offered here.
  const siblings = [...p.idx.diagrams.values()]
    .filter((d) => d.id !== p.diagramId && (d.scopeId ?? null) === (diagram?.scopeId ?? null))
    .sort((a, b) => a.name.localeCompare(b.name));
  const rename = (name: string) => {
    setEditing(false);
    const trimmed = name.trim();
    if (!diagram || !trimmed || trimmed === diagram.name) return;
    void p.run(
      [{ op: "diagram.put", diagram: { ...diagram, name: trimmed, updatedAt: now() } }],
      "rename diagram",
    );
  };

  return (
    <div className="chrome top-left">
      <div className="island">
        <button
          className={p.sidebar ? "icon-btn on" : "icon-btn"}
          onClick={p.onSidebar}
          title={p.sidebar ? "Close the drawer ([)" : "Open the drawer ([)"}
        >
          {p.sidebar ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
        </button>
      </div>
      <nav className="island crumbs">
        <DesignMenu design={p.design.key} name={p.design.name} isAdmin={p.store.isAdmin} />
        {backend.git && <BranchMenu store={p.store} toast={p.toast} />}
        <span className="crumb-div" />
        {top && (
          <button
            className="icon-btn crumb-icon"
            onClick={() => p.onNavigate(top.diagramId!, "home")}
            title={`The top level: ${top.name}`}
          >
            <House size={15} />
          </button>
        )}
        {between.length > 0 && (
          <button
            className="icon-btn crumb-icon"
            onClick={() => p.onUp?.()}
            disabled={!p.onUp}
            title={`Up one level${upTo ? `, to ${upTo}` : ""} (⌘↑)`}
          >
            <ArrowUp size={15} />
          </button>
        )}
        {editing ? (
          <input
            className="crumb-input"
            autoFocus
            defaultValue={diagram?.name}
            onBlur={(e) => rename(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") rename(e.currentTarget.value);
              if (e.key === "Escape") setEditing(false);
            }}
          />
        ) : (
          <button
            className="crumb current"
            onDoubleClick={() => setEditing(true)}
            title="Double-click to rename"
          >
            {diagram?.name}
          </button>
        )}
        {siblings.length > 0 && (
          <OtherViews views={siblings} onNavigate={(id) => p.onNavigate(id, "sibling")} />
        )}

        {p.viewOnly && (
          <span
            className="conn-chip view-only"
            title="You can look around, but not change this design"
          >
            <Eye size={13} />
            View only
          </span>
        )}
        {/* Only said when something's wrong: live is the normal state. */}
        {p.connectivity !== "live" && (
          <span
            className={`conn-chip ${p.connectivity}`}
            title={
              p.connectivity === "offline"
                ? "Can't reach the server; edits wait and sync when it's back"
                : "Connecting…"
            }
          >
            {p.connectivity === "offline" ? (
              <CloudOff size={13} />
            ) : (
              <LoaderCircle size={13} className="spin" />
            )}
            {p.connectivity === "offline" ? "Offline" : null}
          </span>
        )}
        {p.jumpBack && (
          <button
            className="icon-btn crumb-icon crumb-back"
            onClick={p.jumpBack.run}
            title={`Back to ${p.jumpBack.label} (⌥←)`}
          >
            <Undo2 size={15} />
          </button>
        )}
      </nav>
    </div>
  );
}

// --- tools ------------------------------------------------------------------------------

interface ToolsProps {
  tool: ToolId;
  onTool: (t: ToolId) => void;
  onSearch: () => void;
  /** Shown under the tools while a tool other than select is on. */
  hint: ReactNode;
}

export function Tools({
  tool,
  onTool,
  onSearch,
  hint,
  simple,
  last,
  compact,
}: ToolsProps & { simple?: boolean; last?: ObjectKind | null; compact?: boolean }) {
  const [more, setMore] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!more) return;
    const off = (e: PointerEvent) => !moreRef.current?.contains(e.target as Node) && setMore(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setMore(false);
    addEventListener("pointerdown", off, true);
    addEventListener("keydown", esc);
    return () => (
      removeEventListener("pointerdown", off, true),
      removeEventListener("keydown", esc)
    );
  }, [more]);
  const pick = (t: ToolId) => (onTool(tool === t && t !== "select" ? "select" : t), setMore(false));
  const btn = (t: ToolId, icon: ReactNode, title: string, color?: string, label?: string) => (
    <button
      key={t}
      className={`tool${tool === t ? " on" : ""}${last === t ? " last" : ""}`}
      onClick={() => pick(t)}
      title={`${title} (${keyOf(t)})`}
    >
      <span style={color ? { color } : undefined}>{icon}</span>
      {label && <span>{label}</span>}
      <sub>{keyOf(t)}</sub>
    </button>
  );
  // Less used: code, data, frames and notes. In a narrow window they wait behind ⋮ (still on their keys).
  const extra: [ToolId, ReactNode, string, string | undefined, string][] = [
    ...CODE_TOOLS.map(
      (k) =>
        [k, KIND_ICON[k], TOOL_TITLE[k]!, KIND_CSS[k], KIND_LABEL[k]] as [
          ToolId,
          ReactNode,
          string,
          string | undefined,
          string,
        ],
    ),
    ...DATA_TOOLS.map(
      (k) =>
        [k, KIND_ICON[k], TOOL_TITLE[k]!, KIND_CSS[k], KIND_LABEL[k]] as [
          ToolId,
          ReactNode,
          string,
          string | undefined,
          string,
        ],
    ),
    ...(simple
      ? [
          [
            "group",
            <SquareDashed size={16} />,
            "Group: drag a frame around boxes (a group, a region, a subnet…)",
            undefined,
            "Group",
          ] as [ToolId, ReactNode, string, undefined, string],
        ]
      : []),
    [
      "note",
      <MessageSquarePlus size={16} />,
      "Note: click where it goes (on a box pins it there)",
      undefined,
      "Note",
    ],
  ];
  const hidden = compact && extra.some(([t]) => t === tool);
  return (
    <div className="chrome top-center">
      <div className="island tools">
        {btn(
          "select",
          <MousePointer2 size={16} />,
          simple
            ? "Select: drag a box to move it, drag the canvas to pan, right-drag to select several"
            : "Select",
        )}
        <span className="sep" />
        {ARCH_KINDS.map((k) =>
          btn(k, KIND_ICON[k], `Place ${KIND_LABEL[k].toLowerCase()}`, KIND_CSS[k]),
        )}
        <span className="sep" />
        {compact ? (
          btn("connect", <Cable size={16} />, "Connect: click one box, then another")
        ) : (
          <>
            {CODE_TOOLS.map((k) => btn(k, KIND_ICON[k], TOOL_TITLE[k]!, KIND_CSS[k]))}
            <span className="sep" />
            {DATA_TOOLS.map((k) => btn(k, KIND_ICON[k], TOOL_TITLE[k]!, KIND_CSS[k]))}
            <span className="sep" />
            {btn("connect", <Cable size={16} />, "Connect: click one box, then another")}
            {simple &&
              btn(
                "group",
                <SquareDashed size={16} />,
                "Group: drag a frame around boxes (a group, a region, a subnet…)",
              )}
            <span className="sep" />
            {btn(
              "note",
              <MessageSquarePlus size={16} />,
              "Note: click where it goes (on a box pins it there)",
            )}
          </>
        )}
        <span className="sep" />
        <button className="tool" onClick={onSearch} title="Find (⌘K)">
          <Search size={16} />
        </button>
        {compact && (
          <div className="tools-more" ref={moreRef}>
            <button
              className={`tool${hidden || more ? " on" : ""}`}
              onClick={() => setMore((m) => !m)}
              title="More tools: code, tables, groups, notes"
            >
              <MoreVertical size={16} />
            </button>
            {more && (
              <div className="island tools-more-menu">
                {extra.map(([t, icon, title, color, label]) => btn(t, icon, title, color, label))}
              </div>
            )}
          </div>
        )}
      </div>
      {hint && <div className="tool-hint">{hint}</div>}
    </div>
  );
}

// --- bottom left ------------------------------------------------------------------------

interface BottomLeftProps {
  /** Beside the zoom controls: the performance meter, when it's on. */
  children?: ReactNode;
  zoom: number;
  minimap: boolean;
  animate: boolean;
  onAnimate: () => void;
  onZoom: (factor: number) => void;
  onZoomReset: () => void;
  onMinimap: () => void;
  onCenter: () => void;
  onFit: () => void;
}

export function BottomLeft(p: BottomLeftProps) {
  return (
    <>
      {p.minimap && (
        <div className="chrome mini-head">
          <span className="grow muted">Map</span>
          <button
            className="icon-btn tiny"
            onClick={p.onCenter}
            title="Centre on the selection, or the whole diagram"
          >
            <Crosshair size={13} />
          </button>
          <button className="icon-btn tiny" onClick={p.onFit} title="Fit everything (F)">
            <Maximize size={13} />
          </button>
          <button className="icon-btn tiny" onClick={p.onMinimap} title="Minimise (M)">
            <Minus size={13} />
          </button>
        </div>
      )}
      <div className="chrome bottom-left">
        <div className="island">
          <button className="icon-btn" onClick={() => p.onZoom(1 / 1.25)} title="Zoom out (⌘−)">
            <Minus size={15} />
          </button>
          <button className="zoom-pct" onClick={p.onZoomReset} title="Reset to 100%">
            {Math.round(p.zoom * 100)}%
          </button>
          <button className="icon-btn" onClick={() => p.onZoom(1.25)} title="Zoom in (⌘+)">
            <Plus size={15} />
          </button>
          <span className="sep" />
          <button
            className={p.animate ? "icon-btn on" : "icon-btn"}
            onClick={p.onAnimate}
            title={p.animate ? "Animate only what's selected (A)" : "Animate every arrow (A)"}
            aria-pressed={p.animate}
          >
            <Activity size={15} />
          </button>
          <button
            className={p.minimap ? "icon-btn on" : "icon-btn"}
            onClick={p.onMinimap}
            title={p.minimap ? "Minimise the map (M)" : "Show the map (M)"}
          >
            <MapIcon size={15} />
          </button>
        </div>
        {p.children}
      </div>
    </>
  );
}

export function HelpButton({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="chrome bottom-right">
      <div className="island">
        {children}
        <button className={on ? "icon-btn on" : "icon-btn"} onClick={onClick} title="Shortcuts (?)">
          <CircleHelp size={16} />
        </button>
      </div>
    </div>
  );
}

// --- empty diagram ----------------------------------------------------------------------

/** What an empty diagram shows: no box, just the way in. */
export function EmptyState({ onTool }: { onTool: (t: ToolId) => void }) {
  const starts: ObjectKind[] = ["actor", "system", "app", "store"];
  return (
    <div className="empty">
      <h2>Start drawing</h2>
      <p>Pick something to place, then click the canvas.</p>
      <div className="empty-starts">
        {starts.map((k) => (
          <button
            key={k}
            className="empty-start"
            style={{ color: KIND_CSS[k] }}
            onClick={() => onTool(k)}
          >
            {KIND_ICON[k]}
            <span>{k[0]!.toUpperCase() + k.slice(1)}</span>
            <kbd>{keyOf(k)}</kbd>
          </button>
        ))}
      </div>
      <p className="empty-aside">
        Or ask your agent to sketch it: the Archnemesis tools can see this design.
      </p>
    </div>
  );
}

/** The other views at this level, behind a small chip: the way to side views like Deployment. */
function OtherViews({
  views,
  onNavigate,
}: {
  views: { id: string; name: string }[];
  onNavigate: (id: string) => void;
}) {
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!at) return;
    const close = (e: PointerEvent) =>
      !btn.current?.contains(e.target as Node) &&
      !list.current?.contains(e.target as Node) &&
      setAt(null);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [at]);
  return (
    <>
      <button
        ref={btn}
        className="conn-chip other-views"
        title={`Other views at this level: ${views.map((v) => v.name).join(", ")}`}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setAt(at ? null : { top: r.bottom + 10, left: r.left - 6 });
        }}
      >
        <Layers size={14} />
        {views.length > 1 && <span className="other-views-n">{views.length}</span>}
      </button>
      {at &&
        createPortal(
          <div className="design-list island" style={at} ref={list}>
            {views.map((v) => (
              <button
                key={v.id}
                className="design-row"
                onClick={() => (setAt(null), onNavigate(v.id))}
              >
                <span className="design-name">{v.name}</span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
