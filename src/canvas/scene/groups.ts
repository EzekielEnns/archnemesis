// Frames behind the boxes: a file or package around its functions, a box opened in place,
// lanes, boundaries (dashed) and the diagram's own frame.
import { BitmapText, Graphics } from "pixi.js";
import type { CanvasGroup, NodeKind } from "../types";
import { clip } from "./measure";
import type { SceneState } from "./state";
import { BOUNDARY_COLOR, BOUNDARY_LABEL, FONT, KIND_COLOR, mixColor, THEME } from "./theme";

export function drawGroups(state: SceneState, groups: CanvasGroup[]): void {
  state.groupList = groups;
  if (state.selectedBoundary && !groups.some((g) => g.id === `boundary:${state.selectedBoundary}`))
    state.selectedBoundary = null;
  if (state.selectedScope && !groups.some((g) => !g.boundary && !g.lane && !g.container))
    state.selectedScope = false;
  for (const child of [...state.groupLayer.children]) child.destroy({ children: true });
  for (const grp of groups) {
    if (grp.inset) {
      // A box opened in place: a diagram inside the diagram, tinted and edged in its box's
      // kind colour; its name and close are an HTML tab over the top edge.
      const col = (grp.kind && KIND_COLOR[grp.kind as NodeKind]) || THEME.select;
      const on = state.selectedBoundary === grp.id.slice("boundary:".length);
      const g = new Graphics()
        .roundRect(grp.x, grp.y, grp.w, grp.h, 14)
        .fill({ color: mixColor(0x161a22, col, 0.08), alpha: 0.92 })
        .stroke({ color: col, width: on ? 2.5 : 1.5, alpha: on ? 1 : 0.8 });
      state.groupLayer.addChild(g);
      continue;
    }
    if (grp.boundary) {
      drawBoundary(state, grp);
      continue;
    }
    if (grp.container) {
      // A file or package around its functions: a quiet frame, its name in code type.
      const col = KIND_COLOR[grp.container];
      const on = state.selected.has(grp.id);
      const g = new Graphics()
        .roundRect(grp.x, grp.y, grp.w, grp.h, 10)
        .fill({ color: THEME.group, alpha: 0.7 })
        .stroke({ color: on ? THEME.select : col, width: on ? 2 : 1, alpha: on ? 1 : 0.35 });
      const t = new BitmapText({
        text: clip(grp.name, 60),
        style: { fontFamily: FONT, fontSize: 12 },
      });
      t.tint = col;
      t.position.set(grp.x + 10, grp.y + 6);
      state.groupLayer.addChild(g, t);
      continue;
    }
    if (grp.lane) {
      // A lane: a faint column with its value on top, under everything else.
      const g = new Graphics()
        .roundRect(grp.x, grp.y, grp.w, grp.h, 12)
        .fill({ color: THEME.group, alpha: 0.45 })
        .stroke({ color: THEME.groupStroke, width: 1, alpha: 0.5 });
      const t = new BitmapText({
        text: clip(grp.name.toUpperCase(), 40),
        style: { fontFamily: FONT, fontSize: 13 },
      });
      t.tint = THEME.groupTitle;
      t.alpha = 0.8;
      // Top right, so a boundary's title (top left) never lands on it.
      t.position.set(grp.x + grp.w - 16 - t.width, grp.y + 12);
      state.groupLayer.addChild(g, t);
      continue;
    }
    const g = new Graphics()
      .roundRect(grp.x, grp.y, grp.w, grp.h, 16)
      .fill({ color: THEME.group, alpha: 0.85 })
      .stroke({ color: THEME.groupStroke, width: 1.5 });
    const t = new BitmapText({
      text: clip(grp.name, 40),
      style: { fontFamily: FONT, fontSize: 16 },
    });
    t.tint = THEME.groupTitle;
    t.position.set(grp.x + 18, grp.y + 12);
    state.groupLayer.addChild(g, t);
  }
}

/** A boundary (project, network…): a dashed frame, its name, and its kind in small type. */
function drawBoundary(state: SceneState, grp: CanvasGroup): void {
  const color = BOUNDARY_COLOR[grp.boundary!] ?? THEME.groupStroke;
  const g = new Graphics()
    .rect(grp.x, grp.y, grp.w, grp.h)
    .fill({ color, alpha: 0.035 + 0.02 * (grp.depth ?? 0) });
  const dash = 12;
  const gap = 7;
  const line = (x1: number, y1: number, x2: number, y2: number) => {
    const len = Math.hypot(x2 - x1, y2 - y1);
    for (let d = 0; d < len; d += dash + gap) {
      const e = Math.min(d + dash, len);
      g.moveTo(x1 + ((x2 - x1) * d) / len, y1 + ((y2 - y1) * d) / len).lineTo(
        x1 + ((x2 - x1) * e) / len,
        y1 + ((y2 - y1) * e) / len,
      );
    }
  };
  const { x, y, w, h } = grp;
  line(x, y, x + w, y);
  line(x + w, y, x + w, y + h);
  line(x + w, y + h, x, y + h);
  line(x, y + h, x, y);
  g.stroke({ color, width: 1.5, alpha: 0.9 });
  const t = new BitmapText({
    text: clip(grp.name, 48),
    style: { fontFamily: FONT, fontSize: 15 },
  });
  t.tint = color;
  t.position.set(x + 14, y + 8);
  const k = new BitmapText({
    text: BOUNDARY_LABEL[grp.boundary!] ?? grp.boundary!,
    style: { fontFamily: FONT, fontSize: 11 },
  });
  k.tint = color;
  k.alpha = 0.6;
  k.position.set(x + 14 + t.width + 8, y + 11);
  state.groupLayer.addChild(g, t, k);
}
