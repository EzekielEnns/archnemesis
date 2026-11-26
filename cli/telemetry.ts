// archnm telemetry: read the server's call log and the feedback agents sent (server/telemetry.ts).
//
//   archnm telemetry [--since 2026-11-01] [--json]   where the tools hurt: per tool and mode, writes
//                                                   to valid, the errors that repeat, open feedback
//   archnm telemetry session <id>                    a session's calls in order, with args and outcome
//   archnm telemetry repro <call-id>                 a JSON repro a test can load
//   archnm telemetry feedback [resolve <id> [text]]  the feedback, or mark one resolved
//
// The database: --db, else $ARCHNM_TELEMETRY_DB, else telemetry.sqlite next to $ARCHNM_DB (the
// server's, data/archnm.sqlite by default).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { summaryText, Telemetry, type Stored } from "../server/telemetry.ts";
import { loadConfig } from "../server/config.ts";

export interface Repro {
  call: Omit<Stored, "args"> & { args: unknown };
  /** The writes that went in earlier in the same session, in order: replay them on the design, then the call. */
  before: { tool: string; args: unknown }[];
  /** The design's folder on the server now (not as it was at the call): load it when the writes before aren't enough. */
  files: string | null;
}

const parse = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

export function repro(t: Telemetry, id: number, designsRoot: string): Repro | null {
  const c = t.get(id);
  if (!c) return null;
  const earlier = c.session
    ? t
        .session(c.session)
        .filter(
          (x) =>
            x.id < c.id &&
            x.outcome === "ok" &&
            x.tool === "write" &&
            !x.mode?.endsWith(":dry") &&
            x.design === c.design,
        )
    : [];
  const dir = c.design ? join(designsRoot, c.design.split("@")[0]!) : null;
  return {
    call: { ...c, args: parse(c.args) },
    before: earlier.map((x) => ({ tool: x.tool, args: parse(x.args) })),
    files: dir && existsSync(dir) ? dir : null,
  };
}

function line(c: Stored): string {
  const args = c.args.length > 400 ? `${c.args.slice(0, 400)}…` : c.args;
  return `#${c.id} ${c.at.slice(11, 19)} ${c.tool}${c.mode ? ` ${c.mode}` : ""}${c.design ? ` on ${c.design}` : ""} → ${c.outcome}${c.errors ? ` (${c.errors} errors)` : ""} ${c.ms}ms ${c.outChars} chars\n    args: ${args}${c.firstError ? `\n    first error: ${c.firstError}` : ""}`;
}

export function telemetryCli(argv: string[]): number {
  const flags: Record<string, string | true> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) rest.push(a);
    else if (a === "--json" || a === "--all") flags[a.slice(2)] = true;
    else flags[a.slice(2)] = argv[++i] ?? "";
  }
  const config = loadConfig();
  const db = typeof flags.db === "string" ? flags.db : config.telemetry.dbPath;
  if (db !== ":memory:" && !existsSync(db)) {
    console.error(
      `no telemetry at ${db} (the server makes it on its first agent call; --db to point elsewhere)`,
    );
    return 2;
  }
  const t = new Telemetry(db, { calls: false });
  try {
    const [sub, a, b] = rest;
    if (!sub) {
      const s = t.summary({ since: typeof flags.since === "string" ? flags.since : undefined });
      console.log(flags.json ? JSON.stringify(s, null, 2) : summaryText(s));
      return 0;
    }
    if (sub === "session") {
      if (!a) return usage();
      let calls = t.session(a);
      if (!calls.length) {
        const like = t.sessionsLike(a);
        if (like.length === 1) calls = t.session(like[0]!);
        else {
          console.error(
            like.length
              ? `more than one session starts with ${a}: ${like.join(", ")}`
              : `no session ${a}`,
          );
          return 1;
        }
      }
      if (flags.json)
        console.log(
          JSON.stringify(
            calls.map((c) => ({ ...c, args: parse(c.args) })),
            null,
            2,
          ),
        );
      else
        console.log(
          [
            `session ${calls[0]!.session} (${calls[0]!.client ?? "client unknown"}, ${calls[0]!.actor ?? "?"}): ${calls.length} calls`,
            ...calls.map(line),
          ].join("\n"),
        );
      return 0;
    }
    if (sub === "repro") {
      const r = repro(t, Number(a), config.paths.designsRoot);
      if (!r) {
        console.error(`no call #${a}`);
        return 1;
      }
      console.log(JSON.stringify(r, null, 2));
      return 0;
    }
    if (sub === "feedback") {
      if (a === "resolve") {
        if (!b) return usage();
        const done = t.resolveFeedback(Number(b), rest.slice(3).join(" "));
        console.log(done ? `#${b} resolved` : `no open feedback #${b}`);
        return done ? 0 : 1;
      }
      const all = t.feedbackList({ open: !flags.all });
      if (flags.json) console.log(JSON.stringify(all, null, 2));
      else if (!all.length) console.log("no open feedback");
      else
        for (const f of all)
          console.log(
            `#${f.id} ${f.at.slice(0, 16)} ${f.kind}${f.tool ? ` (${f.tool})` : ""}${f.design ? ` on ${f.design}` : ""} from ${f.actor ?? "?"}${f.client ? ` via ${f.client}` : ""}${f.resolvedAt ? ` [resolved: ${f.resolution || f.resolvedAt}]` : ""}\n  ${f.text.replace(/\n/g, "\n  ")}\n  calls: ${f.calls.length ? `${f.calls.join(", ")} (archnm telemetry session ${f.session ?? "?"})` : "none attached"}\n`,
          );
      return 0;
    }
    return usage();
  } finally {
    t.close();
  }
}

function usage(): number {
  console.error(
    "usage: archnm telemetry [--since date] [--json] | session <id> | repro <call-id> | feedback [--all] [resolve <id> [text]]   (--db path)",
  );
  return 2;
}
