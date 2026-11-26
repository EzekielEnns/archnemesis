// Building a box's display objects: its card, logo tile, name, subtitle, badges, tags and a
// table's columns, and replacing them when the box changes.
import { BitmapText, Container, Graphics, GraphicsContext, Sprite } from "pixi.js";
import type { Rect } from "../../../shared/geometry";
import { TABLE_HEAD, TABLE_ROW, tableShowsColumns } from "../../../shared/project.ts";
import type { CanvasNode } from "../types";
import { iconTexture, kindTexture } from "./icons";
import { baseAlpha, clip } from "./measure";
import type { SceneState } from "./state";
import { COLUMN_MARK, FONT, KIND_COLOR, KIND_WORD, RADIUS, THEME, TILE } from "./theme";
import type { NodeView } from "./types";

export function replaceView(state: SceneState, v: NodeView, n: CanvasNode, sig: string): NodeView {
  const view = makeView(state, n, sig);
  const i = state.order.indexOf(v);
  state.order[i] = view;
  state.views.set(n.id, view);
  state.nodeLayer.addChildAt(view.root, state.nodeLayer.getChildIndex(v.root));
  v.root.destroy({ children: true });
  view.title.visible = state.labels.title;
  view.subtitle.visible = state.labels.subtitle;
  view.root.visible = v.root.visible;
  view.root.alpha = baseAlpha(n) * (state.focus && !state.focus.nodes.has(n.id) ? 0.3 : 1);
  return view;
}

/**
 * The bottom of a box: what's inside, connections off the diagram, and its tags. Returns where
 * the off-diagram label is.
 */
function addFooter(root: Container, node: CanvasNode, inset: number): Rect | undefined {
  const foot = node.h - 17;
  // Bottom left: what's inside, and connections to things not on this diagram.
  let leftEnd = inset;
  let offDiagram: Rect | undefined;
  if (node.childCount > 0) {
    const n = new BitmapText({
      text: `${node.childCount} inside →`,
      style: { fontFamily: FONT, fontSize: 10 },
    });
    n.tint = THEME.badge;
    n.position.set(leftEnd, foot);
    root.addChild(n);
    leftEnd += n.width + 10;
  }
  if (node.hidden > 0) {
    const n = new BitmapText({
      text: `⇄ ${node.hidden} off diagram`,
      style: { fontFamily: FONT, fontSize: 10 },
    });
    n.tint = THEME.hidden;
    n.position.set(leftEnd, foot);
    root.addChild(n);
    offDiagram = { x: leftEnd - 4, y: foot - 4, w: n.width + 8, h: 18 };
    leftEnd += n.width + 10;
  }
  // Bottom right: tags, right to left, as many as fit.
  let x = node.w - 10;
  for (const t of node.tags) {
    const tag = new BitmapText({ text: t, style: { fontFamily: FONT, fontSize: 10 } });
    if (x - tag.width < leftEnd) break;
    x -= tag.width;
    tag.tint = t === "future" ? THEME.future : t === "deprecated" ? THEME.deprecated : THEME.badge;
    tag.position.set(x, foot);
    root.addChild(tag);
    x -= 8;
  }
  return offDiagram;
}

export function makeView(state: SceneState, node: CanvasNode, sig: string): NodeView {
  if (node.kind === "function") return makeSlimView(state, node, sig);
  const root = new Container();
  root.position.set(node.x, node.y);
  root.alpha = baseAlpha(node);
  const card = new Graphics(cardContext(state, node));
  // Left, a tile: the technology's logo in its brand colour on a tint of it; with no
  // known technology, the kind's icon in the kind's colour. Top right, the kind's icon
  // (when the tile holds a logo). Bottom right, tags written out.
  // The logo picked by hand ("none": no logo), else the one its technology suggests.
  const logo = iconTexture(
    state,
    node.icon ? (node.icon.trim().toLowerCase() === "none" ? "" : node.icon) : node.technology,
  );
  const kindTex = kindTexture(state, node.kind);
  const kindColor = KIND_COLOR[node.kind];
  const inset = node.kind === "actor" ? 16 : 12;
  const tileColor = logo ? logo.color : kindColor;
  const tile = new Graphics()
    .roundRect(inset, 12, TILE, TILE, 9)
    .fill({ color: tileColor, alpha: 0.16 });
  if (node.external)
    tile.roundRect(inset, 12, TILE, TILE, 9).stroke({ color: tileColor, alpha: 0.55, width: 1 });
  root.addChild(card, tile);
  const inTile = logo?.tex ?? kindTex;
  if (inTile) {
    const s = new Sprite(inTile);
    const size = logo ? 20 : 18;
    s.width = s.height = size;
    s.position.set(inset + (TILE - size) / 2, 12 + (TILE - size) / 2);
    if (!logo) s.tint = kindColor;
    root.addChild(s);
  }
  const left = inset + TILE + 10;
  const corner = logo && kindTex ? 22 : 0;
  const title = new BitmapText({
    text: clip(node.name, Math.max(6, Math.floor((node.w - left - 10 - corner) / 7.4))),
    style: { fontFamily: FONT, fontSize: 15 },
  });
  title.tint = THEME.title;
  title.position.set(left, 13);
  // What it's built with; with nothing known, what kind of thing it is.
  // A table says what it is and how many columns: "Table · 5 cols".
  const subText =
    node.kind === "table" ? node.subtitle : node.technology.trim() || KIND_WORD[node.kind];
  const subtitle = new BitmapText({
    text: clip(subText, Math.max(6, Math.floor((node.w - left - 10) / 5.6))),
    style: { fontFamily: FONT, fontSize: 12 },
  });
  subtitle.tint = THEME.subtitleBright;
  subtitle.position.set(left, 35);
  root.addChild(title, subtitle);
  if (logo && kindTex) {
    const k = new Sprite(kindTex);
    k.width = k.height = 13;
    k.tint = kindColor;
    k.position.set(node.w - 23, 11);
    root.addChild(k);
  }
  // A table tall enough for its columns shows them, one row each, keys marked.
  if (node.kind === "table" && node.columns?.length && tableShowsColumns(node.h)) {
    drawColumns(root, node);
    return { node, sig, root, title, subtitle };
  }
  const offDiagram = addFooter(root, node, inset);
  return { node, sig, root, title, subtitle, offDiagram };
}

/** A table's columns under its name: a mark (PK, FK, UQ, PII), the name, its type on the right. */
function drawColumns(root: Container, node: CanvasNode): void {
  const cols = node.columns ?? [];
  const fits = Math.max(1, Math.floor((node.h - TABLE_HEAD - 6) / TABLE_ROW));
  const shown = cols.length > fits ? cols.slice(0, fits - 1) : cols;
  const lines = new Graphics();
  lines.moveTo(1, TABLE_HEAD).lineTo(node.w - 1, TABLE_HEAD);
  for (let i = 1; i < shown.length + (shown.length < cols.length ? 1 : 0); i++)
    lines.moveTo(10, TABLE_HEAD + i * TABLE_ROW).lineTo(node.w - 10, TABLE_HEAD + i * TABLE_ROW);
  lines.stroke({ color: THEME.cardStroke, width: 1, alpha: 0.8 });
  root.addChild(lines);
  shown.forEach((c, i) => {
    const y = TABLE_HEAD + i * TABLE_ROW + 6;
    if (c.mark) {
      const m = COLUMN_MARK[c.mark];
      const t = new BitmapText({ text: m.word, style: { fontFamily: FONT, fontSize: 8.5 } });
      t.tint = m.fg;
      const chip = new Graphics().roundRect(10, y - 1, 24, 13, 3).fill({ color: m.bg });
      t.position.set(10 + (24 - t.width) / 2, y + 0.5);
      root.addChild(chip, t);
    }
    const typeText = `${c.type}${c.nullable ? "?" : ""}`;
    const type = new BitmapText({
      text: clip(typeText, 16),
      style: { fontFamily: FONT, fontSize: 10.5 },
    });
    type.tint = THEME.subtitle;
    type.position.set(node.w - 10 - type.width, y);
    const room = Math.max(4, Math.floor((node.w - 42 - type.width - 16) / 6.6));
    const name = new BitmapText({
      text: clip(c.name, room),
      style: { fontFamily: FONT, fontSize: 12 },
    });
    name.tint = c.mark === "pk" ? THEME.title : THEME.subtitleBright;
    name.position.set(40, y - 1);
    root.addChild(type, name);
  });
  if (shown.length < cols.length) {
    const more = new BitmapText({
      text: `+${cols.length - shown.length} more`,
      style: { fontFamily: FONT, fontSize: 10.5 },
    });
    more.tint = THEME.badge;
    more.position.set(40, TABLE_HEAD + shown.length * TABLE_ROW + 6);
    root.addChild(more);
  }
}

/** One shared drawing per look: thousands of cards, a handful of geometries. */
function cardContext(state: SceneState, n: CanvasNode): GraphicsContext {
  const gone = n.status === "removed";
  const key = `${n.kind}:${n.external}:${n.w}x${n.h}:${n.color ?? ""}:${gone}`;
  let ctx = state.cardContexts.get(key);
  if (!ctx) {
    const r = n.kind === "actor" ? n.h / 2.4 : RADIUS;
    ctx = new GraphicsContext()
      .roundRect(0, 0, n.w, n.h, r)
      .fill(n.external ? THEME.cardExternal : THEME.card);
    // Coloured by a tag group: a wash of the colour and a border in it.
    if (n.color) {
      const c = parseInt(n.color.slice(1), 16);
      ctx
        .roundRect(0, 0, n.w, n.h, r)
        .fill({ color: c, alpha: 0.1 })
        .stroke({ color: c, width: 2 });
    } else if (gone) {
      // Deleted here, still on main (a diff, or a view that shows removed things): a red wash and edge.
      ctx
        .roundRect(0, 0, n.w, n.h, r)
        .fill({ color: THEME.removed, alpha: 0.08 })
        .stroke({ color: THEME.removed, width: 1.5, alpha: 0.85 });
    } else
      ctx.stroke({ color: n.external ? THEME.cardStrokeExternal : THEME.cardStroke, width: 1 });
    state.cardContexts.set(key, ctx);
  }
  return ctx;
}

/**
 * A function: a slim box with its kind's icon, its name, and what it is. No stripe on
 * its edge: arrows land on the edges, and a stripe there reads as part of the arrowhead.
 */
function makeSlimView(state: SceneState, node: CanvasNode, sig: string): NodeView {
  const root = new Container();
  root.position.set(node.x, node.y);
  root.alpha = baseAlpha(node);
  const card = new Graphics(cardContext(state, node));
  const color = KIND_COLOR[node.kind];
  const what = node.technology.trim();
  const top = what ? 5 : (node.h - 15) / 2;
  const tex = kindTexture(state, node.kind);
  const icon = tex ? new Sprite(tex) : null;
  if (icon) {
    icon.width = icon.height = 13;
    icon.tint = color;
    icon.alpha = 0.85;
    icon.position.set(10, top + 1.5);
  }
  const left = 29;
  const title = new BitmapText({
    text: clip(node.name, Math.max(6, Math.floor((node.w - left - 10) / 7))),
    style: { fontFamily: FONT, fontSize: 13 },
  });
  title.tint = color;
  title.position.set(left, top);
  const subtitle = new BitmapText({
    text: clip(what, Math.max(6, Math.floor((node.w - left - 10) / 5.4))),
    style: { fontFamily: FONT, fontSize: 10.5 },
  });
  subtitle.tint = THEME.subtitle;
  subtitle.position.set(left, 22);
  subtitle.visible = !!what;
  root.addChild(card, ...(icon ? [icon] : []), title, subtitle);
  let offDiagram: Rect | undefined;
  if (node.hidden > 0) {
    const n = new BitmapText({
      text: `⇄ ${node.hidden}`,
      style: { fontFamily: FONT, fontSize: 10 },
    });
    n.tint = THEME.hidden;
    n.position.set(node.w - n.width - 8, 5);
    root.addChild(n);
    offDiagram = { x: node.w - n.width - 12, y: 1, w: n.width + 8, h: 18 };
  }
  return { node, sig, root, title, subtitle, offDiagram };
}
