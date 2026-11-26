// Top left: which design is open. Click for every design, and to start a new one.
import { Boxes, FolderOpen, Link2, Lock, Plus, RefreshCw, Trash2, Users } from "lucide-react";
import { useMenu, type MenuItem } from "./ContextMenu";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { backend } from "../backend";
import type { DesignInfo } from "../route";
import { Dialog } from "./Dialog";
import { usePortable } from "./Portable";
import { ShareDialog } from "./ShareDialog";

interface Props {
  design: string;
  name: string;
  /** Admins may delete team designs too (never someone's private one, which they can't see). */
  isAdmin?: boolean;
  /** Say the design's name beside the icon (the settings dialog), not only in the tooltip. */
  label?: boolean;
}

export function DesignMenu({ design, name, isAdmin = false, label = false }: Props) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<DesignInfo[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // Delete asks first, in a dialog (the menu closes behind it).
  const [asking, setAsking] = useState<DesignInfo | null>(null);
  const [busy, setBusy] = useState(false);
  // The Share dialog: the team, and links.
  const [sharing, setSharing] = useState<DesignInfo | null>(null);
  const [reload, setReload] = useState(0);
  const verbs = [
    ...(backend.designs.share || backend.links ? ["share"] : []),
    ...(backend.git ? ["reconnect"] : []),
    "delete",
  ];
  const rightClickHint = `Right-click a design to ${verbs.length > 1 ? `${verbs.slice(0, -1).join(", ")} or ${verbs.at(-1)}` : verbs[0]} it`;
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // The breadcrumb bar clips what overflows it, so the list is placed on the page instead.
  const [at, setAt] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (!open) return;
    void backend.designs
      .list()
      .then((l) => setList(Array.isArray(l) ? l : []))
      .catch(() => setList([]));
    // A row's right-click menu sits on the page, outside the list: clicking it isn't "outside".
    const close = (e: PointerEvent) =>
      !ref.current?.contains(e.target as Node) &&
      !listRef.current?.contains(e.target as Node) &&
      !(e.target as Element).closest?.(".menu") &&
      setOpen(false);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open, reload]);
  useEffect(() => {
    if (!open) (setNote(null), setError(null));
  }, [open]);

  /** Run a call as busy; false (with the reason shown) when it was refused. */
  const run = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "that didn't work");
      return false;
    } finally {
      setBusy(false);
    }
  };
  const share = async (priv: boolean, key = design) => {
    if (await run(() => backend.designs.share!(key, priv)))
      (setNote(priv ? "Only you can see it now" : "Shared with the team"), setReload((n) => n + 1));
  };
  const remove = async () => {
    // The server tells every tab on it (this one too, if it's this one), which then moves on.
    if (asking && (await run(() => backend.designs.remove(asking.key))))
      (setAsking(null), setReload((n) => n + 1));
  };
  // Right-click a design in the list: what you may do with it.
  const menu = useMenu();
  const rowItems = (d: DesignInfo): MenuItem[] => {
    const deletable = !d.git && (d.mine || (isAdmin && !d.private));
    return [
      {
        label: "Open",
        icon: <FolderOpen size={14} />,
        run: () => ((location.hash = `/${d.key}`), setOpen(false)),
      },
      ...(d.git && backend.git
        ? [
            {
              label: "Reconnect to the repo",
              icon: <RefreshCw size={14} />,
              run: () => void reconnect(d.key),
            },
          ]
        : []),
      ...(backend.links && (d.mine || (isAdmin && !d.private))
        ? [
            {
              label: "Share…",
              icon: <Link2 size={14} />,
              run: () => (setSharing(d), setOpen(false)),
            },
          ]
        : []),
      ...(d.mine && !d.git && backend.designs.share
        ? [
            {
              label: d.private ? "Share with the team" : "Make it private",
              icon: d.private ? <Users size={14} /> : <Lock size={14} />,
              run: () => void share(!d.private, d.key),
            },
          ]
        : []),
      {
        label: d.git
          ? "Delete (it follows a repo: reconnect it instead)"
          : deletable
            ? "Delete design"
            : "Delete (only its owner can)",
        icon: <Trash2 size={14} />,
        danger: true,
        disabled: !deletable,
        run: () => setAsking(d),
      },
    ];
  };
  const reconnect = async (key = design) => {
    if (await run(() => backend.git!.sync(key)))
      (setNote("Reloaded from the repo"), setReload((n) => n + 1));
  };

  const portable = usePortable(design, {
    note: setNote,
    error: setError,
    close: () => setOpen(false),
  });

  const create = async (newName: string) => {
    try {
      const { key } = await backend.designs.create(newName);
      setOpen(false);
      setCreating(false);
      location.hash = `/${key}`;
    } catch (e) {
      setError(e instanceof Error ? e.message : "couldn't create it");
    }
  };

  return (
    <div className="design-menu" ref={ref}>
      {menu.node}
      <button
        className="wordmark design-btn"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setAt({ top: r.bottom + 14, left: r.left - 12 });
          setOpen(!open);
        }}
        title={`${name}: switch design`}
      >
        <Boxes size={15} style={{ flex: "none" }} />
        {label && <span className="design-btn-label">{name}</span>}
      </button>
      {open &&
        createPortal(
          <div className="design-list island" style={at} ref={listRef}>
            {list.map((d) => (
              <button
                key={d.key}
                className={d.key === design ? "design-row on" : "design-row"}
                onClick={() => ((location.hash = `/${d.key}`), setOpen(false))}
                onContextMenu={menu.on(() => rowItems(d))}
                title={rightClickHint}
              >
                <span className="design-name">
                  {d.private && <Lock size={11} className="design-lock" />}
                  {d.name}
                </span>
                <span className="design-meta">
                  {d.private ? "only you · " : ""}
                  {d.objects} objects{d.git ? " · git" : ""}
                  {d.forks ? ` · ${d.forks} fork${d.forks > 1 ? "s" : ""}` : ""}
                  {d.present ? ` · ${d.present} here` : ""}
                </span>
              </button>
            ))}
            {creating ? (
              <input
                className="design-input"
                autoFocus
                placeholder="Name the design"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && e.currentTarget.value.trim())
                    void create(e.currentTarget.value.trim());
                  if (e.key === "Escape") setCreating(false);
                }}
              />
            ) : (
              <button
                className="design-row new"
                onClick={() => (setCreating(true), setError(null))}
              >
                <Plus size={14} /> New design
              </button>
            )}
            {portable.items && <div className="portable-items">{portable.items}</div>}
            <div className="design-hint">{rightClickHint}</div>
            {note && <div className="design-note">{note}</div>}
            {error && <div className="design-error">{error}</div>}
          </div>,
          document.body,
        )}
      {portable.dialogs}
      {sharing && (
        <ShareDialog doc={sharing.key} name={sharing.name} onClose={() => setSharing(null)} />
      )}
      {asking && (
        <Dialog
          title={`Delete ${asking.name}?`}
          confirm="Delete"
          tone="danger"
          busy={busy}
          onCancel={() => (setAsking(null), setError(null))}
          onConfirm={() => void remove()}
        >
          <p>
            {asking.private
              ? "Its diagrams, notes and history go for good."
              : "Its diagrams, notes and history go for good, for everyone. Anyone on it now is moved to another design."}
          </p>
          {error && <p className="first-error small">{error}</p>}
        </Dialog>
      )}
    </div>
  );
}
