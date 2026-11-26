// Story steps on the canvas: dots running along a flow's arrows, and the numbered badges and
// stars that go with them.
import { BitmapText, Container, Graphics } from "pixi.js";
import { visibleWorld } from "../camera";
import { type Point, type Route, route, routePoint } from "../../../shared/geometry";
import { frameOf } from "./lookup";
import type { SceneState } from "./state";
import { FONT, THEME } from "./theme";
import type { EdgeView } from "./types";

type Dots = (
  r: Route,
  back: boolean,
  color: number,
  alpha: number,
  size: number,
  speed: number,
) => void;

/** Draws dots running along one route: the painter drawFlowDots hands to each arrow. */
function dotsPainter(g: Graphics, still: boolean, px: number, t: number): Dots {
  return (r, back, color, alpha, size, speed) => {
    let len = 0;
    for (let i = 1, q = routePoint(r, 0); i <= 24; i++) {
      const n = routePoint(r, i / 24);
      len += Math.hypot(n.x - q.x, n.y - q.y);
      q = n;
    }
    len = Math.max(1, len);
    // One dot every 70 world units, at least two on a short arrow.
    const gap = Math.min(70, len / 2);
    const shift = still ? gap / 2 : (t * speed) % gap;
    for (let d = shift; d < len; d += gap) {
      const p = routePoint(r, back ? 1 - d / len : d / len);
      const fade = Math.min(1, d / 24, (len - d) / 24);
      g.circle(p.x, p.y, Math.max(size, size * 0.8 * px)).fill({ color, alpha: alpha * fade });
    }
  };
}

/** A playing flow's steps: bright, whatever else is on. Says whether any was drawn, and which arrows. */
function stepDots(state: SceneState, dots: Dots): { any: boolean; stepped: Set<EdgeView> } {
  let any = false;
  const stepped = new Set<EdgeView>();
  for (const st of state.spot?.steps ?? []) {
    if (st.from === st.to) continue;
    const fwd = state.edges.get(`${st.from}>${st.to}`);
    const back = fwd ? undefined : state.edges.get(`${st.to}>${st.from}`);
    let r: Route | undefined = (fwd ?? back)?.route;
    if (fwd ?? back) stepped.add((fwd ?? back)!);
    if (!r) {
      const a = state.views.get(st.from)?.node;
      const b = state.views.get(st.to)?.node;
      if (!a || !b) continue;
      r = route(a, b);
    }
    any = true;
    dots(r, !!back, THEME.select, 0.95, 3, 160);
  }
  return { any, stepped };
}

/** What's selected or lit always runs; every other arrow only if this person asked for it. */
function focusDots(state: SceneState, dots: Dots, stepped: Set<EdgeView>): boolean {
  let any = false;
  const v = visibleWorld(state.camera, state.size.w, state.size.h);
  for (const ev of new Set(state.edges.values())) {
    if (stepped.has(ev) || ev.edge.status === "deprecated") continue;
    const focused = state.focus?.edges.has(ev.edge.id) ?? false;
    if (state.focus && !focused) continue;
    const b = ev.box;
    if (b && (b.x1 < v.x || b.y1 < v.y || b.x0 > v.x + v.w || b.y0 > v.y + v.h)) continue;
    any = true;
    if (focused) dots(ev.route, false, state.spot ? THEME.select : THEME.edgeFocus, 0.9, 2.6, 120);
    else dots(ev.route, false, THEME.edgeLive, 0.45, 2, 60);
  }
  return any;
}

/**
 * A flow step plays: dots run along each of its arrows from the step's caller to what it
 * calls, so which way the traffic goes reads at a glance. True while there's something to
 * animate (the frame loop keeps going). Still dots, no motion, for reduced motion.
 */
export function drawFlowDots(state: SceneState, now: number): boolean {
  const g = state.flowDots;
  g.clear();
  const still =
    typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const px = 1 / state.camera.scale;
  const t = now / 1000;
  const dots = dotsPainter(g, still, px, t);
  const played = stepDots(state, dots);
  let any = played.any;
  if (!still && (state.focus || state.animateAll)) {
    if (focusDots(state, dots, played.stepped)) any = true;
  }
  return any && !still;
}

/** A flow's step numbers, the same size on screen at any zoom. */
export function drawSteps(state: SceneState, px: number): void {
  for (const c of state.stepLayer.removeChildren()) c.destroy({ children: true });
  // Two steps over one arrow sit side by side.
  const used = new Map<string, number>();
  for (const st of state.spot?.steps ?? []) {
    let at: Point | null = null;
    const ev = state.edges.get(`${st.from}>${st.to}`) ?? state.edges.get(`${st.to}>${st.from}`);
    const na = state.views.get(st.from)?.node;
    const nb = state.views.get(st.to)?.node;
    if (st.from === st.to && na) at = { x: na.x, y: na.y };
    else if (ev)
      at = ev.label
        ? { x: ev.label.position.x - ev.label.width / 2, y: ev.label.position.y }
        : routePoint(ev.route, 0.5);
    else if (na && nb) at = routePoint(route(na, nb), 0.5);
    if (!at) continue;
    const k = `${Math.round(at.x)},${Math.round(at.y)}`;
    const nth = used.get(k) ?? 0;
    used.set(k, nth + 1);
    const c = new Container();
    const t = new BitmapText({ text: String(st.n), style: { fontFamily: FONT, fontSize: 11 } });
    t.tint = 0xffffff;
    const r = Math.max(9, t.width / 2 + 5);
    const g = new Graphics()
      .circle(0, 0, r)
      .fill(THEME.select)
      .stroke({ color: 0x0f1115, width: 2 });
    t.position.set(-t.width / 2, -t.height / 2);
    c.addChild(g, t);
    c.scale.set(px);
    c.position.set(at.x - 12 * px + nth * 22 * px, at.y);
    state.stepLayer.addChild(c);
  }
  // ✦ on what's new, top right of the box (or the frame's title, for a file).
  for (const id of state.spot?.marked ?? []) {
    const n = state.views.get(id)?.node ?? frameOf(state, id);
    if (!n) continue;
    const c = new Container();
    const g = new Graphics()
      .circle(0, 0, 9)
      .fill(THEME.edgePath)
      .stroke({ color: 0x0f1115, width: 2 });
    const t = new BitmapText({ text: "✦", style: { fontFamily: FONT, fontSize: 11 } });
    t.tint = 0x1a1406;
    t.position.set(-t.width / 2, -t.height / 2 - 0.5);
    c.addChild(g, t);
    c.scale.set(px);
    c.position.set(n.x + n.w - 2 * px, n.y + 2 * px);
    state.stepLayer.addChild(c);
  }
}
