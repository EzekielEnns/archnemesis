// The arrow router, off the main thread. libavoid's cost climbs steeply with arrows (57
// arrows on a tall diagram: seconds), and on the page that froze every jump to a big view.
// Here it routes while the canvas stays live; curves show until the routes come back.
//
// One router per set of boxes (a diagram, in effect), the last few kept: going back to a
// diagram reuses its router, and with nothing changed that's a no-op.
/// <reference lib="webworker" />
import { AvoidLib } from "libavoid-js";
import wasmUrl from "../../node_modules/libavoid-js/dist/libavoid.wasm?url";
import { EdgeRouter, type RouterEdge } from "../../shared/router.ts";
import type { Point, Rect } from "../../shared/geometry.ts";

export interface RouteRequest {
  seq: number;
  key: string;
  boxes: [string, Rect][];
  edges: RouterEdge[];
  style: "elbow" | "straight";
}
export type RouteReply =
  | { seq: number; key: string; paths: [string, Point[]][] }
  | { seq: number; key: string; error: string };

const KEEP = 6;
const routers = new Map<string, EdgeRouter>();
const lib = AvoidLib.load(wasmUrl).then(() => AvoidLib.getInstance());

self.onmessage = async (e: MessageEvent<RouteRequest>) => {
  const { seq, key, boxes, edges, style } = e.data;
  try {
    const A = await lib;
    let r = routers.get(key);
    if (r) routers.delete(key);
    else r = new EdgeRouter(A);
    routers.set(key, r); // most recent last
    while (routers.size > KEEP) {
      const [old, gone] = routers.entries().next().value!;
      routers.delete(old);
      gone.destroy();
    }
    r.sync(new Map(boxes), edges, style);
    const paths: [string, Point[]][] = [];
    for (const ed of edges) {
      const p = r.path(ed.id);
      if (p) paths.push([ed.id, p]);
    }
    self.postMessage({ seq, key, paths } satisfies RouteReply);
  } catch (err) {
    routers.get(key)?.destroy();
    routers.delete(key);
    self.postMessage({
      seq,
      key,
      error: String((err as Error)?.message ?? err),
    } satisfies RouteReply);
  }
};
