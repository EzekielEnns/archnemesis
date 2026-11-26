// Repos read on someone's own machine, sent straight to Archnemesis: the MCP tool index (start) mints
// a ticket (a link good for one upload, for a few minutes), the agent runs the script Archnemesis
// serves with it, and the script posts the repo's survey and code index to the link. The
// repo goes from disk to Archnemesis without passing through the model, and the person never
// handles a token: the ticket is minted inside an MCP call that's already signed in.
import { randomBytes } from "node:crypto";
import type { CodeIndex } from "../shared/codeindex.ts";
import type { Survey } from "./survey.ts";

export interface Upload {
  survey: Survey;
  index: CodeIndex;
  at: number;
}

interface Ticket {
  /** Who minted it: only they read what's uploaded. */
  owner: string;
  design: string;
  path: string;
  expires: number;
  upload?: Upload;
}

const UPLOAD_WINDOW_MS = 15 * 60_000;
const KEEP_MS = 6 * 3600_000;
const MAX_PER_OWNER = 30;

export class Uploads {
  private tickets = new Map<string, Ticket>();

  mint(owner: string, design: string, path: string): string {
    this.sweep();
    const mine = [...this.tickets.entries()]
      .filter(([, t]) => t.owner === owner)
      .sort((a, b) => a[1].expires - b[1].expires);
    while (mine.length >= MAX_PER_OWNER) this.tickets.delete(mine.shift()![0]);
    const id = randomBytes(18).toString("base64url");
    this.tickets.set(id, { owner, design, path, expires: Date.now() + UPLOAD_WINDOW_MS });
    return id;
  }

  /** The script's upload: once per ticket, inside its window. */
  put(
    id: string,
    data: Omit<Upload, "at">,
  ): { ok: true; repo: string } | { ok: false; error: string } {
    const t = this.tickets.get(id);
    if (!t || t.expires < Date.now())
      return {
        ok: false,
        error: "this link has run out or was never made: ask the agent for a new one (index start)",
      };
    if (t.upload)
      return {
        ok: false,
        error: "this link was used already: ask the agent for a new one (index start)",
      };
    t.upload = { ...data, at: Date.now() };
    t.expires = Date.now() + KEEP_MS;
    return { ok: true, repo: data.survey.repo };
  }

  /** The repos uploaded for a design (or its forks), by name. */
  reposFor(design: string): string[] {
    const main = design.split("@")[0];
    return [
      ...new Set(
        [...this.tickets.values()]
          .filter((t) => t.upload && t.design.split("@")[0] === main)
          .map((t) => t.upload!.index.repo || t.upload!.survey.repo)
          .filter(Boolean),
      ),
    ];
  }

  get(id: string, owner: string): { ticket: Ticket } | { error: string } {
    const t = this.tickets.get(id.trim());
    if (!t || t.owner !== owner || t.expires < Date.now())
      return {
        error: `no upload "${id}" of yours (tickets last 15 minutes until used, then 6 hours)`,
      };
    if (!t.upload)
      return {
        error:
          "nothing uploaded on that ticket yet: run the command index start gave, then try again",
      };
    return { ticket: t };
  }

  private sweep() {
    const now = Date.now();
    for (const [id, t] of this.tickets) if (t.expires < now) this.tickets.delete(id);
  }
}
