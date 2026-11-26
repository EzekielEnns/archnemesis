// The tab on a box opened in place (shared/explode.ts): the diagram's name, a way into its own
// view, and close. HTML over the canvas, kept on the frame's top edge as the canvas moves.
import { ArrowUpRight, X } from "lucide-react";
import { useEffect, useRef } from "react";
import type { CanvasGroup } from "../../shared/project.ts";
import { KIND_COLOR } from "../canvas/Scene";

const hex = (n: number) => `#${n.toString(16).padStart(6, "0")}`;

interface Props {
  frames: CanvasGroup[];
  /** The frame's rectangle on the page, or null when it isn't drawn. */
  rectOf: (frameId: string) => { x: number; y: number; w: number; h: number } | null;
  selected: string | null;
  /** A click: select it, to see what flows in and out. */
  onSelect: (frameId: string) => void;
  /** A right-click: its card, like a box's. */
  onCard: (frameId: string) => void;
  onClose: (frameId: string) => void;
  onOpenView: (frameId: string) => void;
}

export function InsetTabs(p: Props) {
  const refs = useRef(new Map<string, HTMLDivElement>());
  const latest = useRef(p);
  latest.current = p;
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      for (const [id, el] of refs.current) {
        const r = latest.current.rectOf(id);
        el.style.visibility = r ? "visible" : "hidden";
        // On the frame's top edge, its left end; never wider than the frame.
        if (r) {
          el.style.transform = `translate(${Math.round(r.x + 12)}px, ${Math.round(r.y - 13)}px)`;
          el.style.maxWidth = `${Math.max(120, r.w - 24)}px`;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <>
      {p.frames.map((f) => (
        <div
          key={f.id}
          className={`inset-tab${p.selected === f.id ? " on" : ""}`}
          data-frame={f.id}
          style={{
            ["--kind" as string]: f.kind
              ? hex(KIND_COLOR[f.kind as keyof typeof KIND_COLOR] ?? 0x4f8cff)
              : "#4f8cff",
          }}
          ref={(el) => {
            if (el) refs.current.set(f.id, el);
            else refs.current.delete(f.id);
          }}
        >
          <button
            className="inset-name"
            onClick={() => p.onSelect(f.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              p.onCard(f.id);
            }}
            data-tip="Click: what flows in and out · Right-click: its card"
          >
            {f.name}
          </button>
          <button
            className="inset-btn"
            onClick={() => p.onOpenView(f.id)}
            data-tip="Go to its own view (Enter)"
          >
            <ArrowUpRight size={13} />
          </button>
          <button className="inset-btn" onClick={() => p.onClose(f.id)} data-tip="Close it (⇧⌘G)">
            <X size={13} />
          </button>
        </div>
      ))}
    </>
  );
}
