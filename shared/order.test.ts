import { describe, expect, it } from "vitest";
import { orderChanges, type Change } from "./agent";
import { newNotes } from "./notes";
import { buildIndex } from "./project";

describe("orderChanges", () => {
  it("puts adds first, parents before children, removals last, keeping order otherwise", () => {
    const changes: Change[] = [
      { remove: "old" },
      { view: { name: "V", scope: "api" } },
      { connect: { from: "web", to: "api" } },
      { add: { id: "api", name: "API", kind: "app", in: "sys" } },
      { add: { id: "sys", name: "Sys", kind: "system" } },
      { update: "api", set: { description: "x" } },
    ];
    expect(orderChanges(changes).map((x) => x.i)).toEqual([4, 3, 5, 2, 1, 0]);
  });
});

describe("newNotes", () => {
  it("counts others' notes and replies after a time, not mine", () => {
    const a = (id: string) => ({ id, name: id, kind: "person" as const });
    const note = (id: string, by: string, at: string) => ({
      id,
      kind: "note",
      diagramId: "d",
      text: "t",
      author: a(by),
      createdAt: at,
      updatedAt: at,
      x: 0,
      y: 0,
    });
    const idx = buildIndex({
      objects: [],
      connections: [],
      diagrams: [],
      placements: [],
      flows: [],
      notes: [
        note("n1", "zeek", "2026-11-22T10:00:00Z"),
        note("n2", "me", "2026-11-22T11:00:00Z"),
        note("n3", "zeek", "2026-11-22T08:00:00Z"),
      ],
      replies: [
        { id: "r1", noteId: "n3", text: "ok", author: a("zeek"), at: "2026-11-22T12:00:00Z" },
      ],
    } as never);
    expect(newNotes(idx, "2026-11-22T09:00:00Z", "me")).toEqual({ notes: 1, replies: 1 });
  });
});
