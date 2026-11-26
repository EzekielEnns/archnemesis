import { describe, expect, it } from "vitest";
import { waitingFlags, worksFor } from "./flags.ts";
import { buildIndex } from "./project.ts";
import type { Author, Note, Reply } from "./model.ts";

const me: Author = { id: "local:You", name: "You", kind: "human" };
const jack: Author = { id: "ts:jack", name: "Jack", kind: "human" };
// An agent from before the rename: its id (agent:claude) is still an agent.
const claude: Author = { id: "agent:claude", name: "Claude", kind: "agent" };
const note = (id: string, author: Author, extra: Partial<Note> = {}): Note => ({
  id,
  diagramId: "d1",
  kind: "note",
  objectId: null,
  x: 0,
  y: 0,
  text: `@agent ${id}`,
  forAgent: true,
  author,
  resolved: false,
  createdAt: "2026-11-21T10:00:00Z",
  updatedAt: "2026-11-21T10:00:00Z",
  ...extra,
});
const reply = (noteId: string, author: Author, at: string): Reply => ({
  id: `${noteId}-${at}`,
  noteId,
  text: "hey",
  author,
  at,
});
const idx = (notes: Note[], replies: Reply[] = []) =>
  buildIndex({
    objects: [],
    connections: [],
    diagrams: [],
    placements: [],
    notes,
    replies,
  } as never);

describe("waiting flags", () => {
  it("lists open flags whose last word is a person's", () => {
    const i = idx(
      [
        note("a", me),
        note("b", me),
        note("c", me, { resolved: true }),
        note("d", me, { forAgent: false }),
      ],
      [reply("b", claude, "2026-11-21T11:00:00Z")],
    );
    expect(waitingFlags(i, "x").map((f) => f.id)).toEqual(["a"]);
  });
  it("an answer to an agent's question is waiting again", () => {
    const i = idx([note("q", claude)], [reply("q", me, "2026-11-21T12:00:00Z")]);
    const [f] = waitingFlags(i, "x");
    expect(f?.last).toMatchObject({ by: me, at: "2026-11-21T12:00:00Z" });
  });
  it("only the person this agent works for", () => {
    const i = idx([note("mine", me), note("his", jack)]);
    expect(waitingFlags(i, "x", "local:*").map((f) => f.id)).toEqual(["mine"]);
    expect(waitingFlags(i, "x", "ts:jack").map((f) => f.id)).toEqual(["his"]);
    expect(worksFor(undefined, me)).toBe(false);
  });
});
