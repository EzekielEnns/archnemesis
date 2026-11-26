// Library stats as people and agents read them: the numbers, and the reasons to look twice.
// Fetched and cached by the server (server/libstats.ts); never written to a design's files.
import type { Package } from "./model.ts";

const DAY = 24 * 60 * 60 * 1000;

export const statsKey = (p: Package) => `${p.ecosystem}/${p.name}@${p.version ?? ""}`;

export interface LibStats {
  fetchedAt: string;
  /** The newest release, and when it came out. */
  latest?: string;
  latestAt?: string;
  /** When the version in the model came out. */
  versionAt?: string;
  licenses?: string[];
  /** Advisories (GHSA, OSV ids) against the version in the model. */
  advisories?: string[];
  repo?: string;
  stars?: number;
  forks?: number;
  openIssues?: number;
  /** OpenSSF scorecard, 0 to 10. */
  scorecard?: number;
  contributors?: number;
  description?: string;
  /** Review tags: the reasons to look twice. */
  warnings: string[];
  /** What failed to load, if anything (the rest is still shown). */
  error?: string;
}

/** Why to look twice, from the stats: few people, no release in a year, no licence, advisories, a low score. */
export function warningsOf(s: Omit<LibStats, "warnings">, now = Date.now()): string[] {
  const out: string[] = [];
  if (s.advisories?.length)
    out.push(
      `${s.advisories.length} known advisor${s.advisories.length === 1 ? "y" : "ies"} on this version`,
    );
  if (s.contributors !== undefined && s.contributors < 5)
    out.push(`only ${s.contributors} contributor${s.contributors === 1 ? "" : "s"}`);
  if (s.latestAt && now - Date.parse(s.latestAt) > 365 * DAY) out.push("no release in over a year");
  if (
    s.licenses &&
    (!s.licenses.length ||
      s.licenses.every((l) => !l || l === "non-standard" || l === "NOASSERTION"))
  )
    out.push("no licence that can be read");
  if (s.scorecard !== undefined && s.scorecard < 4)
    out.push(`OpenSSF score ${s.scorecard.toFixed(1)}`);
  return out;
}

/** One line for an agent: "★ 18k · 312 people · MIT · released 2025-09 (latest 0.8.9) · look twice: ...". */
export function statsLine(s: LibStats): string {
  const n = (x: number) => (x >= 1000 ? `${(x / 1000).toFixed(x >= 10_000 ? 0 : 1)}k` : String(x));
  const bits: string[] = [];
  if (s.stars !== undefined) bits.push(`★ ${n(s.stars)}`);
  if (s.contributors !== undefined)
    bits.push(`${n(s.contributors)} contributor${s.contributors === 1 ? "" : "s"}`);
  if (s.licenses?.length) bits.push(s.licenses.join(", "));
  if (s.versionAt) bits.push(`this version ${s.versionAt.slice(0, 10)}`);
  if (s.latest) bits.push(`latest ${s.latest}${s.latestAt ? ` (${s.latestAt.slice(0, 10)})` : ""}`);
  if (s.scorecard !== undefined) bits.push(`OpenSSF ${s.scorecard.toFixed(1)}`);
  if (s.warnings.length) bits.push(`look twice: ${s.warnings.join("; ")}`);
  return bits.join(" · ") || (s.error ? `stats unavailable (${s.error})` : "no stats");
}
