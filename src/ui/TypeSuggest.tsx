// Suggestions while typing a signature: the entities the design already has, for the capitalised
// word at the cursor. Tab takes the first (or the one arrowed to); Enter takes one only when
// you've arrowed to it, so Enter after a whole name still finishes. A name nothing has yet is
// fine: it becomes a TBD entity when it's saved.
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { completeType, entitySummary, suggestTypes, typeAt } from "../../shared/entities";
import type { ModelIndex } from "../../shared/project";

export function useTypeSuggest(
  idx: ModelIndex,
  value: string,
  setValue: (v: string) => void,
  input: RefObject<HTMLInputElement | null>,
) {
  const [cursor, setCursor] = useState(-1);
  const [pick, setPick] = useState(0);
  const [arrowed, setArrowed] = useState(false);
  const [shut, setShut] = useState(false);
  // Where the cursor goes after a pick: set as soon as the new text is in the input.
  const place = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (place.current === null) return;
    input.current?.setSelectionRange(place.current, place.current);
    place.current = null;
  });
  const at = cursor >= 0 && !shut ? typeAt(value, cursor) : null;
  const items = at ? suggestTypes(idx, at.word) : [];
  const on = Math.min(pick, Math.max(0, items.length - 1));
  const track = () => {
    const el = input.current;
    if (!el) return;
    setCursor(el.selectionStart ?? -1);
  };
  const take = (name: string) => {
    if (!at) return;
    const c = completeType(value, at, name);
    setValue(c.text);
    setPick(0);
    setArrowed(false);
    place.current = c.cursor;
    setCursor(c.cursor);
  };
  /** Handle a key if it's the list's; true when it was. */
  const onKey = (e: KeyboardEvent<HTMLInputElement>): boolean => {
    if (!items.length) return false;
    const stop = () => (e.preventDefault(), e.stopPropagation(), true);
    if (e.key === "ArrowDown")
      return (setArrowed(true), setPick(Math.min(on + 1, items.length - 1)), stop());
    if (e.key === "ArrowUp") return (setArrowed(true), setPick(Math.max(on - 1, 0)), stop());
    if (e.key === "Tab" && !e.shiftKey) return (take(items[on]!.name), stop());
    if (e.key === "Enter" && arrowed) return (take(items[on]!.name), stop());
    if (e.key === "Escape") return (setShut(true), stop());
    return false;
  };
  const changed = () => (
    setPick(0),
    setArrowed(false),
    setShut(false),
    requestAnimationFrame(track)
  );
  const list =
    items.length > 0 ? (
      <div className="nc-sugg ts-sugg">
        {items.map((e, i) => {
          const from = e.sourceId ? idx.objects.get(e.sourceId)?.name : undefined;
          return (
            <button
              key={e.id}
              className={i === on && (arrowed || i === 0) ? "on" : ""}
              onMouseDown={(ev) => (ev.preventDefault(), take(e.name))}
              onMouseEnter={() => setPick(i)}
            >
              <span className="nc-sugg-v mono">{e.name}</span>
              <span className="nc-sugg-m">
                {entitySummary(e)}
                {from && ` · ${from}`}
              </span>
            </button>
          );
        })}
        <div className="ts-hint">{arrowed ? "Tab or Enter to use it" : "Tab to use it"}</div>
      </div>
    ) : null;
  return { onKey, track, changed, list, open: items.length > 0 };
}

/** The card's "Takes": a signature field that saves on Enter or blur, with type suggestions. */
export function SignatureField(p: {
  idx: ModelIndex;
  value: string;
  placeholder?: string;
  className?: string;
  onCommit: (v: string) => void;
}) {
  const [draft, setDraft] = useState(p.value);
  const focused = useRef(false);
  const ref = useRef<HTMLInputElement>(null);
  // Someone else changed it: show theirs, unless you're typing here.
  useEffect(() => {
    if (!focused.current) setDraft(p.value);
  }, [p.value]);
  const ts = useTypeSuggest(p.idx, draft, setDraft, ref);
  // Escape reverts: the blur it causes must not save what was typed.
  const cancelled = useRef(false);
  const commit = () => {
    focused.current = false;
    if (cancelled.current) return void (cancelled.current = false);
    if (draft !== p.value) p.onCommit(draft);
  };
  return (
    <div className="ts-field">
      <input
        ref={ref}
        className={p.className}
        value={draft}
        placeholder={p.placeholder}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => (setDraft(e.target.value), ts.changed())}
        onSelect={ts.track}
        onFocus={() => void (focused.current = true)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (ts.onKey(e)) return;
          if (e.key === "Escape") {
            cancelled.current = true;
            setDraft(p.value);
            e.currentTarget.blur();
          } else if (e.key === "Enter") {
            e.preventDefault();
            commit();
            e.currentTarget.blur();
          }
        }}
      />
      {ts.list}
    </div>
  );
}
