// Notes and links: on a diagram, pinned to a box or not, with replies; tidied with what they hang on.
import { linkNoteOps } from "./notes.ts";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { seedOps } from "./seed.ts";
import { applyOps, danglingOps, emptyState, mirror, ModelError, sweep, type Actor } from "./doc.ts";
import { makeNote, makeReply } from "./model.ts";
import { buildIndex, notesOn } from "./project.ts";
import { keyOps, readFiles, toOps, writeFiles } from "./files.ts";
import { isThreadOp } from "./model.ts";

const me: Actor = { id: "t", name: "T", kind: "human" };

function seeded() {
  const doc = new Y.Doc();
  const state = emptyState();
  mirror(doc, state, () => {});
  applyOps(doc, state, seedOps(), me, "seed");
  const p = [...state.placements.values()][0]!;
  return { doc, state, p };
}
const index = (s: ReturnType<typeof emptyState>) =>
  buildIndex({
    objects: s.objects.values(),
    connections: s.connections.values(),
    diagrams: s.diagrams.values(),
    placements: s.placements.values(),
    notes: s.notes.values(),
    replies: s.replies.values(),
  });

describe("notes", () => {
  it("a pinned note follows its box and keeps its spot when the box goes", () => {
    const { doc, state, p } = seeded();
    const n = makeNote({
      diagramId: p.diagramId,
      kind: "note",
      objectId: p.objectId,
      x: 10,
      y: -8,
      text: "why two queues?",
      author: me,
    });
    applyOps(doc, state, [{ op: "note.put", note: n }], me, "note");
    expect(notesOn(index(state), p.diagramId)[0]).toMatchObject({ x: p.x + 10, y: p.y - 8 });
    applyOps(doc, state, [{ op: "placement.put", placement: { ...p, x: p.x + 100 } }], me, "move");
    expect(notesOn(index(state), p.diagramId)[0]!.x).toBe(p.x + 110);
    applyOps(
      doc,
      state,
      [{ op: "placement.delete", diagramId: p.diagramId, objectId: p.objectId }],
      me,
      "remove",
    );
    expect(state.notes.get(n.id)).toMatchObject({ objectId: null, x: p.x + 110, y: p.y - 8 });
  });

  it("replies are their own records and go with their note", () => {
    const { doc, state, p } = seeded();
    const n = makeNote({
      diagramId: p.diagramId,
      kind: "note",
      x: 0,
      y: 0,
      text: "hm",
      author: me,
    });
    const r1 = makeReply({ noteId: n.id, text: "yes", author: me });
    const r2 = makeReply({
      noteId: n.id,
      text: "no",
      author: { id: "a", name: "A", kind: "agent" },
    });
    applyOps(
      doc,
      state,
      [
        { op: "note.put", note: n },
        { op: "reply.put", reply: r1 },
        { op: "reply.put", reply: r2 },
      ],
      me,
      "thread",
    );
    expect(
      index(state)
        .replies.get(n.id)
        ?.map((r) => r.text)
        .sort(),
    ).toEqual(["no", "yes"]);
    applyOps(doc, state, [{ op: "note.delete", id: n.id }], me, "delete");
    expect(state.replies.size).toBe(0);
  });

  it("go with their diagram", () => {
    const { doc, state, p } = seeded();
    const n = makeNote({
      diagramId: p.diagramId,
      kind: "note",
      x: 0,
      y: 0,
      text: "hm",
      author: me,
    });
    applyOps(
      doc,
      state,
      [
        { op: "note.put", note: n },
        { op: "reply.put", reply: makeReply({ noteId: n.id, text: "x", author: me }) },
      ],
      me,
      "thread",
    );
    applyOps(doc, state, [{ op: "diagram.delete", id: p.diagramId }], me, "delete");
    expect(state.notes.size + state.replies.size).toBe(0);
  });

  it("go with the box they're on or about", () => {
    const { doc, state, p } = seeded();
    const on = makeNote({
      diagramId: p.diagramId,
      kind: "note",
      objectId: p.objectId,
      x: 0,
      y: 0,
      text: "pinned",
      author: me,
    });
    const about = makeNote({
      diagramId: p.diagramId,
      kind: "note",
      about: p.objectId,
      x: 0,
      y: 0,
      text: "about it",
      author: me,
    });
    applyOps(
      doc,
      state,
      [
        { op: "note.put", note: on },
        { op: "note.put", note: about },
      ],
      me,
      "notes",
    );
    applyOps(doc, state, [{ op: "object.delete", id: p.objectId }], me, "delete");
    expect(state.notes.has(on.id) || state.notes.has(about.id)).toBe(false);
  });

  it("links need a web address; notes need words", () => {
    const { doc, state, p } = seeded();
    const bad = [
      makeNote({
        diagramId: p.diagramId,
        kind: "link",
        x: 0,
        y: 0,
        text: "RFC",
        url: "javascript:alert(1)",
        author: me,
      }),
      makeNote({ diagramId: p.diagramId, kind: "link", x: 0, y: 0, text: "RFC", author: me }),
      makeNote({ diagramId: p.diagramId, kind: "note", x: 0, y: 0, text: "  ", author: me }),
      makeNote({
        diagramId: p.diagramId,
        kind: "note",
        objectId: "nope",
        x: 0,
        y: 0,
        text: "hi",
        author: me,
      }),
    ];
    for (const note of bad)
      expect(() => applyOps(doc, state, [{ op: "note.put", note }], me, "x")).toThrow(ModelError);
    const ok = makeNote({
      diagramId: p.diagramId,
      kind: "link",
      x: 0,
      y: 0,
      text: "RFC",
      url: "https://www.notion.so/rfc-12",
      author: me,
    });
    applyOps(doc, state, [{ op: "note.put", note: ok }], me, "link");
    expect(state.notes.get(ok.id)?.url).toBe("https://www.notion.so/rfc-12");
    expect(() =>
      applyOps(
        doc,
        state,
        [{ op: "reply.put", reply: makeReply({ noteId: ok.id, text: "hi", author: me }) }],
        me,
        "x",
      ),
    ).toThrow(ModelError);
  });

  it("dangling ones are tidied; none of it goes in the files", () => {
    const { doc, state, p } = seeded();
    const n = makeNote({
      diagramId: p.diagramId,
      kind: "note",
      objectId: p.objectId,
      x: 0,
      y: 0,
      text: "hm",
      author: me,
    });
    applyOps(doc, state, [{ op: "note.put", note: n }], me, "note");
    // Someone else's delete raced it: the placement vanished without the cascade.
    doc.getMap("placements").delete(`${p.diagramId}|${p.objectId}`);
    expect(danglingOps(state).some((o) => o.op === "note.put")).toBe(true);
    sweep(doc, state, me);
    expect(state.notes.get(n.id)?.objectId).toBe(null);
    expect([...writeFiles(state).values()].join("\n")).not.toContain("hm");
  });

  it("links live on boxes and views, in their files; old link notes move there", () => {
    const { doc, state, p } = seeded();
    applyOps(doc, state, keyOps(state), me, "keys");
    const view = state.diagrams.get(p.diagramId)!;
    const k = view.key ?? view.id;
    const box = state.objects.get(p.objectId)!;
    const bk = box.key ?? box.id;
    // Old link notes (as a live doc may still hold them) move onto the box and the view.
    const link = makeNote({
      diagramId: p.diagramId,
      kind: "link",
      objectId: p.objectId,
      x: 0,
      y: 86,
      text: "RFC 12",
      url: "https://notion.so/rfc-12",
      author: me,
    });
    const loose = makeNote({
      diagramId: p.diagramId,
      kind: "link",
      x: 900,
      y: 40,
      text: "Runbook",
      url: "https://github.com/x/runbook",
      author: me,
    });
    const note = makeNote({
      diagramId: p.diagramId,
      kind: "note",
      x: 0,
      y: 0,
      text: "secret chat",
      author: me,
    });
    applyOps(
      doc,
      state,
      [
        { op: "note.put", note: link },
        { op: "note.put", note: loose },
        { op: "note.put", note: note },
      ],
      me,
      "links",
    );
    applyOps(doc, state, linkNoteOps(state), me, "move");
    expect(linkNoteOps(state)).toEqual([]);
    expect(state.objects.get(p.objectId)!.links).toEqual([
      { title: "RFC 12", url: "https://notion.so/rfc-12" },
    ]);
    expect(state.diagrams.get(p.diagramId)!.links).toEqual([
      { title: "Runbook", url: "https://github.com/x/runbook" },
    ]);
    expect(state.notes.has(note.id)).toBe(true);
    const files = writeFiles(state);
    expect(
      [...files.entries()].find(
        ([f, t]) => f.startsWith("model/") && t.includes("link: https://notion.so/rfc-12"),
      ),
    ).toBeTruthy();
    expect(files.get(`views/${k}.yaml`)).toContain("url: https://github.com/x/runbook");
    expect([...files.values()].join("\n")).not.toContain("secret chat");
    expect(toOps(state, readFiles(files).model)).toEqual([]);
    // v1's view link pinned to a box (on:) isn't read any more: it's a box's own link reference.
    const old = new Map(files);
    old.set(
      `views/${k}.yaml`,
      files.get(`views/${k}.yaml`)! +
        `  - title: Dash\n    url: https://example.com/dash\n    on: ${bk}\n`,
    );
    expect(readFiles(old).problems.map((x) => x.message)).toContainEqual(
      expect.stringContaining('unknown field "on"'),
    );
    // One address once.
    expect(() =>
      applyOps(
        doc,
        state,
        [
          {
            op: "object.put",
            object: {
              ...state.objects.get(p.objectId)!,
              links: [link, link].map((n) => ({ title: n.text, url: n.url! })),
            },
          },
        ],
        me,
        "dup",
      ),
    ).toThrow(ModelError);
    expect(isThreadOp({ op: "note.put", note }, state.notes)).toBe(true);
  });

  it("pin to a connection's arrow, and come loose when it goes", () => {
    const { doc, state, p } = seeded();
    const c = [...state.connections.values()][0]!;
    const n = makeNote({
      diagramId: p.diagramId,
      kind: "note",
      objectId: null,
      connectionId: c.id,
      x: 14,
      y: -10,
      text: "why sync?",
      author: me,
    });
    applyOps(doc, state, [{ op: "note.put", note: n }], me, "note");
    expect(state.notes.get(n.id)!.connectionId).toBe(c.id);
    // Not both a box and an arrow; not an arrow that isn't there.
    expect(() =>
      applyOps(doc, state, [{ op: "note.put", note: { ...n, objectId: p.objectId } }], me, "both"),
    ).toThrow(ModelError);
    expect(() =>
      applyOps(doc, state, [{ op: "note.put", note: { ...n, connectionId: "nope" } }], me, "gone"),
    ).toThrow(ModelError);
    applyOps(doc, state, [{ op: "connection.delete", id: c.id }], me, "delete");
    expect(state.notes.get(n.id)).toBeDefined();
    expect(state.notes.get(n.id)!.connectionId).toBeUndefined();
  });

  it("a connection's running notes go in its file and back", () => {
    const { doc, state } = seeded();
    applyOps(doc, state, keyOps(state), me, "keys");
    const c = [...state.connections.values()][0]!;
    applyOps(
      doc,
      state,
      [{ op: "connection.put", connection: { ...c, notes: "- [ ] retries?\n- timeout is 5s" } }],
      me,
      "notes",
    );
    const files = writeFiles(state);
    expect([...files.values()].join("\n")).toContain("retries?");
    const back = readFiles(files);
    expect(back.problems).toEqual([]);
    expect(toOps(state, back.model)).toEqual([]);
  });
});
