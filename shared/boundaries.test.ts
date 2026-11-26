import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { seedOps } from "./seed.ts";
import {
  describe as describeObject,
  findObject,
  outlineModel,
  outlineView,
  planChanges,
} from "./agent.ts";
import {
  boundaryOf,
  moveManyToBoundaryOps,
  moveToBoundaryOps,
  newBoundaryOps,
  whyIn,
} from "./boundaries.ts";
import { insideAction } from "./actions.ts";
import { applyOps, emptyState, mirror, type Actor } from "./doc.ts";
import { check, keyOps, readFiles, toOps, writeFiles } from "./files.ts";
import { layoutOps } from "./layout.ts";
import { buildIndex, projectDiagram } from "./project.ts";
import { describeChanges, stateFromFiles } from "./diff.ts";

const me: Actor = { id: "t", name: "T", kind: "agent" };

function seeded() {
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
    });
  const apply = (changes: Parameters<typeof planChanges>[2]) => {
    const { ops, summary } = planChanges(state, idx(), changes);
    applyOps(doc, state, ops, me, "t");
    return summary;
  };
  return { doc, state, idx, apply };
}

/** The prod project holds the shop's API and worker; its VPC holds the databases. */
function withInfra() {
  const s = seeded();
  const summary = s.apply([
    {
      boundary: {
        id: "prod",
        name: "acme-prod",
        kind: "project",
        include: [{ ids: ["shop-api", "worker"] }],
      },
    },
    {
      boundary: {
        id: "prod-vpc",
        name: "prod VPC",
        kind: "network",
        in: "prod",
        include: [{ kind: "store" }],
      },
    },
    {
      boundary: {
        id: "internet",
        name: "Public internet",
        kind: "edge",
        include: [{ ids: ["customer"] }],
      },
    },
  ]);
  return { ...s, summary };
}

const landscape = (idx: ReturnType<ReturnType<typeof seeded>["idx"]>) =>
  [...idx.diagrams.values()].find((d) => !d.scopeId)!;
const inside = (idx: ReturnType<ReturnType<typeof seeded>["idx"]>, key: string) =>
  [...idx.diagrams.values()].find((d) => d.scopeId === findObject(idx, key).id)!;

describe("boundaries", () => {
  it("are made with apply, nest, and say where each thing runs", () => {
    const { idx, summary } = withInfra();
    expect(summary[0]).toContain("+ project boundary prod");
    expect(summary[1]).toContain("in prod");
    const i = idx();
    // Its own; inherited from an ancestor (catalog is inside the API); the deepest wins.
    expect(boundaryOf(i, findObject(i, "shop-api").id)).toBe("prod");
    expect(boundaryOf(i, findObject(i, "catalog").id)).toBe("prod");
    expect(boundaryOf(i, findObject(i, "orders-db").id)).toBe("prod-vpc");
    // A system with none of its own: the narrowest boundary holding everything inside it.
    expect(boundaryOf(i, findObject(i, "shop").id)).toBe("prod");
    expect(boundaryOf(i, findObject(i, "payments").id)).toBeNull();
    expect(describeObject(i, findObject(i, "orders-db"))).toContain(
      "runs in: prod-vpc (network) › prod (project)",
    );
    expect(outlineModel(i)).toContain("prod-vpc  prod VPC (network)");
  });

  it("draw only on views that ask, nested, and never change the boxes", () => {
    const { idx, apply } = withInfra();
    const before = projectDiagram(idx(), inside(idx(), "shop").id);
    expect(before.groups.filter((g) => g.boundary)).toHaveLength(0);
    apply([
      {
        view: { id: inside(idx(), "shop").key, name: inside(idx(), "shop").name, boundaries: true },
      },
    ]);
    const after = projectDiagram(idx(), inside(idx(), "shop").id);
    expect(after.nodes.map((n) => n.id).sort()).toEqual(before.nodes.map((n) => n.id).sort());
    const prod = after.groups.find((g) => g.id === "boundary:prod")!;
    const vpc = after.groups.find((g) => g.id === "boundary:prod-vpc")!;
    expect(prod.boundary).toBe("project");
    // The VPC frame sits inside the project's.
    expect(vpc.x).toBeGreaterThan(prod.x);
    expect(vpc.y).toBeGreaterThan(prod.y);
    expect(vpc.x + vpc.w).toBeLessThan(prod.x + prod.w);
    expect(outlineView(idx(), idx().diagrams.get(inside(idx(), "shop").id)!)).toMatch(
      /boundaries drawn: .*acme-prod \(project\), prod VPC \(network\)/,
    );
    // Off again (false, not left out: the document keeps fields that are left out).
    apply([
      {
        view: {
          id: inside(idx(), "shop").key,
          name: inside(idx(), "shop").name,
          boundaries: false,
        },
      },
    ]);
    expect(
      projectDiagram(idx(), inside(idx(), "shop").id).groups.filter((g) => g.boundary),
    ).toHaveLength(0);
  });

  it("tidy keeps each boundary's boxes together, so frames don't overlap", async () => {
    const { doc, state, idx, apply } = withInfra();
    const d = landscape(idx());
    apply([{ view: { id: d.key, name: d.name, boundaries: true } }]);
    applyOps(doc, state, await layoutOps(idx(), d.id, "right"), me, "tidy");
    const g = projectDiagram(idx(), d.id);
    const frames = g.groups.filter((x) => x.boundary && x.depth === 0);
    for (const f of frames) {
      for (const n of g.nodes) {
        const b = boundaryOf(idx(), n.id);
        const inFrame =
          n.x >= f.x && n.y >= f.y && n.x + n.w <= f.x + f.w && n.y + n.h <= f.y + f.h;
        // A box sits in a top-level frame exactly when it belongs to it (or to one inside it).
        const belongs =
          !!b && (b === f.id.slice(9) || idx().boundaries.get(b)?.parentId === f.id.slice(9));
        expect(inFrame, `${n.name} in ${f.name}`).toBe(belongs);
      }
    }
  });

  it("go to boundaries.yaml and back, and show in a pull request's summary", () => {
    const { state } = withInfra();
    const files = writeFiles(state);
    const text = files.get("boundaries.yaml")!;
    expect(text).toContain("id: prod-vpc");
    expect(text).toContain("in: prod");
    expect(text.indexOf("id: prod\n")).toBeLessThan(text.indexOf("id: prod-vpc"));
    const { model, problems } = readFiles(files);
    expect(problems).toEqual([]);
    expect(check(model).filter((p) => p.level === "error")).toEqual([]);
    expect(toOps(state, model)).toEqual([]);
    const after = new Map(files);
    after.set("boundaries.yaml", text.replace("name: prod VPC", "name: prod network"));
    expect(describeChanges(stateFromFiles(files), stateFromFiles(after))).toContain(
      "Changed boundary prod network",
    );
  });

  it("are checked: kinds, nesting, references and IP ranges", () => {
    const { state, idx } = withInfra();
    expect(() => planChanges(state, idx(), [{ boundary: { name: "nameless kind" } }])).toThrow(
      /needs a kind/,
    );
    expect(() =>
      planChanges(state, idx(), [{ boundary: { id: "prod", name: "acme-prod", in: "prod-vpc" } }]),
    ).toThrow(/inside itself/);
    const files = writeFiles(state);
    files.set(
      "boundaries.yaml",
      files
        .get("boundaries.yaml")!
        .replace("name: prod VPC", "name: prod VPC 10.20.0.0/16")
        .replace("ids: [customer]", "ids: [nobody]"),
    );
    const msgs = check(readFiles(files).model).map((p) => p.message);
    expect(msgs.some((m) => m.includes('no object "nobody"'))).toBe(true);
    expect(msgs.some((m) => m.includes("boundary prod-vpc contains something"))).toBe(true);
  });

  it("removing one moves what was inside it up a level", () => {
    const { idx, apply } = withInfra();
    apply([{ remove_boundary: "prod" }]);
    expect(idx().boundaries.get("prod-vpc")!.parentId).toBeNull();
    expect(boundaryOf(idx(), findObject(idx(), "shop-api").id)).toBeNull();
  });
});

describe("apply, for agents building a whole map", () => {
  it("moves several things at once, and a flow can use a view made in the same batch", () => {
    const { idx, apply } = seeded();
    apply([
      { add: { id: "ordering", name: "Ordering", kind: "component", in: "shop-api" } },
      { move: { objects: ["cart", "checkout"], to: "ordering" } },
      { view: { id: "ordering-view", name: "Ordering", scope: "ordering" } },
      {
        flow: {
          view: "ordering-view",
          name: "Check out",
          steps: [{ from: "cart", to: "checkout", text: "hands over" }],
        },
      },
    ]);
    const i = idx();
    expect(findObject(i, "cart").parentId).toBe("ordering");
    expect([...i.flows.values()].some((f) => f.name === "Check out")).toBe(true);
  });

  it("takes a link copied from the app wherever it takes a name", () => {
    const { idx } = seeded();
    const i = idx();
    const api = findObject(i, "shop-api");
    expect(
      findObject(i, `https://archnm.example/#/architecture/d/${landscape(i).id}/o/${api.id}`).id,
    ).toBe(api.id);
  });
});

describe("editing boundaries from the app", () => {
  it("moves a box by editing rules: listed in the new one, out of the old one", () => {
    const { doc, state, idx } = withInfra();
    const api = findObject(idx(), "shop-api").id;
    applyOps(doc, state, moveToBoundaryOps(idx(), api, "prod-vpc"), me, "t");
    expect(boundaryOf(idx(), api)).toBe("prod-vpc");
    // prod is prod-vpc's parent, so it keeps its rule; the VPC lists it by id.
    expect(idx().boundaries.get("prod-vpc")!.rules.include).toContainEqual({ ids: [api] });
    const worker = findObject(idx(), "worker").id;
    expect(idx().boundaries.get("prod")!.rules.include).toContainEqual({ ids: [api, worker] });
    // Into an unrelated one: taken out of prod's list.
    applyOps(doc, state, moveToBoundaryOps(idx(), api, "internet"), me, "t");
    expect(boundaryOf(idx(), api)).toBe("internet");
    expect(idx().boundaries.get("prod")!.rules.include).toContainEqual({ ids: [worker] });
    expect(idx().boundaries.get("prod-vpc")!.rules.include).not.toContainEqual({ ids: [api] });
  });

  it("excludes a box a tag or kind rule would still pick", () => {
    const { doc, state, idx } = withInfra();
    const db = findObject(idx(), "orders-db").id;
    expect(whyIn(idx(), idx().boundaries.get("prod-vpc")!, db, (id) => id)).toBe("every store");
    applyOps(doc, state, moveToBoundaryOps(idx(), db, null), me, "t");
    expect(idx().boundaries.get("prod-vpc")!.rules.exclude).toContainEqual({ ids: [db] });
    expect(boundaryOf(idx(), db)).toBeNull();
    expect(moveToBoundaryOps(idx(), db, null)).toEqual([]);
  });

  it("makes a new boundary around several boxes, as one batch", () => {
    const { doc, state, idx } = withInfra();
    const ids = ["shop-api", "worker"].map((k) => findObject(idx(), k).id);
    const { id, ops } = newBoundaryOps(
      idx(),
      { name: "Staging", kind: "project", parentId: null },
      ids,
    );
    applyOps(doc, state, ops, me, "t");
    expect(ids.map((x) => boundaryOf(idx(), x))).toEqual([id, id]);
    expect(idx().boundaries.get("prod")!.rules.include).toEqual([]);
    applyOps(doc, state, moveManyToBoundaryOps(idx(), ids, "prod"), me, "t");
    expect(ids.map((x) => boundaryOf(idx(), x))).toEqual(["prod", "prod"]);
  });
});

it("only offers to open what has an inside, or can have one", () => {
  const { idx } = seeded();
  const i = idx();
  expect(insideAction(i, findObject(i, "shop").id)).toBe("open");
  expect(insideAction(i, findObject(i, "customer").id)).toBeNull();
  expect(insideAction(i, findObject(i, "orders-db").id)).toBeNull();
  expect(insideAction(i, findObject(i, "payments").id)).toBeNull();
  expect(insideAction(i, findObject(i, "worker").id)).toBe("start");
});
