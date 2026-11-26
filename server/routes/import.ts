// An importer's code index (archnm import --server): planned against the design (or, when it
// follows git, against the importer's own fork of it) and committed as one edit.
import { planChanges, RefError } from "../../shared/agent.ts";
import {
  CALLS_CHOICES,
  importChanges,
  importSummary,
  type CallsChoice,
  type CodeIndex,
} from "../../shared/codeindex.ts";
import { ModelError } from "../../shared/doc.ts";
import type { Ctx } from "../app.ts";
import { GitError } from "../git.ts";
import { body, json } from "../http.ts";
import type { DesignCall } from "./design.ts";

export async function importRoutes(ctx: Ctx, d: DesignCall): Promise<boolean> {
  const { req, res, who, live, git, sub } = d;
  if (req.method !== "POST" || sub !== "/import") return false;
  if (!ctx.hub.perms.can(who, live.key, "edit"))
    return (json(res, 403, { error: "you can read but not edit" }), true);
  const b = (await body(req, 50 * 1024 * 1024)) as {
    index?: CodeIndex;
    under?: string;
    calls?: CallsChoice;
    dryRun?: boolean;
  };
  if (
    !b.index ||
    !Array.isArray(b.index.files) ||
    !Array.isArray(b.index.functions) ||
    typeof b.under !== "string"
  )
    return (json(res, 400, { error: "send { index, under } (archnm import makes it)" }), true);
  try {
    // On a design that follows git, main is read-only: the import goes to a fork.
    const target =
      git && !live.branch && !b.dryRun
        ? await git.fork(
            who!,
            `import ${b.index.repo}${b.index.sha ? ` ${b.index.sha.slice(0, 7)}` : ""}`,
          )
        : live;
    const calls = b.calls && CALLS_CHOICES.includes(b.calls) ? b.calls : undefined;
    const plan = importChanges(target.index(), b.index, { under: b.under, calls });
    const summary = importSummary(plan, { under: b.under, calls });
    if (b.dryRun || !plan.changes.length) {
      json(res, 200, { summary, doc: target.key });
      return true;
    }
    const { ops } = planChanges(target.state, target.index(), plan.changes, {
      tags: target.config().tags,
    });
    target.commit(who!, ops, `import ${b.index.repo}${b.index.sha ? `@${b.index.sha}` : ""}`);
    target.applyRules();
    json(res, 200, {
      summary,
      doc: target.key,
      url: `${ctx.config.listen.publicUrl}/#/${target.key}`,
    });
  } catch (e) {
    if (e instanceof RefError || e instanceof ModelError || e instanceof GitError)
      json(res, 409, { error: e.message });
    else throw e;
  }
  return true;
}
