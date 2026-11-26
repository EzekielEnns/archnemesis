// Tidy on a deep diagram: functions stay in their file's frame, files in their process, and
// no two frames that aren't nested overlap.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { codeSeedOps } from "../server/seed.ts";
import { applyOps, emptyState, mirror, type Actor } from "./doc.ts";
import { keyOps } from "./files.ts";
import { layoutOps } from "./layout.ts";
import { buildIndex, projectDiagram, type CanvasGroup } from "./project.ts";

const me: Actor = { id: "t", name: "T", kind: "agent" };

const overlap = (a: CanvasGroup, b: CanvasGroup) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const holds = (a: CanvasGroup, b: CanvasGroup) =>
  a.x <= b.x && a.y <= b.y && a.x + a.w >= b.x + b.w && a.y + a.h >= b.y + b.h;

describe("tidy for deep diagrams", () => {
  it("keeps files apart, each inside its process", async () => {
    const doc = new Y.Doc();
    const state = emptyState();
    mirror(doc, state, () => {});
    applyOps(doc, state, codeSeedOps(), me, "seed");
    applyOps(doc, state, keyOps(state), me, "keys");
    const idx = () =>
      buildIndex({
        objects: state.objects.values(),
        connections: state.connections.values(),
        diagrams: state.diagrams.values(),
        placements: state.placements.values(),
        flows: state.flows.values(),
        boundaries: state.boundaries.values(),
      });
    const code = [...state.diagrams.values()].find((d) => d.name === "board (code)")!;
    // Scramble it first: everything piled at the origin.
    const piled = [...state.placements.values()]
      .filter((p) => p.diagramId === code.id)
      .map((p) => ({ op: "placement.put" as const, placement: { ...p, x: 0, y: 0 } }));
    applyOps(doc, state, piled, me, "pile");
    applyOps(doc, state, await layoutOps(idx(), code.id, "right"), me, "tidy");

    const g = projectDiagram(idx(), code.id);
    const files = g.groups.filter((x) => x.container && x.name.includes("."));
    expect(files.length).toBeGreaterThan(5);
    for (const a of files)
      for (const b of files)
        if (a !== b) expect(overlap(a, b), `${a.name} overlaps ${b.name}`).toBe(false);
    const procs = g.groups.filter((x) => x.boundary === "process");
    for (const a of procs)
      for (const b of procs)
        if (a !== b) expect(overlap(a, b), `${a.name} overlaps ${b.name}`).toBe(false);
    const hub = procs.find((p) => p.name === "Board hub")!;
    for (const f of files.filter((f) => f.name.startsWith("hub/")))
      expect(holds(hub, f), `${f.name} in Board hub`).toBe(true);
  });

  it("with lanes, a file's functions stay in its frame (s-chan round 7)", async () => {
    const doc = new Y.Doc();
    const state = emptyState();
    mirror(doc, state, () => {});
    applyOps(doc, state, codeSeedOps(), me, "seed");
    applyOps(doc, state, keyOps(state), me, "keys");
    const idx = () =>
      buildIndex({
        objects: state.objects.values(),
        connections: state.connections.values(),
        diagrams: state.diagrams.values(),
        placements: state.placements.values(),
        flows: state.flows.values(),
        boundaries: state.boundaries.values(),
      });
    const code = [...state.diagrams.values()].find((d) => d.name === "board (code)")!;
    // Functions in a file split over two lanes: the case that used to scatter them.
    const fns = [...state.objects.values()].filter((o) => o.kind === "function");
    applyOps(
      doc,
      state,
      fns.map((o, i) => ({
        op: "object.put" as const,
        object: { ...o, tags: [...o.tags, `part:${i % 2 ? "b" : "a"}`] },
      })),
      me,
      "tag",
    );
    applyOps(doc, state, [{ op: "diagram.put", diagram: { ...code, lanes: "part" } }], me, "lanes");
    const piled = [...state.placements.values()]
      .filter((p) => p.diagramId === code.id)
      .map((p) => ({ op: "placement.put" as const, placement: { ...p, x: 0, y: 0 } }));
    applyOps(doc, state, piled, me, "pile");
    applyOps(
      doc,
      state,
      await layoutOps(idx(), code.id, "right", { part: { values: ["a", "b"] } }),
      me,
      "tidy",
    );
    const g = projectDiagram(idx(), code.id);
    const files = g.groups.filter((x) => x.container && x.name.includes("."));
    expect(files.length).toBeGreaterThan(5);
    for (const a of files)
      for (const b of files)
        if (a !== b && !holds(a, b) && !holds(b, a))
          expect(overlap(a, b), `${a.name} overlaps ${b.name}`).toBe(false);
  });
});
