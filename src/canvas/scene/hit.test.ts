import type { Container } from "pixi.js";
import { describe, expect, it } from "vitest";
import { route, type Rect } from "../../../shared/geometry";
import type { CanvasEdge, CanvasGroup, CanvasNode } from "../types";
import {
  dropTargetAt,
  hitArrowPart,
  hitBoundary,
  hitContainer,
  hitEdge,
  hitHandle,
  hitNode,
  hitOffDiagram,
  hitResize,
  hitScope,
} from "./hit";
import type { EdgeView, NodeView } from "./types";

const view = (id: string, r: Rect, over: Partial<CanvasNode> = {}, visible = true): NodeView =>
  ({ node: { id, kind: "app", ...r, ...over }, root: { visible } }) as NodeView;

const group = (id: string, r: Rect, over: Partial<CanvasGroup> = {}): CanvasGroup => ({
  id,
  name: id,
  ...r,
  ...over,
});

const edgeView = (id: string, a: Rect, b: Rect, label = false): EdgeView =>
  ({
    edge: { id, from: "a", to: "b", label: label ? "calls" : "" } as CanvasEdge,
    route: route(a, b),
    label: label ? { position: { x: 150, y: 75 } } : null,
    labelSize: { w: 40, h: 18 },
  }) as EdgeView;

const labels = (visible: boolean) => ({ visible }) as Container;

const A = { x: 0, y: 0, w: 100, h: 50 };
const B = { x: 300, y: 0, w: 100, h: 50 };

describe("hitNode", () => {
  const order = [
    view("under", { x: 0, y: 0, w: 100, h: 50 }),
    view("over", { x: 50, y: 20, w: 100, h: 50 }),
    view("hidden", { x: 200, y: 0, w: 50, h: 50 }, {}, false),
  ];

  it.each([
    [{ x: 60, y: 30 }, "over"],
    [{ x: 10, y: 10 }, "under"],
    [{ x: 120, y: 60 }, "over"],
    [{ x: 220, y: 20 }, null],
    [{ x: 500, y: 500 }, null],
    [{ x: 0, y: 0 }, "under"],
    [{ x: 100, y: 50 }, "over"],
  ])("%j picks %s", (p, want) => {
    expect(hitNode({ order }, p)?.node.id ?? null).toBe(want);
  });
});

describe("hitHandle: the band along a box's border", () => {
  const box = view("a", { x: 100, y: 100, w: 200, h: 100 });
  const views = new Map([["a", box]]);
  const at = (p: { x: number; y: number }, over = {}) =>
    hitHandle(
      { hovered: "a", tool: "select", views, camera: { x: 0, y: 0, scale: 1 }, ...over },
      p,
    );

  it.each([
    ["on the left border", { x: 100, y: 150 }, "a"],
    ["just outside it", { x: 95, y: 150 }, "a"],
    ["too far outside", { x: 85, y: 150 }, null],
    ["just inside", { x: 105, y: 150 }, "a"],
    ["deeper inside, where a drag moves the box", { x: 112, y: 150 }, null],
    ["the middle", { x: 200, y: 150 }, null],
    ["the bottom border", { x: 200, y: 199 }, "a"],
    ["a corner, outside", { x: 305, y: 205 }, "a"],
  ])("%s", (_what, p, want) => {
    expect(at(p)).toBe(want);
  });

  it("shrinks in screen px as the zoom grows", () => {
    const zoomed = { camera: { x: 0, y: 0, scale: 2 } };
    expect(at({ x: 93, y: 150 }, zoomed)).toBeNull();
    expect(at({ x: 97, y: 150 }, zoomed)).toBe("a");
  });

  it("is off for the view tool, and with nothing hovered", () => {
    expect(at({ x: 100, y: 150 }, { tool: "view" })).toBeNull();
    expect(at({ x: 100, y: 150 }, { hovered: null })).toBeNull();
  });
});

describe("hitResize: the corner of the one selected box", () => {
  const views = new Map([["a", view("a", A)]]);
  const at = (p: { x: number; y: number }, over = {}) =>
    hitResize(
      {
        selected: new Set(["a"]),
        tool: "select",
        views,
        camera: { x: 0, y: 0, scale: 1 },
        ...over,
      },
      p,
    );

  it.each([
    [{ x: 100, y: 50 }, "a"],
    [{ x: 109, y: 59 }, "a"],
    [{ x: 111, y: 50 }, null],
    [{ x: 50, y: 25 }, null],
  ])("%j", (p, want) => {
    expect(at(p)).toBe(want);
  });

  it("needs exactly one box selected, and not the view tool", () => {
    expect(at({ x: 100, y: 50 }, { selected: new Set(["a", "b"]) })).toBeNull();
    expect(at({ x: 100, y: 50 }, { selected: new Set() })).toBeNull();
    expect(at({ x: 100, y: 50 }, { tool: "view" })).toBeNull();
  });
});

describe("hitOffDiagram", () => {
  it("finds the box whose '⇄ N off diagram' label is under the point", () => {
    const v = view("a", { x: 100, y: 100, w: 200, h: 80 });
    v.offDiagram = { x: 20, y: 60, w: 90, h: 18 };
    const order = [v, view("b", { x: 0, y: 0, w: 10, h: 10 })];
    expect(hitOffDiagram({ order }, { x: 130, y: 170 })).toBe("a");
    expect(hitOffDiagram({ order }, { x: 130, y: 120 })).toBeNull();
  });
});

describe("frame title strips", () => {
  const cam1 = { x: 0, y: 0, scale: 1 };
  const groupList = [
    group("scope", { x: 0, y: 0, w: 1000, h: 800 }),
    group("boundary:vpc", { x: 100, y: 100, w: 600, h: 400 }, { boundary: "network", depth: 0 }),
    group("boundary:subnet", { x: 120, y: 120, w: 300, h: 200 }, { boundary: "subnet", depth: 1 }),
    group("file-a", { x: 500, y: 300, w: 200, h: 150 }, { container: "module", depth: 0 }),
    group("file-b", { x: 510, y: 310, w: 100, h: 80 }, { container: "module", depth: 2 }),
  ];

  it("hitScope: the top 36px (18 screen px at low zoom) of the diagram's own frame, to 360 wide", () => {
    expect(hitScope({ groupList, camera: cam1 }, { x: 100, y: 20 })).toBe(true);
    expect(hitScope({ groupList, camera: cam1 }, { x: 100, y: 40 })).toBe(false);
    expect(hitScope({ groupList, camera: cam1 }, { x: 500, y: 20 })).toBe(false);
    expect(hitScope({ groupList, camera: { x: 0, y: 0, scale: 0.25 } }, { x: 100, y: 60 })).toBe(
      true,
    );
    expect(hitScope({ groupList: [], camera: cam1 }, { x: 100, y: 20 })).toBe(false);
  });

  it("hitBoundary: the innermost boundary whose title strip holds the point, without its prefix", () => {
    expect(hitBoundary({ groupList, camera: cam1 }, { x: 130, y: 130 })).toBe("subnet");
    expect(hitBoundary({ groupList, camera: cam1 }, { x: 600, y: 110 })).toBe("vpc");
    expect(hitBoundary({ groupList, camera: cam1 }, { x: 600, y: 200 })).toBeNull();
  });

  it("hitContainer: the innermost file frame whose title strip holds the point", () => {
    expect(hitContainer({ groupList, camera: cam1 }, { x: 520, y: 320 })).toBe("file-b");
    expect(hitContainer({ groupList, camera: cam1 }, { x: 650, y: 320 })).toBe("file-a");
    expect(hitContainer({ groupList, camera: cam1 }, { x: 650, y: 400 })).toBeNull();
  });
});

describe("dropTargetAt", () => {
  const order = [
    view("host", { x: 0, y: 0, w: 300, h: 200 }),
    view("person", { x: 400, y: 0, w: 100, h: 100 }, { kind: "actor" }),
    view("moving", { x: 20, y: 20, w: 50, h: 50 }),
  ];
  const groupList = [
    group("outer", { x: 600, y: 0, w: 400, h: 400 }, { container: "module", depth: 0 }),
    group("inner", { x: 650, y: 50, w: 100, h: 100 }, { container: "module", depth: 1 }),
    group("plain", { x: 600, y: 500, w: 100, h: 100 }),
  ];
  const at = (p: { x: number; y: number }) =>
    dropTargetAt({ order, groupList }, p, new Set(["moving"]));

  it.each([
    ["a box under the point (not the dragged one)", { x: 30, y: 30 }, "host"],
    ["an actor is never a container", { x: 450, y: 50 }, null],
    ["the innermost frame", { x: 700, y: 100 }, "inner"],
    ["the outer frame outside the inner", { x: 900, y: 300 }, "outer"],
    ["a frame that isn't a container or an opened box", { x: 650, y: 550 }, null],
    ["empty canvas", { x: 2000, y: 2000 }, null],
  ])("%s", (_what, p, want) => {
    expect(at(p)).toBe(want);
  });
});

describe("hitEdge", () => {
  const cam = { x: 0, y: 0, scale: 1 };
  const labelled = edgeView("a>b", A, B, true);
  const plain = edgeView("a>b", A, B);

  it("hits the label first, when labels are showing", () => {
    const edges = new Map([["a>b", labelled]]);
    expect(hitEdge({ edgeLabels: labels(true), edges, camera: cam }, { x: 165, y: 70 })).toBe(
      labelled,
    );
    expect(
      hitEdge({ edgeLabels: labels(false), edges, camera: cam }, { x: 165, y: 70 }),
    ).toBeNull();
  });

  it("hits the line within 6 screen px, and misses beyond", () => {
    const edges = new Map([["a>b", plain]]);
    const s = { edgeLabels: labels(true), edges, camera: cam };
    expect(hitEdge(s, { x: 200, y: 25 })).toBe(plain);
    expect(hitEdge(s, { x: 200, y: 30 })).toBe(plain);
    expect(hitEdge(s, { x: 200, y: 40 })).toBeNull();
    expect(hitEdge(s, { x: 200, y: 25 + 12 })).toBeNull();
    // Zoomed in the same screen distance is half the world distance.
    expect(hitEdge({ ...s, camera: { x: 0, y: 0, scale: 4 } }, { x: 200, y: 25 + 1.4 })).toBe(
      plain,
    );
    expect(hitEdge({ ...s, camera: { x: 0, y: 0, scale: 4 } }, { x: 200, y: 25 + 2 })).toBeNull();
  });

  it("remembers the route's bounds for the next test", () => {
    const ev = edgeView("a>b", A, B);
    hitEdge(
      { edgeLabels: labels(true), edges: new Map([["a>b", ev]]), camera: cam },
      { x: 0, y: 0 },
    );
    expect(ev.boxOf).toBe(ev.route);
    expect([ev.box?.x0, ev.box?.x1]).toEqual([100, 300]);
    expect(ev.box?.y0).toBeCloseTo(25);
    expect(ev.box?.y1).toBeCloseTo(25);
  });
});

describe("hitArrowPart: the handles of the selected arrow", () => {
  const ev = edgeView("a>b", A, B);
  ev.edge = {
    ...ev.edge,
    shape: { diagramId: "d", from: "a", to: "b", bends: [{ x: 200, y: 100 }] },
  };
  const s = {
    selectedEdge: "a>b",
    edges: new Map([["a>b", ev]]),
    camera: { x: 0, y: 0, scale: 1 },
    shaping: null,
  };

  it.each([
    ["a bend", { x: 203, y: 104 }, { part: "bend", index: 0 }],
    ["its end", { x: 300, y: 25 }, { part: "to", index: -1 }],
    ["its start", { x: 100, y: 28 }, { part: "from", index: -1 }],
    ["nothing", { x: 200, y: 25 }, null],
  ])("%s", (_what, p, want) => {
    expect(hitArrowPart(s, p)).toEqual(want);
  });

  it("is null with no arrow selected", () => {
    expect(hitArrowPart({ ...s, selectedEdge: null }, { x: 300, y: 25 })).toBeNull();
  });

  it("uses the shape being drafted over the saved one", () => {
    const shaping = {
      edge: "a>b",
      shape: { diagramId: "d", from: "a", to: "b", bends: [{ x: 50, y: 50 }] },
    };
    expect(hitArrowPart({ ...s, shaping }, { x: 50, y: 50 })).toEqual({ part: "bend", index: 0 });
    expect(hitArrowPart({ ...s, shaping }, { x: 200, y: 100 })).toBeNull();
  });
});
