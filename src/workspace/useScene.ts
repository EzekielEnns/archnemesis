import { DRAWER_W, PANEL_ROOM } from "./constants";
// The canvas: made once, drawn whenever the model or the diagram changes (and its camera kept
// per diagram), and the things only it needs, such as its callbacks' connection maker, the
// minimap and arrow-animation switches, the zoom and where the pointer last was.
import { useCallback, useEffect, useRef, useState } from "react";
import { connect } from "../../shared/actions.ts";
import type { Op } from "../../shared/model.ts";
import type { ModelIndex } from "../../shared/project.ts";
import { type CanvasGraph } from "../../shared/project.ts";
import { Scene } from "../canvas/Scene";
import type { Store } from "../store";

import { parseHash } from "../route";
import type { LatestRef } from "./latest";
import { sceneCallbacks, type SceneDeps } from "./sceneCallbacks";
import { useStoredFlag } from "./useStored";
import type { useSceneRefs } from "./useSceneRefs";

type XY = { x: number; y: number };

/**
 * Drawn off the arrow `like`: the two part at a split point, the one that arrow has or else
 * where this was drawn off it (its bends were for the way it went before). An arrow that's
 * already through a point of its own stays there.
 */
function splitOps(i: ModelIndex, d: string, from: string, to: string, like: string, at?: XY): Op[] {
  const was = i.arrows.get(`${d}|${like}`);
  const there = i.arrows.get(`${d}|${from}>${to}`);
  const split = was?.split ?? at;
  const likeTo = like.slice(from.length + 1);
  if (!split || likeTo === to || there?.split) return [];
  const ops: Op[] = [{ op: "arrow.put", arrow: { ...there, diagramId: d, from, to, split } }];
  if (!was?.split)
    ops.push({
      op: "arrow.put",
      arrow: { ...was, diagramId: d, from, to: likeTo, bends: undefined, split },
    });
  return ops;
}

/**
 * Dropped on the arrow `onto`: the two meet at a join point (the one that arrow has, or else
 * where this was dropped on it) and go into the box as one line.
 */
function joinOps(i: ModelIndex, d: string, from: string, to: string, onto: string, at: XY): Op[] {
  const had = i.arrows.get(`${d}|${onto}`);
  const there = i.arrows.get(`${d}|${from}>${to}`);
  if (onto === `${from}>${to}` || there?.join) return [];
  const join = had?.join ?? at;
  const ops: Op[] = [{ op: "arrow.put", arrow: { ...there, diagramId: d, from, to, join } }];
  if (!had?.join)
    ops.push({
      op: "arrow.put",
      arrow: {
        ...had,
        diagramId: d,
        from: onto.slice(0, -to.length - 1),
        to,
        bends: undefined,
        join,
      },
    });
  return ops;
}

export function useScene({
  store,
  latest,
  refs,
  open,
  drawn,
  graph,
  diagramId,
  route,
  sidebar,
  leftPanel,
  deps,
}: {
  store: Store;
  latest: LatestRef;
  refs: ReturnType<typeof useSceneRefs>;
  open: (objectId: string) => void;
  drawn: CanvasGraph | null;
  graph: CanvasGraph | null;
  diagramId: string | null;
  route: ReturnType<typeof parseHash>;
  sidebar: boolean;
  /** The left panel is open (it floats over the canvas). */
  leftPanel: boolean;
  deps: Omit<SceneDeps, "store" | "latest" | "open" | "makeConnection" | "pointer" | "setZoom">;
}) {
  const { host, scene, cameras, shown, ready, setReady } = refs;
  const [zoom, setZoom] = useState(1);
  /** Where the pointer last was on the canvas (world): where a paste goes. */
  const pointer = useRef<{ x: number; y: number } | null>(null);
  // The canvas never resizes for the drawer; it just knows what's covered.
  useEffect(
    () => scene.current?.setInsetLeft(sidebar ? DRAWER_W + 12 : leftPanel ? PANEL_ROOM : 0),
    [sidebar, leftPanel, ready],
  );
  const [minimap, setMinimap] = useStoredFlag("archnm.minimap.open", false);
  const [animate, setAnimate] = useStoredFlag("archnm.arrows.all", false);

  /** Make a connection and say what it did, since it may land on an arrow that's already there. */
  const makeConnection = useCallback(
    (
      from: string,
      to: string,
      s: Scene,
      like?: string,
      at?: XY,
      join?: { onto: string; at: XY },
    ) => {
      const { idx: i, run: r, graph: g, toast: say, diagramId: d, spread: sp } = latest.current;
      const up = (p: XY) => ({ x: p.x, y: Math.round(sp.up(p.y)) });
      // Drawn off an arrow: a branch of it, so it's the same connection to one more box.
      const src = like
        ? i.connections.get(g?.edges.find((e) => e.id === like)?.connectionIds[0] ?? "")
        : undefined;
      const made = connect(
        from,
        to,
        src
          ? { name: src.name, technology: src.technology, status: src.status, both: src.both }
          : {},
      );
      const { connection } = made;
      const ops: Op[] = [
        ...made.ops,
        ...(d && src && like ? splitOps(i, d, from, to, like, at && up(at)) : []),
        ...(d && join ? joinOps(i, d, from, to, join.onto, up(join.at)) : []),
      ];
      const key = `${from}>${to}`;
      const existing = g?.edges.find((e) => e.id === key);
      const name = (id: string) => i.objects.get(id)?.name ?? "?";
      void r(ops, `connect ${name(from)} → ${name(to)}`).then(() => {
        if (existing)
          say(
            `Added to the arrow ${name(from)} → ${name(to)}: now ${existing.connectionIds.length + 1} connections`,
          );
      });
      // Select the new arrow and name it where its label goes: type, Enter, and that's its label.
      // The arrow is drawn once the model has it (and, routed, once its route is back): wait for it.
      // A branch has its arrow's name (or, like it, none).
      if (src) return;
      const named = (tries: number) => {
        const at = latest.current.idx.connections.has(connection.id)
          ? s.edgeLabelClient(key)
          : null;
        if (!at) return void (tries > 0 && setTimeout(() => named(tries - 1), 60));
        s.select({ nodes: [], edge: key }, true);
        deps.setEdgeEdit({ connectionId: connection.id, x: at.x, y: at.y });
      };
      setTimeout(() => named(20), 60);
    },
    [],
  );
  // The canvas, created once.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const s: Scene = new Scene(
      sceneCallbacks({ ...deps, store, latest, open, makeConnection, pointer, setZoom }, () => s),
    );
    void s.init(el).then((ok) => {
      if (!ok) return;
      scene.current = s;
      // For profiling from the console; dev builds only.
      if (import.meta.env.DEV) (window as unknown as { __scene: Scene }).__scene = s;
      setReady(true);
    });
    return () => {
      scene.current = null;
      setReady(false);
      s.destroy();
    };
  }, [open, makeConnection]);

  // Draw the diagram whenever the model or the diagram changes.
  useEffect(() => {
    const s = scene.current;
    if (!s || !ready || !drawn || !diagramId) return;
    s.sync(drawn);
    if (shown.current !== diagramId) {
      if (shown.current) cameras.current.set(shown.current, s.getCamera());
      shown.current = diagramId;
      const cam = cameras.current.get(diagramId);
      if (cam) s.setView(cam);
      else s.fit();
      s.select({ nodes: route.objectId ? [route.objectId] : [], edge: null }, true);
      if (route.objectId) s.centerOn(route.objectId);
    }
  }, [drawn, diagramId, ready, route.objectId]);

  // A link to an object on the diagram already open (from an agent, say): select it.
  useEffect(() => {
    const s = scene.current;
    if (!s || !ready || !route.objectId || shown.current !== route.diagramId) return;
    s.select({ nodes: [route.objectId], edge: null }, true);
    s.centerOn(route.objectId);
  }, [route.objectId, route.diagramId, ready]);

  const empty = graph !== null && graph.nodes.length === 0;
  // The map: closed unless asked for, and never on an empty diagram.
  useEffect(() => scene.current?.toggleMinimap(minimap && !empty), [minimap, ready, empty]);
  useEffect(() => scene.current?.setAnimate(animate), [animate, ready]);
  return { pointer, zoom, minimap, setMinimap, animate, setAnimate, empty };
}
