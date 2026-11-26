// The first-run welcome: a centred panel with four ways in, the "Getting started" chip it tucks
// into, the hint on an empty design, and the tip over a shared one. State and rules are in
// welcomeState.ts; src/workspace/WelcomeHost.tsx decides which is on the page.
import { Bot, ChevronLeft, ChevronUp, Map as MapIcon, SquarePlus, Store, X } from "lucide-react";
import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import type { McpSetup } from "../../shared/api.ts";
import { stepsFor } from "./WelcomeSteps";
import {
  clearChipFocus,
  type Detail,
  type Place,
  showDetail,
  type WelcomeUi,
} from "./welcomeState";

/** The facts the words depend on. */
interface Where {
  place: Place;
  mcp: McpSetup | null;
  /** An agent is connected to this server. */
  agent: boolean;
  /** Everyone who signs in sees edits as they happen (false where anyone local is trusted). */
  team: boolean;
}

const HEADLINE = "A shared diagram of how your software fits together";
const LEAD =
  "Boxes are the parts: people, systems, apps, databases, code. Connections show how they talk. You and your AI agents edit it together, live.";

function statusLine(w: Where): string {
  if (w.place === "page-agent")
    return "Demo mode: an agent can work on this page. Your designs stay in this browser.";
  if (w.place === "page") return "Demo mode: your designs stay in this browser.";
  const files = w.team
    ? "Designs are saved as files on this server, and everyone you invite sees edits as they happen."
    : "Designs are saved as files on this server.";
  return `${w.agent ? "An agent is connected." : "No agent connected yet."} ${files}`;
}

interface Way {
  id: "blank" | "map" | "connect" | "example";
  icon: ReactNode;
  color: string;
  title: string;
  text: string;
  next: string;
  tag?: string;
}

function waysFor(w: Where): Way[] {
  const { place } = w;
  const addr = w.mcp?.url.replace(/^https?:\/\//, "") ?? "";
  return [
    {
      id: "blank",
      icon: <SquarePlus size={16} />,
      color: "var(--text)",
      title: "Start blank",
      text: "Place boxes yourself, then connect them.",
      next: "Press 2 to 6, click the canvas",
    },
    {
      id: "map",
      icon: <MapIcon size={16} />,
      color: "var(--app)",
      title: "Map a repo with an agent",
      text:
        place === "server"
          ? "An AI agent reads your code and draws it here."
          : place === "page-agent"
            ? "An AI agent draws a system from a public repo or from what you tell it."
            : "Needs your own copy of Archnemesis (self-hosted). One Docker command.",
      next:
        place === "server"
          ? "“Map this repo into Archnemesis”"
          : place === "page-agent"
            ? "“Map the repo at <link>…”"
            : "See how to self-host",
    },
    {
      id: "connect",
      icon: <Bot size={16} />,
      color: "var(--system)",
      title: "Connect an agent",
      text:
        place === "server"
          ? "Give an AI agent, such as Claude Code, access to this design."
          : place === "page-agent"
            ? "Chrome is ready. Point your agent at this tab."
            : "Takes one command, or one Chrome setting.",
      next:
        place === "server"
          ? w.agent
            ? "Ask it to map a repo"
            : `Add ${addr} to your agent`
          : place === "page-agent"
            ? "Ask it to use the tools on this page"
            : "See how",
      tag:
        place === "server"
          ? w.agent
            ? "Connected"
            : undefined
          : place === "page-agent"
            ? "Ready"
            : undefined,
    },
    {
      id: "example",
      icon: <Store size={16} />,
      color: "var(--store)",
      title: "Open the example",
      text: "A small online shop, already drawn. Your own design stays separate.",
      next: "Opens “Shop” as its own design",
    },
  ];
}

interface PanelProps {
  where: Where;
  detail: Detail;
  /** The left edge of the room the panel may use (px): past the left panel. */
  left: number;
  busy: boolean;
  onBlank: () => void;
  onExample: () => void;
  onTuck: () => void;
  onNever: () => void;
}

/** The panel: what this is, and four ways in; or the steps for one of them. */
export function WelcomePanel(p: PanelProps) {
  const { where, detail } = p;
  const head = useRef<HTMLHeadingElement>(null);
  // Focus goes to the heading when the panel opens and when its view changes.
  useEffect(() => head.current?.focus({ preventScroll: true }), [detail]);
  const way = (id: Way["id"]) => {
    if (id === "blank") p.onBlank();
    else if (id === "example") p.onExample();
    else showDetail(id);
  };
  const steps = detail
    ? stepsFor(detail, {
        place: where.place,
        mcp: where.mcp,
        agent: where.agent,
        onDetail: showDetail,
      })
    : null;
  return (
    <section
      className="wel"
      role="dialog"
      aria-modal="false"
      aria-labelledby="wel-title"
      aria-describedby={steps ? undefined : "wel-lead"}
      style={{ "--wel-left": `${p.left}px` } as CSSProperties}
    >
      {steps ? (
        <>
          <button className="wel-back" onClick={() => showDetail(null)}>
            <ChevronLeft size={14} /> Back
          </button>
          <h2 id="wel-title" tabIndex={-1} ref={head}>
            {steps.title}
          </h2>
          <div className="wel-body">{steps.body}</div>
          <div className="wel-actions">
            <button className="cta primary" onClick={p.onTuck}>
              {detail === "connect" ? "Got it, close this" : "Got it"}
            </button>
          </div>
        </>
      ) : (
        <>
          <h2 id="wel-title" tabIndex={-1} ref={head}>
            {HEADLINE}
          </h2>
          <p className="wel-lead" id="wel-lead">
            {LEAD}
          </p>
          <p className="wel-where">
            <span
              className={`wel-led${where.agent || where.place === "page-agent" ? " on" : ""}`}
              aria-hidden="true"
            />
            {statusLine(where)}
          </p>
          <h3 className="wel-eyebrow">Where do you want to start?</h3>
          <div className="wel-ways">
            {waysFor(where).map((w) => (
              <button
                key={w.id}
                className="wel-way"
                style={{ "--c": w.color } as CSSProperties}
                disabled={w.id === "example" && p.busy}
                onClick={() => way(w.id)}
              >
                <span className="wel-way-icon">{w.icon}</span>
                <span className="wel-way-title">{w.title}</span>
                {w.tag && <span className="wel-tag">{w.tag}</span>}
                <span className="wel-way-text">{w.text}</span>
                <code className="wel-way-next">{w.next}</code>
              </button>
            ))}
          </div>
          <div className="wel-foot">
            <button className="link-btn" onClick={p.onNever}>
              Don't show this again
            </button>
            <span className="muted small">
              Esc closes this. Find it again under ? → Getting started.
            </span>
          </div>
        </>
      )}
      <button className="wel-x" onClick={p.onTuck} aria-label="Close (Esc)" title="Close (Esc)">
        <X size={14} />
      </button>
    </section>
  );
}

/** What the panel tucks into: open it again, or hide it for good. */
export function WelcomeChip({
  ui,
  left,
  onOpen,
  onNever,
}: {
  ui: WelcomeUi;
  left: number;
  onOpen: () => void;
  onNever: () => void;
}) {
  const go = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!ui.focusChip) return;
    go.current?.focus({ preventScroll: true });
    clearChipFocus();
  }, [ui.focusChip]);
  return (
    <div className="wel-chip" style={{ "--wel-left": `${left}px` } as CSSProperties}>
      <button ref={go} className="wel-chip-go" onClick={onOpen}>
        <ChevronUp size={14} /> Getting started
      </button>
      <button
        className="wel-chip-no"
        onClick={onNever}
        aria-label="Hide Getting started for good"
        title="Hide for good"
      >
        <X size={13} />
      </button>
    </div>
  );
}

const Kbd = ({ k }: { k: string }) => <kbd>{k}</kbd>;

/** After Start blank: which keys place a box, then what to do with one. */
export function WelcomeCoach({ left, boxes }: { left: number; boxes: number }) {
  return (
    <div
      className="island wel-coach"
      role="status"
      style={{ "--wel-left": `${left}px` } as CSSProperties}
    >
      {boxes ? (
        <>
          Click a box to edit it. Press <Kbd k="C" />, then click two boxes to connect them.
        </>
      ) : (
        <>
          Press <Kbd k="2" /> for an actor, <Kbd k="3" /> system, <Kbd k="4" /> app, <Kbd k="5" />{" "}
          store or <Kbd k="6" /> component, then click the canvas.
        </>
      )}
    </div>
  );
}

/** A returning person's empty design: where to start, quietly. */
export function EmptyHint({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="wel-hint">
      <b>This design is empty.</b>
      <span>
        Press <Kbd k="2" /> to <Kbd k="6" /> to place a box, or ask your agent to draw it.
      </span>
      <button className="link-btn" onClick={onOpen}>
        Getting started
      </button>
    </div>
  );
}

/** Over a shared design: the one thing a first-timer needs. */
export function SharedTip({ left, onClose }: { left: number; onClose: () => void }) {
  return (
    <div
      className="island wel-tip"
      role="note"
      style={{ "--wel-left": `${left}px` } as CSSProperties}
    >
      <p>
        <b>New here?</b> This is a diagram of a software system. Boxes are its parts; connections
        show how they talk. Click a box to read about it.
      </p>
      <button className="cta" onClick={onClose}>
        Got it
      </button>
    </div>
  );
}
