// A small modal for things worth a second look: naming a fork, discarding one, proposing it.
// Enter confirms (except in a destructive one, which starts on Cancel and needs a click),
// Escape or a click outside cancels. Never the browser's own confirm().
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { LoaderCircle } from "lucide-react";

interface Props {
  title: string;
  children?: ReactNode;
  /** The confirm button's words; none for a dialog whose contents have their own buttons (Close only). */
  confirm?: ReactNode;
  tone?: "primary" | "danger";
  busy?: boolean;
  disabled?: boolean;
  onConfirm?: () => void;
  onCancel: () => void;
  /** A wider dialog, for editing a long text. */
  wide?: boolean;
  /** Just its contents, no title or buttons (Settings: a pane of its own; Escape or outside closes). */
  bare?: boolean;
}

export function Dialog({
  title,
  children,
  confirm,
  tone = "primary",
  busy,
  disabled,
  onConfirm,
  onCancel,
  wide,
  bare,
}: Props) {
  const box = useRef<HTMLDivElement>(null);
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  // Once, on open: focus, and Escape to cancel.
  useEffect(() => {
    // Focus the first field, else the confirm button (Cancel, when it destroys something).
    const el =
      box.current?.querySelector<HTMLElement>("input, textarea") ??
      box.current?.querySelector<HTMLElement>(
        tone === "danger" ? "button.dialog-cancel" : "button.dialog-confirm",
      );
    el?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") (e.stopPropagation(), cancel.current());
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return createPortal(
    <div className="dialog-backdrop" onMouseDown={onCancel}>
      <div
        className={bare ? "dialog bare" : wide ? "dialog wide" : "dialog"}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={box}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // Keys typed here are the dialog's, not the canvas's shortcuts.
          e.stopPropagation();
          if (
            e.key !== "Enter" ||
            e.target instanceof HTMLTextAreaElement ||
            e.target instanceof HTMLButtonElement
          )
            return; // a focused button handles its own Enter
          if (confirm != null && tone !== "danger" && !busy && !disabled)
            (e.preventDefault(), onConfirm?.());
        }}
      >
        {bare ? (
          children
        ) : (
          <>
            <h2 className="dialog-title">{title}</h2>
            {children && <div className="dialog-body">{children}</div>}
            <div className="dialog-actions">
              <button className="dialog-cancel" onClick={onCancel}>
                {confirm == null ? "Close" : "Cancel"}
              </button>
              {confirm != null && (
                <button
                  className={`dialog-confirm ${tone}`}
                  disabled={busy || disabled}
                  onClick={onConfirm}
                >
                  {busy && <LoaderCircle size={14} className="spin" />}
                  {confirm}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
