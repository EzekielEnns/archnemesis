// How the page is laid out around the canvas: the drawer and the left panel (open, pinned,
// which view), how much room a docked panel takes, and whether the tools have to fold into a menu.
import { useEffect, useState } from "react";
import { type PanelView } from "../ui/LeftPanel";

import { DOCK_MIN, MENU_ROOM, PANEL_ROOM, TOOLS_W } from "./constants";
import { useStoredFlag } from "./useStored";

export function useDocking(simple: boolean) {
  /** Layout choices that stick between visits. */
  const [sidebarOpen, setSidebar] = useStoredFlag("archnm.sidebar", true);
  const sidebar = sidebarOpen && !simple;
  // Simple mode's left panel, like Excalidraw's menu: hidden until ☰ (or [) opens it, and gone
  // again at a click on the canvas or Esc, unless it's pinned open.
  const [panelPinned, setPanelPinned] = useStoredFlag("archnm.panel.pinned", false);
  // Open or closed, remembered: it no longer hides itself when you click the canvas.
  const [panelOn, setPanelOn] = useStoredFlag("archnm.panel.on", true);
  const leftPanel = simple && panelOn;
  const [panelView, setPanelView] = useState<PanelView>("tree");
  // Simple mode's top row, as Excalidraw does it: the tools in the middle of the page, ☰ on the
  // left, the people island on the right. The panel floats over the canvas; pinned on a wide
  // window it docks, and the row (tools and all) centres in what's left beside it. When the
  // tools don't fit between what's either side, the less-used ones go in a ⋮ menu.
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
  const dock = simple && leftPanel && panelPinned && winW >= DOCK_MIN ? PANEL_ROOM : 0;
  const toolsCompact = (() => {
    if (!simple) return false;
    const mid = dock + (winW - dock) / 2;
    const left = dock || (leftPanel ? PANEL_ROOM : MENU_ROOM);
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
    dock,
    toolsCompact,
  };
}
