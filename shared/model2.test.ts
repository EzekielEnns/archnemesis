// Tag groups, refs and sources, via, removed, colour-by and decisions: in the files, in
// apply, in check and in a pull request's summary.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { seedOps } from "./seed.ts";
import {
  describe as describeObject,
  findObject,
  planChanges,
  RefError,
  type PlanRules,
} from "./agent.ts";
import { applyOps, emptyState, mirror, type Actor } from "./doc.ts";
import { describeChanges, stateFromFiles } from "./diff.ts";
import { check, keyOps, readFiles, sourceLink, toOps, writeFiles, type FConfig } from "./files.ts";
import { buildIndex, colorGraph, NO_VALUE_COLOR, projectDiagram } from "./project.ts";
import { resolve } from "./views.ts";

const me: Actor = { id: "t", name: "T", kind: "agent" };

const CONFIG: FConfig = {
  name: "Shop",
  tags: {
    "personal-data": {
      description: "Holds data about a person",
      values: ["holds", "not-established"],
      colors: { holds: "#e06c75" },
    },
    contract: { values: ["sub-processor", "public"] },
  },
  protect: ["refs.sys"],
  limits: { boxes: 12, lines: 20 },
  github: "acme",
};

function shop(rules: PlanRules = {}) {
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
  const apply = (changes: Parameters<typeof planChanges>[2], r: PlanRules = rules) => {
    const { ops, summary } = planChanges(state, idx(), changes, r);
    applyOps(doc, state, ops, me, "t");
    return summary;
  };
  return { doc, state, idx, apply };
}

const rules: PlanRules = { protect: CONFIG.protect, tags: CONFIG.tags, agent: true };

/** The shop with one of everything new. */
function full() {
  const s = shop(rules);
  s.apply(
    [
      { add: { id: "lb", name: "Load balancer", kind: "app", in: "shop" } },
      {
        update: "orders-db",
        set: {
          tags: ["personal-data:holds"],
          refs: { sys: "SYS-5", key: "D1" },
          sources: ["shop@abc123:db/schema.sql:10"],
        },
      },
      { update: "payments", set: { tags: ["contract:sub-processor"] } },
      { add: { id: "refunds", name: "Refunds", kind: "app", in: "shop" } },
      {
        connect: {
          from: "refunds",
          to: "payments",
          label: "refunds cards",
          via: "lb",
          sources: ["https://example.com/adr"],
        },
      },
      { update: "warehouse", set: { status: "removed" } },
      {
        decision: {
          title: "Orders live in Postgres",
          status: "accepted",
          date: "2026-11-18",
          affects: ["orders-db"],
          text: "## Context\nWe need transactions.\n",
        },
      },
      // A person sets up the protected refs; the tests then act as an agent.
    ],
    { ...rules, agent: false },
  );
  return s;
}

describe("the new model fields", () => {
  it("round-trip through the files byte for byte, and read back as no change", () => {
    const { state } = full();
    const files = writeFiles(state, CONFIG);
    expect(files.get("model/shop.yaml")).toContain("refs:\n      key: D1\n      sys: SYS-5");
    expect(files.get("model/shop.yaml")).toContain("via: lb");
    expect(files.get("model/_top.yaml")).toContain("status: removed");
    const dec = [...files.keys()].find((k) => k.startsWith("decisions/"))!;
    expect(dec).toBe("decisions/0001-orders-live-in-postgres.yaml");
    expect(files.get(dec)).toContain("text: |");
    expect(files.get("archnm.yaml")).toContain("personal-data:");
    const { model, problems } = readFiles(files);
    expect(problems).toEqual([]);
    expect(check(model).filter((p) => p.level === "error")).toEqual([]);
    expect(model.config).toMatchObject(CONFIG);
    expect(toOps(state, model)).toEqual([]);
    expect(writeFiles(stateFromFiles(files), model.config)).toEqual(files);
  });

  it("check holds them to archnm.yaml and to what exists, with file and line", () => {
    const { state } = full();
    const files = writeFiles(state, CONFIG);
    files.set(
      "model/shop.yaml",
      files
        .get("model/shop.yaml")!
        .replace("personal-data:holds", "personal-data:maybe")
        .replace("via: lb", "via: nowhere"),
    );
    files.set(
      "views/shop.yaml",
      files.get("views/shop.yaml")!.replace("name: Shop\n", "name: Shop\ncolor_by: risk\n"),
    );
    const dec = [...files.keys()].find((k) => k.startsWith("decisions/"))!;
    files.set(dec, files.get(dec)!.replace("- orders-db", "- orders-dbx"));
    const msgs = check(readFiles(files).model).map((p) => `${p.file} ${p.message}`);
    expect(
      msgs.some((m) =>
        /model\/shop\.yaml:\d+ .*personal-data is one of personal-data:holds, personal-data:not-established/.test(
          m,
        ),
      ),
    ).toBe(true);
    expect(msgs.some((m) => m.includes('via: no object "nowhere"'))).toBe(true);
    expect(msgs.some((m) => m.includes('color_by: "risk" isn\'t a tag group'))).toBe(true);
    expect(msgs.some((m) => m.includes('affects: no object "orders-dbx"'))).toBe(true);
  });

  it("removed things are drawn nowhere unless a rule asks for them", () => {
    const { idx, apply } = full();
    const land = [...idx().diagrams.values()].find((d) => !d.scopeId)!;
    const wh = findObject(idx(), "warehouse");
    expect(projectDiagram(idx(), land.id).nodes.some((n) => n.id === wh.id)).toBe(false);
    apply([{ view: { id: "gone", name: "Gone", include: [{ status: "removed" }] } }]);
    const gone = [...idx().diagrams.values()].find((d) => d.key === "gone")!;
    expect([...resolve(idx(), gone).ids]).toEqual([wh.id]);
    // A kind rule doesn't bring it back.
    apply([{ view: { id: "systems", name: "Systems", include: [{ kind: "system" }] } }]);
    const sys = [...idx().diagrams.values()].find((d) => d.key === "systems")!;
    expect(resolve(idx(), sys).ids.has(wh.id)).toBe(false);
  });

  it("via shows on the arrow and in show", () => {
    const { idx, apply } = full();
    const inside = [...idx().diagrams.values()].find(
      (d) => d.scopeId === findObject(idx(), "shop").id,
    )!;
    apply([{ show: { view: inside.key!, objects: ["refunds", "payments"] } }]);
    const e = projectDiagram(idx(), inside.id).edges.find(
      (x) => x.from === "refunds" && x.to === findObject(idx(), "payments").id,
    );
    expect(e?.label).toBe("refunds cards (via Load balancer)");
    expect(describeObject(idx(), findObject(idx(), "refunds"))).toContain("via lb");
  });
});

describe("apply", () => {
  it("merges refs, and won't let an agent change a protected one", () => {
    const { idx, apply } = full();
    apply([{ update: "orders-db", set: { refs: { key: null, linear: "ACME-1" } } }]);
    expect(findObject(idx(), "orders-db").refs).toEqual({ sys: "SYS-5", linear: "ACME-1" });
    expect(() => apply([{ update: "orders-db", set: { refs: { sys: "SYS-6" } } }])).toThrow(
      /refs.sys on .* is protected/,
    );
    expect(() => apply([{ update: "orders-db", set: { refs: { sys: null } } }])).toThrow(RefError);
    // A person can; and an agent may set it on something new.
    apply([{ update: "orders-db", set: { refs: { sys: "SYS-6" } } }], { ...rules, agent: false });
    expect(findObject(idx(), "orders-db").refs?.sys).toBe("SYS-6");
    apply([{ add: { name: "Returns", kind: "app", in: "shop", refs: { sys: "SYS-9" } } }]);
    expect(findObject(idx(), "returns").refs?.sys).toBe("SYS-9");
  });

  it("checks tag groups and colour-by against archnm.yaml", () => {
    const { apply } = full();
    expect(() => apply([{ update: "shop-api", set: { tags: ["contract:handshake"] } }])).toThrow(
      /contract is one of contract:sub-processor, contract:public/,
    );
    expect(() => apply([{ view: { id: "shop", name: "Shop", color_by: "risk" } }])).toThrow(
      /isn't a tag group/,
    );
    apply([{ view: { id: "shop", name: "Shop", color_by: "personal-data" } }]);
  });

  it("numbers decisions, updates them by title, and supersedes", () => {
    const { idx, state, apply } = full();
    apply([{ decision: { title: "Orders move to Spanner", affects: ["orders-db"] } }]);
    expect([...state.decisions.keys()].sort()).toEqual([
      "0001-orders-live-in-postgres",
      "0002-orders-move-to-spanner",
    ]);
    apply([
      { decision: { title: "Orders move to Spanner", status: "accepted" } },
      {
        decision: {
          title: "Orders live in Postgres",
          status: "superseded",
          superseded_by: "0002-orders-move-to-spanner",
        },
      },
    ]);
    expect(state.decisions.get("0001-orders-live-in-postgres")).toMatchObject({
      status: "superseded",
      supersededBy: "0002-orders-move-to-spanner",
    });
    expect(describeObject(idx(), findObject(idx(), "orders-db"))).toContain(
      '0002-orders-move-to-spanner "Orders move to Spanner" (accepted)',
    );
  });
});

describe("a pull request's summary", () => {
  it("leads with protected changes, and names decisions", () => {
    const { state } = full();
    const before = writeFiles(state, CONFIG);
    const after = new Map(before);
    after.set(
      "model/shop.yaml",
      before.get("model/shop.yaml")!.replace("sys: SYS-5", "sys: SYS-7"),
    );
    after.set("decisions/0002-use-spanner.yaml", "title: Use Spanner\nstatus: proposed\n");
    const lines = describeChanges(stateFromFiles(before), stateFromFiles(after), CONFIG.protect);
    expect(lines[0]).toBe('⚠ Protected: changed Orders DB\'s refs.sys ("SYS-5" → "SYS-7")');
    expect(lines).toContain("Recorded decision 0002-use-spanner: Use Spanner (proposed)");
  });
});

it("sources link to GitHub, or are refused when they're neither a repo path nor an address", () => {
  expect(sourceLink("acme", "shop@abc123:db/schema.sql:10-20")).toBe(
    "https://github.com/acme/shop/blob/abc123/db/schema.sql#L10-L20",
  );
  expect(sourceLink("acme", "https://example.com/x")).toBe("https://example.com/x");
  expect(sourceLink("acme", "just words")).toBeNull();
  const files = writeFiles(full().state, CONFIG);
  files.set(
    "model/shop.yaml",
    files.get("model/shop.yaml")!.replace("shop@abc123:db/schema.sql:10", "somewhere in the repo"),
  );
  expect(
    readFiles(files).problems.some((p) => p.message.includes('source "somewhere in the repo"')),
  ).toBe(true);
});

it("colour-by tints each box by its value in the group, with a legend", () => {
  const { idx } = full();
  const land = [...idx().diagrams.values()].find((d) => !d.scopeId)!;
  const inside = [...idx().diagrams.values()].find(
    (d) => d.scopeId === findObject(idx(), "shop").id,
  )!;
  const { graph, legend } = colorGraph(
    projectDiagram(idx(), inside.id),
    idx(),
    "personal-data",
    CONFIG.tags,
  );
  const db = graph.nodes.find((n) => n.id === findObject(idx(), "orders-db").id)!;
  expect(db.color).toBe("#e06c75");
  expect(graph.nodes.filter((n) => n.id !== db.id).every((n) => n.color === NO_VALUE_COLOR)).toBe(
    true,
  );
  expect(legend[0]).toEqual({ value: "holds", color: "#e06c75", count: 1 });
  expect(legend.at(-1)?.value).toBeNull();
  // A value without a colour of its own gets one from the palette; no group, no change.
  const c = colorGraph(projectDiagram(idx(), land.id), idx(), "contract", CONFIG.tags);
  expect(c.legend.find((r) => r.value === "sub-processor")?.color).toMatch(/^#[0-9a-f]{6}$/);
  const g = projectDiagram(idx(), land.id);
  expect(colorGraph(g, idx(), null, CONFIG.tags).graph).toBe(g);
});

it("a tag group made in the app lands in archnm.yaml's settings, checked like the file", () => {
  const { doc, state } = shop();
  applyOps(
    doc,
    state,
    [{ op: "taggroup.put", name: "risk", group: { values: ["High", "low", "high"] } }],
    me,
    "t",
  );
  const cfg = JSON.parse(doc.getMap<string>("meta").get("config")!);
  expect(cfg.tags.risk).toEqual({ values: ["high", "low"] });
  const files = writeFiles(state, cfg);
  expect(files.get("archnm.yaml")).toContain("risk:\n    values: [high, low]");
  expect(() =>
    applyOps(
      doc,
      state,
      [{ op: "taggroup.put", name: "Risk Level", group: { values: ["x"] } }],
      me,
      "t",
    ),
  ).toThrow(/lowercase/);
  expect(() =>
    applyOps(doc, state, [{ op: "taggroup.put", name: "empty", group: { values: [] } }], me, "t"),
  ).toThrow(/1 to 100 values/);
  applyOps(doc, state, [{ op: "taggroup.delete", name: "risk" }], me, "t");
  expect(JSON.parse(doc.getMap<string>("meta").get("config")!).tags).toBeUndefined();
});
