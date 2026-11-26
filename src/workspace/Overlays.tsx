// Everything else laid over the page: boxes opened in place (their tabs), the drop hint, the ☰
// that opens the panel, the dialogs, and the toasts.
import { Menu } from "lucide-react";
import { OPEN_FRAME } from "../../shared/explode.ts";
import { InsetTabs } from "../ui/InsetTabs";
import { SettingsDialog } from "../ui/LeftPanel";
import { Shortcuts } from "../ui/Shortcuts";
import { isFromLink, openWelcome, showTip } from "../ui/welcomeState";

import type { WorkspaceBag } from "./useInteraction";

/** The tabs of boxes opened in place. */
export function InsetTabsHost({
  open,
  exploded,
  openHere,
  setPanel,
  scene,
  sel,
}: Pick<WorkspaceBag, "open" | "exploded" | "openHere" | "setPanel" | "scene" | "sel">) {
  return (
    <>
      {exploded && (
        <InsetTabs
          frames={exploded.frames}
          rectOf={(id) => scene.current?.clientRectOfGroup(id) ?? null}
          selected={sel.boundary ? `boundary:${sel.boundary}` : null}
          onSelect={(id) => {
            scene.current?.select(
              { nodes: [], edge: null, boundary: id.slice("boundary:".length) },
              true,
            );
            setPanel(false);
          }}
          onCard={(id) => {
            scene.current?.select(
              { nodes: [], edge: null, boundary: id.slice("boundary:".length) },
              true,
            );
            setPanel(true);
          }}
          onClose={(id) => openHere(id.slice(`boundary:${OPEN_FRAME}`.length), false)}
          onOpenView={(id) => open(id.slice(`boundary:${OPEN_FRAME}`.length))}
        />
      )}
    </>
  );
}

/** "Put inside X" / "Take out of X" by the pointer while dragging. */
export function DropHint({ dropHint }: Pick<WorkspaceBag, "dropHint">) {
  return (
    <>
      {dropHint && (
        <div className="drop-hint" style={{ left: dropHint.x + 14, top: dropHint.y + 16 }}>
          {dropHint.text}
        </div>
      )}
    </>
  );
}

/** The ☰ that opens the left panel when it is closed. */
export function PanelOpenButton({
  panelOn,
  setPanelOn,
  store,
  simple,
}: Pick<WorkspaceBag, "panelOn" | "setPanelOn" | "store" | "simple">) {
  return (
    <>
      {simple && !panelOn && (
        <button
          className={`island panel-open${store.mode === "fork" ? " on-fork" : ""}`}
          onClick={() => setPanelOn(true)}
          title={`${store.branch ?? "main"}: the tree, branches and settings ([)`}
        >
          <Menu size={16} />
          {/* On a fork, say so: with the panel closed nothing else does. */}
          {store.mode === "fork" && <span className="panel-open-fork">{store.branch}</span>}
        </button>
      )}
    </>
  );
}

/** The shortcuts sheet and settings. */
export function DialogsHost({
  viewSettings,
  minimap,
  setMinimap,
  animate,
  setAnimate,
  help,
  setHelp,
  settings,
  setSettings,
  toast,
  store,
}: Pick<
  WorkspaceBag,
  | "viewSettings"
  | "minimap"
  | "setMinimap"
  | "animate"
  | "setAnimate"
  | "help"
  | "setHelp"
  | "settings"
  | "setSettings"
  | "toast"
  | "store"
>) {
  return (
    <>
      {help && (
        <Shortcuts
          onClose={() => setHelp(false)}
          mcp={store.mcp}
          fromLink={isFromLink(store.design, store.from)}
          onGettingStarted={() => {
            setHelp(false);
            if (isFromLink(store.design, store.from)) showTip(true);
            else openWelcome();
          }}
        />
      )}
      {settings && (
        <SettingsDialog
          store={store}
          toast={toast}
          design={{ key: store.designKey, name: store.designName }}
          section={settings}
          onSection={setSettings}
          canvas={[
            { label: "Minimap", hint: "M", on: minimap, flip: () => setMinimap((v) => !v) },
            {
              label: "Animate every arrow",
              hint: "A · otherwise only what's selected",
              on: animate,
              flip: () => setAnimate((v) => !v),
            },
          ]}
          layout={viewSettings?.layout ?? null}
          arrows={viewSettings?.arrows ?? null}
          onClose={() => setSettings(null)}
        />
      )}
    </>
  );
}

/** The toasts at the bottom. */
export function Toasts({ toasts, setToasts }: Pick<WorkspaceBag, "toasts" | "setToasts">) {
  return (
    <>
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`}>
            {t.text}
            {t.action && (
              <button
                className="toast-action"
                onClick={() => {
                  t.action!.run();
                  setToasts((all) => all.filter((x) => x.id !== t.id));
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
