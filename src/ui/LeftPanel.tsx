// The left panel in simple mode: for finding your way around the design, not for editing.
//
//   head   the branch you're on (opens the branches view) and a save icon for where the
//          design is saved (opens Settings → Repo & git); the settings cog on the right
//   tools  the tree, just the code, or branches; what's new on this fork; search
//   body   the model tree (Sidebar's, in its panel form), or the branches
//
// Settings, the repo and the account are one dialog off the cog, not more chrome.
import {
  ArrowDown,
  ArrowRight,
  Code,
  CloudOff,
  Eye,
  History,
  GitBranch,
  ListTree,
  LoaderCircle,
  Pin,
  PinOff,
  Search,
  Settings,
  X,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { ArrowStyle } from "../../shared/model";
import type { Store } from "../store";
import { FollowForm, gitStatus, Github, repoName, type Act } from "./BranchMenu";
import { PanelBranchHead } from "./Branches";
import { BrowserRepoPane } from "./BrowserRepo";
import { backend } from "../backend";
import { DesignMenu } from "./DesignMenu";
import { Dialog } from "./Dialog";
import { ShareDialog } from "./ShareDialog";
import { AccountFields } from "./Peers";

export type PanelView = "tree" | "code" | "branches";

interface HeadProps {
  store: Store;
  toast: (text: string, tone?: "info" | "error") => void;
  view: PanelView;
  onView: (v: PanelView) => void;
  /** The design has code (modules, functions): offer the code-only tree. */
  hasCode: boolean;
  onSearch: () => void;
  onSettings: (section?: SettingsSection) => void;
  /** Pinned, it stays open while you work on the canvas; otherwise it hides at the first click there. */
  pinned: boolean;
  onPin: () => void;
  onClose: () => void;
}

export function PanelHead(p: HeadProps) {
  const conn = p.store.connectivity;
  return (
    <div className="panel-head">
      <div className="panel-top">
        {backend.git ? (
          <PanelBranchHead store={p.store} onRepo={() => p.onSettings("repo")} />
        ) : (
          <span className="grow" />
        )}
        {/* Only said when something's wrong: live is the normal state. */}
        {conn !== "live" && conn !== "loading" && (
          <span
            className={`icon-btn conn ${conn}`}
            data-tip={
              conn === "offline"
                ? "Can't reach the server; edits wait and sync when it's back"
                : "Connecting…"
            }
          >
            {conn === "offline" ? (
              <CloudOff size={15} />
            ) : (
              <LoaderCircle size={15} className="spin" />
            )}
          </span>
        )}
        {/* An old version is read-only because it is old, not because of who you are. */}
        {p.store.past ? (
          <button
            className="icon-btn conn past"
            data-tip="You're looking at an old version, which can't be edited. Click to go back to now."
            onClick={() => p.store.backToNow()}
          >
            <History size={15} />
          </button>
        ) : (
          !p.store.canEdit && (
            <span
              className="icon-btn conn"
              data-tip="View only: you can look around, but not change this design"
            >
              <Eye size={15} />
            </span>
          )
        )}
        <button
          className="icon-btn"
          data-tip="Settings: the repo, your account, the canvas, layout and arrows"
          onClick={() => p.onSettings()}
        >
          <Settings size={15} />
        </button>
      </div>
      <div className="panel-tools">
        <button
          className={`icon-btn ${p.view === "tree" ? "on" : ""}`}
          data-tip="Tree: everything in the design, folder by folder"
          onClick={() => p.onView("tree")}
        >
          <ListTree size={15} />
        </button>
        {p.hasCode && (
          <button
            className={`icon-btn ${p.view === "code" ? "on" : ""}`}
            data-tip="Code: just the files and functions"
            onClick={() => p.onView("code")}
          >
            <Code size={15} />
          </button>
        )}
        {backend.git && (
          <button
            className={`icon-btn ${p.view === "branches" ? "on" : ""}`}
            data-tip="Branches: main, its forks, and its history"
            onClick={() => p.onView("branches")}
          >
            <GitBranch size={15} />
          </button>
        )}
        <span className="grow" />
        <button
          className="icon-btn"
          data-tip="Find anything, or run a command (⌘K)"
          onClick={p.onSearch}
        >
          <Search size={15} />
        </button>
        <button
          className={`icon-btn ${p.pinned ? "on" : ""}`}
          data-tip={p.pinned ? "Unpin: it closes when you click away" : "Pin: keep it open"}
          onClick={p.onPin}
        >
          {p.pinned ? <PinOff size={14} /> : <Pin size={14} />}
        </button>
        <button className="icon-btn" data-tip="Hide the panel ([)" onClick={p.onClose}>
          <X size={15} />
        </button>
      </div>
    </div>
  );
}

const ROUTE_EXAMPLE = `# Called for every arrow: return the points it goes through.
def route(edge, src, dst, boxes):
    if edge.tech == "HTTP":
        return elbow(src.right, dst.left)
    return curve(src, dst, bend=0.3)`;

export type SettingsSection = "general" | "repo" | "account" | "canvas" | "layout" | "arrows";
const SECTIONS: [SettingsSection, string][] = [
  ["general", "General"],
  ["repo", "Repo & git"],
  ["account", "Account"],
  ["canvas", "Canvas"],
  ["layout", "Layout & tidy"],
  ["arrows", "Arrows"],
];

interface SettingsProps {
  store: Store;
  toast: (text: string, tone?: "info" | "error") => void;
  design: { key: string; name: string };
  section: SettingsSection;
  onSection: (s: SettingsSection) => void;
  canvas: { label: string; hint?: string; on: boolean; flip: () => void }[];
  /** The open view's layout: lay it out once, or keep it tidy as things change. */
  layout: {
    view: string;
    keep: "right" | "down" | null;
    onLayout: (dir: "right" | "down") => void;
    onKeep: (dir: "right" | "down" | null) => void;
    onTidyAll: () => void;
  } | null;
  /** The open view's arrows. */
  arrows: {
    view: string;
    style: ArrowStyle;
    onStyle: (s: ArrowStyle) => void;
    shaped: number;
    onReset: () => void;
  } | null;
  onClose: () => void;
}

const Switch = ({ on, flip, label }: { on: boolean; flip: () => void; label: string }) => (
  <button
    role="switch"
    aria-checked={on}
    aria-label={label}
    className={`switch${on ? " on" : ""}`}
    onClick={flip}
  />
);
const Row = ({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: ReactNode;
  children?: ReactNode;
}) => (
  <div className="set-row">
    <div className="grow">
      {title}
      {hint && <small>{hint}</small>}
    </div>
    {children}
  </div>
);

/** Settings off the cog: sections down the left, like an app's preferences. */
export function SettingsDialog(p: SettingsProps) {
  const [, bump] = useState(0);
  const [sharing, setSharing] = useState(false);
  const flip = (f: () => void) => () => (f(), bump((n) => n + 1));
  return (
    <Dialog title="Settings" bare onCancel={p.onClose}>
      <div className="prefs">
        <nav className="prefs-nav">
          <div className="prefs-h">Settings</div>
          {SECTIONS.filter(([k]) => k !== "repo" || backend.git).map(([k, label]) => (
            <button key={k} className={p.section === k ? "on" : ""} onClick={() => p.onSection(k)}>
              {label}
            </button>
          ))}
        </nav>
        <div className="prefs-pane">
          {p.section === "general" && (
            <>
              <button className="icon-btn prefs-close" title="Close (Esc)" onClick={p.onClose}>
                <X size={15} />
              </button>
              <h2>General</h2>
              <p className="prefs-sub">This design.</p>
              <Row
                title="Design"
                hint={p.store.canEdit ? "Switch designs, or start one" : "View only"}
              >
                <DesignMenu
                  design={p.design.key}
                  name={p.design.name}
                  isAdmin={p.store.isAdmin}
                  label
                />
              </Row>
              {backend.links && p.store.can.manage && (
                <Row title="Share" hint="With the team, or by a link people can open">
                  <button className="share-btn" onClick={() => setSharing(true)}>
                    Share…
                  </button>
                </Row>
              )}
              {sharing && (
                <ShareDialog
                  doc={p.store.design}
                  name={p.design.name}
                  onClose={() => setSharing(false)}
                />
              )}
              <Row title="Keyboard shortcuts" hint="Press ? anywhere" />
              <Row
                title="Export"
                hint="⌘K → “Export”: the diagram as a PNG, or the model as JSON"
              />
            </>
          )}
          {p.section === "repo" &&
            (backend.git?.inBrowser ? (
              <BrowserRepoPane store={p.store} toast={p.toast} />
            ) : (
              <RepoPane store={p.store} toast={p.toast} />
            ))}
          {p.section === "account" && (
            <>
              <h2>Account</h2>
              <p className="prefs-sub">Who you are here.</p>
              <AccountFields store={p.store} />
            </>
          )}
          {p.section === "canvas" && (
            <>
              <h2>Canvas</h2>
              <p className="prefs-sub">How the canvas behaves, on this machine.</p>
              {p.canvas.map((t) => (
                <Row key={t.label} title={t.label} hint={t.hint}>
                  <Switch on={t.on} flip={flip(t.flip)} label={t.label} />
                </Row>
              ))}
            </>
          )}
          {p.section === "layout" && (
            <>
              <h2>Layout &amp; tidy</h2>
              <p className="prefs-sub">
                {p.layout
                  ? `Laying out ${p.layout.view}, for everyone. ⌘Z undoes it.`
                  : "Open a view to lay it out."}
              </p>
              {p.layout && (
                <>
                  <Row title="Lay it out now" hint="Callers first, then what they call">
                    <span className="seg">
                      <button onClick={() => p.layout!.onLayout("right")}>
                        <ArrowRight size={13} /> Across
                      </button>
                      <button onClick={() => p.layout!.onLayout("down")}>
                        <ArrowDown size={13} /> Down
                      </button>
                    </span>
                  </Row>
                  <Row title="Keep it tidy" hint="Lays itself out when boxes or arrows come or go">
                    <span className="seg">
                      {([null, "right", "down"] as const).map((d) => (
                        <button
                          key={d ?? "off"}
                          className={p.layout!.keep === d ? "on" : ""}
                          onClick={() => p.layout!.onKeep(d)}
                        >
                          {d === null ? "Off" : d === "right" ? "Across" : "Down"}
                        </button>
                      ))}
                    </span>
                  </Row>
                  <Row
                    title="Tidy every view"
                    hint="Lays out all of them, each its own way (across unless it says down)"
                  >
                    <button className="cta" onClick={p.layout.onTidyAll}>
                      Tidy everything
                    </button>
                  </Row>
                </>
              )}
            </>
          )}
          {p.section === "arrows" && (
            <>
              <h2>Arrows</h2>
              <p className="prefs-sub">
                {p.arrows
                  ? `How lines are drawn on ${p.arrows.view}, for everyone.`
                  : "Open a view to set its arrows."}
              </p>
              {p.arrows && (
                <>
                  <Row title="Style">
                    <span className="seg">
                      {(["curved", "elbow", "straight"] as const).map((st) => (
                        <button
                          key={st}
                          className={p.arrows!.style === st ? "on" : ""}
                          onClick={() => p.arrows!.onStyle(st)}
                        >
                          {st[0]!.toUpperCase() + st.slice(1)}
                        </button>
                      ))}
                    </span>
                  </Row>
                  <Row
                    title="Hand-bent arrows"
                    hint={
                      p.arrows.shaped
                        ? `${p.arrows.shaped} on this view keep the joints you dragged`
                        : "None on this view"
                    }
                  >
                    <button className="cta" disabled={!p.arrows.shaped} onClick={p.arrows.onReset}>
                      Reset joints
                    </button>
                  </Row>
                </>
              )}
              <div className="set-later">
                <div className="set-later-h">
                  Your own routing <span className="soon">later</span>
                </div>
                <pre className="code-preview">{ROUTE_EXAMPLE}</pre>
                <small>
                  A function in the repo that decides how arrows run and how tidy lays things out,
                  so everyone sees the same lines.
                </small>
              </div>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}

/** Where the design is saved, connecting a repo (or moving to a real one), and GitHub. */
function RepoPane({
  store,
  toast,
}: {
  store: Store;
  toast: (text: string, tone?: "info" | "error") => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [forget, setForget] = useState(false);
  const [, bump] = useState(0);
  useEffect(() => {
    void store.refreshGitHub().then(() => bump((n) => n + 1));
  }, [store]);
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
      bump((n) => n + 1);
    }
  };
  const git = store.git;
  const status = gitStatus(store);
  const gh = store.github;
  const canMove = !git || (git.local && !git.forks.length);
  return (
    <>
      <h2>Repo &amp; git</h2>
      <p className="prefs-sub">
        Where this design is saved. In git, it gets forks, diffs and history.
      </p>
      <div className="set-row">
        <span className={`git-status big ${status.tone}`}>{status.icon}</span>
        <div className="grow">
          {git ? (git.local ? "Archnemesis's own repo" : repoName(git)) : "Not in git"}
          <small>{status.title}</small>
        </div>
        {git?.forge && (
          <a className="cta" href={git.forge.web} target="_blank" rel="noreferrer">
            Open on {git.forge.name}
          </a>
        )}
      </div>
      {git?.path && <Row title="Folder in the repo" hint={`${git.path}/`} />}
      {store.canEdit && (
        <Row
          title={git ? "Move to a real repo" : "Connect a repo"}
          hint={
            !canMove
              ? "Merge or discard the forks first: they're branches in Archnemesis's own repo"
              : git
                ? "Push main and its history to a repo of yours: GitHub, GitLab, any git URL"
                : "GitHub, GitLab, Gitea, any git URL"
          }
        >
          {canMove && !connecting && (
            <button className="cta" onClick={() => setConnecting(true)}>
              <GitBranch size={14} /> {git ? "Move to a repo…" : "Connect a repo…"}
            </button>
          )}
        </Row>
      )}
      {connecting && canMove && (
        <div className="connect-repo inline">
          <FollowForm
            store={store}
            moving={!!git}
            busy={busy}
            act={act}
            onDone={() => setConnecting(false)}
            onForget={() => setForget(true)}
            toast={toast}
          />
        </div>
      )}
      {gh?.configured && (
        <Row
          title="GitHub"
          hint={
            gh.login
              ? `@${gh.login}: pull requests open as you`
              : "Only needed to push to GitHub and open pull requests"
          }
        >
          {gh.login ? (
            <button
              className="cta"
              disabled={!!busy}
              onClick={() => void act("logout", () => store.githubAction.logout())}
            >
              Sign out of GitHub
            </button>
          ) : (
            <button
              className="cta"
              disabled={!!busy}
              onClick={() => void act("login", () => store.githubAction.login())}
            >
              <Github size={14} /> Sign in with GitHub
            </button>
          )}
        </Row>
      )}
      {forget && (
        <Dialog
          title="Forget the GitHub app?"
          confirm="Forget it"
          tone="danger"
          busy={busy === "disconnect"}
          onCancel={() => setForget(false)}
          onConfirm={() =>
            void act("disconnect", () => store.githubAction.disconnect()).then(() =>
              setForget(false),
            )
          }
        >
          <p>
            Archnemesis lets go of its GitHub app and signs everyone out of GitHub. Connecting
            GitHub again sets up a new one; the old app stays on GitHub until you delete it there.
          </p>
        </Dialog>
      )}
    </>
  );
}
