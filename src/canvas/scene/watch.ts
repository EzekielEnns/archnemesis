// Telling things drawn over the canvas (notes, links) when the camera or a live drag moves.
import type { SceneState } from "./state";
import type { SceneView } from "./types";

/** Follow the camera and live drags (for notes drawn over the canvas). Returns an unwatch. */
export function watch(state: SceneState, fn: (v: SceneView) => void): () => void {
  state.watchers.add(fn);
  fn({ camera: state.camera, moving: state.moving });
  return () => state.watchers.delete(fn);
}

/** Arrows moved (a reroute, a live drag): tell watchers once this frame. */
export function tellWatchersSoon(state: SceneState): void {
  if (state.watchSoon || !state.watchers.size) return;
  state.watchSoon = requestAnimationFrame(() => {
    state.watchSoon = 0;
    tellWatchers(state);
  });
}

export function tellWatchers(state: SceneState): void {
  const v = { camera: state.camera, moving: state.moving };
  for (const fn of state.watchers) fn(v);
}
