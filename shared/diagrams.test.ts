// Readable diagrams: folding externals, hiding supporting lines, lanes, stories, and the
// score that tells an agent when a diagram has got too busy.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { seedOps } from "./seed.ts";
import { findObject, outlineView, planChanges, type PlanRules } from "./agent.ts";
import { applyOps, emptyState, mirror, type Actor } from "./doc.ts";
import { check, keyOps, readFiles, toOps, writeFiles, type FConfig } from "./files.ts";
import { layoutOps } from "./layout.ts";
import { buildIndex, projectDiagram, type ModelIndex } from "./project.ts";
import { scoreGraph, viewProblems } from "./score.ts";

const me: Actor = { id: "t", name: "T", kind: "agent" };
const CONFIG: FConfig = {
  name: "Shop",
  tags: { layer: { values: ["edge", "service", "data"] }, infra: { values: ["logging"] } },
};
const rules: PlanRules = { tags: CONFIG.tags };

function shop() {
  const doc = new Y.Doc();
  const state = emptyState();
  mirror(doc, state, () => {});
  applyOps(doc, state, seedOps(), me, "seed");
  applyOps(doc, state, keyOps(state), me, "keys");
  const idx = () =>
    buildIndex({
      objects: state.objects.values(),
      connections: state.connections.values(),
      diagrams: state.diagrams.values(),
      placements: state.placements.values(),
      flows: state.flows.values(),
      boundaries: state.boundaries.values(),
      decisions: state.decisions.values(),
    });
  const apply = (changes: Parameters<typeof planChanges>[2]) => {
    const { ops } = planChanges(state, idx(), changes, rules);
    applyOps(doc, state, ops, me, "t");
  };
  return { doc, state, idx, apply };
}

const landscape = (idx: ModelIndex) => [...idx.diagrams.values()].find((d) => !d.scopeId)!;
const inside = (idx: ModelIndex, key: string) =>
  [...idx.diagrams.values()].find((d) => d.scopeId === findObject(idx, key).id)!;

/** The shop with a third vendor on the landscape, so its externals fold. */
function withVendors() {
  const s = shop();
  s.apply([
    { add: { id: "maps", name: "Maps", kind: "system", external: true, tech: "Google Maps" } },
    { connect: { from: "shop", to: "maps", label: "geocodes addresses" } },
    { show: { view: landscape(s.idx()).key!, objects: ["maps"] } },
  ]);
  return s;
}

describe("fold", () => {
  it("folds a landscape's externals into one box their arrows meet at, and unfolds", () => {
    const { idx, apply } = withVendors();
    const g = projectDiagram(idx(), landscape(idx()).id);
    const box = g.nodes.find((n) => n.folded)!;
    expect(box.name).toBe("3 externals");
    expect(box.folded!.map((id) => idx().objects.get(id)!.key).sort()).toEqual([
      "email",
      "maps",
      "payments",
    ]);
    // People stay; the shop's three arrows to vendors are one arrow now.
    expect(g.nodes.some((n) => n.kind === "actor")).toBe(true);
    const shopId = findObject(idx(), "shop").id;
    const toVendors = g.edges.filter((e) => e.from === shopId && e.to === box.id);
    expect(toVendors).toHaveLength(1);
    expect(toVendors[0]!.label).toBe("3 connections");
    expect(outlineView(idx(), landscape(idx()))).toContain(
      "3 externals (folded): email, maps, payments",
    );
    apply([{ view: { id: landscape(idx()).key, name: landscape(idx()).name, fold: "none" } }]);
    expect(projectDiagram(idx(), landscape(idx()).id).nodes.some((n) => n.folded)).toBe(false);
  });

  it("unfolds one group here as a frame around its boxes, and folds it back", () => {
    const { doc, state, idx } = withVendors();
    const view = landscape(idx());
    applyOps(
      doc,
      state,
      [{ op: "diagram.put", diagram: { ...view, unfolded: ["externals"] } }],
      me,
      "t",
    );
    const g = projectDiagram(idx(), view.id);
    expect(g.nodes.some((n) => n.folded)).toBe(false);
    const frame = g.groups.find((x) => x.id === "boundary:fold:externals")!;
    expect(frame.name).toBe("Externals");
    const keys = g.nodes
      .filter(
        (n) =>
          n.x >= frame.x &&
          n.y >= frame.y &&
          n.x + n.w <= frame.x + frame.w &&
          n.y + n.h <= frame.y + frame.h,
      )
      .map((n) => idx().objects.get(n.id)!.key);
    expect(keys.sort()).toEqual(["email", "maps", "payments"]);
    applyOps(doc, state, [{ op: "diagram.put", diagram: { ...view, unfolded: null } }], me, "t");
    expect(projectDiagram(idx(), view.id).nodes.some((n) => n.folded)).toBe(true);
  });

  it("isn't the default inside a system, and needs three", () => {
    const { idx, apply } = withVendors();
    apply([{ show: { view: inside(idx(), "shop").key!, objects: ["maps"] } }]);
    expect(projectDiagram(idx(), inside(idx(), "shop").id).nodes.some((n) => n.folded)).toBe(false);
    apply([
      {
        view: {
          id: inside(idx(), "shop").key,
          name: inside(idx(), "shop").name,
          fold: "externals",
        },
      },
    ]);
    expect(
      projectDiagram(idx(), inside(idx(), "shop").id).nodes.find((n) => n.folded)?.folded,
    ).toHaveLength(3);
    const plain = shop();
    expect(projectDiagram(plain.idx(), landscape(plain.idx()).id).nodes.some((n) => n.folded)).toBe(
      false,
    );
  });
});

describe("hide_lines", () => {
  it("drops the lines touching what it picks, never the boxes", () => {
    const { idx, apply } = shop();
    const d = inside(idx(), "shop");
    const before = projectDiagram(idx(), d.id);
    apply([
      { update: "worker", set: { tags: ["infra:logging"] } },
      { view: { id: d.key, name: d.name, hide_lines: [{ tag: "infra:logging" }] } },
    ]);
    const after = projectDiagram(idx(), d.id);
    const worker = findObject(idx(), "worker").id;
    expect(after.nodes.map((n) => n.id).sort()).toEqual(before.nodes.map((n) => n.id).sort());
    expect(before.edges.some((e) => e.from === worker || e.to === worker)).toBe(true);
    expect(after.edges.some((e) => e.from === worker || e.to === worker)).toBe(false);
    expect(outlineView(idx(), idx().diagrams.get(d.id)!)).toContain("lines hidden: touching");
  });
});

describe("lanes", () => {
  it("tidy puts each value in its own column, in archnm.yaml's order, and frames them", async () => {
    const { doc, state, idx, apply } = shop();
    const d = inside(idx(), "shop");
    apply([
      { update: "storefront", set: { tags: ["layer:edge"] } },
      { update: "shop-api", set: { tags: ["layer:service"] } },
      { update: "worker", set: { tags: ["layer:service"] } },
      { update: "orders-db", set: { tags: ["layer:data"] } },
      { update: "search-index", set: { tags: ["layer:data"] } },
      { view: { id: d.key, name: d.name, lanes: "layer" } },
    ]);
    applyOps(doc, state, await layoutOps(idx(), d.id, "right", CONFIG.tags), me, "tidy");
    const g = projectDiagram(idx(), d.id);
    const x = (key: string) => g.nodes.find((n) => n.id === findObject(idx(), key).id)!.x;
    expect(x("storefront")).toBeLessThan(x("shop-api"));
    expect(x("shop-api")).toBeLessThan(x("orders-db"));
    expect(x("worker")).toBe(x("shop-api"));
    expect(x("search-index")).toBe(x("orders-db"));
    const lanes = g.groups.filter((f) => f.lane).map((f) => f.name);
    expect(lanes.sort()).toEqual(["data", "edge", "service"]);
    expect(() => apply([{ view: { id: d.key, name: d.name, lanes: "team" } }])).toThrow(
      /isn't a tag group/,
    );
  });
});

describe("the score", () => {
  it("counts boxes, lines and crossings", () => {
    const g = {
      nodes: ["a", "b", "c", "d"].map((id, i) => ({
        id,
        x: [0, 200, 0, 200][i]!,
        y: [0, 200, 200, 0][i]!,
        w: 10,
        h: 10,
      })),
      edges: [
        { id: "1", from: "a", to: "b" },
        { id: "2", from: "c", to: "d" },
      ],
      groups: [],
    } as unknown as Parameters<typeof scoreGraph>[0];
    expect(scoreGraph(g)).toMatchObject({ boxes: 4, lines: 2, crossings: 1 });
  });

  it("warns when a diagram is past the limits, with what to do, and about insides nobody can open", () => {
    const { idx, apply } = shop();
    expect(viewProblems(idx())).toEqual([]);
    const busy = viewProblems(idx(), { boxes: 3 });
    expect(
      busy.some(
        (p) =>
          /Shop: \d+ boxes, past the 3 .*fold: externals/.test(p.message) &&
          p.file.startsWith("views/"),
      ),
    ).toBe(true);
    apply([
      { add: { id: "billing", name: "Billing", kind: "system" } },
      { add: { name: "Invoices", kind: "app", in: "billing" } },
      { add: { name: "Ledger", kind: "store", in: "billing" } },
    ]);
    const p = viewProblems(idx()).find((x) =>
      x.message.startsWith("Billing has 2 things inside it"),
    )!;
    expect(p.file).toBe("model/billing.yaml");
    expect(p.message).toContain("scope: billing");
  });
});

it("story, fold, hide_lines and lanes go to the view's file and back", () => {
  const { state, idx, apply } = shop();
  const d = inside(idx(), "shop");
  apply([
    { update: "worker", set: { tags: ["infra:logging", "layer:service"] } },
    {
      view: {
        id: d.key,
        name: d.name,
        story: "## How orders flow\nStart at the storefront.",
        fold: "externals",
        hide_lines: [{ ids: ["worker"] }],
        lanes: "layer",
      },
    },
  ]);
  const files = writeFiles(state, CONFIG);
  const text = files.get(`views/${d.key}.yaml`)!;
  expect(text).toContain(
    "scope: shop\nstory: |\n  ## How orders flow\n  Start at the storefront.\n",
  );
  expect(text).toContain("fold: externals");
  expect(text).toContain("hide_lines:\n  - ids: [worker]");
  expect(text).toContain("lanes: layer");
  const { model, problems } = readFiles(files);
  expect(problems).toEqual([]);
  expect(check(model).filter((x) => x.level === "error")).toEqual([]);
  expect(toOps(state, model)).toEqual([]);
  files.set(`views/${d.key}.yaml`, text.replace("lanes: layer", "lanes: tier"));
  expect(
    check(readFiles(files).model).some((x) =>
      x.message.includes('lanes: "tier" isn\'t a tag group'),
    ),
  ).toBe(true);
});
