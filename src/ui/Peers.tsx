// Top right: who's here. One dot per person or agent, in their colour; click one to jump to
// what they're looking at. Your own dot sets the name others see.
import { Bot, ChevronDown, LogOut } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { PeerInfo } from "../presence";
import { hashFor } from "../route";
import { colorFor } from "../presence";
import type { SignInPage } from "../../shared/api.ts";
import { backend } from "../backend";
import { NAME_KEY, setStored } from "../storage";
import type { Store } from "../store";

interface Props {
  store: Store;
  peers: PeerInfo[];
  diagramName: (id: string | null) => string;
  onFollow: (p: PeerInfo) => void;
  /** Your other open tabs. */
  ownTabs: number;
  /** Shown first in the island (the notes button). */
  before?: ReactNode;
  /** Your own dot: the account dialog. */
  onAccount: () => void;
}

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "?";

/** Dots shown before the rest fold into "+N" (a list, like Figma's). */
const MAX_DOTS = 5;

interface Row {
  key: string;
  user: { id: string; name: string; color: string; kind: string };
  /** On this design (else elsewhere: faded). */
  here: boolean;
  where: string;
  activity?: string;
  go: () => void;
}

const ago = (at?: number) => {
  if (!at) return "";
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  return s < 60 ? "just now" : `${Math.round(s / 60)} min ago`;
};

export function Peers({ store, peers, diagramName, onFollow, ownTabs, before, onAccount }: Props) {
  const [listAt, setListAt] = useState<{ top: number; right: number } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!listAt) return;
    const close = (e: PointerEvent) =>
      !listRef.current?.contains(e.target as Node) &&
      !moreRef.current?.contains(e.target as Node) &&
      setListAt(null);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [listAt]);

  // One row per person or agent: here first, then elsewhere; people before agents.
  const rows: Row[] = [];
  const seen = new Set([store.me.id]);
  const people = new Map<string, PeerInfo>();
  for (const p of peers) if (!people.has(p.user.id) || p.cursor) people.set(p.user.id, p);
  for (const p of people.values()) {
    seen.add(p.user.id);
    rows.push({
      key: p.user.id,
      user: p.user,
      here: true,
      where: diagramName(p.diagram),
      activity: p.activity ?? undefined,
      go: () => onFollow(p),
    });
  }
  for (const e of store.here) {
    if (seen.has(e.user.id)) continue;
    seen.add(e.user.id);
    const here = e.doc === store.design;
    const where = here
      ? (e.diagramName ?? "this design")
      : `${e.docName}${e.diagramName ? ` › ${e.diagramName}` : ""}`;
    const job =
      e.progress &&
      `${e.progress.text}${e.progress.of && !e.progress.done ? ` (${e.progress.step ?? 0}/${e.progress.of})` : ""}`;
    const activity =
      e.user.kind === "agent"
        ? [
            job || e.activity,
            ago(e.at),
            e.for && !e.for.endsWith(":*")
              ? `for ${e.for.replace(/^[a-z]+:/, "").replace(/@.*$/, "")}`
              : "",
          ]
            .filter(Boolean)
            .join(" · ")
        : undefined;
    rows.push({
      key: `${e.user.id} ${e.doc}`,
      user: e.user,
      here,
      where,
      activity,
      go: () =>
        e.doc && (location.hash = hashFor({ design: e.doc, diagramId: e.diagram, objectId: null })),
    });
  }
  const rank = (r: Row) => (r.user.kind === "agent" ? 2 : 0) + (r.here ? 0 : 1);
  rows.sort((x, y) => rank(x) - rank(y));
  const dots = rows.length > MAX_DOTS ? rows.slice(0, MAX_DOTS - 1) : rows;
  const folded = rows.length - dots.length;

  const dot = (r: Row) => (r.user.kind === "agent" ? <Bot size={14} /> : initials(r.user.name));
  const groups: [string, Row[]][] = [
    ["On this design", rows.filter((r) => r.user.kind !== "agent" && r.here)],
    ["Elsewhere", rows.filter((r) => r.user.kind !== "agent" && !r.here)],
    ["Agents", rows.filter((r) => r.user.kind === "agent")],
  ];

  return (
    <div className="chrome top-right">
      <div className="island peers">
        {before}
        {dots.map((r) => (
          <button
            key={r.key}
            className={r.here ? "peer" : "peer away"}
            style={{ background: r.user.color }}
            title={`${r.user.name}${r.user.kind === "agent" ? " (agent)" : ""} · ${r.here ? "" : "on "}${r.where}${r.activity ? `\n${r.activity}` : ""}`}
            onClick={r.go}
          >
            {dot(r)}
          </button>
        ))}
        {rows.length > 0 && (
          <button
            ref={moreRef}
            className={folded ? "peer-more" : "peer-more quiet"}
            title={folded ? `${folded} more: everyone on Archnemesis` : "Everyone on Archnemesis"}
            onClick={(e) => {
              const b = e.currentTarget.getBoundingClientRect();
              setListAt(
                listAt ? null : { top: b.bottom + 10, right: window.innerWidth - b.right - 6 },
              );
            }}
          >
            {folded ? `+${folded}` : <ChevronDown size={13} />}
          </button>
        )}
        {listAt &&
          createPortal(
            <div className="design-list island here-list" style={listAt} ref={listRef}>
              {groups.map(([title, list]) =>
                list.length ? (
                  <div key={title} className="here-group">
                    <div className="design-note">{title}</div>
                    {list.map((r) => (
                      <button
                        key={r.key}
                        className="design-row here-row"
                        onClick={() => (setListAt(null), r.go())}
                      >
                        <span
                          className={r.here ? "peer small" : "peer small away"}
                          style={{ background: r.user.color }}
                        >
                          {dot(r)}
                        </span>
                        <span className="here-text">
                          <span className="design-name">{r.user.name}</span>
                          <span className="design-meta">
                            {r.where}
                            {r.activity ? ` · ${r.activity}` : ""}
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                ) : null,
              )}
            </div>,
            document.body,
          )}
        {rows.length > 0 && <span className="sep" />}
        <button
          className="peer me"
          style={{ background: colorFor(store.me.id) }}
          title={`${store.me.name}: your account${ownTabs ? `\nOpen in ${ownTabs + 1} tabs` : ""}`}
          onClick={onAccount}
        >
          {initials(store.me.name)}
        </button>
      </div>
    </div>
  );
}

/** You: the name others see, how you're signed in, GitHub, signing out. Off your own dot. */
/** Who you are here: your name (on this machine), how you're signed in, and GitHub. */
export function AccountFields({ store }: { store: Store }) {
  const [name, setName] = useState(store.me.name);
  const local = store.authMode === "local";
  const next = name.trim().slice(0, 40);
  const how = local
    ? "On this machine: no sign-in"
    : store.signin.kind === "token"
      ? "With a token"
      : store.signin.kind === "buttons"
        ? "With your account"
        : "Through your network's sign-in";
  return (
    <>
      <div className="set-row">
        <span className="peer me account-dot" style={{ background: colorFor(store.me.id) }}>
          {initials(next || store.me.name)}
        </span>
        <div className="grow">
          {local ? (
            <input
              className="dialog-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name, as others see it"
              aria-label="Your name"
            />
          ) : (
            store.me.name
          )}
          <small>Shown on your edits and next to your cursor</small>
        </div>
        {local && next && next !== store.me.name && (
          <button className="cta" onClick={() => (setStored(NAME_KEY, next), location.reload())}>
            Save
          </button>
        )}
      </div>
      <div className="set-row">
        <div className="grow">
          Signed in
          <small>{how}</small>
        </div>
        {backend.signIn && (store.signin.kind === "token" || store.signin.kind === "buttons") && (
          <button className="cta" onClick={() => store.signOut()}>
            <LogOut size={14} /> Sign out
          </button>
        )}
      </div>
    </>
  );
}

/** The reason a sign-in flow sent the browser back (the server puts it in the address as #~signin-error=…). */
function errorFromAddress(): string | null {
  const m = /^#~signin-error=(.*)$/.exec(location.hash);
  try {
    return m ? decodeURIComponent(m[1]!) : null;
  } catch {
    return null;
  }
}

/**
 * The one sign-in page, whatever the server signs people in with: the name, a line of plain
 * text, then a token field or one button per way in, and the error, if any, in one place.
 */
export function SignInForm({ page }: { page: SignInPage }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(errorFromAddress);
  useEffect(() => {
    // Shown once: the address goes back to what it was.
    if (/^#~signin-error=/.test(location.hash))
      history.replaceState(null, "", location.pathname + location.search);
  }, []);
  const line =
    page.kind === "token"
      ? page.hint || "This Archnemesis needs a token to open. Ask whoever runs it for one."
      : page.kind === "buttons"
        ? "Sign in to continue."
        : "This Archnemesis didn't recognise you. Ask whoever runs it to let you in.";
  return (
    <div className="signin">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (page.kind === "token" && token.trim()) backend.signIn?.withToken(token);
        }}
      >
        <h1>Archnemesis</h1>
        <p>{line}</p>
        {page.kind === "token" && (
          <>
            <input
              type="password"
              autoFocus
              placeholder="Token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
            <button type="submit">Open</button>
          </>
        )}
        {page.kind === "buttons" &&
          page.buttons.map((b) => (
            <button
              key={b.start}
              type="button"
              onClick={() => {
                setError(null);
                backend.signIn?.start(b.start);
              }}
            >
              {b.label}
            </button>
          ))}
        {error && <p className="first-error">{error}</p>}
      </form>
    </div>
  );
}

/** Not signed in: the one screen before anything else. */
export function SignIn({ store }: { store: Store }) {
  return <SignInForm page={store.signin} />;
}
