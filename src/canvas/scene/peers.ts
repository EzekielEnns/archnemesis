// Other people here: their cursors, their selections and the boxes they are dragging.
import { BitmapText } from "pixi.js";
import { requestRender } from "./frame";
import type { SceneState } from "./state";
import { FONT } from "./theme";
import type { Peer } from "./types";

/** Show who else is here. Cheap: one Graphics and a label per person. */
export function setPeers(state: SceneState, peers: Peer[]): void {
  state.peers = peers;
  if (!state.ready) return;
  drawPeers(state);
  requestRender(state);
}

export function drawPeers(state: SceneState): void {
  const g = state.peerGfx;
  g.clear();
  const s = state.camera.scale;
  const seen = new Set<number>();
  for (const p of state.peers) {
    const color = p.color;
    for (const id of p.selected) {
      const n = state.views.get(id)?.node;
      if (n)
        g.roundRect(n.x - 5, n.y - 5, n.w + 10, n.h + 10, 14).stroke({
          color,
          width: 2 / s,
          alpha: 0.9,
        });
    }
    for (const m of p.moving) {
      g.roundRect(m.x, m.y, m.w, m.h, 10)
        .fill({ color, alpha: 0.12 })
        .stroke({ color, width: 1.5 / s });
    }
    if (!p.cursor) continue;
    const { x, y } = p.cursor;
    const k = 1 / s;
    g.poly([x, y, x + 3 * k, y + 15 * k, x + 7 * k, y + 10 * k, x + 13 * k, y + 9 * k], true)
      .fill({ color })
      .stroke({ color: 0x0b0d12, width: k });
    let label = state.peerLabels.get(p.key);
    if (!label) {
      label = new BitmapText({
        text: "",
        style: { fontFamily: FONT, fontSize: 12, fill: 0xffffff },
      });
      state.peerLabels.set(p.key, label);
      state.peerLayer.addChild(label);
    }
    label.text = p.name;
    label.tint = color;
    label.scale.set(k);
    label.position.set(x + 12 * k, y + 14 * k);
    label.visible = true;
    seen.add(p.key);
  }
  for (const [key, label] of state.peerLabels) {
    if (seen.has(key)) continue;
    label.destroy();
    state.peerLabels.delete(key);
  }
}
