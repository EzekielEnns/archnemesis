// The stats job against a pretend deps.dev and GitHub: what it reads, what it warns about,
// the daily cache, and that it never sends anything when it's off or for "other" packages.
import { describe, expect, it } from "vitest";
import { fetchStats, LibStatsJob } from "./libstats.ts";
import { statsLine, warningsOf } from "../shared/libstats.ts";

const NOW = Date.parse("2026-11-21T12:00:00Z");

function fake(routes: Record<string, unknown>, link?: string) {
  const asked: string[] = [];
  const f = async (url: string) => {
    asked.push(url);
    const hit = Object.entries(routes).find(([k]) => url.startsWith(k));
    return {
      ok: !!hit,
      status: hit ? 200 : 404,
      json: async () => hit?.[1],
      headers: {
        get: (k: string) =>
          k === "link" && url.includes("api.github.com") ? (link ?? null) : null,
      },
    };
  };
  return { f, asked };
}

const AXUM = {
  "https://api.deps.dev/v3/systems/CARGO/packages/axum/versions/0.8.9": {
    publishedAt: "2026-03-01T00:00:00Z",
    licenses: ["MIT"],
    advisoryKeys: [],
    relatedProjects: [
      { projectKey: { id: "github.com/tokio-rs/axum" }, relationType: "SOURCE_REPO" },
    ],
  },
  "https://api.deps.dev/v3/systems/CARGO/packages/axum": {
    versions: [
      { versionKey: { version: "0.8.9" }, publishedAt: "2026-03-01T00:00:00Z", isDefault: true },
    ],
  },
  "https://api.deps.dev/v3/projects/github.com%2Ftokio-rs%2Faxum": {
    starsCount: 23000,
    forksCount: 1100,
    openIssuesCount: 80,
    scorecard: { overallScore: 7.1 },
  },
  "https://api.github.com/repos/tokio-rs/axum/contributors": [{}],
};

describe("library stats", () => {
  it("reads deps.dev and GitHub into one record, people from the last page", async () => {
    const { f } = fake(AXUM, '<https://api.github.com/x?per_page=1&page=412>; rel="last"');
    const s = await fetchStats({ ecosystem: "cargo", name: "axum", version: "0.8.9" }, f, {
      now: NOW,
    });
    expect(s).toMatchObject({
      latest: "0.8.9",
      licenses: ["MIT"],
      stars: 23000,
      contributors: 412,
      scorecard: 7.1,
      repo: "https://github.com/tokio-rs/axum",
      warnings: [],
    });
    expect(statsLine(s)).toContain("★ 23k");
  });

  it("names the reasons to look twice", () => {
    const w = warningsOf(
      {
        fetchedAt: "",
        contributors: 2,
        latestAt: "2024-01-01T00:00:00Z",
        licenses: [],
        advisories: ["GHSA-x"],
        scorecard: 2.5,
      },
      NOW,
    );
    expect(w).toEqual([
      "1 known advisory on this version",
      "only 2 contributors",
      "no release in over a year",
      "no licence that can be read",
      "OpenSSF score 2.5",
    ]);
  });

  it("keeps what it got when one source fails", async () => {
    const routes = { ...AXUM } as Record<string, unknown>;
    delete routes["https://api.github.com/repos/tokio-rs/axum/contributors"];
    const s = await fetchStats(
      { ecosystem: "cargo", name: "axum", version: "0.8.9" },
      fake(routes).f,
      { now: NOW },
    );
    expect(s.stars).toBe(23000);
    expect(s.error).toContain("api.github.com answered 404");
  });

  it("caches a day, skips other ecosystems, and sends nothing when off", async () => {
    const kv = new Map<string, string>();
    const store = {
      setting: (k: string) => kv.get(k) ?? null,
      setSetting: (k: string, v: string) => void kv.set(k, v),
      settings: () => [],
    };
    const pkgs = () => [
      { ecosystem: "cargo" as const, name: "axum", version: "0.8.9" },
      { ecosystem: "cargo" as const, name: "axum", version: "0.8.9" },
      { ecosystem: "other" as const, name: "our-private-thing" },
    ];
    const off = fake(AXUM);
    expect(await new LibStatsJob(store, pkgs, off.f, {}).refresh(NOW)).toBe(0);
    expect(off.asked).toEqual([]);

    const on = fake(AXUM);
    const job = new LibStatsJob(store, pkgs, on.f, { enabled: true });
    expect(await job.refresh(NOW)).toBe(1);
    expect(on.asked.some((u) => u.includes("our-private-thing"))).toBe(false);
    expect(job.get({ ecosystem: "cargo", name: "axum", version: "0.8.9" })?.stars).toBe(23000);
    expect(await job.refresh(NOW + 60_000)).toBe(0);
    expect(await job.refresh(NOW + 25 * 60 * 60 * 1000)).toBe(1);
  });
});
