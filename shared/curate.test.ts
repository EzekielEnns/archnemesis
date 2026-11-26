// The curator's worklist: flags, drift, things gone, guessed calls, unplaced code.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { codeSeedOps } from "../server/seed.ts";
import { planChanges } from "./agent.ts";
import { isEmpty, worklist, worklistText } from "./curate.ts";
import { applyOps, emptyState, mirror, type Actor } from "./doc.ts";
import { keyOps } from "./files.ts";
import { makeNote } from "./model.ts";
import { buildIndex } from "./project.ts";

const me: Actor = { id: "t", name: "T", kind: "agent" };

function board() {
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
      notes: state.notes.values(),
    });
  const apply = (changes: Parameters<typeof planChanges>[2]) =>
    applyOps(doc, state, planChanges(state, idx(), changes).ops, me, "x");
  return { doc, state, idx, apply };
}

describe("curate", () => {
  it("has nothing to do on a fresh design", () => {
    const w = worklist(board().idx());
    expect(isEmpty(w)).toBe(true);
    expect(worklistText(w, "board")).toContain("Nothing to curate");
  });

  it("lists flags, drift, what's gone, guesses and unplaced code", () => {
    const b = board();
    const d = [...b.state.diagrams.values()][0]!;
    const pm = [...b.state.objects.values()].find((o) => o.name === "post_message()")!;
    applyOps(
      b.doc,
      b.state,
      [
        {
          op: "note.put",
          note: makeNote({
            diagramId: d.id,
            kind: "note",
            text: "which process runs this?",
            author: { id: "a", name: "Agent", kind: "agent" },
            forAgent: true,
            about: pm.id,
          }),
        },
      ],
      me,
      "flag",
    );
    b.apply([
      {
        add: {
          id: "lib-x",
          name: "x.rs",
          kind: "module",
          in: "board",
          path: "s-chan:crates/board/src/x.rs",
          tags: ["generated"],
          sources: ["s-chan@aaa:crates/board/src/x.rs"],
        },
      },
      {
        add: {
          id: "x-a",
          name: "a()",
          kind: "function",
          in: "lib-x",
          tags: ["generated"],
          sources: ["s-chan@bbb:crates/board/src/x.rs:3"],
        },
      },
      {
        add: {
          id: "x-old",
          name: "old()",
          kind: "function",
          in: "lib-x",
          tags: ["generated"],
          status: "deprecated",
        },
      },
      { connect: { from: "x-a", to: "post-message", guess: true } },
      {
        add: {
          id: "tools",
          name: "tools",
          kind: "module",
          in: "board",
          tags: ["generated"],
          path: "s-chan:crates/tools",
        },
      },
    ]);
    const w = worklist(b.idx());
    expect(w.flags.map((f) => f.ref)).toEqual([
      "s-chan:crates/board/src/hub/routes.rs#post_message",
    ]);
    expect(w.drift).toEqual([
      {
        repo: "s-chan",
        commits: [
          { sha: "aaa", count: 1 },
          { sha: "bbb", count: 1 },
        ],
      },
    ]);
    expect(w.gone).toEqual(["s-chan:crates/board/src/x.rs#old"]);
    expect(w.guessed).toEqual([
      {
        from: "s-chan:crates/board/src/x.rs#a",
        to: "s-chan:crates/board/src/hub/routes.rs#post_message",
      },
    ]);
    expect(w.unplaced).toContain("s-chan:crates/tools");
    const t = worklistText(w, "board");
    expect(t).toContain("ONE fork");
    // With a url, each entry carries a link: its own view, or its nearest drawn ancestor's.
    const linked = worklist(b.idx(), {
      url: (d, o) => `http://archnm/#/board/d/${d}${o ? `/o/${o}` : ""}`,
    });
    expect(linked.links["s-chan:crates/board/src/hub/routes.rs#post_message"]).toMatch(
      /^http:\/\/archnm\/#\/board\/d\/.+\/o\//,
    );
    expect(worklistText(linked, "board")).toContain("http://archnm/#/board/d/");
    expect(t).toContain("which process runs this?");
  });
});
