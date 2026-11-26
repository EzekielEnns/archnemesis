import { useEffect, useRef, useState } from "react";

/** A text box that saves on Enter or when it loses focus, and reverts on Escape. */
export function TextField(props: {
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  multiline?: boolean;
  className?: string;
  autoFocus?: boolean;
}) {
  const [draft, setDraft] = useState(props.value);
  // Someone else changed it: show theirs, unless you're typing here (then yours wins on save).
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(props.value);
  }, [props.value]);
  // Escape reverts: the blur it causes must not save what was typed (the draft it sees is still that).
  const cancelled = useRef(false);
  const commit = () => {
    focused.current = false;
    if (cancelled.current) return void (cancelled.current = false);
    if (draft !== props.value) props.onCommit(draft);
  };
  const common = {
    className: props.className,
    autoFocus: props.autoFocus,
    value: draft,
    placeholder: props.placeholder,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setDraft(e.target.value),
    onFocus: () => void (focused.current = true),
    onBlur: commit,
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (e.key === "Escape") {
        cancelled.current = true;
        setDraft(props.value);
        e.currentTarget.blur();
      } else if (e.key === "Enter" && (!props.multiline || e.metaKey)) {
        e.preventDefault();
        commit();
        e.currentTarget.blur();
      }
    },
  };
  return props.multiline ? <textarea rows={3} {...common} /> : <input {...common} />;
}
