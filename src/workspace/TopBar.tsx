// The top of the page: the tools, the old top-left bar, and an agent's guide bar.
import { sourceLink } from "../../shared/files.ts";
import { X } from "lucide-react";
import { Tools, TopLeft } from "../ui/Chrome";

import type { WorkspaceBag } from "./useInteraction";

/** The tools in the middle of the page, and the top-left bar when not in simple mode. */
/** A first name for a sentence ("Sam is on it"); "Your agent" stays whole. */
const shortName = (name: string) => (/^your /i.test(name) ? name : name.split(" ")[0]!);

export function TopBar({
  up,
  canUp,
  jump,
  jumpBack,
  navigate,
  tool,
  lastKind,
  toolHint,
  pickTool,
  sidebar,
  setSidebar,
  toolsCompact,
  setPalette,
  toast,
  store,
  idx,
  simple,
  run,
  diagramId,
}: Omit<
  Pick<
    WorkspaceBag,
    | "up"
    | "canUp"
    | "jump"
    | "jumpBack"
    | "navigate"
    | "tool"
    | "lastKind"
    | "toolHint"
    | "pickTool"
    | "sidebar"
    | "setSidebar"
    | "toolsCompact"
    | "setPalette"
    | "toast"
    | "store"
    | "idx"
    | "simple"
    | "run"
    | "diagramId"
  >,
  "diagramId"
> & { diagramId: string }) {
  return (
    <>
      {/* No up chip: ⌘↑ and the right-click menu's "Up to …" go up a level. */}
      {!simple && (
        <TopLeft
          jumpBack={jump ? { label: jump.label, run: jumpBack } : null}
          design={{ key: store.designKey, name: store.designName }}
          store={store}
          toast={toast}
          idx={idx}
          diagramId={diagramId}
          sidebar={sidebar}
          connectivity={store.connectivity}
          viewOnly={!store.canEdit}
          onSidebar={() => setSidebar((v) => !v)}
          onNavigate={(d, how) => navigate(d, null, how ?? "crumb")}
          onUp={canUp ? up : null}
          run={run}
        />
      )}
      <Tools
        tool={tool}
        onTool={pickTool}
        onSearch={() => setPalette(true)}
        hint={toolHint}
        simple={simple}
        compact={toolsCompact}
        last={simple ? lastKind : null}
      />
    </>
  );
}

/** The bar an agent talks through while it shows you around. */
export function GuideBar({
  following,
  setFollowing,
  guide,
  followed,
  asking,
  setAsking,
  closedGuide,
  setClosedGuide,
  answer,
  store,
}: Pick<
  WorkspaceBag,
  | "following"
  | "setFollowing"
  | "guide"
  | "followed"
  | "asking"
  | "setAsking"
  | "closedGuide"
  | "setClosedGuide"
  | "answer"
  | "store"
>) {
  return (
    <>
      {guide && closedGuide !== `${guide.by}:${guide.seq}` && (
        <div className="guide-bar" role="status">
          <div className="guide-top">
            <span className="guide-who">{guide.name}</span>
            <span className="guide-say">
              {guide.say ||
                (following
                  ? "is showing you around"
                  : "is showing you around (you stopped following)")}
            </span>
            <button
              className="icon guide-close"
              title={guide.waiting ? "Close: ends the walkthrough" : "Close"}
              onClick={() => {
                // A walkthrough waiting on you is told you've stopped; a plain pointer just goes.
                if (guide.waiting) answer("stop");
                setClosedGuide(`${guide.by}:${guide.seq}`);
              }}
            >
              <X size={14} />
            </button>
          </div>
          {guide.tag && following && (
            <div className="guide-refs">
              <span>
                Showing <b>#{guide.tag}</b>
              </span>
            </div>
          )}
          {!!guide.refs?.length && (
            <div className="guide-refs">
              {guide.refs.map((r) => {
                const url = sourceLink(store.config.github, r);
                return url ? (
                  <a key={r} href={url} target="_blank" rel="noopener noreferrer" title={url}>
                    {r}
                  </a>
                ) : (
                  <span key={r}>{r}</span>
                );
              })}
            </div>
          )}
          <div className="guide-actions">
            {guide.waiting && following ? (
              <>
                <input
                  className="guide-ask"
                  value={asking}
                  placeholder="Ask about this…"
                  onChange={(e) => setAsking(e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter" && asking.trim()) answer("ask", asking.trim());
                  }}
                />
                <button className="small" onClick={() => answer("back")}>
                  Back
                </button>
                <button className="small primary" onClick={() => answer("next")}>
                  Next
                </button>
                <button className="small" onClick={() => answer("stop")}>
                  Stop
                </button>
                {guide.listening === false && (
                  <span
                    className="muted small guide-quiet"
                    title="A press is kept and handed to it the next time it checks"
                  >
                    {shortName(guide.name)} isn't listening right now: a press waits for it, or
                    reply in chat
                  </span>
                )}
              </>
            ) : (
              <>
                {guide.waiting === false && following && (
                  <span className="muted small grow">
                    {guide.listening === false
                      ? `Sent. ${shortName(guide.name)} gets it when it next checks in, or reply in chat`
                      : `${shortName(guide.name)} is on it…`}
                  </span>
                )}
                <span className="grow" />
                <button
                  className="small"
                  onClick={() => {
                    if (!following) followed.current = "";
                    setFollowing((v) => !v);
                  }}
                >
                  {following ? "Stop following" : "Follow"}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
