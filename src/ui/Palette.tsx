// ⌘K: jump to any object or diagram, or run a command, by typing part of its name.
import { useEffect, useMemo, useRef, useState } from "react";
import type { ObjectKind } from "../../shared/model.ts";
import type { ModelIndex } from "../../shared/project.ts";
import { KindDot } from "./KindDot";

/** Something ⌘K can do, besides jumping somewhere. */
export interface Command {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

export interface PaletteItem {
  kind: "object" | "diagram" | "command";
  id: string;
  label: string;
  detail: string;
  objectKind?: ObjectKind;
  external?: boolean;
  command?: Command;
}

/** Subsequence match, scored: earlier, tighter, word-start matches win. */
function score(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 1;
  const direct = t.indexOf(q);
  if (direct !== -1)
    return (
      1000 -
      direct * 2 -
      (t.length - q.length) * 0.1 +
      (direct === 0 || t[direct - 1] === " " ? 50 : 0)
    );
  let ti = 0;
  let gaps = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return -1;
    gaps += found - ti;
    ti = found + 1;
  }
  return 500 - gaps * 5 - t.length * 0.1;
}

export function Palette({
  idx,
  commands,
  onClose,
  onPick,
}: {
  idx: ModelIndex;
  commands: Command[];
  onClose: () => void;
  onPick: (item: PaletteItem) => void;
}) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  const items = useMemo<PaletteItem[]>(() => {
    const out: PaletteItem[] = commands.map((c) => ({
      kind: "command",
      id: c.id,
      label: c.label,
      detail: c.hint ?? "",
      command: c,
    }));
    for (const d of idx.diagrams.values())
      out.push({ kind: "diagram", id: d.id, label: d.name, detail: "diagram" });
    for (const o of idx.objects.values()) {
      const parent = o.parentId ? idx.objects.get(o.parentId)?.name : null;
      out.push({
        kind: "object",
        id: o.id,
        label: o.name,
        detail: [o.technology, parent && `in ${parent}`, ...(o.tags ?? []).map((t) => `#${t}`)]
          .filter(Boolean)
          .join(" · "),
        objectKind: o.kind,
        external: o.external,
      });
    }
    return out;
  }, [idx, commands]);

  const results = useMemo(
    () =>
      items
        // Commands first when nothing's typed; otherwise best match wins, commands nudged up.
        .map((it) => ({
          it,
          s:
            score(query, it.kind === "command" ? it.label : `${it.label} ${it.detail}`) +
            (it.kind === "command" ? (query ? 40 : 2000) : 0),
        }))
        .filter((r) => r.s >= 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 40)
        .map((r) => r.it),
    [items, query],
  );

  useEffect(() => input.current?.focus(), []);
  useEffect(() => setCursor(0), [query]);

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={input}
          placeholder="Find an object or diagram, or run a command…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            else if (e.key === "ArrowDown") {
              e.preventDefault();
              setCursor((c) => Math.min(results.length - 1, c + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((c) => Math.max(0, c - 1));
            } else if (e.key === "Enter" && results[cursor]) onPick(results[cursor]);
          }}
        />
        <ul>
          {results.map((r, i) => (
            <li key={`${r.kind}:${r.id}`}>
              <button
                className={i === cursor ? "active" : ""}
                onMouseEnter={() => setCursor(i)}
                onClick={() => onPick(r)}
              >
                {r.objectKind ? (
                  <KindDot kind={r.objectKind} external={r.external} />
                ) : (
                  <span className="glyph">{r.kind === "command" ? "›" : "◆"}</span>
                )}
                <span className="name">{r.label}</span>
                {r.kind === "command" ? (
                  r.detail && <kbd className="grow-left">{r.detail}</kbd>
                ) : (
                  <span className="muted">{r.detail}</span>
                )}
              </button>
            </li>
          ))}
          {results.length === 0 && <li className="muted none">Nothing matches.</li>}
        </ul>
      </div>
    </div>
  );
}
