// The app: the sidebar (diagrams and the model), the canvas for one diagram, the inspector
// for what's selected. Gestures on the canvas become ops (shared/actions.ts) sent to the
// server; the store's change events bring them back and the canvas re-syncs.
//
// This file only puts it together. The state and behaviour are hooks in src/workspace (each owns
// one concern: see useDiagramState, useCanvasSession and useInteraction for the order they run
// in), and each region of the page is a component there.
import type { CSSProperties } from "react";
import type { Store } from "./store";
import { EmptyState } from "./ui/Chrome";
import { Tips } from "./ui/Tips";
import { OBJECT_DRAG_TYPE } from "./workspace/constants";
import { Banners } from "./workspace/Banners";
import { CanvasHost, DiffHost, Legend, NotesHost, PartsHost } from "./workspace/CanvasLayers";
import { CardHost } from "./workspace/CardHost";
import { BottomCorner, HelpCorner, PeersIsland, ReportHost } from "./workspace/Corners";
import { ContextMenuHost, MarkingDialog, PaletteHost } from "./workspace/Dialogs";
import { FlowHost } from "./workspace/FlowHost";
import { EdgeRenameInput, RenameInput } from "./workspace/InlineEditors";
import { NotePanels } from "./workspace/NotePanels";
import {
  DialogsHost,
  DropHint,
  InsetTabsHost,
  PanelOpenButton,
  Toasts,
} from "./workspace/Overlays";
import { SidebarHost } from "./workspace/SidebarHost";
import { GuideBar, TopBar } from "./workspace/TopBar";
import { WelcomeHost } from "./workspace/WelcomeHost";
import { useCanvasSession } from "./workspace/useCanvasSession";
import { useDiagramState } from "./workspace/useDiagramState";
import { useInteraction } from "./workspace/useInteraction";

export { OBJECT_DRAG_TYPE };

export function Workspace({ store }: { store: Store }) {
  // Simple mode (a test of docs/v1.md): no drawer, no top-left navigation, and a box's panel
  // only when asked for (right-click, or a click with the view tool). ?simple=1 / ?simple=0.
  // It's the only layout now: the old drawer and the floating top-left bar are gone.
  const simple = true as boolean;
  const state = useDiagramState(store, simple);
  const session = useCanvasSession(state);
  const w = useInteraction(state, session);
  return (
    <div
      className={`workspace${w.dock ? " docked" : ""}`}
      style={{ "--dock": `${w.dock}px` } as CSSProperties}
    >
      <main
        className="stage"
        onDragOver={(e) => e.dataTransfer.types.includes(OBJECT_DRAG_TYPE) && e.preventDefault()}
        onDrop={w.onDrop}
      >
        <CanvasHost {...w} />
        <Legend {...w} />
        <PartsHost {...w} />
        <DiffHost {...w} />
        <NotesHost {...w} />
        <SidebarHost {...w} />
        {w.diagramId && (
          <>
            {/* No up chip: ⌘↑ and the right-click menu's "Up to …" go up a level. */}
            <TopBar {...w} diagramId={w.diagramId} />
            <GuideBar {...w} />
            <BottomCorner {...w} />
            <ReportHost {...w} />
            <HelpCorner {...w} />
            <PeersIsland {...w} />
          </>
        )}
        {/* An empty design has the welcome or its hint (WelcomeHost); an empty view of a full one this. */}
        {w.empty && w.store.objects.size > 0 && <EmptyState onTool={w.setTool} />}
        <WelcomeHost {...w} />
        <FlowHost {...w} />
        <Banners {...w} />
        <NotePanels {...w} />
        <CardHost {...w} />
        <InsetTabsHost {...w} />
        <DropHint {...w} />
        <PanelOpenButton {...w} />
        <DialogsHost {...w} />
        <Tips />
        <Toasts {...w} />
      </main>
      <RenameInput {...w} />
      <EdgeRenameInput {...w} />
      <ContextMenuHost {...w} />
      <MarkingDialog {...w} />
      <PaletteHost {...w} />
    </div>
  );
}
