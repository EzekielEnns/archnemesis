// Icons for boxes: a kind's icon (drawn white, tinted per use) and a technology's logo in
// its brand colour, loaded once and kept.
import { Texture } from "pixi.js";
import { kindSvg } from "../kindIcons";
import type { NodeKind } from "../types";
import { requestRender } from "./frame";
import type { SceneState } from "./state";
import { THEME } from "./theme";

/** A kind's icon, drawn white to be tinted; null until it has loaded (the cards are redrawn then). */
export function kindTexture(state: SceneState, kind: NodeKind): Texture | null {
  const hit = state.kindIcons.get(kind);
  if (hit === undefined) {
    state.kindIcons.set(kind, "loading");
    const img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(kindSvg(kind, "#ffffff"))}`;
    void img.decode().then(() => {
      if (state.destroyed) return;
      state.kindIcons.set(kind, Texture.from(img));
      for (const v of [...state.order])
        if (v.node.kind === kind) state.replaceView(v, v.node, v.sig);
      requestRender(state);
    });
    return null;
  }
  return hit === "loading" ? null : hit;
}

/** The logo for a technology: null until it has loaded (the card is redrawn then), or if there's none. */
export function iconTexture(
  state: SceneState,
  technology: string,
): { tex: Texture; color: number } | null {
  const key = technology.trim().toLowerCase();
  if (!key) return null;
  const hit = state.icons.get(key);
  if (hit === undefined) {
    state.icons.set(key, "loading");
    void loadIcon(state, key, technology);
    return null;
  }
  return hit === "loading" ? null : hit;
}

async function loadIcon(state: SceneState, key: string, technology: string): Promise<void> {
  try {
    // The loader is Scene's to choose (the app's own route unless the caller passed one); it
    // answers the SVG text, or null when there is no logo.
    const svg = await state.fetchIcon(technology, "brand");
    if (svg === null) {
      state.icons.set(key, null);
      return;
    }
    const img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await img.decode();
    if (state.destroyed) return;
    const fill = /fill="#([0-9a-f]{6})"/i.exec(svg)?.[1];
    state.icons.set(key, {
      tex: Texture.from(img),
      color: fill ? parseInt(fill, 16) : THEME.subtitle,
    });
    for (const v of [...state.order]) {
      if (v.node.technology.trim().toLowerCase() === key) state.replaceView(v, v.node, v.sig);
    }
    requestRender(state);
  } catch (e) {
    console.warn(`archnm: no icon for ${technology}`, e);
    state.icons.set(key, null);
  }
}
