// @mentions in notes and replies: @Name for a person who's written in the design's notes
// or is here now, or @agent for the agents. Mentioning an agent makes a note a flag, so
// agents and the curator pick it up. (@Claude, what it was called before, still counts.)
import type { Author } from "./model.ts";

/** Anyone to mention: the people in this design's notes, who's here, and the agents. */
export interface Mentionable {
  id: string;
  name: string;
  kind: Author["kind"];
  /** Shown beside the name in the list. */
  hint?: string;
}

/** "@agent": the agents. A note that mentions them is a flag, so agents (and the curator) pick it up. */
export const ANY_AGENT: Mentionable = {
  id: "agent",
  name: "agent",
  kind: "agent",
  hint: "flags it for an agent",
};
/** The old name for it, still read in notes written before. */
export const OLD_AGENT: Mentionable = { id: "agent", name: "Claude", kind: "agent" };

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The mentions in a text: @Name for each name it knows, longest names first. */
export function mentionsIn(text: string, people: Mentionable[]): Mentionable[] {
  const found = new Map<string, Mentionable>();
  for (const p of [...people].sort((a, b) => b.name.length - a.name.length))
    if (new RegExp(`(^|[^\\w@])@${escape(p.name)}(?![\\w-])`, "i").test(text)) found.set(p.id, p);
  return [...found.values()];
}
export const mentionsAgent = (text: string, people: Mentionable[]) =>
  mentionsIn(text, [...people, ANY_AGENT, OLD_AGENT]).some((p) => p.kind === "agent");
