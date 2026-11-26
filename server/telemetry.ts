// Telemetry: every agent tool call as a row in the server's own sqlite (nothing leaves the
// machine), and the reports agents send with the feedback tool. It's how tool problems are
// found: which calls get refused, which errors repeat, how many tries a write takes before
// it's valid. `archnm telemetry` reads it; /api/telemetry gives admins the same summary.
// ARCHNM_TELEMETRY=off stops the call log (feedback is still kept: an agent chose to send it).
// Logging never fails a call: every write here is guarded.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { judge, modeOf, type Outcome } from "../shared/tools/judge.ts";

export { judge, modeOf };

export interface CallRow {
  at?: string;
  session?: string | null;
  client?: string | null;
  actor?: string | null;
  actorKind?: string | null;
  /** mcp (the server's), or page (WebMCP, posted by the browser). */
  via?: "mcp" | "page";
  tool: string;
  mode?: string | null;
  design?: string | null;
  args?: unknown;
  ms?: number;
  outcome: Outcome;
  outChars?: number;
  errors?: number;
  warnings?: number;
  firstError?: string | null;
  stack?: string | null;
}

export interface Stored extends Required<Omit<CallRow, "args">> {
  id: number;
  args: string;
}

export interface Feedback {
  id: number;
  at: string;
  session: string | null;
  client: string | null;
  actor: string | null;
  design: string | null;
  kind: string;
  tool: string | null;
  text: string;
  calls: number[];
  resolvedAt: string | null;
  resolution: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL, session TEXT, client TEXT, actor TEXT, actor_kind TEXT, via TEXT NOT NULL,
  tool TEXT NOT NULL, mode TEXT, design TEXT, args TEXT, ms INTEGER, outcome TEXT NOT NULL,
  out_chars INTEGER, errors INTEGER, warnings INTEGER, first_error TEXT, stack TEXT
);
CREATE INDEX IF NOT EXISTS tool_calls_session ON tool_calls (session, id);
CREATE INDEX IF NOT EXISTS tool_calls_at ON tool_calls (at);
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL, session TEXT, client TEXT, actor TEXT, design TEXT,
  kind TEXT NOT NULL, tool TEXT, text TEXT NOT NULL, calls TEXT NOT NULL,
  resolved_at TEXT, resolution TEXT
);`;

const ARGS_CAP = 8 * 1024;
const KEEP_DAYS = 30;
const KEEP_ROWS = 100_000;
const PRUNE_EVERY = 500;

/** The JSON of a call's arguments, at most ARGS_CAP bytes (a long yaml is cut, and says so). */
export function capArgs(args: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(args ?? {});
  } catch {
    return '{"unserialisable":true}';
  }
  if (Buffer.byteLength(s) <= ARGS_CAP) return s;
  return `${Buffer.from(s)
    .subarray(0, ARGS_CAP - 40)
    .toString("utf8")}… [cut at ${ARGS_CAP} bytes of ${Buffer.byteLength(s)}]`;
}

/** An error line with the specifics taken out, so the same mistake counts as one. */
export function normalise(line: string): string {
  return line
    .replace(/^error: /, "")
    .replace(/"[^"]*"/g, '"…"')
    .replace(/`[^`]*`/g, "`…`")
    .replace(/\byaml( \(new\))?:\d+/g, "yaml:N")
    .replace(/\b[\w./-]*\d[\w./-]*\b/g, "N")
    .replace(/\b[a-z][a-z0-9]*(?:[-_@][a-z0-9]+)+\b/g, "<id>")
    .replace(/\([^)]{40,}\)/g, "(…)")
    .slice(0, 200);
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};

export interface Summary {
  since: string | null;
  calls: number;
  tools: {
    tool: string;
    mode: string;
    calls: number;
    refused: number;
    invalid: number;
    exception: number;
    p50: number;
    p95: number;
    meanChars: number;
  }[];
  writes: {
    sessions: number;
    streaks: number[];
    median: number;
    worst: number;
    worstSession: string | null;
    unfinished: number;
  };
  errors: { line: string; count: number; tool: string }[];
  feedback: Feedback[];
}

export class Telemetry {
  private db: DatabaseSync;
  /** Off: the call log isn't kept (feedback is). */
  readonly calls: boolean;
  private sincePrune = 0;

  private keep: { days: number; rows: number };

  constructor(path: string, o: { calls?: boolean; keepDays?: number; keepRows?: number } = {}) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 2000");
    this.db.exec(SCHEMA);
    this.calls = o.calls ?? true;
    this.keep = { days: o.keepDays ?? KEEP_DAYS, rows: o.keepRows ?? KEEP_ROWS };
    if (this.calls) this.prune();
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* closed */
    }
  }

  /** Store one call. Never throws: a call doesn't fail because its row couldn't be written. Returns the row's id, or null. */
  call(r: CallRow): number | null {
    if (!this.calls) return null;
    try {
      const res = this.db
        .prepare(
          "INSERT INTO tool_calls (at, session, client, actor, actor_kind, via, tool, mode, design, args, ms, outcome, out_chars, errors, warnings, first_error, stack) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          r.at ?? new Date().toISOString(),
          r.session ?? null,
          r.client ?? null,
          r.actor ?? null,
          r.actorKind ?? null,
          r.via ?? "mcp",
          r.tool,
          r.mode ?? null,
          r.design ?? null,
          capArgs(r.args),
          Math.round(r.ms ?? 0),
          r.outcome,
          r.outChars ?? 0,
          r.errors ?? 0,
          r.warnings ?? 0,
          r.firstError ?? null,
          r.stack ? r.stack.slice(0, 4000) : null,
        );
      if (++this.sincePrune >= PRUNE_EVERY) this.prune();
      return Number(res.lastInsertRowid);
    } catch (e) {
      console.warn("archnm: telemetry: couldn't log a call:", (e as Error).message);
      return null;
    }
  }

  /** Keep 30 days and at most 100k rows. */
  prune(now = Date.now()): void {
    this.sincePrune = 0;
    try {
      this.db
        .prepare("DELETE FROM tool_calls WHERE at < ?")
        .run(new Date(now - this.keep.days * 86400_000).toISOString());
      const max = Number(
        (this.db.prepare("SELECT MAX(id) AS m FROM tool_calls").get() as { m: number | null }).m ??
          0,
      );
      if (max > this.keep.rows)
        this.db.prepare("DELETE FROM tool_calls WHERE id <= ?").run(max - this.keep.rows);
    } catch (e) {
      console.warn("archnm: telemetry: couldn't prune:", (e as Error).message);
    }
  }

  private row(r: Record<string, unknown>): Stored {
    return {
      id: Number(r.id),
      at: String(r.at),
      session: (r.session as string | null) ?? null,
      client: (r.client as string | null) ?? null,
      actor: (r.actor as string | null) ?? null,
      actorKind: (r.actor_kind as string | null) ?? null,
      via: (r.via as "mcp" | "page") ?? "mcp",
      tool: String(r.tool),
      mode: (r.mode as string | null) ?? null,
      design: (r.design as string | null) ?? null,
      args: String(r.args ?? "{}"),
      ms: Number(r.ms ?? 0),
      outcome: r.outcome as Outcome,
      outChars: Number(r.out_chars ?? 0),
      errors: Number(r.errors ?? 0),
      warnings: Number(r.warnings ?? 0),
      firstError: (r.first_error as string | null) ?? null,
      stack: (r.stack as string | null) ?? null,
    };
  }

  /** A session's calls in order (the last `limit`). */
  session(id: string, limit = 1000): Stored[] {
    const rows = this.db
      .prepare("SELECT * FROM tool_calls WHERE session = ? ORDER BY id DESC LIMIT ?")
      .all(id, limit) as Record<string, unknown>[];
    return rows.reverse().map((r) => this.row(r));
  }

  get(id: number): Stored | null {
    const r = this.db.prepare("SELECT * FROM tool_calls WHERE id = ?").get(id) as
      Record<string, unknown> | undefined;
    return r ? this.row(r) : null;
  }

  /** Sessions whose id starts with this (for typing a short one). */
  sessionsLike(prefix: string): string[] {
    return (
      this.db
        .prepare("SELECT DISTINCT session FROM tool_calls WHERE session LIKE ? LIMIT 10")
        .all(`${prefix}%`) as { session: string }[]
    ).map((r) => r.session);
  }

  /** A report from an agent, with its session's last 20 calls attached. Returns its id. */
  feedback(f: {
    session?: string | null;
    client?: string | null;
    actor?: string | null;
    design?: string | null;
    kind: string;
    tool?: string | null;
    text: string;
  }): number {
    // The session's last 20 calls; a client that sent no session id: the same agent's last 20.
    let calls: number[] = [];
    try {
      if (f.session) calls = this.session(f.session, 20).map((c) => c.id);
      else if (f.actor)
        calls = (
          this.db
            .prepare("SELECT id FROM tool_calls WHERE actor = ? ORDER BY id DESC LIMIT 20")
            .all(f.actor) as { id: number }[]
        )
          .map((r) => Number(r.id))
          .reverse();
    } catch {
      /* the report matters more than what's attached */
    }
    const r = this.db
      .prepare(
        "INSERT INTO feedback (at, session, client, actor, design, kind, tool, text, calls) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        new Date().toISOString(),
        f.session ?? null,
        f.client ?? null,
        f.actor ?? null,
        f.design ?? null,
        f.kind,
        f.tool ?? null,
        f.text.slice(0, 8000),
        JSON.stringify(calls),
      );
    return Number(r.lastInsertRowid);
  }

  feedbackList(o: { open?: boolean } = {}): Feedback[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM feedback${o.open ? " WHERE resolved_at IS NULL" : ""} ORDER BY id DESC LIMIT 200`,
      )
      .all() as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r.id),
      at: String(r.at),
      session: (r.session as string | null) ?? null,
      client: (r.client as string | null) ?? null,
      actor: (r.actor as string | null) ?? null,
      design: (r.design as string | null) ?? null,
      kind: String(r.kind),
      tool: (r.tool as string | null) ?? null,
      text: String(r.text),
      calls: JSON.parse(String(r.calls ?? "[]")) as number[],
      resolvedAt: (r.resolved_at as string | null) ?? null,
      resolution: (r.resolution as string | null) ?? null,
    }));
  }

  resolveFeedback(id: number, resolution = ""): boolean {
    return (
      Number(
        this.db
          .prepare(
            "UPDATE feedback SET resolved_at = ?, resolution = ? WHERE id = ? AND resolved_at IS NULL",
          )
          .run(new Date().toISOString(), resolution, id).changes,
      ) > 0
    );
  }

  /** Where the tools hurt: per tool and mode, writes to valid, the errors that repeat, open feedback. */
  summary(o: { since?: string } = {}): Summary {
    const rows = (
      o.since
        ? this.db.prepare("SELECT * FROM tool_calls WHERE at >= ? ORDER BY id").all(o.since)
        : this.db.prepare("SELECT * FROM tool_calls ORDER BY id").all()
    ) as Record<string, unknown>[];
    const all = rows.map((r) => this.row(r));
    const by = new Map<string, Stored[]>();
    for (const c of all)
      by.set(`${c.tool}\u0000${c.mode ?? ""}`, [
        ...(by.get(`${c.tool}\u0000${c.mode ?? ""}`) ?? []),
        c,
      ]);
    const tools = [...by].map(([k, cs]) => {
      const [tool, mode] = k.split("\u0000") as [string, string];
      const n = (x: Outcome) => cs.filter((c) => c.outcome === x).length;
      return {
        tool,
        mode,
        calls: cs.length,
        refused: n("refused") / cs.length,
        invalid: n("invalid") / cs.length,
        exception: n("exception") / cs.length,
        p50: pct(
          cs.map((c) => c.ms),
          50,
        ),
        p95: pct(
          cs.map((c) => c.ms),
          95,
        ),
        meanChars: Math.round(cs.reduce((s, c) => s + c.outChars, 0) / cs.length),
      };
    });
    tools.sort((a, b) => a.tool.localeCompare(b.tool) || b.calls - a.calls);
    // Writes to valid: per session, the failed writes before each one that went in.
    const streaks: number[] = [];
    let worst = 0;
    let worstSession: string | null = null;
    let unfinished = 0;
    const sessions = new Set<string>();
    const perSession = new Map<string, Stored[]>();
    for (const c of all)
      if (c.tool === "write" && !c.mode?.startsWith("undo"))
        perSession.set(c.session ?? `?${c.id}`, [
          ...(perSession.get(c.session ?? `?${c.id}`) ?? []),
          c,
        ]);
    for (const [s, cs] of perSession) {
      sessions.add(s);
      let failed = 0;
      for (const c of cs) {
        if (c.outcome !== "ok") failed++;
        else if (!c.mode?.endsWith(":dry")) {
          streaks.push(failed);
          if (failed > worst) ((worst = failed), (worstSession = s));
          failed = 0;
        }
      }
      if (failed) unfinished++;
    }
    const errs = new Map<string, { count: number; tool: string }>();
    for (const c of all) {
      if (!c.firstError) continue;
      const k = normalise(c.firstError);
      const e = errs.get(k) ?? { count: 0, tool: c.tool };
      e.count++;
      errs.set(k, e);
    }
    return {
      since: o.since ?? null,
      calls: all.length,
      tools,
      writes: {
        sessions: sessions.size,
        streaks,
        median: pct(streaks, 50),
        worst,
        worstSession,
        unfinished,
      },
      errors: [...errs]
        .map(([line, e]) => ({ line, ...e }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 20),
      feedback: this.feedbackList({ open: true }),
    };
  }
}

/** The server's telemetry, on its own database file (calls false: no call log). */
export function openTelemetry(path: string, calls: boolean): Telemetry | null {
  try {
    return new Telemetry(path, { calls });
  } catch (e) {
    console.warn("archnm: telemetry is off: couldn't open its database:", (e as Error).message);
    return null;
  }
}

/** The summary as text, for the CLI. */
export function summaryText(s: Summary): string {
  const p = (x: number) => (x ? `${Math.round(x * 100)}%` : "-");
  const out = [
    `${s.calls} calls${s.since ? ` since ${s.since}` : ""}`,
    "",
    "tool      mode                 calls  refused  invalid  exception   p50ms   p95ms  chars",
  ];
  for (const t of s.tools)
    out.push(
      `${t.tool.padEnd(9)} ${(t.mode || "-").slice(0, 20).padEnd(20)} ${String(t.calls).padStart(5)}  ${p(t.refused).padStart(7)}  ${p(t.invalid).padStart(7)}  ${p(t.exception).padStart(9)}  ${String(t.p50).padStart(6)}  ${String(t.p95).padStart(6)}  ${String(t.meanChars).padStart(5)}`,
    );
  const w = s.writes;
  out.push(
    "",
    `writes to valid: ${w.streaks.length} writes went in across ${w.sessions} sessions; failed tries before each: median ${w.median}, worst ${w.worst}${w.worstSession ? ` (session ${w.worstSession})` : ""}${w.unfinished ? `; ${w.unfinished} sessions ended on a failed write` : ""}`,
  );
  if (s.errors.length)
    out.push(
      "",
      "errors that repeat:",
      ...s.errors.map((e) => `  ${String(e.count).padStart(4)}  ${e.tool}: ${e.line}`),
    );
  out.push(
    "",
    s.feedback.length ? `open feedback (${s.feedback.length}):` : "no open feedback",
    ...s.feedback.map(
      (f) =>
        `  #${f.id} ${f.at.slice(0, 16)} ${f.kind}${f.tool ? ` (${f.tool})` : ""}${f.design ? ` on ${f.design}` : ""}: ${f.text.replace(/\s+/g, " ").slice(0, 160)}`,
    ),
  );
  return out.join("\n");
}
