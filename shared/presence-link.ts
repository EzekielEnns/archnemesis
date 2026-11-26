// Presence that follows the connection, not timers.
//
// y-protocols' awareness re-announces every 15s and drops anyone silent for 30s. Browsers
// throttle timers in background tabs to about once a minute, so background tabs blinked
// out for everyone and back. And after a dropped socket the provider re-sent this tab's
// presence with the same clock the server had already removed, so everyone ignored it and
// the tab stayed invisible until it next moved.
//
// Here presence lasts exactly as long as the connection: the server removes a client's
// state when its socket closes (a ping finds dead sockets within a minute), clients clear
// everyone else's when they lose the server, and every (re)connect announces this
// client's state with a fresh clock.
import type { HocuspocusProvider } from "@hocuspocus/provider";

type Awareness = NonNullable<HocuspocusProvider["awareness"]>;

/** Stop y-protocols' timer: no renewals, and no expiring of others. */
export function stopAwarenessTimer(awareness: { _checkInterval?: unknown }): void {
  clearInterval(awareness._checkInterval as ReturnType<typeof setInterval>);
}

/** Wire a provider's awareness to its connection. Returns a function that undoes it. */
export function linkPresence(provider: HocuspocusProvider): () => void {
  const awareness = provider.awareness as Awareness | null;
  if (!awareness) return () => {};
  stopAwarenessTimer(awareness as unknown as { _checkInterval?: unknown });
  // The last state this client announced, so it can be restored after a page hide.
  let last: Record<string, unknown> | null = awareness.getLocalState();
  const remember = () => {
    const s = awareness.getLocalState();
    if (s) last = s;
  };
  const announce = () => {
    const s = awareness.getLocalState() ?? last;
    // A new object bumps the clock, so the server and peers take it over what they removed.
    if (s) awareness.setLocalState({ ...s });
  };
  awareness.on("change", remember);
  provider.on("synced", announce);
  const onShow = (e: { persisted?: boolean }) => e.persisted && announce();
  // A tab back in front (a phone unlocked, a laptop woken) or back online reconnects now,
  // rather than when its backoff next fires: phones suspend background tabs, so after a
  // server restart they'd otherwise stay gone until reloaded.
  const wake = () => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    const ws = (
      provider.configuration as { websocketProvider?: { status?: string; shouldConnect?: boolean } }
    ).websocketProvider;
    if (ws && ws.status === "disconnected" && ws.shouldConnect !== false)
      void provider.connect().catch(() => {});
  };
  const win = typeof window !== "undefined" ? window : null;
  win?.addEventListener("pageshow", onShow as EventListener);
  win?.addEventListener("online", wake);
  win?.document?.addEventListener("visibilitychange", wake);
  return () => {
    awareness.off("change", remember);
    provider.off("synced", announce);
    win?.removeEventListener("pageshow", onShow as EventListener);
    win?.removeEventListener("online", wake);
    win?.document?.removeEventListener("visibilitychange", wake);
  };
}
