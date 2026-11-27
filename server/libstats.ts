// Library stats: what a reviewer wants to know before a new dependency goes in. Is it
// maintained, by how many people, under what licence, with known advisories? From deps.dev
// (versions, licence, repo, OpenSSF scorecard, advisories) and GitHub (contributors).
//
// A daily job caches them in the server's settings table (libstats:<ecosystem>/<name>@<version>).
// They're display data: never in the design's files. Opt-in (ARCHNM_LIBSTATS=on), because
// it sends each library's package name to deps.dev and GitHub, and a private package's name
// is a private fact. Packages with ecosystem "other" are never sent.
import type { Ecosystem, Package } from "../shared/model.ts";
import { statsKey, warningsOf, type LibStats } from "../shared/libstats.ts";

export type { LibStats };

const SYSTEM: Partial<Record<Ecosystem, string>> = {
  cargo: "CARGO",
  npm: "NPM",
  pypi: "PYPI",
  go: "GO",
  maven: "MAVEN",
  nuget: "NUGET",
  rubygems: "RUBYGEMS",
};
const DAY = 24 * 60 * 60 * 1000;
const UA = { "user-agent": "archnm-libstats" };

type Fetch = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  headers: { get(k: string): string | null };
}>;

/** Fetch one package's stats. Never throws: what failed is in error. */
export async function fetchStats(
  p: Package,
  fetchImpl: Fetch,
  opts: { githubToken?: string; now?: number } = {},
): Promise<LibStats> {
  const sys = SYSTEM[p.ecosystem];
  const s: Omit<LibStats, "warnings"> = {
    fetchedAt: new Date(opts.now ?? Date.now()).toISOString(),
  };
  if (!sys) return { ...s, warnings: [], error: "no registry for this ecosystem" };
  const get = async (url: string, headers: Record<string, string> = {}) => {
    const r = await fetchImpl(url, {
      headers: { ...UA, ...headers },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`);
    return r;
  };
  const base = `https://api.deps.dev/v3/systems/${sys}/packages/${encodeURIComponent(p.name)}`;
  try {
    const pkg = (await (await get(base)).json()) as {
      versions?: { versionKey: { version: string }; publishedAt?: string; isDefault?: boolean }[];
    };
    const versions = pkg.versions ?? [];
    const latest = versions.find((v) => v.isDefault) ?? versions.at(-1);
    if (latest) {
      s.latest = latest.versionKey.version;
      s.latestAt = latest.publishedAt;
    }
    const want = p.version ?? s.latest;
    if (want) {
      const v = (await (await get(`${base}/versions/${encodeURIComponent(want)}`)).json()) as {
        publishedAt?: string;
        licenses?: string[];
        advisoryKeys?: { id: string }[];
        relatedProjects?: { projectKey: { id: string }; relationType?: string }[];
      };
      s.versionAt = v.publishedAt;
      s.licenses = v.licenses ?? [];
      s.advisories = (v.advisoryKeys ?? []).map((a) => a.id);
      const repo = (v.relatedProjects ?? []).find((r) => r.relationType === "SOURCE_REPO")
        ?.projectKey.id;
      if (repo) {
        s.repo = `https://${repo}`;
        const proj = (await (
          await get(`https://api.deps.dev/v3/projects/${encodeURIComponent(repo)}`)
        ).json()) as {
          starsCount?: number;
          forksCount?: number;
          openIssuesCount?: number;
          description?: string;
          scorecard?: { overallScore?: number };
        };
        s.stars = proj.starsCount;
        s.forks = proj.forksCount;
        s.openIssues = proj.openIssuesCount;
        s.description = proj.description;
        s.scorecard = proj.scorecard?.overallScore;
        const gh = /^github\.com\/([^/]+)\/([^/]+)$/.exec(repo);
        if (gh) {
          // How many people: the last page of a one-per-page list.
          const r = await get(
            `https://api.github.com/repos/${gh[1]}/${gh[2]}/contributors?per_page=1&anon=true`,
            opts.githubToken ? { authorization: `Bearer ${opts.githubToken}` } : {},
          );
          const last = /[?&]page=(\d+)>;\s*rel="last"/.exec(r.headers.get("link") ?? "");
          s.contributors = last ? Number(last[1]) : ((await r.json()) as unknown[]).length;
        }
      }
    }
  } catch (e) {
    s.error = e instanceof Error ? e.message : String(e);
  }
  return { ...s, warnings: warningsOf(s, opts.now) };
}

interface Settings {
  setting(key: string): string | null;
  setSetting(key: string, value: string): void;
  settings(prefix: string): { key: string; value: string }[];
}

/** The cache and the daily job that fills it. */
export class LibStatsJob {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private store: Settings;
  private packages: () => Package[];
  private fetchImpl: Fetch;
  private opts: { githubToken?: string; enabled?: boolean };
  constructor(
    store: Settings,
    packages: () => Package[],
    fetchImpl: Fetch = fetch as unknown as Fetch,
    opts: { githubToken?: string; enabled?: boolean } = {},
  ) {
    this.store = store;
    this.packages = packages;
    this.fetchImpl = fetchImpl;
    this.opts = opts;
  }

  get enabled(): boolean {
    return !!this.opts.enabled;
  }

  get(p: Package): LibStats | null {
    const v = this.store.setting(`libstats:${statsKey(p)}`);
    return v ? (JSON.parse(v) as LibStats) : null;
  }

  /** One package, fetched now if it isn't kept yet (a library just written), within `ms`. */
  async now(p: Package, ms = 4000): Promise<LibStats | null> {
    const had = this.get(p);
    if (had || !this.enabled || !SYSTEM[p.ecosystem]) return had;
    const got = await Promise.race([
      fetchStats(p, this.fetchImpl, { githubToken: this.opts.githubToken }),
      new Promise<null>((r) => setTimeout(() => r(null), ms).unref()),
    ]);
    if (got) this.store.setSetting(`libstats:${statsKey(p)}`, JSON.stringify(got));
    return got;
  }

  /** Fetch what's missing or a day old, one at a time (gently: these are free APIs). */
  async refresh(now = Date.now()): Promise<number> {
    if (!this.enabled || this.running) return 0;
    this.running = true;
    let n = 0;
    try {
      const seen = new Set<string>();
      for (const p of this.packages()) {
        const k = statsKey(p);
        if (seen.has(k) || !SYSTEM[p.ecosystem]) continue;
        seen.add(k);
        const had = this.get(p);
        if (had && now - Date.parse(had.fetchedAt) < DAY) continue;
        this.store.setSetting(
          `libstats:${k}`,
          JSON.stringify(
            await fetchStats(p, this.fetchImpl, { githubToken: this.opts.githubToken, now }),
          ),
        );
        n++;
      }
    } finally {
      this.running = false;
    }
    return n;
  }

  /** A minute after start, then every six hours (each package at most daily). */
  start(): void {
    if (!this.enabled || this.timer) return;
    const run = () => void this.refresh().catch((e) => console.error("archnm: library stats:", e));
    setTimeout(run, 60_000).unref();
    this.timer = setInterval(run, 6 * 60 * 60 * 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
