import { DRAWER_W } from "./constants";
// The canvas: made once, drawn whenever the model or the diagram changes (and its camera kept
// per diagram), and the things only it needs, such as its callbacks' connection maker, the
// minimap and arrow-animation switches, the zoom and where the pointer last was.
import { useCallback, useEffect, useRef, useState } from "react";
import { connect } from "../../shared/actions.ts";
import { type CanvasGraph } from "../../shared/project.ts";
import { Scene } from "../canvas/Scene";
import type { Store } from "../store";

import { parseHash } from "../route";
import type { LatestRef } from "./latest";
import { sceneCallbacks, type SceneDeps } from "./sceneCallbacks";
import { useStoredFlag } from "./useStored";
import type { useSceneRefs } from "./useSceneRefs";

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
  dock,
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
  dock: number;
  deps: Omit<SceneDeps, "store" | "latest" | "open" | "makeConnection" | "pointer" | "setZoom">;
}) {
  const { host, scene, cameras, shown, ready, setReady } = refs;
  const [zoom, setZoom] = useState(1);
  /** Where the pointer last was on the canvas (world): where a paste goes. */
  const pointer = useRef<{ x: number; y: number } | null>(null);
  // The canvas never resizes for the drawer; it just knows what's covered.
  useEffect(
    () => scene.current?.setInsetLeft(sidebar ? DRAWER_W + 12 : dock),
    [sidebar, dock, ready],
  );
  const [minimap, setMinimap] = useStoredFlag("archnm.minimap.open", false);
  const [animate, setAnimate] = useStoredFlag("archnm.arrows.all", false);

  /** Make a connection and say what it did, since it may land on an arrow that's already there. */
  const makeConnection = useCallback((from: string, to: string, s: Scene) => {
    const { idx: i, run: r, graph: g, toast: say } = latest.current;
    const { ops, connection } = connect(from, to);
    const key = `${from}>${to}`;
    const existing = g?.edges.find((e) => e.id === key);
    const name = (id: string) => i.objects.get(id)?.name ?? "?";
    void r(ops, `connect ${name(from)} → ${name(to)}`).then(() => {
      if (existing)
        say(
          `Added to the arrow ${name(from)} → ${name(to)}: now ${existing.connectionIds.length + 1} connections`,
        );
    });
    // Select the new arrow, so it can be named straight away (in simple mode, in its card).
    setTimeout(() => {
      s.select({ nodes: [], edge: `${connection.fromId}>${connection.toId}` }, true);
      if (latest.current.simple)
        latest.current.openFresh(`${connection.fromId}>${connection.toId}`);
    }, 60);
  }, []);
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
