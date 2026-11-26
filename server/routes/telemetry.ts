// What agents did and what people reported: the summary for admins, the page's agent posting its
// calls and feedback, and a person's bug report or feature request from the app.
import { FEEDBACK_KINDS } from "../../shared/tools/tools.ts";
import type { Call, Ctx } from "../app.ts";
import { body, json } from "../http.ts";
import { modeOf, type Telemetry } from "../telemetry.ts";

const str = (x: unknown, n = 200) => (typeof x === "string" && x ? x.slice(0, n) : null);

/** One tool call the page's agent made. */
function recordCall(
  t: Telemetry,
  b: Record<string, unknown>,
  actor: string,
  res: Call["res"],
): void {
  const outcome = (["ok", "refused", "invalid", "exception"] as const).find((o) => o === b.outcome);
  if (!outcome || typeof b.tool !== "string")
    return json(res, 400, { error: "send { tool, outcome, … }" });
  const tool = b.tool.slice(0, 40);
  const args = b.args && typeof b.args === "object" ? b.args : {};
  t.call({
    session: str(b.session, 80),
    client: str(b.client),
    actor,
    actorKind: "agent",
    via: "page",
    tool,
    mode: modeOf(tool, args as Record<string, unknown>),
    design: str(b.design),
    args,
    ms: Number(b.ms) || 0,
    outcome,
    outChars: Number(b.outChars) || 0,
    errors: Number(b.errors) || 0,
    warnings: Number(b.warnings) || 0,
    firstError: str(b.firstError, 400),
    stack: str(b.stack, 4000),
  });
  json(res, 200, { ok: true });
}

/** Feedback from the page's agent. */
function recordFeedback(
  t: Telemetry,
  b: Record<string, unknown>,
  actor: string,
  res: Call["res"],
): void {
  const kind = (FEEDBACK_KINDS as readonly string[]).find((k) => k === b.kind);
  if (!kind || !str(b.text, 8000))
    return json(res, 400, { error: `send { kind: ${FEEDBACK_KINDS.join("|")}, text, tool? }` });
  json(res, 200, {
    id: t.feedback({
      session: str(b.session, 80),
      client: str(b.client),
      actor,
      design: str(b.design),
      kind,
      tool: str(b.tool, 40),
      text: str(b.text, 8000)!,
    }),
  });
}

/** A person's bug report or feature request from the app (Report a bug / Request a feature): kept with agents' feedback, so `archnm telemetry feedback` lists them together. */
async function report(ctx: Ctx, { req, res, who }: Call): Promise<void> {
  const { telemetry } = ctx;
  if (!who) return json(res, 401, { error: "sign in" });
  if (!telemetry)
    return json(res, 503, { error: "reports aren't kept on this server (no telemetry database)" });
  const b = ((await body(req, 64 * 1024)) ?? {}) as Record<string, unknown>;
  const kind = b.kind === "bug" || b.kind === "feature" ? b.kind : null;
  const text = typeof b.text === "string" ? b.text.trim() : "";
  if (!kind || !text)
    return json(res, 400, { error: "send { kind: bug|feature, text, design?, context? }" });
  // What the page saw (view, selection, frame rate, recent errors), after the words, cut to fit.
  const context = b.context && typeof b.context === "object" ? JSON.stringify(b.context) : "";
  const full = context
    ? `${text.slice(0, 4000)}\n\ncontext: ${context}`.slice(0, 8000)
    : text.slice(0, 8000);
  const design = typeof b.design === "string" ? b.design.slice(0, 200) : null;
  json(res, 200, {
    id: telemetry.feedback({
      client: "app",
      actor: `person:${who.id}`,
      design,
      kind,
      text: full,
    }),
  });
}

export async function telemetryRoutes(ctx: Ctx, call: Call): Promise<boolean> {
  const { req, res, path, who } = call;
  const { telemetry, auth } = ctx;
  // The summary is for admins; the page's agent posts its calls and feedback (as the person's agent).
  if (path === "/api/telemetry" && req.method === "GET") {
    if (!auth.authorize(who, "admin")) return (json(res, 403, { error: "admins only" }), true);
    if (!telemetry) return (json(res, 404, { error: "telemetry isn't kept on this server" }), true);
    const since =
      new URL(req.url ?? "/", ctx.config.listen.publicUrl).searchParams.get("since") ?? undefined;
    json(res, 200, telemetry.summary({ since }));
    return true;
  }
  if (
    (path === "/api/telemetry/call" || path === "/api/telemetry/feedback") &&
    req.method === "POST"
  ) {
    if (!who) return (json(res, 401, { error: "sign in" }), true);
    if (!telemetry) return (json(res, 200, { kept: false }), true);
    const b = ((await body(req, 64 * 1024)) ?? {}) as Record<string, unknown>;
    const actor = `agent:page:${who.id}`;
    if (path === "/api/telemetry/call") recordCall(telemetry, b, actor, res);
    else recordFeedback(telemetry, b, actor, res);
    return true;
  }
  if (path === "/api/report" && req.method === "POST") {
    await report(ctx, call);
    return true;
  }
  return false;
}
