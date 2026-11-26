// The flow you're walking (or the path lit on the diagram): its chip and its panel.
import { Route, PanelLeftOpen, X } from "lucide-react";
import { FlowPanel } from "../ui/FlowPanel";

import type { WorkspaceBag } from "./useInteraction";

/** A flow: its chip, or its panel when the drawer is open. */
export function FlowHost({
  setFlowId,
  step,
  setStep,
  activeFlow,
  isPath,
  pick,
  sidebar,
  setSidebar,
  idx,
  run,
}: Pick<
  WorkspaceBag,
  | "setFlowId"
  | "step"
  | "setStep"
  | "activeFlow"
  | "isPath"
  | "pick"
  | "sidebar"
  | "setSidebar"
  | "idx"
  | "run"
>) {
  return (
    <>
      {activeFlow && isPath && (
        <div
          className="flow-chip path-chip"
          title="A path: the route lit on the diagram (Esc to close)"
        >
          <Route size={14} />
          <span className="flow-chip-name">{activeFlow.name}</span>
          <span className="muted">{activeFlow.steps.length} calls</span>
          <button className="icon-btn" onClick={() => setFlowId(null)} title="Close (Esc)">
            <X size={13} />
          </button>
        </div>
      )}
      {activeFlow && !isPath && !sidebar && (
        <button className="flow-chip" onClick={() => setSidebar(true)} title="Open the flow ([)">
          <PanelLeftOpen size={14} />
          <span className="flow-chip-name">{activeFlow.name}</span>
          <span className="muted">
            {step === -1
              ? `${activeFlow.steps.length} steps`
              : `${Math.min(step, activeFlow.steps.length - 1) + 1}/${activeFlow.steps.length}`}
          </span>
        </button>
      )}
      {activeFlow && !isPath && sidebar && (
        <FlowPanel
          onCollapse={() => setSidebar(false)}
          idx={idx}
          flow={activeFlow}
          step={Math.min(step, activeFlow.steps.length - 1)}
          pick={pick}
          onStep={setStep}
          onClose={() => {
            setFlowId(null);
          }}
          run={run}
        />
      )}
    </>
  );
}
