// The cheat sheet behind the ? button: what each key or gesture does, grouped.
import { Compass, X } from "lucide-react";
import type { McpSetup } from "../../shared/api.ts";
import { AgentCommand } from "./ConnectAgent";

/** [what it does, the keys (each a keycap; "or" between alternatives)] */
type Row = [string, string[]];

const GROUPS: { title: string; rows: Row[] }[] = [
  {
    title: "Tools",
    rows: [
      ["Select", ["1"]],
      ["Place a box: actor … component, file, function, table", ["2–9"]],
      ["Connect two boxes", ["C"]],
      ["Leave a note", ["N"]],
      ["Draw a group around boxes", ["G"]],
      ["Add a link", ["L"]],
      ["Back to select", ["Esc"]],
    ],
  },
  {
    title: "Connect",
    rows: [
      ["Connect", ["Drag a box's edge"]],
      ["Rename an arrow", ["Double-click it"]],
    ],
  },
  {
    title: "Boxes",
    rows: [
      ["Open what's inside", ["↵"]],
      ["Up a level", ["⌘", "↑"]],
      ["Rename", ["F2"]],
      ["Nudge (×5 with ⇧)", ["←↑→↓"]],
      ["Duplicate", ["⌘", "D"]],
      ["Copy a link to it", ["⇧", "⌘", "C"]],
      ["Remove from diagram", ["⌫"]],
      ["Delete everywhere", ["⇧", "⌫"]],
      ["Place off-grid", ["⌥ drag"]],
    ],
  },
  {
    title: "View",
    rows: [
      ["Pan", ["Drag the canvas"]],
      ["Select several", ["Right-drag the canvas", "or", "⇧ drag"]],
      ["Group the selection", ["⌘", "G"]],
      ["Find anything, run a command", ["⌘", "K"]],
      ["Fit to screen", ["F"]],
      ["Zoom", ["⌘", "+ / −"]],
      ["Sidebar", ["["]],
      ["Minimap", ["M"]],
      ["Diff a fork with main", ["D"]],
      ["Animate every arrow", ["A"]],
      ["Back to where you jumped from", ["⌥", "←"]],
      ["Step through a flow", ["← →"]],
    ],
  },
  {
    title: "History",
    rows: [
      ["Undo", ["⌘", "Z"]],
      ["Redo", ["⇧", "⌘", "Z"]],
      ["Export PNG", ["⇧", "⌘", "E"]],
      ["This sheet", ["?"]],
      ["Mark this as confusing (for your trail)", ["!"]],
    ],
  },
];

export function Shortcuts({
  onClose,
  mcp,
  fromLink,
  onGettingStarted,
}: {
  onClose: () => void;
  mcp?: McpSetup | null;
  /** The design came from a link: its first-timer's note is "What is this?". */
  fromLink: boolean;
  onGettingStarted: () => void;
}) {
  return (
    <div className="shortcuts">
      <div className="shortcuts-head">
        <span>Keyboard shortcuts</span>
        <button className="icon-btn" onClick={onClose} title="Close (? or Esc)">
          <X size={14} />
        </button>
      </div>
      <button className="shortcuts-start" onClick={onGettingStarted}>
        <Compass size={15} />
        <span>
          {fromLink ? "What is this?" : "Getting started"}
          <small>
            {fromLink
              ? "A short note about the diagram you're looking at"
              : "Four ways to start, and what to give an agent"}
          </small>
        </span>
      </button>
      {mcp && (
        <section>
          <h4>Connect your agent</h4>
          <AgentCommand mcp={mcp} />
        </section>
      )}
      <div className="shortcuts-cols">
        {GROUPS.map((g) => (
          <section key={g.title}>
            <h4>{g.title}</h4>
            {g.rows.map(([what, keys]) => (
              <div key={what} className="shortcut">
                <span>{what}</span>
                <span className="keys">
                  {keys.map((k) => (
                    <kbd key={k}>{k}</kbd>
                  ))}
                </span>
              </div>
            ))}
          </section>
        ))}
        <p className="muted small">Right-click anything for the rest.</p>
      </div>
    </div>
  );
}
