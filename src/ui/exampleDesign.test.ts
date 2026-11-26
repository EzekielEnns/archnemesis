// "Open the example": made once, as the person's own editable design, and opened as it is after.
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { applyOps, readState } from "../../shared/doc.ts";
import { makeObject } from "../../shared/model.ts";
import { createLocalBackend, type ListStore } from "../backend/local.ts";
import type { Backend } from "../backend/types.ts";
import { openExample } from "./exampleDesign.ts";

function memoryList(): ListStore {
  let text: string | null = null;
  return { read: () => text, write: (v) => void (text = v) };
}

async function openDoc(b: Backend, key: string): Promise<Y.Doc> {
  const info = await b.designs.info(key);
  const ydoc = new Y.Doc();
  let loaded = () => {};
  const live = new Promise<void>((r) => (loaded = r));
  b.designs.open(info, ydoc, { onStatus: (s) => s === "live" && loaded(), onEvent: () => {} });
  await live;
  return ydoc;
}

describe("open the example", () => {
  it("makes the shop as an editable design of their own when they have none", async () => {
    const b = createLocalBackend(memoryList());
    const r = await openExample(b);
    expect(r).toEqual({ key: "shop", created: true });
    const doc = await openDoc(b, r.key);
    expect(readState(doc).objects.size).toBeGreaterThan(5);
    const me = { id: "local:You", name: "You", kind: "human" } as const;
    applyOps(
      doc,
      readState(doc),
      [{ op: "object.put", object: makeObject({ kind: "system", name: "Mine" }) }],
      me,
      "edit",
    );
    expect([...readState(doc).objects.values()].map((o) => o.name)).toContain("Mine");
    // Their blank design is still there.
    expect((await b.designs.list()).map((d) => d.key)).toEqual(["my-design", "shop"]);
  });

  it("opens the one they already have, and makes nothing", async () => {
    const b = createLocalBackend(memoryList());
    const first = await openExample(b);
    const again = await openExample(b);
    expect(again).toEqual({ key: first.key, created: false });
    expect((await b.designs.list()).filter((d) => d.name === "Shop")).toHaveLength(1);
  });

  it("opens a design they named Shop, whatever is in it", async () => {
    const b = createLocalBackend(memoryList());
    await b.designs.create("shop");
    expect(await openExample(b)).toEqual({ key: "shop", created: false });
  });
});
