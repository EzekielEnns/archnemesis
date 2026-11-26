// What a browser can write straight into the document (skipping the ops checks) is read
// back field by field: anything malformed is ignored, so it can't reach a file or the page.
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { seedOps } from "./seed.ts";
import { writable } from "../server/files.ts";
import { applyOps, emptyState, logEntryOk, mirror, readState, type Actor } from "./doc.ts";
import { forbidError, writeFiles } from "./files.ts";

const me: Actor = { id: "t", name: "T", kind: "human" };

function raw(fields: Record<string, unknown>): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(fields)) m.set(k, v);
  return m;
}

describe("entries written straight into the document", () => {
  it("are ignored when malformed: no path out of the folder, no javascript: link", () => {
    const doc = new Y.Doc();
    const state = emptyState();
    mirror(doc, state, () => {});
    applyOps(doc, state, seedOps(), me, "seed");
    const d = [...state.diagrams.values()][0]!;
    const parent = [...state.objects.values()][0]!;
    doc.transact(() => {
      doc
        .getMap("objects")
        .set("evil", raw({ id: "evil", key: "../../../x/evil", kind: "system", name: "Evil" }));
      doc
        .getMap("objects")
        .set("child", raw({ id: "child", kind: "app", name: "Child", parentId: "evil" }));
      doc.getMap("objects").set("liar", raw({ id: "other", kind: "app", name: "Wrong key" }));
      doc.getMap("objects").set("big", raw({ id: "big", kind: "app", name: "x".repeat(500) }));
      doc
        .getMap("objects")
        .set("ok", raw({ id: "ok", kind: "app", name: "Fine", parentId: parent.id }));
      doc.getMap("notes").set(
        "n1",
        raw({
          id: "n1",
          diagramId: d.id,
          kind: "link",
          x: 0,
          y: 0,
          text: "click",
          url: "javascript:alert(1)",
          author: me,
        }),
      );
      doc
        .getMap("diagrams")
        .set("v", raw({ id: "v", name: "V", rules: { include: [null], exclude: [] } }));
    });
    for (const s of [state, readState(doc)]) {
      expect(s.objects.has("evil")).toBe(false);
      expect(s.objects.has("liar")).toBe(false);
      expect(s.objects.has("big")).toBe(false);
      expect(s.objects.has("ok")).toBe(true);
      expect(s.notes.has("n1")).toBe(false);
      expect(s.diagrams.has("v")).toBe(false);
    }
    for (const path of writeFiles(state).keys()) expect(path).not.toContain("..");
  });

  it("history entries are checked before anyone reads them", () => {
    expect(logEntryOk({ actor: me, label: "moved", at: "x", ids: [] })).toBe(true);
    expect(logEntryOk({ label: "no actor", at: "x", ids: [] })).toBe(false);
    expect(logEntryOk({ actor: me, label: 5, at: "x", ids: [] })).toBe(false);
  });

  it("the file writer only writes Archnemesis's own files, never through a symlinked folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "archnm-guard-"));
    mkdirSync(join(dir, "elsewhere"));
    symlinkSync(join(dir, "elsewhere"), join(dir, "views"));
    expect(writable(dir, "model/shop.yaml")).toBe(true);
    expect(writable(dir, "views/shop.yaml")).toBe(false);
    expect(writable("/tmp", "model/../../etc/x.yaml")).toBe(false);
    expect(writable("/tmp", ".github/workflows/x.yaml")).toBe(false);
    expect(writable("/tmp", "views/a/b.yaml")).toBe(false);
  });

  it("forbid patterns that could freeze the server are refused", () => {
    expect(forbidError("\\binternal\\.example\\b")).toBe(null);
    expect(forbidError("(a+)+$")).toMatch(/forever/);
    expect(forbidError("(x|xy)*z")).toBe(null);
    expect(forbidError("([a-z]*)*")).toMatch(/forever/);
    expect(forbidError("x".repeat(300))).toMatch(/too long/);
    expect(forbidError("(")).toMatch(/valid/);
  });
});
