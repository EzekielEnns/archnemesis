// What a fresh Archnemesis starts with: one empty design, not the example shop. The example is
// still there when asked for.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Auth } from "./auth.ts";
import { Hub } from "./live.ts";
import { DocStore } from "./store.ts";
import { testConfig } from "./testing.ts";

let hub: Hub;
beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), "archnm-first-"));
  hub = new Hub(
    new DocStore(join(dir, "archnm.sqlite")),
    new Auth(testConfig(dir).auth),
    testConfig(dir),
  );
  await hub.start();
});
afterEach(async () => {
  await hub.close();
});

describe("first start", () => {
  it("makes one empty design called My design, with its view", () => {
    expect(hub.seeded).toHaveLength(1);
    const first = hub.seeded[0]!;
    expect(first.key).toBe("my-design");
    expect(first.name()).toBe("My design");
    expect(first.state.objects.size).toBe(0);
    expect(first.state.diagrams.size).toBe(1);
    expect(hub.list(null, true).map((d) => d.key)).toEqual(["my-design"]);
  });

  it("still makes the example shop when asked", async () => {
    const shop = await hub.create("Shop", "shop", "example");
    expect(shop.state.objects.size).toBeGreaterThan(5);
    expect(hub.list(null, true).map((d) => d.key)).toEqual(["my-design", "shop"]);
  });
});
