import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  run: () => void;
}

/** A right-click menu at a page point; closes on any outside click, Escape or a pick. */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: (MenuItem | "sep")[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", down, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("mousedown", down, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [onClose]);

  // Keep it on screen.
  const left = Math.min(x, window.innerWidth - 232);
  const top = Math.min(y, window.innerHeight - (items.length * 30 + 16));
  // On the page itself: a panel that clips (the drawer) can't cut it off.
  return createPortal(
    <div ref={ref} className="menu" style={{ left, top }} onContextMenu={(e) => e.preventDefault()}>
      {items.map((it, i) =>
        it === "sep" ? (
          <div key={i} className="menu-sep" />
        ) : (
          <button
            key={i}
            className={it.danger ? "danger" : ""}
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.run();
            }}
          >
            <span className="menu-icon">{it.icon}</span>
            <span className="grow">{it.label}</span>
            {it.hint && <kbd>{it.hint}</kbd>}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

/**
 * A right-click menu for rows in a list: `on(items)` goes on a row's onContextMenu, and
 * `node` goes anywhere in the component. Items are built when the menu opens.
 */
export function useMenu() {
  const [at, setAt] = useState<{ x: number; y: number; items: (MenuItem | "sep")[] } | null>(null);
  const on = useCallback(
    (items: () => (MenuItem | "sep")[]) => (e: ReactMouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setAt({ x: e.clientX, y: e.clientY, items: items() });
    },
    [],
  );
  const close = useCallback(() => setAt(null), []);
  const node = at ? <ContextMenu x={at.x} y={at.y} items={at.items} onClose={close} /> : null;
  return { on, node };
}
