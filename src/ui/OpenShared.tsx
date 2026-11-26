// What a link that carries a design (`#~d=`) or names one on GitHub (`#~gh=`) shows while it
// opens, and the one plain sentence when it can't, with a way back to your own designs.
import { LoaderCircle } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { backend } from "../backend";
import { hashFor } from "../route";
import { setSharedNotice } from "./sharedNotice";
import { markOpenedFromLink } from "./welcomeState";

/** The fragment (without #) of a link this page opens, or null. */
export function sharedFragment(hash = location.hash): string | null {
  return /^#(~(?:d|gh)=.+)$/s.exec(hash)?.[1] ?? null;
}

/** Read-only GitHub designs come back by their own key: they open through the same page. */
export function remoteFragment(design: string): string | null {
  return backend.portable?.fragmentOf(design) ?? null;
}

function Wait({ children }: { children: ReactNode }) {
  return <div className="shared-page">{children}</div>;
}

/**
 * Open what the link says, then go to the design (or, for a design that has to be fetched
 * again on a reload, show it through `children`).
 */
export function OpenShared({ fragment, children }: { fragment: string; children?: ReactNode }) {
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const gated = children !== undefined;
  useEffect(() => {
    let off = false;
    backend
      .portable!.openShared(fragment)
      .then((r) => {
        if (off) return;
        markOpenedFromLink(r.key);
        if (r.existing) setSharedNotice({ key: r.key, fragment });
        if (gated) setDone(true);
        else location.replace(`#${hashFor({ design: r.key, diagramId: null, objectId: null })}`);
      })
      .catch(
        (e: unknown) => !off && setError(e instanceof Error ? e.message : "That didn't open."),
      );
    return () => {
      off = true;
    };
  }, [fragment, gated]);
  if (done) return <>{children}</>;
  if (error)
    return (
      <Wait>
        <h1>That link didn't open</h1>
        <p className="shared-error" role="alert">
          {error}
        </p>
        <button className="cta primary" onClick={() => (location.hash = "")}>
          Go to my designs
        </button>
      </Wait>
    );
  return (
    <Wait>
      <p className="shared-wait">
        <LoaderCircle size={16} className="spin" />
        {fragment.startsWith("~gh=") ? "Reading the design from GitHub…" : "Opening the design…"}
      </p>
    </Wait>
  );
}
