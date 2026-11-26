// The left panel (or the drawer), with the tree of diagrams and, on a fork, the branches.
import { newDiagram, placeBeside } from "../../shared/actions.ts";
import { hasCode } from "../../shared/navtree.ts";
import { allTags, flowsOf } from "../../shared/project.ts";
import { Sidebar } from "../ui/Sidebar";
import { PanelHead } from "../ui/LeftPanel";
import { BranchesView } from "../ui/Branches";

import type { WorkspaceBag } from "./useInteraction";

type SidebarProps = Pick<
  WorkspaceBag,
  | "diffChanges"
  | "goToObject"
  | "deleteDiagram"
  | "navigate"
  | "open"
  | "setFlowId"
  | "setStep"
  | "tag"
  | "setTag"
  | "activeFlow"
  | "isPath"
  | "startFlow"
  | "whatsNew"
  | "showNew"
  | "setShowNew"
  | "diffCount"
  | "newSets"
  | "scene"
  | "sidebar"
  | "setSidebar"
  | "panelPinned"
  | "setPanelPinned"
  | "setPanelOn"
  | "leftPanel"
  | "panelView"
  | "setPanelView"
  | "pinned"
  | "setPinned"
  | "setPalette"
  | "setSettings"
  | "toast"
  | "store"
  | "idx"
  | "run"
  | "sel"
  | "diagramId"
>;

/** The left panel: tree, flows, tags, branches, settings. */
export function SidebarHost(props: SidebarProps) {
  const {
    goToObject,
    deleteDiagram,
    navigate,
    open,
    setFlowId,
    setStep,
    tag,
    setTag,
    activeFlow,
    isPath,
    startFlow,
    whatsNew,
    showNew,
    setShowNew,
    newSets,
    scene,
    sidebar,
    setSidebar,
    leftPanel,
    pinned,
    setPinned,
    setPalette,
    toast,
    store,
    idx,
    run,
    sel,
    diagramId,
  } = props;
  return (
    <>
      {(sidebar || leftPanel) && (!activeFlow || isPath) && (
        <Sidebar
          panel={leftPanelOf(props)}
          idx={idx}
          diagramId={diagramId}
          pinned={pinned}
          onPin={() => setPinned((v) => !v)}
          onClose={() => setSidebar(false)}
          onNavigate={(d: string) => navigate(d, null, "sidebar")}
          onSelectObject={goToObject}
          selected={sel.nodes}
          onSearch={() => setPalette(true)}
          showNew={showNew}
          onShowNew={() => setShowNew((v) => !v)}
          changed={newSets?.changed}
          diffMark={(id) => {
            if (whatsNew?.added?.includes(id)) return { added: true };
            const ls = whatsNew?.lines?.[id];
            return ls?.length
              ? {
                  plus: ls.filter((l) => l[0] === "+").length,
                  minus: ls.filter((l) => l[0] === "-").length,
                }
              : null;
          }}
          context={newSets?.context}
          onAddObject={(id) => {
            if (!diagramId) return;
            const name = idx.objects.get(id)?.name ?? "object";
            void run(placeBeside(idx, diagramId, id), `place ${name}`).then(() => {
              scene.current?.select({ nodes: [id], edge: null }, true);
              scene.current?.centerOn(id, true);
            });
          }}
          onOpen={open}
          flows={diagramId ? flowsOf(idx, diagramId) : []}
          activeFlow={activeFlow?.id ?? null}
          onOpenFlow={(id) => {
            setFlowId((cur) => (cur === id ? null : id));
            setStep(-1);
            setTag(null);
          }}
          onNewFlow={startFlow}
          tags={allTags(idx)}
          activeTag={tag}
          onTag={(t) => {
            setTag((cur) => (cur === t ? null : t));
            setFlowId(null);
          }}
          onDeleteDiagram={deleteDiagram}
          run={(ops, label) =>
            store
              .send(ops, label)
              .catch(
                (e: unknown) => (
                  toast(e instanceof Error ? e.message : String(e), "error"),
                  Promise.reject(e)
                ),
              )
          }
          done={(text) => toast(text, { label: "Undo", run: () => void store.undo() })}
          canEdit={store.canEdit}
          onNewDiagram={() => {
            const { ops, diagram } = newDiagram("Untitled diagram");
            void run(ops, "new diagram").then(() => navigate(diagram.id, null, "new"));
          }}
        />
      )}
    </>
  );
}

/** What goes in the left panel's head and body: the view tabs, and the branches. */
function leftPanelOf({
  leftPanel,
  panelView,
  store,
  toast,
  diffCount,
  showNew,
  setShowNew,
  diffChanges,
  setSettings,
  setPanelView,
  idx,
  setPalette,
  panelPinned,
  setPanelPinned,
  setPanelOn,
}: SidebarProps) {
  return leftPanel
    ? {
        code: panelView === "code",
        body:
          panelView === "branches" ? (
            <BranchesView
              store={store}
              toast={toast}
              diff={
                store.branch
                  ? {
                      count: diffCount,
                      on: showNew,
                      toggle: () => setShowNew((v) => !v),
                      changes: diffChanges,
                    }
                  : null
              }
              onRepo={() => setSettings("repo")}
            />
          ) : undefined,
        head: (
          <PanelHead
            store={store}
            toast={toast}
            view={panelView}
            onView={setPanelView}
            hasCode={hasCode(idx)}
            onSearch={() => setPalette(true)}
            onSettings={(sec) => setSettings(sec ?? "general")}
            pinned={panelPinned}
            onPin={() => setPanelPinned((v) => !v)}
            onClose={() => setPanelOn(false)}
          />
        ),
      }
    : undefined;
}
