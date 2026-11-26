import { describe as suite, expect, it } from "vitest";
import * as Y from "yjs";
import { seedOps } from "./seed.ts";
import { describe, findObject, path, planChanges, RefError } from "./agent.ts";
import { applyOps, emptyState, mirror, type Actor } from "./doc.ts";
import { keyOps } from "./files.ts";
import { buildIndex } from "./project.ts";

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
    });
  return { doc, state, idx };
}

suite("agent", () => {
  it("finds things by key, id or name, and suggests on a miss", () => {
    const { idx } = seeded();
    expect(findObject(idx(), "shop-api").name).toBe("Shop API");
    expect(findObject(idx(), "shop api").key).toBe("shop-api");
    expect(() => findObject(idx(), "paymnts")).toThrow(RefError);
    expect(() => findObject(idx(), "shop")).not.toThrow();
  });

  it("adds, connects and refers to the new thing in one batch", () => {
    const { doc, state, idx } = seeded();
    const { ops, summary } = planChanges(state, idx(), [
      { add: { name: "Refunds", kind: "app", in: "shop", tech: "Go" } },
      { connect: { from: "refunds", to: "payments", label: "refunds cards" } },
    ]);
    expect(summary[0]).toContain("+ app refunds");
    applyOps(doc, state, ops, me, "refunds");
    expect(describe(idx(), findObject(idx(), "refunds"))).toContain(
      'refunds → payments "refunds cards"',
    );
  });

  it("re-adding an existing id updates it instead of duplicating", () => {
    const { state, idx } = seeded();
    const { summary } = planChanges(state, idx(), [
      { add: { id: "worker", name: "Worker", kind: "app", tech: "Rust" } },
    ]);
    expect(summary[0]).toContain("already there");
  });

  it("rejects a bad batch whole, with a readable reason", () => {
    const { state, idx } = seeded();
    expect(() =>
      planChanges(state, idx(), [
        { add: { name: "X", kind: "app" } },
        { connect: { from: "x", to: "nowhere" } },
      ]),
    ).toThrow(/no object "nowhere"/);
  });

  it("finds a path through what's inside", () => {
    const { idx } = seeded();
    const p = path(idx(), findObject(idx(), "customer"), findObject(idx(), "orders-db"));
    expect(p.split("\n")[0]).toContain("customer → storefront");
    expect(p).toContain("orders-db");
  });
});

suite("hide on a view that follows rules", () => {
  it("keeps the box off: the rules learn it, so they don't put it back", async () => {
    const { resolve } = await import("./views.ts");
    const { doc, state, idx } = seeded();
    const made = planChanges(state, idx(), [
      { view: { id: "inside-shop", name: "Inside the shop", scope: "shop" } },
    ]);
    applyOps(doc, state, made.ops, me, "view");
    const d = [...state.diagrams.values()].find((x) => x.key === "inside-shop" && x.rules)!;
    expect(d).toBeTruthy();
    const victim = [...resolve(idx(), d).ids][0]!;
    const { ops } = planChanges(state, idx(), [
      { hide: { view: d.key ?? d.id, objects: [victim] } },
    ]);
    applyOps(doc, state, ops, me, "hide");
    expect(resolve(idx(), state.diagrams.get(d.id)!).ids.has(victim)).toBe(false);
    // And show brings it back the same way.
    const back = planChanges(state, idx(), [{ show: { view: d.key ?? d.id, objects: [victim] } }]);
    applyOps(doc, state, back.ops, me, "show");
    expect(resolve(idx(), state.diagrams.get(d.id)!).ids.has(victim)).toBe(true);
  });
});
