// An agent's context on a view or a box: markdown written for agents (examples, data,
// decisions), not for people reading the diagram. So the panel shows only that it's there;
// a person who wants to read or change it opens it in a dialog.
import { Bot, ChevronRight } from "lucide-react";
import { useState } from "react";
import { Dialog } from "./Dialog";
import { Markdown } from "./Markdown";

export function AgentContext({
  text,
  of,
  canEdit,
  onSave,
}: {
  text: string;
  of: string;
  canEdit?: boolean;
  onSave: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(text);
  const [preview, setPreview] = useState(false);
  const lines = text ? text.split("\n").length : 0;
  if (!text && canEdit === false) return null;
  return (
    <>
      <button
        className="agent-context-row"
        title="Written for agents: they read it before working on this. Open to read or edit it."
        onClick={() => (setDraft(text), setPreview(!canEdit && !!text), setOpen(true))}
      >
        <Bot size={13} />
        <span>Agent context</span>
        <span className="muted">{text ? `${lines} line${lines === 1 ? "" : "s"}` : "none"}</span>
        <ChevronRight size={13} className="agent-context-go" />
      </button>
      {open && (
        <Dialog
          wide
          title={`Agent context: ${of}`}
          confirm={canEdit === false ? "Close" : "Save"}
          disabled={canEdit !== false && draft.trim() === text.trim()}
          onCancel={() => setOpen(false)}
          onConfirm={() => {
            if (canEdit !== false) onSave(draft.trim());
            setOpen(false);
          }}
        >
          <div className="agent-context-tabs">
            {canEdit !== false && (
              <button className={preview ? "" : "on"} onClick={() => setPreview(false)}>
                Edit
              </button>
            )}
            <button className={preview ? "on" : ""} onClick={() => setPreview(true)}>
              Preview
            </button>
            <span className="muted small">
              Markdown, for agents: examples, data shapes, decisions, open questions.
            </span>
          </div>
          {preview ? (
            <div className="agent-context-preview">
              {draft.trim() ? (
                <Markdown text={draft} />
              ) : (
                <p className="muted small">Nothing yet.</p>
              )}
            </div>
          ) : (
            <textarea
              className="agent-context-edit"
              value={draft}
              spellCheck={false}
              placeholder="## Goal\n…\n\n## Example\n```json\n…\n```"
              onChange={(e) => setDraft(e.target.value)}
            />
          )}
        </Dialog>
      )}
    </>
  );
}
