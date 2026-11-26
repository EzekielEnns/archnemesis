// Starting and stopping the canvas: Pixi, the dot grid, the layers, and tearing it all down.
import { BitmapFont, Graphics, TilingSprite } from "pixi.js";
import { bindInput } from "./input";
import type { SceneState } from "./state";
import { FONT, GRID, THEME } from "./theme";
import { setCamera } from "./view";

/** Resolves false if the scene was destroyed while Pixi was starting. */
export async function init(state: SceneState, host: HTMLElement): Promise<boolean> {
  const { width, height } = host.getBoundingClientRect();
  await state.app.init({
    width: Math.max(1, width),
    height: Math.max(1, height),
    background: THEME.bg,
    antialias: true,
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
    autoStart: false,
    preference: "webgl",
  });
  if (state.destroyed) {
    state.app.destroy(true, { children: true });
    return false;
  }
  state.app.ticker.stop();
  state.app.stage.eventMode = "none";
  state.size = { w: Math.max(1, width), h: Math.max(1, height) };
  host.appendChild(state.app.canvas);

  BitmapFont.install({
    name: FONT,
    style: {
      fontFamily: "Inter, -apple-system, system-ui, sans-serif",
      fontSize: 40,
      fill: 0xffffff,
    },
    // What almost every label uses: ASCII, Latin-1 (café, Zürich), typographic punctuation and
    // the four arrows. Anything else in Latin Extended (Łódź) or the arrows block is added the
    // first time a label uses it. Kept short on purpose: Pixi measures every pair of these for
    // kerning when the font is made, which blocked the page for about a second with 460 of them.
    // Other scripts (CJK, emoji) draw as gaps.
    chars: [[" ", "~"], ["\u00a0", "\u00ff"], ["\u2010", "\u2027"], "←↑→↓↔", "✦", "★", "✓", "✗"],
    resolution: Math.max(3, (window.devicePixelRatio || 1) * 1.5),
  });

  state.grid = makeGrid(state);
  state.minimap.addChild(state.miniBg, state.miniNodes, state.miniView);
  state.app.stage.addChild(state.grid, state.world, state.minimap, state.screenOverlay);
  state.world.addChild(
    state.groupLayer,
    state.edgesStatic,
    state.edgesLive,
    state.edgeHighlight,
    state.flowDots,
    state.nodeLayer,
    // Over the boxes: placed clear of them where the line allows; otherwise better on top than cut off.
    state.edgeLabels,
    state.overlay,
    state.stepLayer,
    state.peerLayer,
  );
  state.peerLayer.addChild(state.peerGfx);

  bindInput(state, host);
  state.ready = true;
  setCamera(state, state.camera);
  return true;
}

export function destroy(state: SceneState): void {
  if (state.destroyed) return;
  state.destroyed = true;
  state.avoid?.destroy();
  state.avoid = null;
  for (const off of state.cleanup) off();
  if (state.statsTimer) clearTimeout(state.statsTimer);
  if (!state.ready) return;
  cancelAnimationFrame(state.watchSoon);
  state.watchers.clear();
  state.app.destroy(true, { children: true });
  for (const ctx of state.cardContexts.values()) ctx.destroy();
  BitmapFont.uninstall(FONT);
}

function makeGrid(state: SceneState): TilingSprite {
  const dot = new Graphics()
    .rect(0, 0, GRID, GRID)
    .fill(THEME.bg)
    .circle(GRID / 2, GRID / 2, 1.1)
    .fill(THEME.dot);
  const texture = state.app.renderer.generateTexture({ target: dot, resolution: 2 });
  dot.destroy();
  return new TilingSprite({ texture, width: state.size.w, height: state.size.h });
}
