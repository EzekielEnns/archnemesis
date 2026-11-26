// Who's touched it: the people (and agents) behind a box, read from git rather than an
// owner field nobody keeps up to date. Each of the box's sources (repo@ref:path[:line])
// names a path; its recent commits, grouped by author, say who changes that code and how
// recently. With coding agents in the loop, a commit an agent helped with is counted too,
// so "Zeek, 14 commits, 9 with an agent" reads for what it is.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { GitHub } from "./github.ts";

const run = promisify(execFile);

interface Toucher {
  name: string;
  login?: string;
  commits: number;
  /** How many of those an agent helped with (a co-author trailer, or a bot). */
  withAgent: number;
  last: string;
}

export interface Touched {
  people: Toucher[];
  /** Commits looked at, per source path. */
  looked: { source: string; commits: number; via: "github" | "local" }[];
  /** Sources it couldn't read, and why. */
  missed: { source: string; why: string }[];
}

interface Commit {
  sha: string;
  name: string;
  login?: string;
  email: string;
  date: string;
  message: string;
}

// repo@ref:path, or repo:path for a file that isn't written yet (no history to read, then).
const SOURCE = /^([A-Za-z0-9._-]+)(?:@([A-Za-z0-9._/-]+))?:([^:\s]+)(?::\d+(?:-\d+)?)?$/;
/** A commit an agent wrote or helped with. */
const AGENT =
  /co-authored-by:\s*(claude|copilot|cursor|devin|codex|aider|[^\n<]*\[bot\])|claudy mcclaudin helped|generated with \[?claude/i;
const isBot = (c: Commit) =>
  /\[bot\]$/.test(c.login ?? c.name) || /noreply@anthropic\.com/.test(c.email);

const cache = new Map<
  string,
  { at: number; value: Promise<{ commits: Commit[]; via: "github" | "local" }> }
>();
const TTL = 10 * 60_000;

/**
 * The recent commits on one source path: through GitHub when Archnemesis's app can read the
 * repo, else a local clone under `localRoot/<repo>` (ARCHNM_SOURCE_ROOT), so it works on a
 * laptop too. Follows the repo's default branch, not the ref the source was pinned at:
 * the question is who changes it now.
 */
async function commitsFor(
  github: GitHub | undefined,
  owner: string | undefined,
  localRoot: string | undefined,
  repo: string,
  path: string,
  limit: number,
) {
  const key = `${owner}/${repo}:${path}:${limit}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  const value = (async () => {
    if (github && owner) {
      const token = await github.repoToken(owner, repo).catch(() => null);
      if (token) {
        const list = await github.commits(owner, repo, path, limit, token);
        return { commits: list, via: "github" as const };
      }
    }
    const dir = localRoot ? join(localRoot, repo) : "";
    if (dir && existsSync(join(dir, ".git"))) {
      const { stdout } = await run(
        "git",
        ["-C", dir, "log", `-n${limit}`, "--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%B%x1e", "--", path],
        { maxBuffer: 8 << 20 },
      );
      const commits = stdout
        .split("\x1e")
        .map((r) => r.trim())
        .filter(Boolean)
        .map((r): Commit => {
          const [sha = "", name = "", email = "", date = "", message = ""] = r.split("\x1f");
          return { sha, name, email, date, message };
        });
      return { commits, via: "local" as const };
    }
    throw new Error(
      owner
        ? `Archnemesis's GitHub app can't read ${owner}/${repo}${localRoot ? `, and there's no clone at ${dir}` : ""}`
        : "set github: in archnm.yaml (the owner), or ARCHNM_SOURCE_ROOT for local clones",
    );
  })();
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  return value;
}

/** Who's touched what `sources` point at, most commits first. */
export async function touched(
  sources: string[],
  o: { github?: GitHub; owner?: string; localRoot?: string; limit?: number },
): Promise<Touched> {
  const people = new Map<string, Toucher>();
  const looked: Touched["looked"] = [];
  const missed: Touched["missed"] = [];
  const seen = new Set<string>();
  // A folder and a file in it are both sources often: a commit counts once.
  const counted = new Set<string>();
  const alias = new Map<string, string>();
  await Promise.all(
    sources.map(async (s) => {
      const m = SOURCE.exec(s);
      if (!m) return void missed.push({ source: s, why: "not repo@ref:path" });
      const [, repo, , path] = m;
      if (seen.has(`${repo}:${path}`)) return;
      seen.add(`${repo}:${path}`);
      try {
        const { commits, via } = await commitsFor(
          o.github,
          o.owner,
          o.localRoot,
          repo!,
          path!,
          o.limit ?? 50,
        );
        looked.push({ source: s, commits: commits.length, via });
        for (const c of commits) {
          if (counted.has(`${repo}:${c.sha}`)) continue;
          counted.add(`${repo}:${c.sha}`);
          // One person, however they signed the commit: the same login, email or name is
          // the same person ("Zeke" and "Ezekiel Enns" from one address read as one).
          const keys = [
            c.login && `l:${c.login.toLowerCase()}`,
            c.email && `e:${c.email.toLowerCase()}`,
            `n:${c.name.toLowerCase()}`,
          ].filter(Boolean) as string[];
          const who = keys.map((k) => alias.get(k)).find(Boolean) ?? keys[0]!;
          for (const k of keys) alias.set(k, who);
          const p = people.get(who) ?? {
            name: c.name,
            ...(c.login ? { login: c.login } : {}),
            commits: 0,
            withAgent: 0,
            last: "",
          };
          // Shown under the name they used last.
          if (c.date > p.last) p.name = c.name;
          p.commits++;
          if (AGENT.test(c.message) || isBot(c)) p.withAgent++;
          if (c.date > p.last) p.last = c.date;
          people.set(who, p);
        }
      } catch (e) {
        missed.push({ source: s, why: (e as Error).message });
      }
    }),
  );
  return {
    people: [...people.values()].sort(
      (a, b) => b.commits - a.commits || b.last.localeCompare(a.last),
    ),
    looked,
    missed,
  };
}

/** For an agent: one line per person. */
export function touchedText(t: Touched): string {
  const out = t.people.map(
    (p) =>
      `${p.name}${p.login && p.login !== p.name ? ` (@${p.login})` : ""}: ${p.commits} commit(s)${p.withAgent ? `, ${p.withAgent} with an agent` : ""}, last ${p.last.slice(0, 10)}`,
  );
  if (!t.people.length)
    out.push(t.looked.length ? "no commits on its sources" : "no readable sources");
  for (const m of t.missed) out.push(`couldn't read ${m.source}: ${m.why}`);
  return out.join("\n");
}
