// What GitHub says about a repo, remembered for a few minutes: what one person may do there
// (asked with their own GitHub sign-in) and whether anyone may read it without signing in.
//
// Reads are synchronous and only ever see what has been fetched (warm* fetches), so the checks in
// server/access.ts stay pure and quick; anything not yet known, or that failed, is "none" / "not
// public". GitHub is a RepoSource, so tests plug in a fake.
import type { RepoRef, RepoRights } from "./access.ts";
import type { GitHub } from "./github.ts";

export interface RepoSource {
  repoRights(person: string, owner: string, repo: string): Promise<RepoRights>;
  repoIsPublic(owner: string, repo: string): Promise<boolean>;
}

/** How long an answer is kept. */
export const RIGHTS_TTL_MS = 3 * 60_000;
export const PUBLIC_TTL_MS = 5 * 60_000;

interface Entry<T> {
  value: T;
  at: number;
}

const keyOf = (r: RepoRef) => `${r.owner}/${r.repo}`.toLowerCase();

export class RepoAccess {
  private source: () => RepoSource | null;
  private now: () => number;
  private rights_ = new Map<string, Entry<RepoRights>>();
  private public_ = new Map<string, Entry<boolean>>();
  private asking = new Map<string, Promise<void>>();

  constructor(source: () => RepoSource | null, now: () => number = Date.now) {
    this.source = source;
    this.now = now;
  }

  rights(person: string, repo: RepoRef): RepoRights {
    const e = this.rights_.get(`${person}\n${keyOf(repo)}`);
    return e && this.now() - e.at < RIGHTS_TTL_MS ? e.value : "none";
  }

  isPublic(repo: RepoRef): boolean {
    const e = this.public_.get(keyOf(repo));
    return !!e && this.now() - e.at < PUBLIC_TTL_MS && e.value;
  }

  /** Ask GitHub what `person` may do on the repo, unless that's recent. Never throws. */
  warmRights(person: string, repo: RepoRef): Promise<void> {
    const key = `${person}\n${keyOf(repo)}`;
    const hit = this.rights_.get(key);
    if (hit && this.now() - hit.at < RIGHTS_TTL_MS) return Promise.resolve();
    return this.once(`r\n${key}`, async () => {
      const src = this.source();
      const value = await src
        ?.repoRights(person, repo.owner, repo.repo)
        .catch(() => "none" as const);
      this.rights_.set(key, { value: value ?? "none", at: this.now() });
    });
  }

  /** Ask whether the repo is public, unless that's recent. Never throws. */
  warmPublic(repo: RepoRef): Promise<void> {
    const key = keyOf(repo);
    const hit = this.public_.get(key);
    if (hit && this.now() - hit.at < PUBLIC_TTL_MS) return Promise.resolve();
    return this.once(`p\n${key}`, async () => {
      const src = this.source();
      const value = await src?.repoIsPublic(repo.owner, repo.repo).catch(() => false);
      this.public_.set(key, { value: value ?? false, at: this.now() });
    });
  }

  /** Concurrent questions about the same thing share one call. A failed ask is remembered as none (or not public), for the usual time. */
  private once(key: string, ask: () => Promise<void>): Promise<void> {
    let p = this.asking.get(key);
    if (!p) {
      p = ask().finally(() => this.asking.delete(key));
      this.asking.set(key, p);
    }
    return p;
  }
}

/**
 * GitHub as a RepoSource. A person's rights are asked with THEIR OWN sign-in token, never the app's
 * installation token (which can do more than they can); no token, or any failure, is "none".
 * Whether a repo is public is asked with no credentials at all; failing, it's "not public".
 */
export function githubSource(gh: GitHub, api: string): RepoSource {
  const path = (owner: string, repo: string) =>
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  return {
    repoRights: async (person, owner, repo) => {
      const token = await gh.userToken(person);
      if (!token) return "none";
      const r = await gh
        .call<{ permissions?: { push?: boolean; pull?: boolean } }>("GET", path(owner, repo), token)
        .catch(() => null);
      return r?.permissions?.push ? "push" : r?.permissions?.pull ? "read" : "none";
    },
    repoIsPublic: async (owner, repo) => {
      try {
        const r = await fetch(`${api}${path(owner, repo)}`, {
          headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
        });
        return r.ok && ((await r.json()) as { private?: boolean }).private === false;
      } catch {
        return false;
      }
    },
  };
}
