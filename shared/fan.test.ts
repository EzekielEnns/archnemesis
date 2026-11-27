import { describe, expect, it } from "vitest";
import { fanSides, joinRoute, sharedRun, splitRoute } from "./geometry.ts";
import { routerEdges, tailId, trunkId } from "./router.ts";

const box = (x: number, y: number) => ({ x, y, w: 100, h: 40 });

describe("fan-out arrows", () => {
  const rects = new Map([
    ["bus", box(0, 0)],
    ["a", box(-200, 300)],
    ["b", box(0, 300)],
    ["c", box(200, 300)],
  ]);
  const rect = (id: string) => rects.get(id);
  const fan = (to: string, more = {}) => ({
    id: `bus>${to}`,
    from: "bus",
    to,
    fan: "bus|publishes",
    ...more,
  });

  it("all leave the side facing the middle of where they go", () => {
    const got = fanSides([fan("a"), fan("b"), fan("c")], rect);
    expect([...got.values()].map((f) => f.side)).toEqual(["b", "b", "b"]);
  });

  it("one pinned by hand keeps its start and the rest start there with it", () => {
    const got = fanSides(
      [fan("a"), fan("b", { shape: { fromSide: "left", fromAt: 0.3 } }), fan("c")],
      rect,
    );
    expect([...got.keys()]).toEqual(["bus>a", "bus>c"]);
    expect(got.get("bus>a")).toEqual({ side: "l", at: 0.3 });
    expect(fanSides([fan("a"), { id: "x", from: "bus", to: "b" }], rect).size).toBe(0);
    // Bent by hand, it's still part of the fan.
    expect(fanSides([fan("a", { shape: { bends: [{ x: 1, y: 1 }] } }), fan("c")], rect).size).toBe(
      2,
    );
  });

  it("measures how far two lines run as one", () => {
    const down = [
      { x: 0, y: 0 },
      { x: 0, y: 100 },
    ];
    expect(sharedRun([...down, { x: -200, y: 100 }], [...down, { x: 200, y: 100 }])).toBe(100);
    expect(
      sharedRun(
        [...down, { x: 50, y: 100 }],
        [
          { x: 0, y: 0 },
          { x: 0, y: 60 },
          { x: 90, y: 60 },
        ],
      ),
    ).toBe(60);
    expect(
      sharedRun(down, [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ]),
    ).toBe(0);
  });

  it("through a split point: out of its box to the point, then square into its own box", () => {
    const p = { x: 50, y: 150 };
    const r = splitRoute(box(0, 0), p, box(200, 500));
    expect(r.pts![0]).toEqual({ x: 50, y: 40 });
    expect(r.pts).toContainEqual(p);
    expect(r.pts![r.pts!.length - 1]).toEqual({ x: 250, y: 500 });
    // Every stretch is level or upright.
    for (let i = 1; i < r.pts!.length; i++)
      expect(r.pts![i]!.x === r.pts![i - 1]!.x || r.pts![i]!.y === r.pts![i - 1]!.y).toBe(true);
  });

  it("the stretch to a split point is routed once, and each arrow from the point on", () => {
    const split = { x: 50, y: 150 };
    const edges = ["a", "b", "c"].map((to) => ({
      id: `bus>${to}`,
      from: "bus",
      to,
      shape: { split },
    }));
    const got = routerEdges(edges, rects, rects);
    expect(got.map((e) => e.id)).toEqual([trunkId("bus", split), "bus>a", "bus>b", "bus>c"]);
    expect(got[0]!.toAt).toMatchObject(split);
    expect(got[1]!.fromAt).toMatchObject(split);
  });

  it("never doubles back along the line it came to the split point on", () => {
    const p = { x: 50, y: 150 };
    // The router's way to a box up and to the right: back up the trunk, then across.
    const r = splitRoute(box(0, 0), p, box(300, 60), {
      branch: [p, { x: 50, y: 80 }, { x: 350, y: 80 }],
    });
    // It parts from the trunk where it turns off, and the dot is there.
    expect(r.pts).not.toContainEqual(p);
    expect(r.dots?.split).toEqual({ x: 50, y: 80 });
    expect(r.pts![0]).toEqual({ x: 50, y: 40 });
  });

  it("a join is a split the other way round: to the point, then into the box as one", () => {
    const p = { x: 50, y: 150 };
    const r = joinRoute(box(200, 500), p, box(0, 0));
    expect(r.pts![0]).toEqual({ x: 250, y: 500 });
    expect(r.pts).toContainEqual(p);
    expect(r.pts![r.pts!.length - 1]).toEqual({ x: 50, y: 40 });
    const join = p;
    const edges = ["a", "b"].map((from) => ({
      id: `${from}>bus`,
      from,
      to: "bus",
      shape: { join },
    }));
    expect(routerEdges(edges, rects, rects).map((e) => e.id)).toEqual([
      tailId("bus", join),
      "a>bus",
      "b>bus",
    ]);
  });
});

import { shiftBends } from "./align.ts";
import { wrapPanels } from "./explode.ts";

describe("boxes laid out again", () => {
  const shape = {
    diagramId: "d",
    from: "a",
    to: "b",
    bends: [{ x: 10, y: 10 }],
    split: { x: 5, y: 5 },
    join: { x: 50, y: 50 },
  };
  const before = new Map([
    ["a", { x: 0, y: 0 }],
    ["b", { x: 100, y: 0 }],
  ]);
  it("drops bends when the ends moved apart, and carries split and join with their boxes", () => {
    const after = new Map([
      ["a", { x: 8, y: 0 }],
      ["b", { x: 100, y: 40 }],
    ]);
    const [s] = shiftBends([shape], before, after, { reroute: true });
    expect(s!.bends).toBeUndefined();
    expect(s!.split).toEqual({ x: 13, y: 5 });
    expect(s!.join).toEqual({ x: 50, y: 90 });
  });
  it("keeps the shape when both ends moved the same way", () => {
    const after = new Map([
      ["a", { x: 8, y: 8 }],
      ["b", { x: 108, y: 8 }],
    ]);
    const [s] = shiftBends([shape], before, after, { reroute: true });
    expect(s!.bends).toEqual([{ x: 18, y: 18 }]);
  });
});

describe("an opened box's panel", () => {
  it("stays inside the frame around it", () => {
    const frame = { id: "scope", name: "", x: 0, y: 0, w: 300, h: 300 };
    const lane = { id: "l", name: "", lane: true, x: 0, y: 0, w: 300, h: 300 };
    const panel = { id: "p", name: "", inset: true, x: 100, y: 100, w: 400, h: 100 };
    wrapPanels([frame, lane], [panel]);
    expect(frame).toMatchObject({ x: 0, y: 0, w: 524, h: 300 });
    expect(lane.w).toBe(300);
  });
});

describe("lines both ways between two boxes", () => {
  it("are one line with a head at each end, on the arrow somebody shaped", async () => {
    const { memHost } = await import("./tools/memhost.ts");
    const { TOOLS } = await import("./tools/tools.ts");
    const { projectDiagram } = await import("./project.ts");
    const h = memHost({});
    const write = TOOLS.find((t) => t.name === "write")!;
    await write.run({ host: h } as never, {
      yaml: [
        "objects:",
        '  bus: {kind: store, context: "Events."}',
        '  mail: {kind: app, context: "Sends."}',
        "connections:",
        "  - {from: bus, to: mail, label: Send code}",
        "  - {from: mail, to: bus, label: Delivery status}",
        "views:",
        "  main: {name: Main, boxes: [bus, mail]}",
      ].join("\n"),
    });
    const idx = h.index();
    const d = [...idx.diagrams.values()].find((x) => x.key === "main")!;
    const g = projectDiagram(idx, d.id);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]!.both).toBe(true);
    expect(g.edges[0]!.labels).toEqual(["Send code", "Delivery status"]);
  });
});
