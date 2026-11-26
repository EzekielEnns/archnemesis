// The ways a design travels, in the design menu: copy a link that carries it, download its
// files, open files or a folder, open one from a public GitHub repository. Shown only where
// the backend can do it (`backend.portable`). And the banner over a design that came from
// somewhere: read-only from GitHub with its one action, or "you already had this copy".
import { Download, FolderOpen, Globe, Link2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { parseGhSpec, ghText } from "../../shared/ghlink.ts";
import { backend } from "../backend";
import type { Store } from "../store";
import { Dialog } from "./Dialog";
import { setSharedNotice, useSharedNotice } from "./sharedNotice";

/** From this many characters a link is "long": some chat and mail apps cut those. */
const LONG_LINK = 8000;

interface Say {
  note(text: string | null): void;
  error(text: string | null): void;
  /** Close the design list. */
  close(): void;
}

const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

/** `owner/repo`, from what a person pastes: a GitHub address works too. */
function repoOf(text: string): string {
  const t = text
    .trim()
    .replace(/^https?:\/\/github\.com\//, "")
    .replace(/\.git$/, "");
  return t.split("/").slice(0, 2).join("/");
}

function GithubDialog({ onClose }: { onClose: () => void }) {
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("");
  const [folder, setFolder] = useState("");
  const spec = parseGhSpec(
    `${repoOf(repo)}${branch.trim() ? `@${branch.trim()}` : ""}${folder.trim() ? `:${folder.trim()}` : ""}`,
  );
  const open = () => {
    if (!spec) return;
    onClose();
    location.hash = `~gh=${ghText(spec)}`;
  };
  return (
    <Dialog
      title="Open from GitHub"
      confirm="Open"
      disabled={!spec}
      onConfirm={open}
      onCancel={onClose}
    >
      <p>A design in a public repository. It opens read-only; you can make your own copy.</p>
      <input
        className="dialog-input"
        placeholder="owner/repository"
        value={repo}
        onChange={(e) => setRepo(e.target.value)}
        aria-label="Repository"
      />
      <input
        className="dialog-input"
        placeholder="Branch (a fork is archnm/design/name)"
        value={branch}
        onChange={(e) => setBranch(e.target.value)}
        aria-label="Branch"
      />
      <input
        className="dialog-input"
        placeholder="Folder in the repository (if there are several designs)"
        value={folder}
        onChange={(e) => setFolder(e.target.value)}
        aria-label="Folder"
      />
    </Dialog>
  );
}

function FilesDialog({ onClose }: { onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pick = async (kind: "zip" | "folder") => {
    setBusy(true);
    setError(null);
    try {
      const got = await backend.portable!.openFiles(kind);
      if (got) {
        onClose();
        location.hash = `/${got.key}`;
      }
    } catch (e) {
      setError(message(e, "Those files didn't open."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="Open files" onCancel={onClose}>
      <p>
        Open a design's files as a new design here: a .zip, or the folder that has its archnm.yaml.
      </p>
      <div className="portable-choices">
        <button className="cta" disabled={busy} onClick={() => void pick("zip")}>
          Choose a .zip
        </button>
        <button className="cta" disabled={busy} onClick={() => void pick("folder")}>
          Choose a folder
        </button>
      </div>
      {error && (
        <p className="first-error small" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}

/** The link, shown to copy by hand when the browser wouldn't put it on the clipboard. */
function LinkDialog({ url, onClose }: { url: string; onClose: () => void }) {
  return (
    <Dialog title="Copy this link" onCancel={onClose}>
      <textarea
        className="dialog-input portable-link"
        readOnly
        value={url}
        onFocus={(e) => e.currentTarget.select()}
      />
    </Dialog>
  );
}

/**
 * The design menu's entries for travelling designs, and the dialogs they open. The dialogs
 * go outside the list (it closes when you click elsewhere), so this gives both.
 */
export function usePortable(design: string, say: Say): { items: ReactNode; dialogs: ReactNode } {
  const [dialog, setDialog] = useState<"files" | "github" | { url: string } | null>(null);
  const p = backend.portable;
  if (!p) return { items: null, dialogs: null };

  const download = async () => {
    try {
      await p.download(design);
      say.note("Downloaded");
    } catch (e) {
      say.error(message(e, "Couldn't make the download."));
    }
  };
  const copyLink = async () => {
    say.note(null);
    say.error(null);
    try {
      const made = await p.link(design);
      if ("tooBig" in made) {
        say.error("This design is too big to fit in a link. Download its files instead.");
        return;
      }
      try {
        await navigator.clipboard.writeText(made.url);
        say.note(
          made.length > LONG_LINK
            ? `Link copied. It's long (about ${Math.round(made.length / 1000)},000 characters) and some chat and mail apps cut long links. Download files works every time.`
            : "Link copied",
        );
      } catch {
        say.close();
        setDialog({ url: made.url });
      }
    } catch (e) {
      say.error(message(e, "Couldn't make a link."));
    }
  };
  const row = (icon: ReactNode, label: string, run: () => void, tip: string) => (
    <button className="design-row action" onClick={run} title={tip}>
      {icon} {label}
    </button>
  );
  return {
    items: (
      <>
        {row(
          <Link2 size={14} />,
          "Copy link",
          () => void copyLink(),
          "A link that carries this design: whoever opens it gets their own copy",
        )}
        {row(
          <Download size={14} />,
          "Download files",
          () => void download(),
          "This design's files, as a .zip",
        )}
        {row(
          <FolderOpen size={14} />,
          "Open files…",
          () => (say.close(), setDialog("files")),
          "A .zip or a folder of a design's files",
        )}
        {row(
          <Globe size={14} />,
          "Open from GitHub…",
          () => (say.close(), setDialog("github")),
          "A design in a public repository",
        )}
      </>
    ),
    dialogs: (
      <>
        {dialog === "files" && <FilesDialog onClose={() => setDialog(null)} />}
        {dialog === "github" && <GithubDialog onClose={() => setDialog(null)} />}
        {typeof dialog === "object" && dialog && (
          <LinkDialog url={dialog.url} onClose={() => setDialog(null)} />
        )}
      </>
    ),
  };
}

/** Over a design that came from elsewhere: what it is, and the one thing to do about it. */
export function SharedBanner({ store }: { store: Store }) {
  const notice = useSharedNotice();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const p = backend.portable;
  if (!p) return null;
  const go = async (make: () => Promise<{ key: string }>) => {
    setBusy(true);
    setError(null);
    try {
      const { key } = await make();
      setSharedNotice(null);
      location.hash = `/${key}`;
    } catch (e) {
      setError(message(e, "That didn't work."));
    } finally {
      setBusy(false);
    }
  };
  if (store.from)
    return (
      <div className="tag-banner portable-banner">
        <Globe size={13} />
        <span>
          From GitHub: <b>{store.from}</b>
          <span className="muted"> · read-only</span>
          {store.branch && (
            <span className="muted"> · a fork: the diff shows what changed on it</span>
          )}
        </span>
        <button className="cta" disabled={busy} onClick={() => void go(() => p.copy(store.design))}>
          Make my own copy
        </button>
        {error && <span className="first-error small">{error}</span>}
      </div>
    );
  if (notice && notice.key === store.design)
    return (
      <div className="tag-banner portable-banner">
        <Link2 size={13} />
        <span>You opened this link before, so this is the copy you already have.</span>
        <button
          className="cta"
          disabled={busy}
          onClick={() => void go(() => p.openShared(notice.fragment, { again: true }))}
        >
          Make another copy
        </button>
        <button className="icon-btn" onClick={() => setSharedNotice(null)} title="Dismiss">
          ×
        </button>
        {error && <span className="first-error small">{error}</span>}
      </div>
    );
  return null;
}
