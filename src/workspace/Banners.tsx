// The banners at the top: viewing a past version, and a tag being shown.
import { Eye, History, X } from "lucide-react";
import { backend } from "../backend";

import { SharedBanner } from "../ui/Portable";
import type { WorkspaceBag } from "./useInteraction";

/** A past version (read-only), and a tag being shown. */
export function Banners({
  following,
  guide,
  tag,
  setTag,
  store,
  toast,
}: Pick<WorkspaceBag, "following" | "guide" | "tag" | "setTag" | "store" | "toast">) {
  // Opened from a share link: look around, and make your own copy (a guest signs in first).
  const fork = async () => {
    if (store.guest) return store.askSignIn();
    try {
      const { key } = await backend.links!.copy(store.design);
      location.hash = `/${key}`;
    } catch (e) {
      toast(e instanceof Error ? e.message : "couldn't make a copy", "error");
    }
  };
  return (
    <>
      <SharedBanner store={store} />
      {(store.viaLink || store.guest) && backend.links && (
        <div className="tag-banner past-banner view-link-banner">
          <Eye size={13} />
          <span>
            <b>View only</b>
            <span className="muted"> · you opened this from a link</span>
          </span>
          {(store.guest || store.can.fork) && (
            <button className="cta" onClick={() => void fork()}>
              {store.guest ? "Sign in to fork" : "Fork to my copy"}
            </button>
          )}
        </div>
      )}
      {store.past && (
        <div className="tag-banner past-banner" style={tag ? { top: 100 } : undefined}>
          <History size={13} />
          <span>
            As of{" "}
            <b>
              {new Date(store.past.date).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </b>
            <span className="muted">
              {" "}
              ·{" "}
              {store.past.subject.length > 60
                ? `${store.past.subject.slice(0, 60)}…`
                : store.past.subject}{" "}
              · read-only
            </span>
          </span>
          <button className="cta" onClick={() => store.backToNow()}>
            Back to now
          </button>
        </div>
      )}
      {tag && !(guide && following) && (
        <div className="tag-banner">
          Showing <b>#{tag}</b>
          <button className="icon-btn" onClick={() => setTag(null)} title="Clear (Esc)">
            <X size={13} />
          </button>
        </div>
      )}
    </>
  );
}
