// A flow: a story told step by step over a diagram ("a customer places an order"). Each
// step is one thing going from one box to another; stepping through lights it up.
import { useMenu } from "./ContextMenu";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  PanelLeftClose,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { makeStep, now, type Flow, type FlowStep, type Op } from "../../shared/model.ts";
import type { ModelIndex } from "../../shared/project.ts";
import { TextField } from "./TextField";

interface Props {
  /** Fold it away (the drawer's collapse): the flow stays on, as a chip. */
  onCollapse: () => void;
  idx: ModelIndex;
  flow: Flow;
  step: number; // -1: the whole flow
  /** What's selected, as a step: an arrow (a message), one box (a process), two boxes. */
  pick: { fromId: string; toId: string; text: string } | null;
  onStep: (i: number) => void;
  onClose: () => void;
  run: (ops: Op[], label: string) => Promise<unknown>;
}

export function FlowPanel({ idx, flow, step, pick, onStep, onClose, run, onCollapse }: Props) {
  const save = (steps: FlowStep[], label: string, patch: Partial<Flow> = {}) =>
    run([{ op: "flow.put", flow: { ...flow, ...patch, steps, updatedAt: now() } }], label);
  const name = (id: string) => idx.objects.get(id)?.name ?? "(deleted)";
  const n = flow.steps.length;

  const menu = useMenu();
  const move = (i: number, by: number) => {
    const j = i + by;
    if (j < 0 || j >= n) return;
    const steps = [...flow.steps];
    [steps[i], steps[j]] = [steps[j]!, steps[i]!];
    void save(steps, "reorder steps").then(() => onStep(j));
  };

  return (
    // In the drawer's place: an active flow takes over the left panel, and folds away with it.
    <aside className="drawer flow-panel">
      <div className="flow-head">
        <TextField
          key={flow.name}
          className="title-input"
          value={flow.name}
          onCommit={(v) => v.trim() && void save(flow.steps, "rename flow", { name: v.trim() })}
        />
        <button className="icon-btn" title="Fold away ([)" onClick={onCollapse}>
          <PanelLeftClose size={15} />
        </button>
        <button className="icon-btn" title="Close the flow (Esc)" onClick={onClose}>
          <X size={15} />
        </button>
      </div>

      <div className="flow-controls">
        <button
          className="icon-btn"
          disabled={n === 0}
          onClick={() => onStep(step <= 0 ? n - 1 : step - 1)}
          title="Previous step (←)"
        >
          <ChevronLeft size={16} />
        </button>
        <button className="flow-pos" onClick={() => onStep(-1)} title="Show the whole flow">
          {step === -1 ? `${n} step${n === 1 ? "" : "s"}` : `Step ${step + 1} of ${n}`}
        </button>
        <button
          className="icon-btn"
          disabled={n === 0}
          onClick={() => onStep(step >= n - 1 ? 0 : step + 1)}
          title="Next step (→)"
        >
          <ChevronRight size={16} />
        </button>
      </div>

      {menu.node}
      <ol className="steps">
        {flow.steps.map((st, i) => (
          <li
            key={st.id}
            className={i === step ? "active" : ""}
            onClick={() => onStep(i)}
            onContextMenu={menu.on(() => [
              {
                label: "Move up",
                icon: <ArrowUp size={14} />,
                disabled: i === 0,
                run: () => move(i, -1),
              },
              {
                label: "Move down",
                icon: <ArrowDown size={14} />,
                disabled: i === n - 1,
                run: () => move(i, 1),
              },
              "sep",
              {
                label: "Delete step",
                icon: <Trash2 size={14} />,
                danger: true,
                run: () => {
                  void save(
                    flow.steps.filter((x) => x.id !== st.id),
                    "delete step",
                  );
                  if (step >= n - 1) onStep(n - 2);
                },
              },
            ])}
            title="Right-click to move or delete"
          >
            <div className="step-ends">
              <span className="num">{i + 1}</span>
              {st.fromId === st.toId ? (
                <>
                  <RefreshCw size={11} className="muted" /> {name(st.fromId)}
                </>
              ) : (
                <>
                  {name(st.fromId)} <ArrowRight size={11} className="muted" /> {name(st.toId)}
                </>
              )}
            </div>
            <TextField
              key={`${st.id}:${st.text}`}
              value={st.text}
              placeholder="What happens here…"
              onCommit={(text) =>
                void save(
                  flow.steps.map((x) => (x.id === st.id ? { ...x, text } : x)),
                  "describe step",
                )
              }
            />
          </li>
        ))}
      </ol>
      <button
        className="step-add"
        disabled={!pick}
        title={pick ? undefined : "Select an arrow, a box, or two boxes on the canvas first"}
        onClick={() =>
          pick && void save([...flow.steps, makeStep(pick)], "add step").then(() => onStep(-1))
        }
      >
        <Plus size={13} />{" "}
        {pick
          ? pick.fromId === pick.toId
            ? `Step: ${name(pick.fromId)} does something`
            : `Step: ${name(pick.fromId)} → ${name(pick.toId)}`
          : "Step from selection"}
      </button>
      {n === 0 && (
        <p className="muted small">
          Select an arrow (a message), a box (something it does) or two boxes, then add it as a
          step. Steps are numbered on the diagram.
        </p>
      )}

      <div className="actions">
        <button
          className="danger small"
          onClick={() =>
            void run([{ op: "flow.delete", id: flow.id }], "delete flow").then(onClose)
          }
        >
          <Trash2 size={13} /> Delete flow
        </button>
      </div>
    </aside>
  );
}
