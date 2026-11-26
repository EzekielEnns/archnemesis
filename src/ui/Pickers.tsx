// Tags and technology: chips on the panel, and a searchable
// picker that opens beside it (checkboxes, logos, colours). The model doesn't change:
// tags are still "group:value" strings, technology is still "Go, Postgres".
import { Check, Hash, Plus } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { backend } from "../backend";
import { TechImg } from "./TechImg";
import { tagColor, type ModelIndex } from "../../shared/project.ts";
import type { TagGroupDef } from "../../shared/model.ts";

const CHIPS_SHOWN = 12;

type Groups = Record<
  string,
  { description?: string; values: string[]; colors?: Record<string, string> }
>;

export const techList = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

/** A panel that opens to the left of the inspector, level with what opened it. */
function Popover({
  anchor,
  title,
  onClose,
  children,
}: {
  anchor: HTMLElement;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number }>({ top: 80, right: 360 });
  useLayoutEffect(() => {
    const a = anchor.getBoundingClientRect();
    const panel = anchor.closest(".inspector")?.getBoundingClientRect();
    const h = box.current?.offsetHeight ?? 360;
    setPos({
      top: Math.max(12, Math.min(a.top - 40, window.innerHeight - h - 12)),
      right: window.innerWidth - (panel?.left ?? a.left) + 8,
    });
  }, [anchor]);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") (e.stopPropagation(), onClose());
    };
    window.addEventListener("mousedown", down, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("mousedown", down, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [anchor, onClose]);
  return createPortal(
    <div ref={box} className="picker" style={{ top: pos.top, right: pos.right }}>
      <div className="picker-title">{title}</div>
      {children}
    </div>,
    document.body,
  );
}

/** A tag as a chip: a group's value in its colour, a free tag with a #. */
function TagChip({ tag, groups }: { tag: string; groups: Groups }) {
  const at = tag.indexOf(":");
  const g = at > 0 ? tag.slice(0, at) : "";
  const group = g ? groups[g] : undefined;
  const value = group ? tag.slice(at + 1) : tag;
  const color = group ? tagColor(group, value) : undefined;
  return (
    <span
      className={`tag-chip ${group ? "grouped" : ""}`}
      style={color ? { color, background: `${color}22`, borderColor: `${color}55` } : undefined}
      title={group ? `${g}: ${value}` : tag}
    >
      {!group && <Hash size={10} />}
      <span className="tag-chip-text">{value}</span>
    </span>
  );
}

/** An object's tags: chips, and "+ Add tags" opens the picker. */
export function TagsField({
  tags,
  groups,
  idx,
  onChange,
  onGroup,
}: {
  tags: string[];
  groups: Groups;
  idx: ModelIndex;
  onChange: (tags: string[], label: string) => void;
  /** Add or change a tag group in archnm.yaml. */
  onGroup?: (name: string, group: TagGroupDef, label: string) => Promise<unknown>;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [all, setAll] = useState(false);
  // Group values first (they carry meaning and colour), then the rest; many fold away.
  const grouped = tags.filter((t) => Object.keys(groups).some((g) => t.startsWith(`${g}:`)));
  const rest = tags.filter((t) => !grouped.includes(t));
  const shown = [...grouped, ...(all ? rest : rest.slice(0, CHIPS_SHOWN))];
  // The whole field opens the picker: untick there to take a tag off.
  return (
    <div
      className="chip-field clickable"
      title="Change tags"
      onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
    >
      {shown.map((t) => (
        <TagChip key={t} tag={t} groups={groups} />
      ))}
      {rest.length > CHIPS_SHOWN && (
        <button
          className="add-chip more"
          onClick={(e) => {
            e.stopPropagation();
            setAll((v) => !v);
          }}
        >
          {all ? "Fewer" : `+${rest.length - CHIPS_SHOWN} more`}
        </button>
      )}
      {!tags.length && (
        <span className="add-chip">
          <Plus size={11} /> Add tags
        </span>
      )}
      {anchor && (
        <TagPicker
          anchor={anchor}
          tags={tags}
          groups={groups}
          idx={idx}
          onChange={onChange}
          onGroup={onGroup}
          onClose={() => setAnchor(null)}
        />
      )}
    </div>
  );
}

function TagPicker({
  anchor,
  tags,
  groups,
  idx,
  onChange,
  onGroup,
  onClose,
}: {
  anchor: HTMLElement;
  tags: string[];
  groups: Groups;
  idx: ModelIndex;
  onChange: (tags: string[], label: string) => void;
  onGroup?: (name: string, group: TagGroupDef, label: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  // Making a group, or adding a value to one ("" is a new group).
  const [making, setMaking] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const saveGroup = (name: string, group: TagGroupDef, label: string, pick?: string) => {
    setErr("");
    onGroup?.(name, group, label)
      .then(() => {
        setMaking(null);
        if (pick)
          onChange(
            [...tags.filter((x) => !x.startsWith(`${name}:`)), `${name}:${pick}`],
            `set ${name}`,
          );
      })
      .catch((e: Error) => setErr(e.message));
  };
  const inGroup = (t: string) => Object.keys(groups).some((g) => t.startsWith(`${g}:`));
  // Free tags anyone has used in this design, most used first.
  const free = useMemo(() => {
    const n = new Map<string, number>();
    for (const o of idx.objects.values())
      for (const t of o.tags) if (!inGroup(t)) n.set(t, (n.get(t) ?? 0) + 1);
    return [...n].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, groups]);
  const ql = q.trim().toLowerCase();
  const hit = (s: string) => !ql || s.toLowerCase().includes(ql);
  const has = new Set(tags);
  // A group holds one value: picking another swaps it.
  const toggleGroup = (g: string, v: string) => {
    const t = `${g}:${v}`;
    onChange(
      has.has(t) ? tags.filter((x) => x !== t) : [...tags.filter((x) => !x.startsWith(`${g}:`)), t],
      has.has(t) ? `clear ${g}` : `set ${g}`,
    );
  };
  const toggleFree = (t: string) =>
    onChange(has.has(t) ? tags.filter((x) => x !== t) : [...tags, t], has.has(t) ? "untag" : "tag");
  const fresh = q.trim().replace(/\s+/g, "-");
  const canCreate =
    fresh &&
    !groups[fresh.toLowerCase()] &&
    !has.has(fresh) &&
    !free.includes(fresh) &&
    !Object.entries(groups).some(([g, d]) => d.values.some((v) => `${g}:${v}` === fresh));
  return (
    <Popover anchor={anchor} title="Tags" onClose={onClose}>
      <input
        className="picker-search"
        autoFocus
        value={q}
        placeholder="Search or make a tag…"
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && canCreate) {
            toggleFree(fresh);
            setQ("");
          }
        }}
      />
      <div className="picker-list">
        {Object.entries(groups).map(([g, d]) => {
          const vals = d.values.filter((v) => hit(v) || hit(g));
          if (!vals.length) return null;
          return (
            <div key={g} className="picker-group">
              <div className="picker-group-head" title={d.description}>
                {g}
                <span className="muted">one of</span>
                {onGroup && (
                  <button
                    className="picker-plus"
                    title={`Add a value to ${g}`}
                    onClick={() => setMaking(making === g ? null : g)}
                  >
                    <Plus size={12} />
                  </button>
                )}
              </div>
              {making === g && (
                <GroupForm
                  value={{ name: g, values: "" }}
                  fixedName
                  err={err}
                  onCancel={() => setMaking(null)}
                  onSave={({ values }) => {
                    const add = values.filter((v) => !d.values.includes(v));
                    if (add.length)
                      saveGroup(
                        g,
                        { ...d, values: [...d.values, ...add] },
                        `add ${add.join(", ")} to ${g}`,
                        add.length === 1 ? add[0] : undefined,
                      );
                    else setMaking(null);
                  }}
                />
              )}
              {vals.map((v) => (
                <button key={v} className="picker-row" onClick={() => toggleGroup(g, v)}>
                  <span className={`check ${has.has(`${g}:${v}`) ? "on" : ""}`}>
                    {has.has(`${g}:${v}`) && <Check size={10} />}
                  </span>
                  <TagChip tag={`${g}:${v}`} groups={groups} />
                </button>
              ))}
            </div>
          );
        })}
        {free.some(hit) && (
          <div className="picker-group">
            <div className="picker-group-head">Other tags</div>
            {free.filter(hit).map((t) => (
              <button key={t} className="picker-row" onClick={() => toggleFree(t)}>
                <span className={`check ${has.has(t) ? "on" : ""}`}>
                  {has.has(t) && <Check size={10} />}
                </span>
                <TagChip tag={t} groups={groups} />
              </button>
            ))}
          </div>
        )}
        {canCreate && (
          <button
            className="picker-row create"
            onClick={() => {
              toggleFree(fresh);
              setQ("");
            }}
          >
            <Plus size={12} /> Make tag <TagChip tag={fresh} groups={groups} />
          </button>
        )}
        {onGroup &&
          (making === "" ? (
            <GroupForm
              value={{
                name: q
                  .trim()
                  .toLowerCase()
                  .replace(/[^a-z0-9-]+/g, "-"),
                values: "",
              }}
              err={err}
              onCancel={() => setMaking(null)}
              onSave={({ name, values }) => {
                if (groups[name]) return setErr(`there's already a group called ${name}`);
                saveGroup(name, { values }, `new tag group ${name}`);
              }}
            />
          ) : (
            <button className="picker-row create" onClick={() => setMaking("")}>
              <Plus size={12} /> New group
            </button>
          ))}
        <p className="muted small picker-foot">
          A group is a set of values a box can have one of (risk: high, medium, low). It's saved in
          archnm.yaml.
        </p>
      </div>
    </Popover>
  );
}

/** An object's technology: a logo chip per tech, and "+ Add technology" opens the picker. */
export function TechField({
  value,
  idx,
  onChange,
}: {
  value: string;
  idx: ModelIndex;
  onChange: (v: string, label: string) => void;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const list = techList(value);
  return (
    <div
      className="chip-field clickable"
      title="Change technology"
      onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
    >
      {list.map((t) => (
        <span key={t} className="tech-chip" title={t}>
          <TechImg tech={t} width={14} height={14} />
          <span className="tag-chip-text">{t}</span>
        </span>
      ))}
      {!list.length && (
        <span className="add-chip">
          <Plus size={11} /> Add technology
        </span>
      )}
      {anchor && (
        <TechPicker
          anchor={anchor}
          list={list}
          idx={idx}
          onChange={onChange}
          onClose={() => setAnchor(null)}
        />
      )}
    </div>
  );
}

function TechPicker({
  anchor,
  list,
  idx,
  onChange,
  onClose,
}: {
  anchor: HTMLElement;
  list: string[];
  idx: ModelIndex;
  onChange: (v: string, label: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<string[]>([]);
  // What this design already uses, most used first: the usual picks.
  const used = useMemo(() => {
    const n = new Map<string, number>();
    for (const o of idx.objects.values())
      for (const t of techList(o.technology)) n.set(t, (n.get(t) ?? 0) + 1);
    for (const c of idx.connections.values())
      for (const t of techList(c.technology)) n.set(t, (n.get(t) ?? 0) + 1);
    return [...n].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
  }, [idx]);
  const ql = q.trim().toLowerCase();
  useEffect(() => {
    if (!ql) return setHits([]);
    const ctl = new AbortController();
    const t = setTimeout(() => {
      backend.icons
        .search(q, ctl.signal)
        .then(setHits)
        .catch(() => {});
    }, 120);
    return () => (clearTimeout(t), ctl.abort());
  }, [ql, q]);
  const has = new Set(list.map((t) => t.toLowerCase()));
  const toggle = (t: string) =>
    onChange(
      (has.has(t.toLowerCase())
        ? list.filter((x) => x.toLowerCase() !== t.toLowerCase())
        : [...list, t]
      ).join(", "),
      "set technology",
    );
  const mine = used.filter((t) => !ql || t.toLowerCase().includes(ql));
  const more = hits.filter((t) => !mine.some((m) => m.toLowerCase() === t.toLowerCase()));
  const exact = [...mine, ...more, ...list].some((t) => t.toLowerCase() === ql);
  const row = (t: string) => (
    <button key={t} className="picker-row" onClick={() => toggle(t)}>
      <span className={`check ${has.has(t.toLowerCase()) ? "on" : ""}`}>
        {has.has(t.toLowerCase()) && <Check size={10} />}
      </span>
      <TechImg tech={t} width={16} height={16} missing="keep" />
      <span>{t}</span>
    </button>
  );
  return (
    <Popover anchor={anchor} title="Technology" onClose={onClose}>
      <input
        className="picker-search"
        autoFocus
        value={q}
        placeholder="Search Go, Postgres, Cloud Run…"
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && q.trim()) {
            toggle((more[0] && !mine.length ? more[0] : mine[0]) ?? q.trim());
            setQ("");
          }
        }}
      />
      <div className="picker-list">
        {list.length > 0 && !ql && (
          <div className="picker-group">
            <div className="picker-group-head">On this one</div>
            {list.map(row)}
          </div>
        )}
        {mine.filter((t) => !has.has(t.toLowerCase()) || ql).length > 0 && (
          <div className="picker-group">
            <div className="picker-group-head">Used in this design</div>
            {mine.filter((t) => !has.has(t.toLowerCase()) || ql).map(row)}
          </div>
        )}
        {more.length > 0 && (
          <div className="picker-group">
            <div className="picker-group-head">All</div>
            {more.slice(0, 30).map(row)}
          </div>
        )}
        {ql && !exact && (
          <button
            className="picker-row create"
            onClick={() => {
              toggle(q.trim());
              setQ("");
            }}
          >
            <Plus size={12} /> Add “{q.trim()}”
          </button>
        )}
        {!ql && !used.length && (
          <p className="muted small picker-foot">Type to search the logos Archnemesis knows.</p>
        )}
      </div>
    </Popover>
  );
}

/** A group's name and values (comma-separated), for a new group or more values. */
function GroupForm({
  value,
  fixedName,
  err,
  onSave,
  onCancel,
}: {
  value: { name: string; values: string };
  fixedName?: boolean;
  err: string;
  onSave: (g: { name: string; values: string[] }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(value.name);
  const [values, setValues] = useState(value.values);
  const list = values
    .split(",")
    .map((v) => v.trim().toLowerCase().replace(/\s+/g, "-"))
    .filter(Boolean);
  const ok = /^[a-z][a-z0-9-]{0,31}$/.test(name) && list.length > 0;
  const submit = () => ok && onSave({ name, values: [...new Set(list)] });
  return (
    <div
      className="group-form"
      onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), submit())}
    >
      {!fixedName && (
        <input
          autoFocus
          value={name}
          placeholder="group name, e.g. risk"
          onChange={(e) => setName(e.target.value.toLowerCase())}
        />
      )}
      <input
        autoFocus={fixedName}
        value={values}
        placeholder={fixedName ? "new values, comma-separated" : "values: high, medium, low"}
        onChange={(e) => setValues(e.target.value)}
      />
      {err && <p className="err small">{err}</p>}
      <div className="group-form-acts">
        <button onClick={onCancel}>Cancel</button>
        <button className="primary" disabled={!ok} onClick={submit}>
          {fixedName ? "Add" : "Create group"}
        </button>
      </div>
    </div>
  );
}
