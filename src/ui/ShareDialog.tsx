// Share one design: with the team (a private design becomes the team's, or goes back), and by
// link. A link lets whoever opens it look at the design and make their own copy, never change
// it; who it reaches (people who can sign in here, or anyone, for a public repo) is what the
// server says, said here in one line. A link's address is shown once, when it's made.
import { Check, Copy, Link2, Lock, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { backend } from "../backend";
import type { ShareLink, ShareReach } from "../../shared/api.ts";
import { Dialog } from "./Dialog";

interface Props {
  /** The design (or fork) being shared. */
  doc: string;
  name: string;
  onClose: () => void;
}

const EXPIRY: [string, number | null][] = [
  ["Never expires", null],
  ["1 day", 1],
  ["7 days", 7],
  ["30 days", 30],
];

/** Who a link reaches: said plainly, from what the server reports. */
function reachLine(r: ShareReach): string {
  if (r.kind === "anyone")
    return "Anyone with this link, no sign-in. This design follows a public GitHub repository.";
  if (r.publicRepo && !r.publicLinks)
    return "Anyone with this link who can sign in here. This design follows a public repository, but this host doesn't allow viewing without signing in.";
  return "Anyone with this link who can sign in here.";
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : null);

function state(l: ShareLink): string {
  if (l.revoked) return "Revoked";
  if (!l.active) return `Expired ${when(l.expires)}`;
  return l.expires ? `Expires ${when(l.expires)}` : "No expiry";
}

/** Run a call as busy, showing why when it's refused. */
function useRun(setError: (e: string | null) => void) {
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "that didn't work");
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

interface SectionProps {
  doc: string;
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
}

/** With the team: a design's owner makes it theirs alone, or the team's. */
function TeamSection({ doc, busy, run }: SectionProps) {
  const [mine, setMine] = useState<{ private: boolean } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const isFork = doc.includes("@");
  useEffect(() => {
    if (isFork || !backend.designs.share) return;
    void backend.designs
      .list()
      .then((l) => {
        const d = l.find((x) => x.key === doc);
        if (d?.mine && !d.git) setMine({ private: d.private });
      })
      .catch(() => {});
  }, [doc, isFork]);
  if (!mine) return null;
  return (
    <section className="share-sec">
      <h3>{mine.private ? <Lock size={13} /> : <Users size={13} />} With the team</h3>
      <p>
        {mine.private
          ? "Only you can see this design now."
          : "Everyone on this Archnemesis can see this design."}
      </p>
      <button
        className="share-btn"
        disabled={busy}
        onClick={() =>
          void run(async () => {
            await backend.designs.share!(doc, !mine.private);
            setMine({ private: !mine.private });
            setNote(mine.private ? "Shared with the team" : "Only you can see it now");
          })
        }
      >
        {mine.private ? "Share with the team" : "Make it private"}
      </button>
      {note && <span className="share-note">{note}</span>}
    </section>
  );
}

/** The address of a link just made: shown here, once. */
function Fresh({ url, onError }: { url: string; onError: (e: string) => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      onError("Couldn't copy it: select the address and copy it by hand");
    }
  };
  return (
    <div className="share-fresh">
      <p>Copy it now: it isn't shown again.</p>
      <div className="share-url">
        <input readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
        <button className="share-btn" onClick={() => void copy()}>
          {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

function LinkRow({
  l,
  doc,
  busy,
  run,
  reload,
}: SectionProps & { l: ShareLink; reload: () => void }) {
  return (
    <li className={l.active ? "" : "gone"}>
      <div>
        <div className="share-what">
          Made by {l.by}, {when(l.created)}
        </div>
        <div className="share-meta">
          {state(l)} · {l.lastUsed ? `last used ${when(l.lastUsed)}` : "never used"}
        </div>
      </div>
      {l.active && (
        <button
          className="share-btn danger"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await backend.links!.revoke(doc, l.id);
              reload();
            })
          }
        >
          Revoke
        </button>
      )}
    </li>
  );
}

export function ShareDialog({ doc, name, onClose }: Props) {
  const [links, setLinks] = useState<ShareLink[] | null>(null);
  const [reach, setReach] = useState<ShareReach | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState<number | null>(null);
  // The address of the link just made: only ever here.
  const [fresh, setFresh] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const { busy, run } = useRun(setError);
  const reload = () => setVersion((n) => n + 1);

  useEffect(() => {
    let live = true;
    backend
      .links!.list(doc)
      .then((r) => {
        if (!live) return;
        setLinks(r.links);
        setReach(r.reach);
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : "couldn't read the links"));
    return () => {
      live = false;
    };
  }, [doc, version]);

  const make = () =>
    run(async () => {
      setFresh((await backend.links!.create(doc, days)).url);
      reload();
    });

  return (
    <Dialog title={`Share ${name}`} onCancel={onClose} wide>
      <TeamSection doc={doc} busy={busy} run={run} />
      <section className="share-sec">
        <h3>
          <Link2 size={13} /> By link
        </h3>
        <p>
          A link lets people look at {doc.includes("@") ? "this fork" : "this design"} and make
          their own copy. They can't change it.
        </p>
        {reach && <p className="share-reach">{reachLine(reach)}</p>}
        <div className="share-make">
          <select
            className="share-select"
            value={days ?? ""}
            onChange={(e) => setDays(e.target.value ? Number(e.target.value) : null)}
            aria-label="When the link ends"
          >
            {EXPIRY.map(([label, d]) => (
              <option key={label} value={d ?? ""}>
                {label}
              </option>
            ))}
          </select>
          <button className="share-btn primary" disabled={busy} onClick={() => void make()}>
            Make a link
          </button>
        </div>
        {fresh && <Fresh url={fresh} onError={setError} />}
        {links && links.length > 0 && (
          <ul className="share-links">
            {links.map((l) => (
              <LinkRow key={l.id} l={l} doc={doc} busy={busy} run={run} reload={reload} />
            ))}
          </ul>
        )}
        {links && links.length === 0 && <p className="share-meta">No links yet.</p>}
      </section>
      {error && <p className="first-error small">{error}</p>}
    </Dialog>
  );
}
