// The whole diagram as a PNG.
import { Graphics } from "pixi.js";
import { applyLabelVisibility } from "./frame";
import type { SceneState } from "./state";
import { THEME } from "./theme";
import { setCamera } from "./view";

/** The whole diagram as a PNG, at 2x, on the canvas background. */
export async function exportPng(state: SceneState): Promise<Blob | null> {
  if (!state.ready || !state.order.length) return null;
  const saved = {
    camera: state.camera,
    overlay: state.overlay.visible,
    grid: state.grid?.visible ?? false,
  };
  state.overlay.visible = false;
  state.edgeHighlight.visible = false;
  for (const v of state.order) v.root.visible = true;
  applyLabelVisibility(state, true);
  const prevLabels = state.labels;
  for (const v of state.order) {
    v.title.visible = true;
    v.subtitle.visible = true;
  }
  state.edgeLabels.visible = true;
  const bounds = state.world.getLocalBounds();
  const pad = 48;
  const bg = new Graphics()
    .rect(bounds.x - pad, bounds.y - pad, bounds.width + pad * 2, bounds.height + pad * 2)
    .fill(THEME.bg);
  state.world.addChildAt(bg, 0);
  state.world.position.set(0, 0);
  state.world.scale.set(1);
  try {
    const canvas = state.app.renderer.extract.canvas({
      target: state.world,
      resolution: 2,
    }) as HTMLCanvasElement;
    return await new Promise<Blob | null>((ok) => canvas.toBlob((b) => ok(b), "image/png"));
  } finally {
    bg.destroy();
    state.overlay.visible = saved.overlay;
    state.edgeHighlight.visible = true;
    state.labels = prevLabels;
    setCamera(state, saved.camera);
    applyLabelVisibility(state, true);
  }
}
