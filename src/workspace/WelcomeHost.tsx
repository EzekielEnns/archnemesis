// Puts the first-run welcome on the page: which of its pieces shows (welcomeState.ts decides), where
// the ways in lead, and the keys it listens for.
import { useEffect, useState, useSyncExternalStore } from "react";
import { backend } from "../backend";
import { carryToast, hashFor } from "../route";
import {
  autoOpen,
  endCoach,
  hideForGood,
  isFromLink,
  modeOf,
  openWelcome,
  placeOf,
  readMemory,
  showTip,
  tuck,
  useWelcomeUi,
} from "../ui/welcomeState";
import { exampleError, openExample } from "../ui/exampleDesign";
import { EmptyHint, SharedTip, WelcomeChip, WelcomeCoach, WelcomePanel } from "../ui/Welcome";
import { modelContext } from "../webmcp";
import { PANEL_ROOM } from "./constants";
import type { WorkspaceBag } from "./useInteraction";

/** The "?" button, which takes focus when the welcome is hidden for good. */
const focusHelp = () =>
  requestAnimationFrame(() =>
    document.querySelector<HTMLElement>('[title="Shortcuts (?)"]')?.focus({ preventScroll: true }),
  );

export function WelcomeHost({
  store,
  empty,
  leftPanel,
  dock,
  help,
  toast,
}: Pick<WorkspaceBag, "store" | "empty" | "leftPanel" | "dock" | "help" | "toast">) {
  const ui = useWelcomeUi();
  useSyncExternalStore(store.subscribe, store.getVersion);
  const [busy, setBusy] = useState(false);
  const live = store.connectivity === "live";
  const boxes = store.objects.size;
  const fromLink = isFromLink(store.design, store.from);
  const mode = modeOf({ memory: readMemory(), empty: empty && boxes === 0, fromLink });
  const left = dock || (leftPanel ? PANEL_ROOM : 12);
  const place = placeOf(store.mcp, modelContext() !== null);
  const agent = store.here.some((e) => e.user.kind === "agent");

  useEffect(() => {
    if (live && mode === "welcome") autoOpen();
  }, [live, mode]);

  // Esc tucks the panel into the chip (the shortcuts sheet, if open, takes the first Esc).
  useEffect(() => {
    if (!ui.panel || help) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && tuck();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [ui.panel, help]);

  // Something was drawn while the panel was up (an agent, or someone else): get out of its way.
  useEffect(() => {
    if (boxes > 0 && ui.panel) tuck();
  }, [boxes, ui.panel]);

  // The coach has said its piece once there is a connection.
  const connected = store.connections.size > 0;
  useEffect(() => {
    if (connected && ui.coach) endCoach();
  }, [connected, ui.coach]);
  // While it points at the place keys, the dock lights them (welcome.css).
  const pointing = ui.coach && !ui.panel && boxes === 0;
  useEffect(() => {
    document.body.classList.toggle("welcome-points", pointing);
    return () => document.body.classList.remove("welcome-points");
  }, [pointing]);

  if (!live) return null;
  if (fromLink) return ui.tip ? <SharedTip left={left} onClose={() => showTip(false)} /> : null;

  const never = () => {
    hideForGood();
    toast("Hidden. You can find it again under ? → Getting started.");
    focusHelp();
  };
  const example = async () => {
    setBusy(true);
    try {
      const { key, created } = await openExample(backend);
      carryToast(
        created
          ? `Opened “Shop” as its own design. ${boxes === 0 ? "Your blank design" : "Your other designs"} ${boxes === 0 ? "is" : "are"} still in the design menu.`
          : "Opened your “Shop” design.",
      );
      tuck();
      location.hash = hashFor({ design: key, diagramId: null, objectId: null });
    } catch (e) {
      toast(exampleError(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const quiet = !ui.panel && !ui.chip && !ui.coach;
  return (
    <>
      {ui.panel && (
        <WelcomePanel
          where={{ place, mcp: store.mcp, agent, team: store.authMode !== "local" }}
          detail={ui.detail}
          left={left}
          busy={busy}
          onBlank={() => tuck({ coach: true })}
          onExample={() => void example()}
          onTuck={() => tuck()}
          onNever={never}
        />
      )}
      {ui.chip && !ui.panel && (
        <WelcomeChip ui={ui} left={left} onOpen={() => openWelcome()} onNever={never} />
      )}
      {ui.coach && !ui.panel && <WelcomeCoach left={left} boxes={boxes} />}
      {quiet && mode === "hint" && <EmptyHint onOpen={() => openWelcome()} />}
    </>
  );
}
