// A box's or a diagram's docs (an RFC, a runbook, a dashboard): a list in its panel.
import { ExternalLink, Pencil, Plus, Trash2 } from "lucide-react";
import { useMenu } from "./ContextMenu";
import { useEffect, useRef, useState } from "react";
import { safeUrl, type DocLink } from "../../shared/model.ts";
import { LinkIcon, hostOf, titleFromUrl } from "./Notes";

export function LinksField({
  links,
  canEdit = true,
  open = 0,
  onChange,
}: {
  links: DocLink[];
  canEdit?: boolean;
  open?: number;
  onChange: (links: DocLink[], label: string) => void;
}) {
  // Which row is being edited: -1 for a new one.
  const [editing, setEditing] = useState<number | null>(null);
  const menu = useMenu();
  useEffect(() => {
    if (open) setEditing(-1);
  }, [open]);
  const save = (i: number, l: DocLink) => {
    const others = links.filter((_, j) => j !== i);
    if (others.some((x) => x.url === l.url)) return "that address is already here";
    onChange(
      i < 0 ? [...links, l] : links.map((x, j) => (j === i ? l : x)),
      i < 0 ? `linked ${l.title}` : `changed the link ${l.title}`,
    );
    setEditing(null);
    return "";
  };
  return (
    <div
      className="links-field"
      title={canEdit && links.length ? "Right-click a link to edit or remove it" : undefined}
    >
      {menu.node}
      {links.map((l, i) =>
        editing === i ? (
          <LinkForm
            key={l.url}
            value={l}
            onSave={(x) => save(i, x)}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <div
            key={l.url}
            className="doc-link"
            onContextMenu={menu.on(() => [
              {
                label: "Open",
                icon: <ExternalLink size={14} />,
                run: () => window.open(l.url, "_blank", "noopener,noreferrer"),
              },
              {
                label: "Edit",
                icon: <Pencil size={14} />,
                disabled: !canEdit,
                run: () => setEditing(i),
              },
              {
                label: "Remove",
                icon: <Trash2 size={14} />,
                danger: true,
                disabled: !canEdit,
                run: () =>
                  onChange(
                    links.filter((_, j) => j !== i),
                    `removed the link ${l.title}`,
                  ),
              },
            ])}
          >
            <a href={l.url} target="_blank" rel="noopener noreferrer" title={l.url}>
              <LinkIcon url={l.url} />
              <span className="doc-link-text">
                <b>{l.title || hostOf(l.url)}</b>
                <i>{hostOf(l.url)}</i>
              </span>
            </a>
          </div>
        ),
      )}
      {canEdit &&
        (editing === -1 ? (
          <LinkForm onSave={(x) => save(-1, x)} onCancel={() => setEditing(null)} />
        ) : (
          <button className="linkish add-line" onClick={() => setEditing(-1)}>
            <Plus size={12} /> Add a link
          </button>
        ))}
    </div>
  );
}

function LinkForm({
  value,
  onSave,
  onCancel,
}: {
  value?: DocLink;
  onSave: (l: DocLink) => string;
  onCancel: () => void;
}) {
  const [url, setUrl] = useState(value?.url ?? "");
  const [title, setTitle] = useState(value?.title ?? "");
  const [err, setErr] = useState("");
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);
  const clean = safeUrl(url.trim());
  const submit = () => {
    if (!clean) return setErr("an http or https address");
    setErr(onSave({ url: clean, title: (title.trim() || titleFromUrl(clean)).slice(0, 200) }));
  };
  return (
    <div
      className="group-form"
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") (e.preventDefault(), submit());
        else if (e.key === "Escape") onCancel();
      }}
    >
      <input
        ref={first}
        value={url}
        placeholder="https://… (an RFC, a runbook, a dashboard)"
        onChange={(e) => setUrl(e.target.value)}
      />
      <input
        value={title}
        placeholder={(clean && titleFromUrl(clean)) || "Title (optional)"}
        onChange={(e) => setTitle(e.target.value)}
      />
      {err && <p className="err small">{err}</p>}
      <div className="group-form-acts">
        <button onClick={onCancel}>Cancel</button>
        <button className="primary" disabled={!clean} onClick={submit}>
          {value ? "Save" : "Add"}
        </button>
      </div>
    </div>
  );
}
