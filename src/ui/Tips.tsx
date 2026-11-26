// Tooltips: anything with data-tip="…" gets one, shortly after the pointer rests on it.
// One listener for the whole app, drawn above everything (not clipped by the panel it's in).
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

const DELAY = 350;

export function Tips() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number; below: boolean } | null>(
    null,
  );
  useEffect(() => {
    let timer = 0;
    let on: Element | null = null;
    const hide = () => (clearTimeout(timer), (on = null), setTip(null));
    const over = (e: PointerEvent) => {
      const el = (e.target as Element | null)?.closest?.("[data-tip]") ?? null;
      if (el === on) return;
      hide();
      if (!el) return;
      on = el;
      timer = window.setTimeout(() => {
        const text = el.getAttribute("data-tip");
        if (!text || !el.isConnected) return;
        const r = el.getBoundingClientRect();
        // Under it, unless that runs off the bottom.
        const below = r.bottom + 60 < innerHeight;
        setTip({
          text,
          x: Math.min(Math.max(r.left + r.width / 2, 120), innerWidth - 120),
          y: below ? r.bottom + 6 : r.top - 6,
          below,
        });
      }, DELAY);
    };
    window.addEventListener("pointerover", over, true);
    window.addEventListener("pointerdown", hide, true);
    window.addEventListener("wheel", hide, true);
    window.addEventListener("keydown", hide, true);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointerover", over, true);
      window.removeEventListener("pointerdown", hide, true);
      window.removeEventListener("wheel", hide, true);
      window.removeEventListener("keydown", hide, true);
    };
  }, []);
  if (!tip) return null;
  return createPortal(
    <div
      className={`tip${tip.below ? "" : " above"}`}
      style={{ left: tip.x, top: tip.y }}
      role="tooltip"
    >
      {tip.text}
    </div>,
    document.body,
  );
}
