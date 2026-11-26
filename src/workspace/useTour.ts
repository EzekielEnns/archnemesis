// An agent showing you around (MCP point, or WebMCP show): the guide's current stop, following
// it (your tab goes where it points, the drawer folds away for the tour), gliding to what the
// step is about, and answering it (next, back, stop, ask).
import type { Dispatch, SetStateAction } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { type PeerInfo } from "../presence";
import { boxesWithTag, type ModelIndex } from "../../shared/project.ts";
import type { Store } from "../store";
import { backend } from "../backend";

import { go } from "../route";
import { via } from "../trail";
import type { Stop, StopReply } from "../../shared/tools/host";
import type { SceneRef } from "./types";

export function useTour({
  store,
  peers,
  diagramId,
  idx,
  scene,
  ready,
  sidebar,
  setSidebar,
  setFlowId,
  setStep,
  setTag,
}: {
  store: Store;
  peers: PeerInfo[];
  diagramId: string | null;
  idx: ModelIndex;
  scene: SceneRef;
  ready: boolean;
  sidebar: boolean;
  setSidebar: Dispatch<SetStateAction<boolean>>;
  setFlowId: Dispatch<SetStateAction<string | null>>;
  setStep: Dispatch<SetStateAction<number>>;
  setTag: Dispatch<SetStateAction<string | null>>;
}) {
  // An agent showing you around (MCP point): your tabs go where it points, until you stop.
  const [following, setFollowing] = useState(true);
  // An agent in this page (WebMCP show) guides the same way, without the server in between.
  const [localGuide, setLocalGuide] = useState<
    | (Stop & {
        for: string;
        by: string;
        seq: number;
        waiting?: boolean;
        listening?: boolean;
        name: string;
      })
    | null
  >(null);
  const localReply = useRef<((r: StopReply | null) => void) | null>(null);
  const guide = useMemo(() => {
    if (localGuide) return localGuide;
    const me = store.me.id;
    for (const p of peers) {
      const g = p.guide;
      if (g && (g.for === me || (g.for === "local:*" && me.startsWith("local:"))))
        return { ...g, name: p.user.name };
    }
    return null;
  }, [peers, store.me.id, localGuide]);
  const followed = useRef("");
  const guideFolded = useRef(false);
  useEffect(() => {
    if (guide || !guideFolded.current) return;
    guideFolded.current = false;
    setSidebar(true);
  }, [guide]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!guide || !following) return;
    const k = `${guide.by}:${guide.seq}:${guide.diagram}`;
    if (followed.current === k) return;
    followed.current = k;
    if (guide.diagram !== diagramId) (via("guide"), go(guide.diagram, guide.object ?? null));
    setFlowId(guide.flow ?? null);
    setStep(guide.step ?? -1);
    setTag(guide.tag ?? null);
    // The agent's bar tells the story: the drawer folds away for the tour, and comes back after.
    if (sidebar && !guideFolded.current) {
      guideFolded.current = true;
      setSidebar(false);
    }
  }, [guide, following]); // eslint-disable-line react-hooks/exhaustive-deps
  // Once the view is showing, glide to what the step is about.
  useEffect(() => {
    if (!guide || !following || guide.diagram !== diagramId || !ready) return;
    const s = scene.current;
    if (!s) return;
    if (guide.objects?.length) {
      s.select({ nodes: guide.objects, edge: null }, true);
      s.frameBoxes(guide.objects);
    } else if (guide.object) {
      s.select({ nodes: [guide.object], edge: null }, true);
      s.centerOn(guide.object, true);
    } else {
      // A flow step or a tag: nothing selected, so the box panel isn't in the way.
      s.select({ nodes: [], edge: null }, true);
      if (guide.tag) s.frameBoxes(boxesWithTag(idx, diagramId, guide.tag));
    }
  }, [guide?.seq, following, diagramId, ready]); // eslint-disable-line react-hooks/exhaustive-deps
  const [asking, setAsking] = useState("");
  // The bar you closed, until the agent points again (a new step shows it again).
  const [closedGuide, setClosedGuide] = useState<string | null>(null);
  const answer = (action: "next" | "back" | "stop" | "ask", text?: string) => {
    if (!guide) return;
    if (guide === localGuide) {
      const r = localReply.current;
      localReply.current = null;
      r?.({ action, ...(text ? { text } : {}) });
      if (action === "stop") setLocalGuide(null);
      setAsking("");
      return;
    }
    void backend.guide
      ?.reply(store.design, { seq: guide.seq, action, ...(text ? { text } : {}) })
      .catch(() => {});
    if (action === "stop") setFollowing(false);
    setAsking("");
  };
  return {
    following,
    setFollowing,
    setLocalGuide,
    localReply,
    guide,
    followed,
    asking,
    setAsking,
    closedGuide,
    setClosedGuide,
    answer,
  };
}
