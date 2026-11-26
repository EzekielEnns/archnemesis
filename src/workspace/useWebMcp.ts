// WebMCP (src/webmcp.ts): the agent tools, for an agent in this page when the browser has it.
// Its canvas is this one: "show" steers it through the local guide (useTour), "here" reads it.
import { useEffect, useRef } from "react";
import { type Selection } from "../canvas/Scene";
import type { Store } from "../store";

import type { Canvas, StopReply } from "../../shared/tools/host";
import { registerWebMcp } from "../webmcp";
import type { useTour } from "./useTour";

export function useWebMcp({
  store,
  diagramId,
  sel,
  localReply,
  setFollowing,
  setClosedGuide,
  setLocalGuide,
}: {
  store: Store;
  diagramId: string | null;
  sel: Selection;
  localReply: ReturnType<typeof useTour>["localReply"];
  setFollowing: ReturnType<typeof useTour>["setFollowing"];
  setClosedGuide: ReturnType<typeof useTour>["setClosedGuide"];
  setLocalGuide: ReturnType<typeof useTour>["setLocalGuide"];
}) {
  // WebMCP (src/webmcp.ts): the agent tools, for an agent in this page when the browser has it.
  // Its canvas is this one: show steers it through the local guide above, here reads it.
  const looking = useRef({ diagramId, sel });
  looking.current = { diagramId, sel };
  const localSeq = useRef(0);
  useEffect(() => {
    const settle = (r: StopReply | null) => {
      const f = localReply.current;
      localReply.current = null;
      f?.(r);
    };
    const canvas: Canvas = {
      show: (stop, wait) => {
        settle(null);
        setFollowing(true);
        setClosedGuide(null);
        setLocalGuide({
          ...stop,
          for: store.me.id,
          by: "webmcp",
          seq: ++localSeq.current,
          waiting: !!wait,
          name: "Your agent",
        });
        if (!wait) return Promise.resolve(null);
        return new Promise<StopReply | null>((resolve) => {
          const done = (r: StopReply | null) => {
            clearTimeout(timer);
            wait.signal?.removeEventListener("abort", abort);
            resolve(r);
          };
          const abort = () => settle(null);
          const timer = setTimeout(() => settle(null), wait.ms);
          wait.signal?.addEventListener("abort", abort);
          localReply.current = done;
        });
      },
      end: () => {
        settle(null);
        setLocalGuide(null);
      },
      here: () => ({
        design: store.design,
        diagram: looking.current.diagramId ?? null,
        selection: looking.current.sel.nodes,
      }),
      watching: () => 1,
    };
    const off = registerWebMcp(store, () => canvas);
    return () => {
      off();
      settle(null);
    };
  }, [store]);
}
