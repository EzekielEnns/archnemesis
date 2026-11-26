// The arrow router for the canvas: libavoid in a worker (routeWorker.ts), so a big diagram
// never freezes the page. The router itself is shared (shared/router.ts), so a server render
// routes the same.
import type { Point, Rect } from "../../shared/geometry.ts";
import type { RouterEdge } from "../../shared/router.ts";
import type { RouteReply, RouteRequest } from "./routeWorker";

export type { RouterEdge };

/** A short stable hash of which boxes are on the canvas: picks the worker's router. */
function keyOf(ids: Iterable<string>): string {
  let h = 2166136261;
  for (const id of [...ids].sort())
    for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

/**
 * Asks the worker for routes and keeps the latest. sync() returns at once; onRouted fires
 * when new routes arrive. Until then an arrow whose boxes moved has no path (it's drawn as
 * a curve), and the rest keep the path they had. Only the newest request waits: a burst
 * (a drag) routes the last position, not every step.
 */
export class AsyncRouter {
  private worker: Worker;
  private seq = 0;
  private busy = false;
  private next: RouteRequest | null = null;
  private key = "";
  private paths = new Map<string, Point[]>();
  /** The last routes per set of boxes, so going back to a diagram draws them at once. */
  private cache = new Map<string, Map<string, Point[]>>();
  private sent = new Map<string, Rect>();
  private ends = new Map<string, string>();
  failed = false;
  private onRouted: () => void;

  constructor(onRouted: () => void) {
    this.onRouted = onRouted;
    this.worker = new Worker(new URL("./routeWorker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e: MessageEvent<RouteReply>) => this.receive(e.data);
    this.worker.onerror = (e) => this.fail(e.message);
  }

  sync(boxes: Map<string, Rect>, edges: RouterEdge[], style: "elbow" | "straight"): void {
    if (this.failed) return;
    const key = `${keyOf(boxes.keys())}:${style}`;
    if (key !== this.key) {
      this.key = key;
      this.paths = new Map(this.cache.get(key) ?? []);
      this.sent.clear();
    }
    // An arrow whose end boxes moved, or whose ends changed, loses its old path until it's routed again.
    for (const e of edges) {
      const ends = `${e.from}>${e.to}:${e.fromSide ?? ""}${e.toSide ?? ""}`;
      const moved = [e.from, e.to].some((id) => {
        const was = this.sent.get(id);
        const now = boxes.get(id);
        return (
          !!was &&
          !!now &&
          (was.x !== now.x || was.y !== now.y || was.w !== now.w || was.h !== now.h)
        );
      });
      if (moved || (this.ends.has(e.id) && this.ends.get(e.id) !== ends)) this.paths.delete(e.id);
      this.ends.set(e.id, ends);
    }
    this.sent = new Map([...boxes].map(([id, r]) => [id, { ...r }]));
    const req: RouteRequest = { seq: ++this.seq, key, boxes: [...boxes], edges, style };
    if (this.busy) this.next = req;
    else this.post(req);
  }

  path(id: string): Point[] | null {
    return this.paths.get(id) ?? null;
  }

  destroy(): void {
    this.worker.terminate();
  }

  private post(req: RouteRequest) {
    this.busy = true;
    this.worker.postMessage(req);
  }

  private receive(r: RouteReply) {
    this.busy = false;
    const pending = this.next;
    this.next = null;
    if ("error" in r) {
      if (pending) this.post(pending);
      else
        console.warn(
          "archnm: arrow router failed on this diagram; its arrows stay curved",
          r.error,
        );
      return;
    }
    const routes = new Map(r.paths);
    this.cache.delete(r.key);
    this.cache.set(r.key, routes);
    while (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value!);
    if (pending) this.post(pending);
    // Stale (a newer request is on its way): keep it cached, but don't draw it.
    if (r.key !== this.key || r.seq !== this.seq) return;
    this.paths = new Map(routes);
    this.onRouted();
  }

  private fail(why: string) {
    console.warn("archnm: arrow router didn't load; arrows stay curved", why);
    this.failed = true;
    this.paths.clear();
    this.onRouted();
  }
}
