import type { SceneRef } from "./types";
import { useEffect, useRef } from "react";
import type { CanvasGraph } from "../../shared/project.ts";
import { OPEN_FRAME } from "../../shared/explode.ts";
import type { Selection } from "../canvas/Scene";
// The card for what's selected (simple mode): whether it's open, what was just made (it opens
// with the keyboard in it), and the boxes made in this sitting.
import { useCallback, useState } from "react";

export function useCardState() {
  /** Simple mode: the panel for what's selected is open. */
  const [panel, setPanel] = useState(false);
  /** Simple mode: what was just made (a box or an arrow): its card opens with the keyboard in it. */
  const [fresh, setFresh] = useState<string | null>(null);
  // Boxes made in this sitting: never folded away (an outside service named Stripe stays where
  // it was put, not in "4 externals"). The view's folding takes them in on the next visit.
  const [made, setMade] = useState<ReadonlySet<string>>(() => new Set());
  const openFresh = useCallback((id: string) => {
    setPanel(true);
    setFresh(id);
    setMade((m) => new Set(m).add(id));
  }, []);
  return { panel, setPanel, fresh, setFresh, made, openFresh };
}

export function useCardFollow({
  simple,
  panel,
  sel,
  graph,
  scene,
}: {
  simple: boolean;
  panel: boolean;
  sel: Selection;
  graph: CanvasGraph | null;
  scene: SceneRef;
}) {
  // The card floats beside what it's for and follows it as the canvas moves.
  const floatRef = useRef<HTMLDivElement>(null);
  // Simple mode: the card sits beside the selected box (or the middle of the arrow), right of it
  // when there's room, else left, and follows it as the canvas pans and zooms.
  useEffect(() => {
    if (!simple || !panel) return;
    let raf = 0;
    const tick = () => {
      const el = floatRef.current;
      const s = scene.current;
      if (el && s) {
        const W = el.offsetWidth || 300;
        const H = el.offsetHeight || 200;
        let r: { x: number; y: number; w: number; h: number } | null = null;
        const rects = sel.nodes
          .map((id) => s.clientRectOf(id))
          .filter((x): x is NonNullable<typeof x> => !!x);
        if (rects.length) {
          const x = Math.min(...rects.map((q) => q.x)),
            y = Math.min(...rects.map((q) => q.y));
          r = {
            x,
            y,
            w: Math.max(...rects.map((q) => q.x + q.w)) - x,
            h: Math.max(...rects.map((q) => q.y + q.h)) - y,
          };
        } else if (sel.boundary?.startsWith(OPEN_FRAME)) {
          // A box opened here: beside its tab, the way a card sits beside its box.
          const tab = document
            .querySelector(`.inset-tab[data-frame="boundary:${CSS.escape(sel.boundary)}"]`)
            ?.getBoundingClientRect();
          r = tab
            ? { x: tab.x, y: tab.y, w: tab.width, h: tab.height }
            : s.clientRectOfGroup(`boundary:${sel.boundary}`);
        } else if (sel.boundary) {
          r = s.clientRectOfGroup(`boundary:${sel.boundary}`);
        } else if (sel.edge) {
          const e = graph?.edges.find((g) => g.id === sel.edge);
          const a = e && s.clientRectOf(e.from);
          const b = e && s.clientRectOf(e.to);
          if (a && b) {
            const mx = (a.x + a.w / 2 + b.x + b.w / 2) / 2,
              my = (a.y + a.h / 2 + b.y + b.h / 2) / 2;
            r = { x: mx - 10, y: my + 14, w: 20, h: 0 };
          }
        }
        let left = innerWidth - W - 12;
        let top = 72;
        if (r) {
          left = r.x + r.w + 16;
          if (left + W > innerWidth - 12) left = r.x - W - 16;
          if (left < 12) left = Math.min(innerWidth - W - 12, Math.max(12, r.x));
          top = Math.max(64, Math.min(r.y, innerHeight - H - 12));
        }
        el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
        // Never past the bottom of the window, wherever it sits: the rest scrolls inside.
        el.style.setProperty(
          "--card-room",
          `${Math.max(160, Math.round(innerHeight - top - 12))}px`,
        );
        el.style.visibility = "visible";
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [simple, panel, sel, graph]);
  return floatRef;
}
