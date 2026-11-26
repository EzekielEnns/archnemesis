// Settings → Repo & git where the design is kept in this browser (the static build): where it's
// saved, and, for a design forked off a public GitHub repository, where it came from and a way
// to pull that repository's changes. Forks, diffs and history need nothing from here.
import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { Store } from "../store";
import { ago, gitStatus, repoName, type Act } from "./BranchMenu";

type Toast = (text: string, tone?: "info" | "error") => void;

export function BrowserRepoPane({ store, toast }: { store: Store; toast: Toast }) {
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => void store.refreshGit(), [store]);
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
  const git = store.git;
  const status = gitStatus(store);
  return (
    <>
      <h2>Repo &amp; git</h2>
      <p className="prefs-sub">
        This design is kept in this browser, with its forks and history. Nothing leaves it.
      </p>
      <div className="set-row">
        <span className={`git-status big ${status.tone}`}>{status.icon}</span>
        <div className="grow">
          {git ? repoName(git) : "This browser"}
          <small>{status.title}</small>
        </div>
        {git?.remote && (
          <a
            className="cta"
            href={`https://github.com/${git.remote}`}
            target="_blank"
            rel="noreferrer"
          >
            Open on GitHub
          </a>
        )}
      </div>
      {git?.remote && (
        <div className="set-row">
          <div className="grow">
            Forked from {git.remote}
            {git.branch === "main" ? "" : `@${git.branch}`}
            {git.path ? ` · ${git.path}/` : ""}
            <small>
              Pulled {ago(git.syncedAt)}. Pulling reads the public repository again and brings its
              changes into main.
            </small>
          </div>
          <button
            className="cta"
            disabled={!!busy}
            onClick={() =>
              void act("sync", () => store.gitAction.sync()).then(() => store.refreshGit())
            }
          >
            <RefreshCw size={14} className={busy === "sync" ? "spin" : ""} /> Pull
          </button>
        </div>
      )}
      <p className="prefs-sub">
        Pushing to a repo, or opening pull requests, needs your own Archnemesis (self-hosted).
      </p>
    </>
  );
}
