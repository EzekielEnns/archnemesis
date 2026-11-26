// How the page is laid out around the canvas: the drawer and the left panel (open, pinned,
// which view), and whether the tools have to fold into a menu.
import { useEffect, useState } from "react";
import { type PanelView } from "../ui/LeftPanel";

import { MENU_ROOM, PANEL_ROOM, TOOLS_W } from "./constants";
import { useStoredFlag } from "./useStored";

export function useDocking(simple: boolean) {
  /** Layout choices that stick between visits. */
  const [sidebarOpen, setSidebar] = useStoredFlag("archnm.sidebar", true);
  const sidebar = sidebarOpen && !simple;
  // The left panel, like Excalidraw's menu: closed until ☰ (or [) opens it, and gone again at a
  // click anywhere else, unless it's pinned. Pinned, it stays open (and opens with the page).
  // It always floats over the canvas: nothing else moves for it.
  const [panelPinned, setPanelPinned] = useStoredFlag("archnm.panel.pinned", false);
  const [panelOn, setPanelOn] = useState(panelPinned);
  const leftPanel = simple && panelOn;
  useEffect(() => {
    if (!leftPanel || panelPinned) return;
    const away = (e: PointerEvent) => {
      const at = e.target as Element | null;
      // Its own menus and dialogs (settings, search) open outside it: those aren't "away".
      if (at?.closest(".left-panel, .panel-open, [role=dialog], [role=menu], .modal, .popover"))
        return;
      setPanelOn(false);
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [leftPanel, panelPinned]);
  const [panelView, setPanelView] = useState<PanelView>("tree");
  // Simple mode's top row, as Excalidraw does it: the tools in the middle of the page, ☰ on the
  // left, the people island on the right. When the tools don't fit between what's either side
  // (the open panel included), the less-used ones go in a ⋮ menu.
  const [rightW, setRightW] = useState(0);
  const [winW, setWinW] = useState(() => innerWidth);
  useEffect(() => {
    const ro = new ResizeObserver(([e]) =>
      setRightW(Math.round((e!.target as HTMLElement).offsetWidth) + 24),
    );
    // The island mounts once the design has loaded: wait for it.
    let raf = 0;
    const find = () => {
      const el = document.querySelector<HTMLElement>(".top-right");
      if (el) ro.observe(el);
      else raf = requestAnimationFrame(find);
    };
    find();
    const onResize = () => setWinW(innerWidth);
    window.addEventListener("resize", onResize);
    return () => (
      cancelAnimationFrame(raf),
      ro.disconnect(),
      window.removeEventListener("resize", onResize)
    );
  }, [simple]);
  const toolsCompact = (() => {
    if (!simple) return false;
    const mid = winW / 2;
    const left = leftPanel ? PANEL_ROOM : MENU_ROOM;
    return Math.min(mid - left, winW - rightW - mid) < TOOLS_W / 2;
  })();
  const [pinned, setPinned] = useStoredFlag("archnm.drawerPinned", true);
  return {
    sidebar,
    setSidebar,
    panelPinned,
    setPanelPinned,
    panelOn,
    setPanelOn,
    leftPanel,
    panelView,
    setPanelView,
    pinned,
    setPinned,
    toolsCompact,
  };
}
