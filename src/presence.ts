// Who else is here, through Yjs awareness: throwaway state each client broadcasts and
// nobody stores. Pointers, selections and in-progress drags go here, so a drag shows live
// for everyone without writing a hundred edits; the drop is the one real edit.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Store } from "./store.ts";

export interface PresenceState {
  user: { id: string; name: string; color: string; kind: "human" | "agent" | "system" };
  diagram: string | null;
  cursor: { x: number; y: number } | null;
  selected: string[];
  moving: { id: string; x: number; y: number; w: number; h: number }[];
  /** What an agent says it's doing ("updating Payments"). */
  activity?: string;
  /** An agent walking its person through the diagrams (MCP point). */
  guide?: {
    for: string;
    by: string;
    diagram: string;
    object?: string | null;
    flow?: string | null;
    step?: number;
    objects?: string[];
    tag?: string | null;
    refs?: string[];
    say: string;
    waiting?: boolean;
    listening?: boolean;
    seq: number;
  };
}

export interface PeerInfo extends PresenceState {
  key: number;
}

const COLORS = [
  "#f472b6",
  "#60a5fa",
  "#34d399",
  "#fbbf24",
  "#a78bfa",
  "#fb923c",
  "#22d3ee",
  "#f87171",
];

export function colorFor(id: string): string {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0;
  return COLORS[Math.abs(h) % COLORS.length]!;
}

/** Everyone else's presence, and a setter for this tab's own. */
export function usePresence(store: Store, version: number) {
  const awareness = store.awareness;
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  /** How many other tabs you have open on this Archnemesis. */
  const [ownTabs, setOwnTabs] = useState(0);
  const pending = useRef<Partial<PresenceState>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!awareness) return;
    const me = store.me;
    awareness.setLocalState({
      user: { id: me.id, name: me.name, color: colorFor(me.id), kind: me.kind },
      diagram: null,
      cursor: null,
      selected: [],
      moving: [],
    } satisfies PresenceState);
    const read = () => {
      const out: PeerInfo[] = [];
      let mine = 0;
      awareness.getStates().forEach((st, key) => {
        if (key === awareness.clientID) return;
        const s = st as Partial<PresenceState>;
        if (!s.user) return;
        // Your own other tabs aren't other people: they'd show as a second you.
        if (s.user.id === store.me.id) {
          mine++;
          return;
        }
        out.push({ key, diagram: null, cursor: null, selected: [], moving: [], ...s } as PeerInfo);
      });
      setPeers(out);
      setOwnTabs(mine);
    };
    awareness.on("change", read);
    read();
    return () => {
      awareness.off("change", read);
    };
    // `version` re-runs this once the provider exists and when the name is confirmed.
  }, [awareness, store, version > 0 && store.me.id]);

  const set = useMemo(() => {
    const flush = () => {
      timer.current = null;
      if (!awareness) return;
      const cur = (awareness.getLocalState() ?? {}) as PresenceState;
      awareness.setLocalState({ ...cur, ...pending.current });
      pending.current = {};
    };
    /** Update this tab's presence; pointer moves are batched to ~25 a second. */
    return (patch: Partial<PresenceState>, now = false) => {
      Object.assign(pending.current, patch);
      if (now) {
        if (timer.current) clearTimeout(timer.current);
        flush();
      } else if (!timer.current) timer.current = setTimeout(flush, 40);
    };
  }, [awareness]);

  return { peers, ownTabs, set };
}
