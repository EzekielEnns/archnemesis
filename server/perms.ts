// The server's side of server/access.ts: answers "may this person do that to this design?" from
// what the hub knows (owners, git bindings), the share links, and what GitHub said about repos
// (server/repoaccess.ts). Every route, the sync socket, presence and the MCP ask here; this is
// where can() gets its facts and nothing else decides.
//
// Asking GitHub takes a moment, so a check is two steps: `await perms.prepare(who, doc)` (or
// `warm(who)` for a list) fetches what's missing, then the synchronous `can()` answers from what's
// remembered. What isn't known counts as no access.
import {
  designAccess,
  can,
  canShare,
  owns,
  type AccessSources,
  type DesignAction,
  type DesignAccess,
  type Guest,
  type RepoRef,
  type Who,
  personOf,
} from "./access.ts";
import type { ShareReach } from "../shared/api.ts";
import type { Principal } from "./auth.ts";
import { FailureLimiter, type Links } from "./links.ts";
import type { Hub } from "./live.ts";
import type { RepoAccess } from "./repoaccess.ts";

export const GUEST: Guest = { kind: "guest" };

/** What a socket (or request) is known by: who, and the share link it came with, if any. */
export interface Viewer {
  who: Who;
  /** The share token it presented (already checked once), or null. */
  pass: string | null;
}

/** What the sync server keeps about a connection. */
export interface ConnContext {
  /** The signed-in person; null for a guest. */
  principal: Principal | null;
  guest: boolean;
  pass: string | null;
  /** The link this connection came in on, so revoking it can close the connection. */
  linkId: string | null;
  /** A guest's anonymous id. */
  guestId: string;
}

/**
 * What the sync connection's auth message carries: the bearer token (as before), then, after a
 * newline, "share:" and a share link's token. (Auth messages are not URLs: nothing logs them.)
 */
export function splitToken(raw: string | undefined): {
  bearer: string | null;
  share: string | null;
} {
  const [bearer, rest] = (raw ?? "").split("\n");
  return {
    bearer: bearer || null,
    share: rest?.startsWith("share:") ? rest.slice("share:".length) || null : null,
  };
}

export class Perms {
  readonly links: Links;
  private hub: Hub;
  private repo: RepoAccess;
  private publicLinks: boolean;
  private limiter = new FailureLimiter();
  private now: () => number;

  constructor(
    hub: Hub,
    links: Links,
    repo: RepoAccess,
    publicLinks: boolean,
    githubSignIn = false,
    now: () => number = Date.now,
  ) {
    this.hub = hub;
    this.links = links;
    this.repo = repo;
    this.publicLinks = publicLinks;
    this.now = now;
    this.githubSignIn = githubSignIn;
  }

  /** The instance signs in with GitHub: repo permissions count (settable so tests can stand in for it). */
  githubSignIn: boolean;

  get publicLinksOn(): boolean {
    return this.publicLinks;
  }

  private sources(): AccessSources {
    const { hub } = this;
    return {
      designOf: (doc) => hub.get(doc)?.design ?? null,
      ownerOf: (doc) => {
        const live = hub.get(doc);
        if (!live) return null;
        return live.branch
          ? (hub.git.get(live.design)?.ownerOf(live.key) ?? null)
          : hub.access(live.design).owner;
      },
      isPrivate: (design) => hub.access(design).private,
      githubRepo: (design) => hub.git.get(design)?.githubRepo() ?? null,
      githubSignIn: this.githubSignIn,
      publicLinks: this.publicLinks,
      rights: (person, repo) => this.repo.rights(person, repo),
      isPublic: (repo) => this.repo.isPublic(repo),
      linkByToken: (t) => this.links.find(t),
      now: this.now,
    };
  }

  /** What `who` may do on `doc`, gathered; null when there's no such document. */
  access(who: Who, doc: string, pass: string | null = null): DesignAccess | null {
    const live = this.hub.get(doc);
    return live ? designAccess(this.sources(), who, live.key, pass) : null;
  }

  /** The one question. Synchronous: call prepare() first where GitHub may need asking. */
  can(who: Who, doc: string, action: DesignAction, pass: string | null = null): boolean {
    const a = this.access(who, doc, pass);
    return !!a && can(who, a, action);
  }

  /** Whether `who` may make or revoke links for `doc`. */
  canShare(who: Who, doc: string): boolean {
    const a = this.access(who, doc);
    return !!a && canShare(who, a);
  }

  /** Whether `who` made `doc` (the one who shares it with the team, or takes it back). */
  owns(who: Who, doc: string): boolean {
    const live = this.hub.get(doc);
    return !!live && owns(who, this.access(who, live.key)?.owner ?? null);
  }

  private repoOf(doc: string): RepoRef | null {
    const live = this.hub.get(doc);
    return live ? (this.hub.git.get(live.design)?.githubRepo() ?? null) : null;
  }

  /** Fetch what answering about `doc` needs from GitHub (the person's rights; for a guest or a link page, whether the repo is public). */
  async prepare(who: Who, doc: string, withPublic = false): Promise<void> {
    const repo = this.repoOf(doc);
    if (!repo) return;
    const person = personOf(who);
    const asks: Promise<void>[] = [];
    if (this.githubSignIn && person) asks.push(this.repo.warmRights(person, repo));
    if (withPublic || who?.kind === "guest") asks.push(this.repo.warmPublic(repo));
    await Promise.all(asks);
  }

  /** Fetch GitHub's answers for every design this person might list. */
  async warm(who: Who): Promise<void> {
    const person = personOf(who);
    if (!this.githubSignIn || !person) return;
    const repos = new Map<string, RepoRef>();
    for (const g of this.hub.git.values()) {
      const r = g.githubRepo();
      if (r) repos.set(`${r.owner}/${r.repo}`.toLowerCase(), r);
    }
    await Promise.all([...repos.values()].map((r) => this.repo.warmRights(person, r)));
  }

  /**
   * A share token that came with a request, checked at the edge: the token itself when it names a
   * link that works now, else null. A failure counts against the address; past a few, that
   * address's tokens aren't looked at for a while. Looking costs the same either way.
   */
  present(token: string | null | undefined, addr: string): string | null {
    if (!token || token.length > 128) return null;
    if (this.limiter.blocked(addr)) return null;
    const row = this.links.find(token);
    const ok =
      !!row && row.revokedAt === null && (row.expiresAt === null || row.expiresAt > this.now());
    if (!ok) {
      this.limiter.fail(addr);
      return null;
    }
    this.links.used(row.id);
    return token;
  }

  /** The id of the link a (presented) token names. */
  linkId(token: string | null): string | null {
    return token ? (this.links.find(token)?.id ?? null) : null;
  }

  /** What anyone who opens a link to this design needs to sign in for: "signin" or "anyone" (public repo, hoster allows it). */
  reach(doc: string): ShareReach {
    const repo = this.repoOf(doc);
    const publicRepo = !!repo && this.repo.isPublic(repo);
    return {
      kind: this.publicLinks && publicRepo ? "anyone" : "signin",
      publicRepo,
      publicLinks: this.publicLinks,
    };
  }
}
