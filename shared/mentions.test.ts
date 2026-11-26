import { describe, expect, it } from "vitest";
import { ANY_AGENT, mentionsAgent, mentionsIn } from "./mentions.ts";

const people = [
  { id: "u1", name: "Jack", kind: "human" as const },
  { id: "u2", name: "Jack-Smith", kind: "human" as const },
  { id: "a1", name: "curator", kind: "agent" as const },
  ANY_AGENT,
];

describe("mentions", () => {
  it("finds whole @names, the longest first, any case", () => {
    expect(mentionsIn("hey @jack-smith look", people).map((p) => p.id)).toEqual(["u2"]);
    expect(
      mentionsIn("@Jack and @Jack-Smith", people)
        .map((p) => p.id)
        .sort(),
    ).toEqual(["u1", "u2"]);
  });
  it("skips emails and names inside words", () => {
    expect(mentionsIn("mail jack@jackson.com", people)).toEqual([]);
    expect(mentionsIn("@Jackson", people)).toEqual([]);
  });
  it("an agent mention makes a flag", () => {
    expect(mentionsAgent("@agent tidy this", people)).toBe(true);
    expect(mentionsAgent("@Agent, tidy this", [])).toBe(true);
    // What it was called before: notes already written still flag.
    expect(mentionsAgent("@Claude tidy this", people)).toBe(true);
    expect(mentionsAgent("@claude, tidy this", [])).toBe(true);
    expect(mentionsAgent("@curator have a look", people)).toBe(true);
    expect(mentionsAgent("@Jack have a look", people)).toBe(false);
  });
});
