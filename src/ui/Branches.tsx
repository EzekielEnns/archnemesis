// Branches, as a view in the left panel (tree · code · branches), the way git tools show them:
//
//   current   the branch you're on. On a fork, in the order you'd do it: what changed (and the
//             diff, drawn on the canvas, with the list of changes here), then merging it
//   graph     main and its forks as a git graph: each fork curves off main's lane in a colour of
//             its own; main's history runs down its lane, commit by commit
//
// The head shows the branch and a save icon for where the design is saved (Settings → Repo).
import {
  ExternalLink,
  Eye,
  EyeOff,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequestArrow,
  History,
  Link as LinkIcon,
  LoaderCircle,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
  Users,
} from "lucide-react";
import { useEffect, useState } from "react";
import { colorFor } from "../presence";
import { carryToast, goDoc } from "../route";
import type { Store } from "../store";
import {
  ago,
  ForkIcons,
  gitStatus,
  mainMeta,
  mainNote,
  prState,
  repoName,
  type Act,
} from "./BranchMenu";
import { Dialog } from "./Dialog";

type Toast = (text: string, tone?: "info" | "error") => void;

/** The graph keeps to two colours: main's blue, and green for the fork you're on (the rest grey). */
const MAIN = "#7aa7ff";
const HERE = "#34d399";
const QUIET = "#59606e";

/** The panel's head: the branch you're on, and a save icon for where it's saved. */
export function PanelBranchHead(p: { store: Store; onRepo: () => void }) {
  const status = gitStatus(p.store);
  return (
    <>
      <span
        className="branch-wide static"
        data-tip={p.store.branch ? `You're on the fork ${p.store.branch}` : "You're on main"}
      >
        <GitBranch size={15} className="b-icon" style={{ color: p.store.branch ? HERE : MAIN }} />
        <span className="b-name">{p.store.branch ?? "main"}</span>
      </span>
      <button
        className={`icon-btn git-status ${status.tone}`}
        data-tip={`${status.label}: ${status.title}. Click for the repo's settings`}
        aria-label={status.label}
        onClick={p.onRepo}
      >
        {status.icon}
      </button>
    </>
  );
}

export interface Change {
  key: string;
  sign: "+" | "~" | "−";
  name: string;
  /** For a changed one: how many lines went and came. */
  plus?: number;
  minus?: number;
  go: () => void;
}

interface Props {
  store: Store;
  toast: Toast;
  /** On a fork: diffing it with main, on the canvas, and what changed. */
  diff: { count: number; on: boolean; toggle: () => void; changes: Change[] } | null;
  /** Settings → Repo & git: connect one, or move to a real one. */
  onRepo: () => void;
}

export function BranchesView({ store, toast, diff, onRepo }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [ask, setAsk] = useState<null | "fork" | "discard" | "merge">(null);
  const [forkName, setForkName] = useState("");
  const [past, setPast] = useState<
    { sha: string; date: string; author: string; subject: string }[] | null
  >(null);
  const git = store.git;
  const forkIndex = git?.forks.findIndex((f) => f.doc === store.design) ?? -1;
  const fork = forkIndex >= 0 ? git!.forks[forkIndex]! : null;
  const forge = git?.forge ?? null;
  useEffect(() => void (git && store.refreshGit()), []); // eslint-disable-line react-hooks/exhaustive-deps
  // main's history, read once the view opens (it's always shown, under the branches).
  const head = git?.main ?? null;
  useEffect(() => {
    if (!head) return;
    let live = true;
    void store.versions().then(
      (v) => live && setPast(v),
      () => live && setPast([]),
    );
    return () => {
      live = false;
    };
  }, [store, head]);

  const act: Act = async (what, fn) => {
    setBusy(what);
    try {
      await fn();
      return true;
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
      return false;
    } finally {
      setBusy(null);
    }
  };
  const copy = (text: string, what: string) =>
    void navigator.clipboard.writeText(text).then(
      () => toast(`${what} copied`),
      () => toast("Couldn't copy", "error"),
    );
  const openPr = () => {
    // Opened during the click: one opened after the request returns is a blocked popup.
    const tab = window.open("", "_blank");
    void act("pr", async () => {
      const r = await store.gitAction.propose();
      const url = r.pr?.url ?? r.url;
      if (!url) throw new Error("This repo has no pull requests");
      if (tab) tab.location.href = url;
      else window.location.assign(url);
      toast(
        r.pr
          ? `Opened PR #${r.pr.number}`
          : `Finish the pull request on ${forge?.name ?? "the forge"}`,
      );
    }).then((ok) => !ok && tab?.close());
  };

  if (!git)
    return (
      <div className="branches">
        <div className="br-cur">
          <div className="br-cur-t">
            <GitCommitHorizontal size={15} style={{ color: MAIN }} /> main
          </div>
          <p className="br-note">
            Not in git yet. A repo gives this design forks to try changes on, diffs, and its
            history.
          </p>
          <button className="cta primary wide" onClick={onRepo} data-tip="Settings → Repo & git">
            <Upload size={14} /> Put it in a repo…
          </button>
        </div>
      </div>
    );

  const needsSignIn = !!git.app?.installed && !store.github?.login;
  const hasChanges = !!fork && (fork.pending || !!fork.head);
  const pr = fork?.pr && fork.pr.state !== "closed" ? fork.pr : null;
  const color = fork ? HERE : MAIN;
  const forks = git.forks;
  const history = past ?? [];

  return (
    <div className="branches">
      {/* The branch you're on: what changed, then what to do with it. */}
      <div className="br-cur" style={{ "--lane": color } as React.CSSProperties}>
        {store.branch ? (
          <>
            <div className="br-cur-t">
              <span className="br-swatch" />
              <span className="br-cur-name">{store.branch}</span>
              <span className="br-from">from main</span>
              <span className="grow" />
              <button
                className="icon-btn"
                data-tip="Copy a link to this fork, to share it"
                aria-label="Copy link"
                onClick={() => copy(location.href, "Link to fork")}
              >
                <LinkIcon size={14} />
              </button>
              <button
                className="icon-btn danger"
                data-tip="Discard this fork and its changes"
                aria-label="Discard"
                disabled={!!busy}
                onClick={() => setAsk("discard")}
              >
                <Trash2 size={14} />
              </button>
            </div>
            {diff && (
              <button
                className={`br-changes${diff.on ? " on" : ""}`}
                onClick={diff.toggle}
                disabled={!diff.count}
                data-tip={
                  diff.on
                    ? "Stop drawing the changes on the canvas (D)"
                    : "Draw what changed on the canvas, like a file diff (D)"
                }
              >
                <span className="br-count">
                  {diff.count
                    ? `${diff.count} change${diff.count === 1 ? "" : "s"}`
                    : "No changes yet"}
                </span>
                {diff.count > 0 && (
                  <span className="br-show">
                    {diff.on ? <EyeOff size={13} /> : <Eye size={13} />}
                    {diff.on ? "Hide diff" : "Show diff"}
                  </span>
                )}
              </button>
            )}
            {diff?.on && diff.changes.length > 0 && <ChangesList changes={diff.changes} />}
            {fork && fork.behind > 0 && (
              <div className="br-behind" data-tip="main has moved on since this fork started">
                ↓ main is {fork.behind} commit{fork.behind === 1 ? "" : "s"} ahead
              </div>
            )}
            {pr ? (
              <a
                className={`cta primary wide pr-${pr.state === "open" ? (pr.review ?? "open") : pr.state}`}
                href={pr.url}
                target="_blank"
                rel="noreferrer"
                data-tip="Open the pull request"
              >
                <GitPullRequestArrow size={14} /> PR #{pr.number} · {prState(pr)}{" "}
                <ExternalLink size={11} />
              </a>
            ) : !forge ? (
              <button
                className="cta primary wide"
                disabled={!!busy || !hasChanges}
                onClick={() => setAsk("merge")}
                data-tip={hasChanges ? "Put these changes on main" : "Change something first"}
              >
                <GitMerge size={14} /> Merge into main
              </button>
            ) : needsSignIn ? (
              <button
                className="cta primary wide"
                disabled={!!busy}
                onClick={() => void act("login", () => store.githubAction.login())}
                data-tip="Pull requests open as you"
              >
                Sign in to open a pull request
              </button>
            ) : (
              <button
                className="cta primary wide"
                disabled={!!busy || !hasChanges}
                onClick={openPr}
                data-tip={
                  hasChanges ? `Opens it on ${forge.name}, as you` : "Change something first"
                }
              >
                {busy === "pr" ? (
                  <LoaderCircle size={14} className="spin" />
                ) : (
                  <GitPullRequestArrow size={14} />
                )}{" "}
                Open pull request
              </button>
            )}
          </>
        ) : (
          <>
            <div className="br-cur-t">
              <span className="br-swatch" />
              <span className="br-cur-name">main</span>
              <span className="br-from">{repoName(git)}</span>
              <span className="grow" />
              {(!git.inBrowser || git.remote) && (
                <button
                  className="icon-btn"
                  data-tip={
                    git.inBrowser ? "Pull GitHub's changes into main" : "Sync with the repo now"
                  }
                  aria-label="Sync"
                  disabled={!!busy}
                  onClick={() => void act("sync", () => store.gitAction.sync())}
                >
                  <RefreshCw size={14} className={busy === "sync" || git.syncing ? "spin" : ""} />
                </button>
              )}
            </div>
            <p className="br-note">
              {git.inBrowser
                ? mainNote(git)
                : `Main mirrors the repo: editing it starts a fork. Synced ${ago(git.syncedAt)}.`}
              {git.inBrowser && git.remote ? ` Pulled ${ago(git.syncedAt)}.` : ""}
            </p>
            {git.inBrowser && git.error && <p className="br-note first-error">{git.error}</p>}
            {git.local && store.canEdit && (
              <button
                className="cta wide"
                disabled={forks.length > 0}
                onClick={onRepo}
                data-tip={
                  forks.length
                    ? "Merge or discard the forks first: they're branches in Archnemesis's own repo"
                    : "Push main and its history to a repo of yours"
                }
              >
                <Upload size={14} /> Push to a real repo…
              </button>
            )}
          </>
        )}
      </div>

      {/* The graph: main's lane, the forks curving off it, then main's history down its lane. */}
      <div className="br-sect">
        Branches
        <span className="grow" />
        <button
          disabled={!!busy || !store.canEdit}
          onClick={() => (setForkName(""), setAsk("fork"))}
          data-tip="Start a fork: a copy of main to change and share"
        >
          <Plus size={12} /> New fork
        </button>
      </div>
      <div className="br-graph">
        <GraphRow
          kind="main"
          color={MAIN}
          on={!store.branch}
          lane={forks.length > 0 || history.length > 0 ? "down" : "none"}
          name="main"
          meta={mainMeta(git)}
          tip={store.branch ? "Go to main" : "You're on main"}
          onClick={() => store.branch && goDoc(store.designKey)}
        />
        {forks.map((f, i) => (
          <GraphRow
            key={f.doc}
            kind="fork"
            color={f.doc === store.design ? HERE : QUIET}
            on={f.doc === store.design}
            lane={i < forks.length - 1 || history.length > 0 ? "through" : "end"}
            name={f.name}
            who={f.by ?? "someone"}
            meta={`${f.by ?? "someone"}${f.agent ? " (agent)" : ""} · ${ago(f.createdAt)}`}
            extra={
              <>
                <ForkIcons f={f} />
                {f.present > 0 && (
                  <span
                    className="br-here"
                    data-tip={`${f.present} ${f.present === 1 ? "person is" : "people are"} on it now`}
                  >
                    <Users size={11} /> {f.present}
                  </span>
                )}
              </>
            }
            tip={f.doc === store.design ? "You're on this fork" : `Switch to ${f.name}`}
            onClick={() => f.doc !== store.design && goDoc(f.doc)}
          />
        ))}
      </div>
      {/* main's history, down its lane: fills what's left of the panel, and scrolls there. */}
      <div className={`br-hist${history.length ? " lane" : ""}`}>
        <History size={12} /> History
        {past === null && <LoaderCircle size={12} className="spin" />}
      </div>
      <div className="br-history">
        {past?.length === 0 && <div className="br-note pad">No earlier versions.</div>}
        {history.map((v, i) => (
          <GraphRow
            key={v.sha}
            kind="commit"
            color={MAIN}
            on={store.past?.sha === v.sha}
            lane={i < history.length - 1 ? "through" : "end"}
            name={v.subject}
            meta={`${v.author} · ${new Date(v.date).toLocaleDateString(undefined, { month: "short", day: "numeric" })} · @${v.sha.slice(0, 7)}`}
            tip="Look at main as it was then (read-only)"
            onClick={() => void act("past", () => store.viewAt(v))}
          />
        ))}
      </div>

      {ask === "fork" && (
        <Dialog
          title="New fork"
          confirm="Create"
          busy={busy === "fork"}
          onCancel={() => setAsk(null)}
          onConfirm={() =>
            void act("fork", async () => {
              const r = await store.gitAction.fork(forkName.trim() || undefined);
              setAsk(null);
              carryToast(`On fork ${r.doc.split("@")[1]}`);
              goDoc(r.doc);
            })
          }
        >
          <p>A copy of main to change and share.</p>
          <input
            className="dialog-input"
            placeholder="Name (optional)"
            value={forkName}
            maxLength={40}
            onChange={(e) => setForkName(e.target.value)}
          />
        </Dialog>
      )}
      {ask === "discard" && (
        <Dialog
          title={`Discard ${store.branch}?`}
          confirm="Discard"
          tone="danger"
          busy={busy === "discard"}
          onCancel={() => setAsk(null)}
          onConfirm={() =>
            void act("discard", async () => {
              await store.gitAction.discard();
              setAsk(null);
            })
          }
        >
          <p>
            Its changes{fork?.head ? " and branch" : ""} are deleted. Anyone on it goes back to
            main.
          </p>
        </Dialog>
      )}
      {ask === "merge" && (
        <Dialog
          title={`Merge ${store.branch} into main?`}
          confirm="Merge"
          tone="danger"
          busy={busy === "merge"}
          onCancel={() => setAsk(null)}
          onConfirm={() =>
            void act("merge", async () => {
              const r = await store.gitAction.merge();
              setAsk(null);
              carryToast(r.result);
            })
          }
        >
          <p>
            {git.inBrowser
              ? "The fork's changes go onto main, together with anything changed on main since."
              : "This repo has no pull requests, so this goes straight to main without review."}
          </p>
        </Dialog>
      )}
    </div>
  );
}

const ROW = 44;
const COMMIT_ROW = 34;
const MX = 13; // main's lane
const FX = 31; // a fork's dot

/** One row of the graph: its piece of main's lane, a fork's curve off it, and its dot. */
function GraphRow(p: {
  kind: "main" | "fork" | "commit";
  color: string;
  on: boolean;
  /** Main's lane through this row: on down, through, ending here, or none. */
  lane: "down" | "through" | "end" | "none";
  name: string;
  meta: string;
  who?: string;
  extra?: React.ReactNode;
  tip: string;
  onClick: () => void;
}) {
  const h = p.kind === "commit" ? COMMIT_ROW : ROW;
  const mid = h / 2;
  const laneTop = p.lane === "down" ? mid : 0;
  const laneBottom = p.lane === "end" ? (p.kind === "fork" ? mid - 7 : mid) : h;
  return (
    <button
      className={`br-row ${p.kind}${p.on ? " on" : ""}`}
      style={{ "--lane": p.color, height: h } as React.CSSProperties}
      onClick={p.onClick}
      data-tip={p.tip}
    >
      <svg className="br-gutter" width={44} height={h} viewBox={`0 0 44 ${h}`} aria-hidden>
        {p.lane !== "none" && (
          <line
            x1={MX}
            x2={MX}
            y1={laneTop}
            y2={laneBottom}
            stroke={MAIN}
            strokeWidth={2}
            opacity={0.55}
          />
        )}
        {p.kind === "fork" && (
          <path
            d={`M${MX} ${mid - 7} Q ${MX} ${mid} ${MX + 7} ${mid} H ${FX - 6}`}
            stroke={p.color}
            strokeWidth={2}
            fill="none"
          />
        )}
        {p.kind === "main" && (
          <circle
            cx={MX}
            cy={mid}
            r={6.5}
            fill={p.on ? MAIN : "#161a21"}
            stroke={MAIN}
            strokeWidth={2.5}
          />
        )}
        {p.kind === "commit" && (
          <circle
            cx={MX}
            cy={mid}
            r={3.5}
            fill={p.on ? MAIN : "#161a21"}
            stroke={MAIN}
            strokeWidth={2}
          />
        )}
        {p.kind === "fork" && (
          <circle
            cx={FX}
            cy={mid}
            r={6}
            fill={p.on ? p.color : "#161a21"}
            stroke={p.color}
            strokeWidth={2.5}
          />
        )}
      </svg>
      <span className="br-text">
        <span className="br-name">
          <span className="br-label">{p.name}</span>
          {p.on && p.kind !== "commit" && <span className="br-you">you're here</span>}
          {p.extra}
        </span>
        <span className="br-meta">
          {p.who && (
            <span className="br-av" style={{ background: colorFor(p.who) }}>
              {p.who.slice(0, 1).toUpperCase()}
            </span>
          )}
          {p.meta}
        </span>
      </span>
    </button>
  );
}

/** The fork's changes against main, one row each: new, changed, deleted (still on main). */
function ChangesList({ changes }: { changes: Change[] }) {
  return (
    <div className="changes in-card">
      {changes.map((c) => (
        <button
          key={c.key}
          className={`change ${c.sign === "+" ? "add" : c.sign === "−" ? "del" : "mod"}`}
          onClick={c.go}
          data-tip={
            c.sign === "−"
              ? `${c.name}: deleted here, still on main`
              : c.sign === "+"
                ? `${c.name}: new`
                : `${c.name}: changed`
          }
        >
          <span className="change-sign">{c.sign}</span>
          <span className="change-name">{c.name}</span>
          {c.sign === "~" && (
            <span className="change-n">
              {!!c.plus && <b className="plus">+{c.plus}</b>}
              {!!c.minus && <b className="minus">−{c.minus}</b>}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
