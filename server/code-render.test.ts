// The code layer as drawn: files as frames around their functions, calls between processes
// dashed and named, libraries quiet until picked. Same projection for the canvas and the PNG.
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { applyOps, emptyState, mirror, type Actor } from "../shared/doc.ts";
import { check, keyOps, readFiles, toOps, writeFiles } from "../shared/files.ts";
import { buildIndex, projectDiagram } from "../shared/project.ts";
import { renderView, toPng } from "./render.ts";
import { codeSeedOps } from "./seed.ts";

const me: Actor = { id: "t", name: "T", kind: "agent" };

function board() {
  const doc = new Y.Doc();
  const state = emptyState();
  mirror(doc, state, () => {});
  applyOps(doc, state, codeSeedOps(), me, "seed");
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
  const code = [...idx.diagrams.values()].find((d) => d.name === "board (code)")!;
  const name = (id: string) => idx.objects.get(id)?.name;
  return { doc, state, idx, code, name };
}

describe("code layer, drawn", () => {
  it("draws a file whose functions are on the diagram as a frame around them, not a box", () => {
    const { idx, code, name } = board();
    const g = projectDiagram(idx, code.id);
    const nodes = g.nodes.map((n) => n.name);
    expect(nodes).toContain("post_message()");
    expect(nodes).not.toContain("hub/routes.rs");
    const routes = g.groups.find((x) => x.container && x.name === "hub/routes.rs")!;
    expect(routes).toBeDefined();
    const pm = g.nodes.find((n) => n.name === "post_message()")!;
    expect(pm.x).toBeGreaterThan(routes.x);
    expect(pm.y + pm.h).toBeLessThan(routes.y + routes.h);
    // Process frames hold the file frames too.
    const hub = g.groups.find((x) => x.boundary === "process" && x.name === "Board hub")!;
    expect(hub.x).toBeLessThanOrEqual(routes.x);
    expect(hub.y + hub.h).toBeGreaterThanOrEqual(routes.y + routes.h);
    expect(name(routes.id)).toBe("hub/routes.rs");
  });

  it("marks a call between processes as a hop, named by how it travels", () => {
    const { idx, code, name } = board();
    const g = projectDiagram(idx, code.id);
    const edge = (a: string, b: string) =>
      g.edges.find((e) => name(e.from) === a && name(e.to) === b);
    expect(edge("forward()", "post_message()")).toMatchObject({ hop: true, label: "HTTP" });
    expect(edge("run_post()", "forward()")).toMatchObject({ hop: true, label: "local socket" });
    expect(edge("main()", "run_post()")?.hop).toBeUndefined();
    // board-core's check() runs in the hub too, though it's another crate.
    expect(edge("post_message()", "check()")?.hop).toBeUndefined();
    // Libraries aren't on the code view: they have their own dependency graph.
    expect(g.nodes.some((n) => n.name === "axum")).toBe(false);
  });

  it("writes the example to files and reads it back unchanged", () => {
    const { state } = board();
    const files = writeFiles(state);
    expect([...files.keys()].filter((f) => f.startsWith("code/")).sort()).toContain(
      "code/s-chan/crates/board/src/hub/routes.rs.yaml",
    );
    const { model, problems } = readFiles(files);
    expect(problems).toEqual([]);
    expect(check(model).filter((p) => p.level === "error")).toEqual([]);
    expect(toOps(state, model)).toEqual([]);
  });

  it("renders it", async () => {
    const { idx, code } = board();
    const { svg } = await renderView(idx, { name: "board" }, code.id);
    expect(svg).toContain("hub/routes.rs");
    expect(svg).toContain('stroke-dasharray="5 4"');
    const out = process.env.ARCHNM_RENDER_OUT;
    if (out) writeFileSync(out, await toPng(svg, 1.5));
  });
});

describe("path flows, drawn", () => {
  it("lights a path's route without step numbers", async () => {
    const { idx, code } = board();
    const flow = [...idx.flows.values()].find((f) => f.kind === "path")!;
    const { svg } = await renderView(idx, { name: "board" }, code.id, flow.name);
    expect(svg).toContain("path: board post");
    expect(svg).toContain('stroke="#f2c14e"');
    // No numbered badges.
    expect(svg).not.toMatch(/<circle[^>]*r="10"/);
  });
});
