// A diagram's story: a few lines on how to read it ("follow a verification from the phone
// to the verdict"). Shown in the inspector when you click the diagram's own frame by its
// title, so it's there when you want it and out of the way otherwise. It lives in the
// view's file (story:).
import { Pencil, Plus } from "lucide-react";
import { useState } from "react";
import { Markdown } from "./Markdown";
import { TextField } from "./TextField";

export function Story({
  text,
  onSave,
  title = "How to read it",
  placeholder = "How to read this diagram: what it shows, where to start",
  empty = "No story yet: a line or two on what this diagram shows and where to start.",
}: {
  text: string;
  onSave: (text: string) => void;
  title?: string;
  placeholder?: string;
  empty?: string;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="story">
      <h4>
        {title}
        {!editing && (
          <button
            className="icon"
            title={text ? "Rewrite the story" : "Add a story"}
            onClick={() => setEditing(true)}
          >
            {text ? <Pencil size={12} /> : <Plus size={13} />}
          </button>
        )}
      </h4>
      {editing ? (
        <TextField
          multiline
          autoFocus
          value={text}
          placeholder={placeholder}
          onCommit={(v) => {
            setEditing(false);
            if (v.trim() !== text) onSave(v.trim());
          }}
        />
      ) : text ? (
        <Markdown text={text} className="story-body md" />
      ) : (
        <p className="muted small">{empty}</p>
      )}
    </div>
  );
}
