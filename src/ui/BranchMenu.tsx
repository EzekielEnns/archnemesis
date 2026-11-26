// Top left, next to the design: which version of it you're looking at.
//
//   no git     a quiet branch icon: connect a repo
//   main       a commit-line icon and "main". main mirrors the repo, so your first edit
//              starts a fork (or joins the one you're on) and opens it
//   a fork     a branch icon and its name; a dot while edits wait to be saved, a spinner
//              while they're saved, then its pull
//              request's state, and how far behind main it is
//
// Getting a fork into main goes through a pull request: one click opens it (as you, with
// Archnemesis's GitHub App; otherwise the forge's prefilled page). Only a repo with no forge
// merges inside Archnemesis, behind a dialog. Starting and discarding a fork are dialogs too.
import {
  Save,
  ArrowDown,
  Check,
  Link as LinkIcon,
  ExternalLink,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequestArrow,
  GitPullRequestClosed,
  History,
  LoaderCircle,
  LogOut,
  Plus,
  RefreshCw,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  carryToast,
  goDoc,
  type ForkInfo,
  type GitInfo,
  type PullState,
  type RepoChoice,
  type BranchChoice,
} from "../route";
import type { Store } from "../store";
import { Dialog } from "./Dialog";

interface Props {
  store: Store;
  toast: (text: string, tone?: "info" | "error") => void;
}

/** Where the design's history lives and how it stands, as one icon and a sentence. */
/** Where the design is saved, as a save icon coloured by how far it's got: on the server only,
 *  in Archnemesis's own repo (not in a remote), saving, synced with a remote, or can't reach it. */
export function gitStatus(store: Store): {
  icon: ReactNode;
  tone: string;
  title: string;
  label: string;
} {
  const git = store.git;
  const fork = git?.forks.find((f) => f.doc === store.design);
  const icon = (cls = "") => <Save size={15} className={cls} />;
  if (!git)
    return {
      icon: icon(),
      tone: "server",
      label: "Not in git",
      title: "On the Archnemesis server only, not in git: no forks, diffs or history yet",
    };
  if (git.error)
    return {
      icon: icon(),
      tone: "bad",
      label: "Can't reach the repo",
      title: `${repoName(git)}: ${git.error}. Saved here; it pushes when it's back`,
    };
  if (git.inBrowser && !git.syncing)
    return {
      icon: icon(),
      tone: git.remote ? "ok" : "ahead",
      label: git.remote
        ? `Kept in this browser, forked from ${git.remote}`
        : "Kept in this browser",
      title: git.remote
        ? `Saved in this browser, with its forks and history. Forked from ${git.remote} on GitHub: pulled ${ago(git.syncedAt)}`
        : "Saved in this browser only, with its forks and history",
    };
  if (git.syncing || fork?.saving)
    return { icon: icon(), tone: "busy", label: "Syncing", title: `Saving to ${repoName(git)}…` };
  if (fork?.pending)
    return {
      icon: icon(),
      tone: "ahead",
      label: "Not saved to git yet",
      title: "Edits not on the fork's branch yet: they're saved a minute after they stop",
    };
  if (git.local)
    return {
      icon: icon(),
      tone: "ahead",
      label: "In Archnemesis's own repo",
      title: "In a git repo on the Archnemesis server, not pushed to a remote",
    };
  return {
    icon: icon(),
    tone: "ok",
    label: "Synced",
    title: `Synced with ${repoName(git)}${git.forge ? ` on ${git.forge.name}` : ""} · ${ago(git.syncedAt)}`,
  };
}

type Ask = "fork" | "discard" | "merge" | "forget" | null;
export type Act = (what: string, fn: () => Promise<unknown>) => Promise<boolean>;

export const ago = (iso: string | null) => {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 60
    ? "just now"
    : s < 3600
      ? `${Math.round(s / 60)}m ago`
      : s < 86400
        ? `${Math.round(s / 3600)}h ago`
        : `${Math.round(s / 86400)}d ago`;
};
const short = (sha: string | null) => sha?.slice(0, 7) ?? "";

/** The line under main: its latest version, and when it was last synced with the repo. */
export const mainMeta = (git: GitInfo) =>
  git.inBrowser && !git.remote
    ? `@${short(git.main)} · in this browser`
    : `@${short(git.main)} · synced ${ago(git.syncedAt)}`;

/** What main is, in a sentence: a mirror of a repo (edits fork), or yours to edit (in the browser). */
export const mainNote = (git: GitInfo) =>
  git.inBrowser
    ? "Main is yours to edit. Start a fork to try a change on the side, then merge it."
    : "Main mirrors the repo. Edit to start a fork.";

/** GitHub's mark (from Simple Icons, CC0); lucide has no brand icons. */
export function Github({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

/** The repo in a few words: "owner/name" on a forge, else the path's last part. */
export function repoName(git: GitInfo): string {
  if (git.inBrowser && !git.remote) return "This browser";
  if (git.forge) return git.forge.web.replace(/^https?:\/\/[^/]+\//, "");
  if (git.local) return "Local repo";
  return git.remote
    .replace(/\.git$/, "")
    .split(/[/:]/)
    .slice(-2)
    .join("/");
}

const PR_STATE: Record<string, string> = {
  open: "Open",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
  approved: "Approved",
  changes: "Changes requested",
};
export const prState = (pr: PullState) =>
  PR_STATE[pr.state === "open" && pr.review ? pr.review : pr.state] ?? pr.state;

/** A fork's state as small icons: saving, its pull request, behind main. Nothing when it's all quiet. */
export function ForkIcons({ f }: { f: ForkInfo }) {
  return (
    <>
      {f.saving ? (
        <span className="b-icon" title="Saving to its branch">
          <LoaderCircle size={12} className="spin" />
        </span>
      ) : f.pending ? (
        <span
          className="b-icon"
          title="Edits not on its branch yet: saved a minute after they stop"
        >
          <span className="unsaved-dot" />
        </span>
      ) : null}
      {f.pr && (
        <span
          className={`b-icon pr-${f.pr.state === "open" ? (f.pr.review ?? "open") : f.pr.state}`}
          title={`PR #${f.pr.number}: ${prState(f.pr)}`}
        >
          {f.pr.state === "closed" ? (
            <GitPullRequestClosed size={12} />
          ) : (
            <GitPullRequestArrow size={12} />
          )}
          {f.pr.review === "approved" && f.pr.state === "open" ? <Check size={10} /> : null}
        </span>
      )}
      {f.behind > 0 && (
        <span
          className="b-icon warn"
          title={`main is ${f.behind} commit${f.behind > 1 ? "s" : ""} ahead`}
        >
          <ArrowDown size={11} />
          {f.behind}
        </span>
      )}
    </>
  );
}

export function BranchMenu({ store, toast }: Props) {
  const [open, setOpen] = useState(false);
  const [ask, setAsk] = useState<Ask>(null);
  // Connecting a repo is a dialog: the first one, or a real one instead of the one on this
  // server (moving).
  const [connect, setConnect] = useState<null | "first" | "move">(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [forkName, setForkName] = useState("");
  // Main's earlier versions, read when "Look back" is opened.
  const [past, setPast] = useState<
    { sha: string; date: string; author: string; subject: string }[] | "loading" | null
  >(null);
  const loadPast = async () => {
    if (past !== null) return setPast(null);
    setPast("loading");
    setPast(await store.versions().catch(() => []));
  };
  const [at, setAt] = useState({ top: 0, left: 0 });
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const git = store.git;
  const fork = git?.forks.find((f) => f.doc === store.design) ?? null;
  const forge = git?.forge ?? null;

  useEffect(() => {
    if (!open) return;
    if (git) void store.refreshGit();
    const close = (e: PointerEvent) =>
      !ref.current?.contains(e.target as Node) &&
      !listRef.current?.contains(e.target as Node) &&
      setOpen(false);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /** Run a git action with a busy state; show what went wrong. True if it worked. */
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

  const openAsk = (a: Ask) => {
    setOpen(false);
    if (a === "fork") setForkName("");
    setAsk(a);
  };

  const copy = (text: string, what: string) =>
    void navigator.clipboard.writeText(text).then(
      () => toast(`${what} copied`),
      () => toast("Couldn't copy", "error"),
    );

  /** Open the fork's pull request: as you through the app, or the forge's prefilled page. */
  const openPr = () => {
    // Open the tab during the click: one opened after the request returns is a blocked popup.
    const tab = window.open("", "_blank");
    void act("pr", async () => {
      const r = await store.gitAction.propose();
      const url = r.pr?.url ?? r.url;
      if (!url) throw new Error("This repo has no pull requests");
      if (tab) tab.location.href = url;
      else window.location.assign(url);
      setOpen(false);
      toast(
        r.pr
          ? `Opened PR #${r.pr.number}`
          : `Finish the pull request on ${forge?.name ?? "the forge"}`,
      );
    }).then((ok) => {
      if (!ok) tab?.close();
    });
  };

  // The pill.
  let pill: ReactNode;
  let tone = "";
  if (!git) {
    pill = <GitBranch size={13} />;
    tone = "quiet";
  } else if (store.branch) {
    pill = (
      <>
        <GitBranch size={14} />
        {fork && <ForkIcons f={fork} />}
      </>
    );
    tone = "fork";
  } else {
    pill = <>{git.error ? <TriangleAlert size={13} /> : <GitCommitHorizontal size={15} />}</>;
    tone = git.error ? "bad" : "main";
  }

  const needsSignIn = !!git?.app?.installed && !store.github?.login;
  const hasChanges = !!fork && (fork.pending || !!fork.head);
  const pr = fork?.pr && fork.pr.state !== "closed" ? fork.pr : null;

  const row = (f: ForkInfo) => (
    <button
      key={f.doc}
      className={f.doc === store.design ? "design-row on" : "design-row"}
      onClick={() => (setOpen(false), goDoc(f.doc))}
    >
      <span className="design-name fork-row-name">
        <GitBranch size={12} /> {f.name}
        <ForkIcons f={f} />
      </span>
      <span className="design-meta">
        {f.by ?? "someone"}
        {f.agent ? " (agent)" : ""} · {ago(f.createdAt)}
        {f.head || f.base ? ` · @${short(f.head ?? f.base)}` : ""}
        {f.present ? ` · ${f.present} here` : ""}
      </span>
    </button>
  );

  return (
    <div className="branch-menu" ref={ref}>
      <button
        className={`branch-pill ${tone}`}
        onClick={(e) => {
          if (!git) return setConnect("first");
          const r = e.currentTarget.getBoundingClientRect();
          setAt({ top: r.bottom + 14, left: r.left - 12 });
          setOpen(!open);
        }}
        title={
          !git
            ? "Connect a git repo"
            : store.branch
              ? `Fork ${store.branch}`
              : `main of ${repoName(git)}`
        }
      >
        {pill}
      </button>
      {open &&
        createPortal(
          <div className="design-list branch-list island" style={at} ref={listRef}>
            {!git ? null : (
              <>
                <div className="branch-head">
                  {forge ? (
                    <a
                      className="branch-repo"
                      href={forge.web}
                      target="_blank"
                      rel="noreferrer"
                      title={`Open on ${forge.name}`}
                    >
                      {forge.kind === "github" ? <Github size={14} /> : <FolderGit2 size={14} />}
                      <span>{repoName(git)}</span>
                      <ExternalLink size={11} className="b-muted" />
                    </a>
                  ) : (
                    <span
                      className="branch-repo"
                      title={git.local ? "A repo on the Archnemesis server" : git.remote}
                    >
                      <FolderGit2 size={14} />
                      <span>{repoName(git)}</span>
                    </span>
                  )}
                  <div className="design-meta">
                    {git.path ? `${git.path}/ · ` : ""}
                    {store.branch
                      ? `fork of main @${short(fork?.base ?? null)}`
                      : `main ${mainMeta(git)}`}
                  </div>
                  {git.error && <div className="design-error">{git.error}</div>}
                  {git.local && !store.branch && store.canEdit && (
                    <button
                      className="branch-move"
                      disabled={git.forks.length > 0}
                      title={
                        git.forks.length
                          ? "Merge or discard the forks first: they're branches in the repo on this server"
                          : "Move this design to a repo on GitHub (or anywhere git reaches)"
                      }
                      onClick={() => (setOpen(false), setConnect("move"))}
                    >
                      <Github size={13} /> Connect a real repo…
                    </button>
                  )}
                </div>

                {store.branch ? (
                  <div className="branch-cta">
                    {pr ? (
                      <a
                        className={`cta primary pr-${pr.state === "open" ? (pr.review ?? "open") : pr.state}`}
                        href={pr.url}
                        target="_blank"
                        rel="noreferrer"
                        onClick={() => setOpen(false)}
                      >
                        <GitPullRequestArrow size={14} /> PR #{pr.number} · {prState(pr)}
                        <ExternalLink size={11} />
                      </a>
                    ) : !forge ? (
                      <button
                        className="cta primary"
                        disabled={!!busy || !hasChanges}
                        onClick={() => openAsk("merge")}
                      >
                        <GitMerge size={14} /> {hasChanges ? "Merge into main…" : "No changes yet"}
                      </button>
                    ) : needsSignIn ? (
                      <button
                        className="cta primary"
                        disabled={!!busy}
                        onClick={() => void act("login", () => store.githubAction.login())}
                      >
                        <Github size={14} /> Sign in to open a PR
                      </button>
                    ) : (
                      <button
                        className="cta primary"
                        disabled={!!busy || !hasChanges}
                        onClick={openPr}
                        title={hasChanges ? "Opens it on GitHub, as you" : "Edit the fork first"}
                      >
                        {busy === "pr" ? (
                          <LoaderCircle size={14} className="spin" />
                        ) : (
                          <GitPullRequestArrow size={14} />
                        )}
                        {hasChanges ? "Open pull request" : "No changes yet"}
                      </button>
                    )}
                    <button
                      className="cta"
                      title="Copy a link to this fork, to share"
                      onClick={() => copy(location.href, "Link to fork")}
                    >
                      <LinkIcon size={14} /> Share
                    </button>
                  </div>
                ) : (
                  <div className="branch-note pad">{mainNote(git)}</div>
                )}

                <div className="branch-section">Versions</div>
                <button
                  className={store.branch ? "design-row" : "design-row on"}
                  onClick={() => (setOpen(false), store.branch && goDoc(store.designKey))}
                >
                  <span className="design-name fork-row-name">
                    <GitCommitHorizontal size={13} /> main
                  </span>
                  <span className="design-meta">{mainMeta(git)}</span>
                </button>
                {git.forks.map(row)}
                <button
                  className="design-row action"
                  disabled={!!busy}
                  onClick={() => openAsk("fork")}
                >
                  <Plus size={14} /> New fork
                </button>

                <button
                  className="branch-section as-button"
                  onClick={() => void loadPast()}
                  aria-expanded={past !== null}
                >
                  <History size={12} /> Look back {past === null ? "" : "▾"}
                </button>
                {past === "loading" && (
                  <div className="branch-note pad">Reading the repo's history…</div>
                )}
                {Array.isArray(past) && !past.length && (
                  <div className="branch-note pad">No earlier versions.</div>
                )}
                {Array.isArray(past) &&
                  past.slice(0, 20).map((v) => (
                    <button
                      key={v.sha}
                      className={store.past?.sha === v.sha ? "design-row on" : "design-row"}
                      title={`${v.subject}\n${v.author}, ${new Date(v.date).toLocaleString()}`}
                      onClick={() =>
                        void act("past", async () => {
                          await store.viewAt(v);
                          setOpen(false);
                        })
                      }
                    >
                      <span className="design-name fork-row-name past-subject">{v.subject}</span>
                      <span className="design-meta">
                        {new Date(v.date).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                        })}{" "}
                        · @{v.sha.slice(0, 7)}
                      </span>
                    </button>
                  ))}

                <div className="branch-foot">
                  <GitHubLine store={store} app={git.app} act={act} busy={busy} />
                  <span className="branch-foot-actions">
                    {(!git.inBrowser || git.remote) && (
                      <button
                        className="icon-btn"
                        title="Sync with the repo"
                        disabled={!!busy}
                        onClick={() => void act("sync", () => store.gitAction.sync())}
                      >
                        <RefreshCw
                          size={13}
                          className={busy === "sync" || git.syncing ? "spin" : ""}
                        />
                      </button>
                    )}
                    {store.branch && (
                      <button
                        className="icon-btn danger"
                        title="Discard fork"
                        disabled={!!busy}
                        onClick={() => openAsk("discard")}
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </span>
                </div>
              </>
            )}
          </div>,
          document.body,
        )}

      {connect && (
        <Dialog
          title={connect === "move" ? "Move to a real repo" : "Connect a git repo"}
          onCancel={() => setConnect(null)}
        >
          <div className="connect-repo">
            <FollowForm
              store={store}
              moving={connect === "move"}
              busy={busy}
              act={act}
              onDone={() => setConnect(null)}
              onForget={() => (setAsk("forget"), setConnect(null))}
              toast={toast}
            />
          </div>
        </Dialog>
      )}
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

      {ask === "forget" && (
        <Dialog
          title="Forget the GitHub app?"
          confirm="Forget it"
          tone="danger"
          busy={busy === "disconnect"}
          onCancel={() => setAsk(null)}
          onConfirm={() =>
            void act("disconnect", async () => {
              await store.githubAction.disconnect();
              setAsk(null);
            })
          }
        >
          <p>
            Archnemesis lets go of its GitHub app and signs everyone out of GitHub. Connecting
            GitHub again sets up a new one; the old app stays on GitHub until you delete it there.
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
            {git?.inBrowser
              ? "The fork's changes go onto main, together with anything changed on main since."
              : "This repo has no pull requests, so this goes straight to main without review."}
          </p>
        </Dialog>
      )}
    </div>
  );
}

export function FollowForm(p: {
  store: Store;
  moving?: boolean;
  busy: string | null;
  act: Act;
  onDone: () => void;
  onForget: () => void;
  toast: (text: string, tone?: "info" | "error") => void;
}) {
  const [remote, setRemote] = useState("");
  const [path, setPath] = useState("");
  const [branch, setBranch] = useState("");
  // Whether Archnemesis is connected to GitHub yet: following a private repo needs that first.
  useEffect(() => {
    if (!p.store.github) void p.store.refreshGitHub();
  }, [p.store]);
  const gh = p.store.github;
  // The repos Archnemesis's app is on: pick one instead of pasting a URL.
  const [repos, setRepos] = useState<RepoChoice[] | null>(null);
  const configured = !!gh?.configured;
  useEffect(() => {
    if (!configured) return;
    const load = () => void p.store.githubRepos().then(setRepos);
    load();
    // Back from installing on GitHub (another tab): look again.
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [p.store, configured]);
  // A picked repo: its branches, and where their designs are. Pick one and go.
  const picked = repos?.find((r) => r.url === remote) ?? null;
  const [branches, setBranches] = useState<BranchChoice[] | null>(null);
  const [branchError, setBranchError] = useState<string | null>(null);
  // "d:<branch>\n<folder>" a design that's there · "add:<branch>" put one on it (admins) · "new"
  const [choice, setChoice] = useState("");
  const [newBranch, setNewBranch] = useState("archnm");
  const [newFolder, setNewFolder] = useState("archnm");
  useEffect(() => {
    setBranches(null);
    setBranchError(null);
    setChoice("");
    if (!picked) return;
    let live = true;
    void p.store.githubBranches(picked.name).then((r) => {
      if (!live) return;
      if ("error" in r) return setBranchError(r.error);
      setBranches(r.list);
      const first = r.list.find((b) => b.designs.length);
      setChoice(first ? `d:${first.name}\n${first.designs[0]}` : "new");
    });
    return () => {
      live = false;
    };
  }, [p.store, picked?.name]);
  const follow = (o: {
    remote?: string;
    path?: string;
    branch?: string;
    local?: boolean;
    addHere?: boolean;
  }) =>
    void p.act("follow", async () => {
      await p.store.gitAction.follow(o);
      p.onDone();
      p.toast("Connected. Edits now go to forks.");
    });
  return (
    <form
      className="branch-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (picked) {
          if (choice.startsWith("d:")) {
            const [b, folder] = choice.slice(2).split("\n");
            follow({ remote, branch: b, path: folder ?? "" });
          } else if (choice.startsWith("add:"))
            follow({ remote, branch: choice.slice(4), path: newFolder.trim(), addHere: true });
          else if (choice === "new" && newBranch.trim())
            follow({ remote, branch: newBranch.trim(), path: newFolder.trim() });
        } else if (remote.trim())
          follow({ remote: remote.trim(), path: path.trim(), branch: branch.trim() || undefined });
      }}
    >
      <p className="branch-note">
        {p.moving ? "Its main and history move to the repo you pick. " : ""}Main mirrors the repo.
        Edits go to forks, which become pull requests.
      </p>
      {gh?.configured && gh.installUrl && (
        <>
          {repos?.length ? (
            <select
              className="design-input"
              value={repos.find((r) => r.url === remote)?.url ?? ""}
              onChange={(e) => setRemote(e.target.value)}
              aria-label="Repo"
            >
              <option value="">Pick a repo…</option>
              {repos.map((r) => (
                <option key={r.url} value={r.url}>
                  {r.name}
                  {r.private ? " (private)" : ""}
                </option>
              ))}
            </select>
          ) : (
            <p className="branch-note">
              Connect GitHub to pick a repo: GitHub asks which account or org, and which repos
              Archnemesis may use.
            </p>
          )}
          <div className="gh-row">
            <a className="branch-gh" href={gh.installUrl} target="_blank" rel="noreferrer">
              <Github size={12} /> {repos?.length ? "Add repos on GitHub" : "Connect GitHub"}
            </a>
            {gh.login ? (
              <span className="branch-gh signed">
                <Github size={12} /> @{gh.login}
              </span>
            ) : (
              <button
                type="button"
                className="branch-gh"
                disabled={!!p.busy}
                onClick={() => void p.act("login", () => p.store.githubAction.login())}
                title="Pull requests open under your name"
              >
                Sign in with GitHub
              </button>
            )}
          </div>
          {p.store.isAdmin && !gh.fixed && (
            <p className="branch-note">
              Wrong app, or deleted on GitHub?{" "}
              <button type="button" className="branch-gh" disabled={!!p.busy} onClick={p.onForget}>
                Forget it
              </button>
            </p>
          )}
        </>
      )}
      {gh && !gh.configured && p.store.isAdmin && (
        <>
          <p className="branch-note">
            Connect GitHub to pick one of your repos, private ones included. GitHub asks you to
            confirm once, then which repos Archnemesis may use, and brings you back here.
          </p>
          <button
            type="button"
            className="cta gh-connect"
            disabled={!!p.busy}
            onClick={() => void p.act("setup", () => p.store.githubAction.setup())}
          >
            <Github size={14} /> Connect a GitHub repo
          </button>
        </>
      )}
      {gh && !gh.configured && !p.store.isAdmin && (
        <p className="branch-note">
          For a private GitHub repo, an admin sets Archnemesis up with GitHub first.
        </p>
      )}
      <input
        className="design-input"
        placeholder={
          repos?.length
            ? "…or paste any git URL"
            : "…or paste any git URL (git@github.com:you/designs.git)"
        }
        value={repos?.some((r) => r.url === remote) ? "" : remote}
        onChange={(e) => setRemote(e.target.value)}
      />
      {picked ? (
        <>
          {branchError && <p className="branch-note first-error">{branchError}</p>}
          {!branches && !branchError && (
            <p className="branch-note">
              <LoaderCircle size={12} className="spin" /> Reading {picked.name}'s branches…
            </p>
          )}
          {branches && (
            <select
              className="design-input"
              value={choice}
              onChange={(e) => setChoice(e.target.value)}
              aria-label="Branch"
            >
              {branches.flatMap((b) =>
                b.designs.map((f) => (
                  <option key={`d:${b.name}\n${f}`} value={`d:${b.name}\n${f}`}>
                    {b.name} · design in {f ? `${f}/` : "the root"}
                  </option>
                )),
              )}
              <option value="new">New branch… (start a design there)</option>
              {branches
                .filter((b) => !b.designs.length)
                .map((b) =>
                  p.store.isAdmin ? (
                    <option key={`add:${b.name}`} value={`add:${b.name}`}>
                      {b.name} · no design: add one here (admin)
                    </option>
                  ) : (
                    <option key={`no:${b.name}`} value={`no:${b.name}`} disabled>
                      {b.name} · no design
                    </option>
                  ),
                )}
            </select>
          )}
          {choice === "new" && (
            <div className="gh-setup">
              <input
                className="design-input"
                placeholder="New branch name"
                value={newBranch}
                onChange={(e) => setNewBranch(e.target.value)}
                aria-label="New branch"
              />
              <input
                className="design-input"
                placeholder="Folder (blank: root)"
                value={newFolder}
                onChange={(e) => setNewFolder(e.target.value)}
                aria-label="Folder"
              />
            </div>
          )}
          {choice.startsWith("add:") && (
            <>
              <input
                className="design-input"
                placeholder="Folder (blank: root)"
                value={newFolder}
                onChange={(e) => setNewFolder(e.target.value)}
                aria-label="Folder"
              />
              <p className="branch-note">
                This commits a new design onto {choice.slice(4)}, a branch people already use.
              </p>
            </>
          )}
        </>
      ) : (
        <>
          <input
            className="design-input"
            placeholder="Folder in the repo (optional)"
            value={path}
            onChange={(e) => setPath(e.target.value)}
          />
          <input
            className="design-input"
            placeholder="Branch (blank: main; a new name starts a design there)"
            title="Archnemesis follows this branch. If the repo has no design yet, name a new branch: Archnemesis starts it there and never touches main."
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
          />
        </>
      )}
      <div className="branch-form-row">
        <button
          type="submit"
          className="primary"
          disabled={
            !remote.trim() ||
            !!p.busy ||
            (!!picked && (!branches || !choice || choice.startsWith("no:")))
          }
        >
          {p.busy === "follow" ? <LoaderCircle size={14} className="spin" /> : null} Connect
        </button>
        {p.store.isAdmin && p.store.localRepos && !p.moving && (
          <button
            type="button"
            disabled={!!p.busy}
            onClick={() => follow({ local: true })}
            title="A repo on the Archnemesis server, to try it out"
          >
            New local repo
          </button>
        )}
      </div>
    </form>
  );
}

/** The one GitHub step that's missing, or who you're signed in as: a quiet line in the footer. */
function GitHubLine(p: { store: Store; app: GitInfo["app"]; act: Act; busy: string | null }) {
  if (!p.app) return <span />;
  const gh = p.store.github;
  if (!p.app.configured)
    return (
      <button
        className="branch-gh"
        disabled={!!p.busy}
        title="Lets Archnemesis open pull requests as you"
        onClick={() => void p.act("setup", () => p.store.githubAction.setup())}
      >
        <Github size={12} /> Connect GitHub
      </button>
    );
  if (!p.app.installed)
    return p.app.installUrl ? (
      <a
        className="branch-gh"
        href={p.app.installUrl}
        target="_blank"
        rel="noreferrer"
        title="Install Archnemesis's GitHub App on this repo"
      >
        <Github size={12} /> Install app
      </a>
    ) : (
      <span />
    );
  if (!gh?.login)
    return (
      <button
        className="branch-gh"
        disabled={!!p.busy}
        onClick={() => void p.act("login", () => p.store.githubAction.login())}
      >
        <Github size={12} /> Sign in
      </button>
    );
  return (
    <span className="branch-gh signed">
      <Github size={12} /> @{gh.login}
      <button
        className="icon-btn tiny"
        title="Sign out of GitHub"
        onClick={() => void p.act("logout", () => p.store.githubAction.logout())}
      >
        <LogOut size={11} />
      </button>
    </span>
  );
}
