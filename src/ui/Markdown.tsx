// A little markdown, rendered as React elements (never as HTML, so nothing in the text can
// run): headings, paragraphs, lists, quotes, fenced code, and inline code, bold, italics
// and links. Enough for a plan's context with examples; anything else shows as text.
import type { ReactNode } from "react";

const SAFE_URL = /^(https?:|mailto:)/i;

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  // `code`, **bold**, *italic* or _italic_, [text](url)
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    const k = `${key}.${i++}`;
    if (m[1]) out.push(<code key={k}>{t.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k}>{inline(t.slice(2, -2), k)}</strong>);
    else if (m[3]) out.push(<em key={k}>{inline(t.slice(1, -1), k)}</em>);
    else {
      const [, label, url] = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(t)!;
      out.push(
        SAFE_URL.test(url!) ? (
          <a key={k} href={url} target="_blank" rel="noopener noreferrer">
            {label}
          </a>
        ) : (
          t
        ),
      );
    }
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text, className = "md" }: { text: string; className?: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    const k = `b${i}`;
    const fence = /^\s*```\s*([\w-]*)/.exec(l);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) body.push(lines[i++]!);
      i++;
      blocks.push(
        <pre key={k} data-lang={fence[1] || undefined}>
          <code>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(l);
    if (h) {
      const level = Math.min(6, h[1]!.length + 3);
      const H = `h${level}` as "h4" | "h5" | "h6";
      blocks.push(<H key={k}>{inline(h[2]!, k)}</H>);
      i++;
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) {
      const ordered = /^\s*\d/.test(l);
      const items: ReactNode[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i]!)) {
        const item = lines[i]!.replace(/^\s*([-*+]|\d+[.)])\s+/, "");
        const check = /^\[( |x)\]\s+/i.exec(item);
        items.push(
          <li key={`${k}.${items.length}`}>
            {check ? (check[1] === " " ? "☐ " : "☑ ") : null}
            {inline(check ? item.slice(check[0].length) : item, `${k}.${items.length}`)}
          </li>,
        );
        i++;
      }
      blocks.push(ordered ? <ol key={k}>{items}</ol> : <ul key={k}>{items}</ul>);
      continue;
    }
    if (/^\s*>\s?/.test(l)) {
      const q: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i]!))
        q.push(lines[i++]!.replace(/^\s*>\s?/, ""));
      blocks.push(<blockquote key={k}>{inline(q.join(" "), k)}</blockquote>);
      continue;
    }
    if (!l.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !/^\s*(```|#{1,4}\s|([-*+]|\d+[.)])\s|>)/.test(lines[i]!)
    )
      para.push(lines[i++]!);
    blocks.push(<p key={k}>{inline(para.join(" "), k)}</p>);
  }
  return <div className={className}>{blocks}</div>;
}
