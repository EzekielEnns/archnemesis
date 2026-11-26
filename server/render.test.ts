// The server draws a view as an image: what an agent checks its work against, and what a
// pull request shows.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { applyOps, emptyState, mirror, type Actor } from "../shared/doc.ts";
import { keyOps } from "../shared/files.ts";
import { buildIndex } from "../shared/project.ts";
import { renderView, toPng } from "./render.ts";
import { seedOps } from "../shared/seed.ts";
import { memHost } from "../shared/tools/memhost.ts";
import { runTool, tool } from "../shared/tools/tools.ts";

const me: Actor = { id: "t", name: "T", kind: "agent" };

function shop() {
  const doc = new Y.Doc();
  const state = emptyState();
  mirror(doc, state, () => {});
  applyOps(doc, state, seedOps(), me, "seed");
  applyOps(doc, state, keyOps(state), me, "keys");
  const idx = buildIndex({
    objects: state.objects.values(),
    connections: state.connections.values(),
    diagrams: state.diagrams.values(),
    placements: state.placements.values(),
    flows: state.flows.values(),
    boundaries: state.boundaries.values(),
    decisions: state.decisions.values(),
  });
  return { doc, state, idx };
}

describe("render", () => {
  it("draws every box and labelled arrow of a view, escaped", async () => {
    const { idx } = shop();
    const d = [...idx.diagrams.values()].find((x) => x.scopeId)!;
    const { svg } = await renderView(idx, { name: "Shop <&>" }, d.key!);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("Shop &lt;&amp;&gt;");
    for (const id of idx.placements.get(d.id)!.keys()) {
      const o = idx.objects.get(id);
      if (o && !o.external) expect(svg).toContain(o.name);
    }
    await expect(renderView(idx, { name: "x" }, "nope")).rejects.toThrow(/no view/);
  });

  it("makes a PNG", async () => {
    const { idx } = shop();
    const d = [...idx.diagrams.values()][0]!;
    const png = await toPng((await renderView(idx, { name: "Shop" }, d.id)).svg, 1);
    expect([...png.slice(1, 4)].map((c) => String.fromCharCode(c)).join("")).toBe("PNG");
  }, 20_000);

  // Trial 5: a box with insides on the view is a frame, and its own lines end on the frame.
  it("draws lines that end on a frame, curved and routed", async () => {
    const h = memHost({});
    const yaml = `objects:
  customer: {kind: actor}
  shop: {kind: app}
  pay: {kind: component, in: shop}
  ship: {kind: component, in: shop}
  bank: {kind: system, external: true}
connections:
  - {from: customer, to: shop, label: buys}
  - {from: shop, to: bank, label: settles}
  - {from: pay, to: ship, label: hands over}
views:
  inside: {name: Inside, scope: shop}
  boxes: {name: Boxes, boxes: [customer, shop, pay, ship, bank]}
`;
    expect(
      (await runTool(tool("write"), { host: h }, { yaml, tidy: ["inside", "boxes"] })).isError,
    ).toBeFalsy();
    for (const view of ["inside", "boxes"]) {
      for (const arrows of ["curved", "elbow"] as const) {
        await runTool(
          tool("write"),
          { host: h },
          { yaml: `views:\n  ${view}: {arrows: ${arrows}}` },
        );
        const { svg } = await renderView(h.index(), { name: "T" }, view);
        // Every line is drawn: two to the frame, one inside it.
        for (const l of ["buys", "settles", "hands over"])
          expect(svg, `${view} ${arrows}`).toContain(`>${l}<`);
        expect(svg.match(/<polygon /g)?.length, `${view} ${arrows}`).toBe(3);
      }
    }
  }, 20_000);

  // Trial 5: two connections between the same ends are one arrow; the picture says both labels.
  it("labels an arrow that stands for several connections with each one's label", async () => {
    const h = memHost({});
    const yaml = `objects:
  a: {kind: app}
  b: {kind: app}
connections:
  - {from: a, to: b, label: places orders}
  - {from: a, to: b, label: asks for a courier}
views:
  v: {name: V, boxes: [a, b]}
`;
    expect((await runTool(tool("write"), { host: h }, { yaml })).isError).toBeFalsy();
    const { svg } = await renderView(h.index(), { name: "T" }, "v");
    // Each one's label, in order, a line each (trial 16: joined with "·" they read as one sentence).
    expect(svg).toMatch(/<tspan[^>]*>places o[^<]*<\/tspan><tspan[^>]*dy="14"[^>]*>asks f/);
    expect(svg).not.toContain("2 connections");
  }, 20_000);

  // Trial 16: with four or more, one line still says them all.
  it("joins the labels of four or more connections on one line", async () => {
    const h = memHost({});
    const yaml = `objects:
  a: {kind: app}
  b: {kind: app}
connections:
  - {from: a, to: b, label: one}
  - {from: a, to: b, label: two}
  - {from: a, to: b, label: three}
  - {from: a, to: b, label: four}
views:
  v: {name: V, boxes: [a, b]}
`;
    expect((await runTool(tool("write"), { host: h }, { yaml })).isError).toBeFalsy();
    const { svg } = await renderView(h.index(), { name: "T" }, "v");
    expect(svg).toMatch(/>(one|two|three|four)[^<]* · /);
    expect(svg).not.toContain("<tspan");
  }, 20_000);
});
