import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { codeSeedOps } from "../server/seed.ts";
import { codeRef, contextText, notesAbout, packageLinks, resolveRef } from "./context.ts";
import { applyOps, emptyState, mirror, ModelError } from "./doc.ts";
import { keyOps } from "./files.ts";
import { makeNote } from "./model.ts";
import { notesText } from "./notes.ts";
import { buildIndex } from "./project.ts";

const me = { id: "t", name: "T", kind: "agent" as const };
function board() {
  const doc = new Y.Doc();
  const state = emptyState();
  mirror(doc, state, () => {});
  applyOps(doc, state, codeSeedOps(), me, "s");
  applyOps(doc, state, keyOps(state), me, "k");
  const idx = () =>
    buildIndex({
      objects: state.objects.values(),
      connections: state.connections.values(),
      diagrams: state.diagrams.values(),
      placements: state.placements.values(),
      flows: state.flows.values(),
      boundaries: state.boundaries.values(),
      notes: state.notes.values(),
      replies: state.replies.values(),
      decisions: state.decisions.values(),
    });
  const id = (name: string) => [...state.objects.values()].find((o) => o.name === name)!.id;
  return { doc, state, idx, id };
}

describe("context for agents", () => {
  it("points at code by repo:path#name and reads it back", () => {
    const { idx, id } = board();
    const i = idx();
    expect(codeRef(i, id("post_message()"))).toBe(
      "s-chan:crates/board/src/hub/routes.rs#post_message",
    );
    expect(codeRef(i, id("hub/routes.rs"))).toBe("s-chan:crates/board/src/hub/routes.rs");
    expect(resolveRef(i, "s-chan:crates/board/src/hub/routes.rs#post_message")?.name).toBe(
      "post_message()",
    );
    expect(resolveRef(i, "s-chan:crates/board/src/hub/routes.rs#post_message()")?.name).toBe(
      "post_message()",
    );
    expect(resolveRef(i, "s-chan:crates/board/src/hub/routes.rs")?.name).toBe("hub/routes.rs");
    expect(resolveRef(i, "s-chan:nope.rs")).toBeNull();
  });

  it("bundles where it runs, its calls with hops, and its libraries", () => {
    const { idx, id } = board();
    const t = contextText(idx(), id("post_message()"), { design: "board" });
    expect(t).toContain("file: s-chan:crates/board/src/hub/routes.rs");
    expect(t).toContain("runs in: Board hub (process)");
    expect(t).toMatch(/← \[.*#forward · id forward\] \(another process\): HTTP/);
    expect(t).toMatch(/→ \[.*#append[ \]]/);
    expect(t).toContain("libraries:\n  axum 0.8.9");
    const lib = contextText(idx(), id("axum"), { design: "board" });
    expect(lib).toContain("package: cargo axum 0.8.9");
    expect(lib).toContain("listed as a dependency by (3)");
    expect(lib).toContain("https://docs.rs/axum/0.8.9");
    // A file lists what's inside and its insides' calls.
    expect(contextText(idx(), id("hub/routes.rs"), { design: "board" })).toContain(
      "inside it (2):",
    );
  });

  it("a flag on a function in a file frame is about the function, and shows up from the file and the app", () => {
    const { doc, state, idx, id } = board();
    const i = idx();
    const d = [...i.diagrams.values()].find((x) => x.name === "board (code)")!;
    const note = makeNote({
      diagramId: d.id,
      kind: "note",
      text: "which process runs this?",
      author: me,
      forAgent: true,
      about: id("check()"),
      objectId: id("guards.rs"),
    });
    applyOps(doc, state, [{ op: "note.put", note }], me, "flag");
    expect(state.notes.get(note.id)).toMatchObject({ forAgent: true, about: id("check()") });
    const j = idx();
    expect(notesAbout(j, id("check()")).map((n) => n.id)).toEqual([note.id]);
    expect(notesAbout(j, id("board")).map((n) => n.id)).toEqual([note.id]);
    expect(notesAbout(j, id("serve()"))).toEqual([]);
    expect(notesText(j, { objectId: id("board"), forAgent: true, url: () => "" })).toContain(
      `flag ${note.id} on check()`,
    );
    expect(contextText(j, id("guards.rs"), { design: "board" })).toContain("flag");
    expect(() =>
      applyOps(
        doc,
        state,
        [{ op: "note.put", note: { ...note, id: "n_x", about: "o_nope" } }],
        me,
        "x",
      ),
    ).toThrow(ModelError);
  });

  it("links a package to its registry and docs", () => {
    expect(packageLinks({ ecosystem: "npm", name: "@scope/pkg", version: "1.0.0" })[0]!.url).toBe(
      "https://www.npmjs.com/package/%40scope/pkg",
    );
    expect(packageLinks({ ecosystem: "other", name: "x" })).toEqual([]);
  });
});
