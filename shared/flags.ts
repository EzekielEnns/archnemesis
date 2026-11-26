// Flags waiting on an agent: open notes left for agents whose last word is from a person.
// The channel (cli `archnm channel`) polls these and pushes each new one into the person's
// running Claude Code session, so an @agent (or the older @Claude) gets an answer without anyone asking twice.
import type { Author } from "./model.ts";
import type { ModelIndex } from "./project.ts";

export interface WaitingFlag {
  /** The design or fork it's in. */
  doc: string;
  id: string;
  diagramId: string;
  /** What it's pinned to (or about), by name. */
  on: string | null;
  /** The thread's first message. */
  text: string;
  /** The last message: always from a person. */
  last: { by: Author; at: string; text: string };
}

/**
 * Is this person the one this agent works for? An agent on a machine with no sign-in works
 * for whoever's on it (for "local:*"); a signed-in agent, for the person whose token it holds.
 */
export const worksFor = (agentFor: string | undefined, person: Author) =>
  !!agentFor &&
  person.kind === "human" &&
  (agentFor === "local:*" ? person.id.startsWith("local:") : person.id === agentFor);

/** The open flags in a design whose last message is a person's, optionally only this agent's person. */
export function waitingFlags(idx: ModelIndex, doc: string, agentFor?: string): WaitingFlag[] {
  const out: WaitingFlag[] = [];
  for (const n of idx.notes.values()) {
    if (n.kind !== "note" || !n.forAgent || n.resolved) continue;
    const replies = [...(idx.replies.get(n.id) ?? [])].sort((a, b) => a.at.localeCompare(b.at));
    const tail = replies.at(-1);
    const last = tail
      ? { by: tail.author, at: tail.at, text: tail.text }
      : { by: n.author, at: n.createdAt, text: n.text };
    if (last.by.kind !== "human") continue;
    if (agentFor !== undefined && !worksFor(agentFor, last.by)) continue;
    const about = n.about ?? n.objectId;
    out.push({
      doc,
      id: n.id,
      diagramId: n.diagramId,
      on: about ? (idx.objects.get(about)?.name ?? about) : null,
      text: n.text,
      last,
    });
  }
  return out.sort((a, b) => a.last.at.localeCompare(b.last.at));
}
