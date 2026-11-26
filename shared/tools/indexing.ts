// index: the factory's static pass, run on the person's machine (the server only hands out the
// command and takes the upload): start, scan, import, and progress for a long job.
import { ToolError, fail, ok, type Host, type Out } from "./host.ts";
import { object, idOf } from "./refs.ts";
import { MANUAL_MAP } from "./teach.ts";
import type { CallsChoice } from "../codeindex.ts";
import { DEFAULT_LIMITS } from "../files.ts";
import type { Op } from "../model.ts";
import { buildIndex, type ModelIndex } from "../project.ts";
import { resolve } from "../views.ts";

/**
 * Views that follow rules and would pass the boxes that read at a glance once the import's
 * boxes are in: said at the dry run, so the grouping is planned before the write (the warnings only came after, and views were regrouped by hand).
 */
function crowding(idx: ModelIndex, ops: Op[]): string[] {
  const objects = new Map(idx.objects);
  const connections = new Map(idx.connections);
  for (const op of ops) {
    if (op.op === "object.put") objects.set(op.object.id, op.object);
    else if (op.op === "object.delete") objects.delete(op.id);
    else if (op.op === "connection.put") connections.set(op.connection.id, op.connection);
  }
  const after = buildIndex({
    objects: objects.values(),
    connections: connections.values(),
    diagrams: idx.diagrams.values(),
    placements: [],
  });
  const out: string[] = [];
  for (const d of idx.diagrams.values()) {
    if (!d.rules) continue;
    const was = resolve(idx, d).ids.size;
    const now = resolve(after, d).ids.size;
    if (now > DEFAULT_LIMITS.boxes && now > was) out.push(`${d.key ?? d.id} (${was} → ${now})`);
  }
  return out;
}

export const INDEX_ACTIONS = ["start", "scan", "import", "progress"] as const;

export interface IndexArgs {
  action: (typeof INDEX_ACTIONS)[number];
  path?: string;
  ticket?: string;
  /** scan: the key for the repo's system in the draft. */
  system?: string;
  /** import: the box the repo's code goes in (usually its app). */
  under?: string;
  /** import: which calls come in (exact, all, none). */
  calls?: CallsChoice;
  dry_run?: boolean;
  text?: string;
  step?: number;
  of?: number;
  done?: boolean;
}

/** Let other work in (other calls, other designs) before the next long step. */
const breathe = () => new Promise<void>((r) => setTimeout(r, 0));

export async function indexTool(
  host: Host,
  a: IndexArgs,
  c: { progress?: (progress: number, total: number, message: string) => Promise<void> } = {},
): Promise<Out> {
  const ix = host.indexer;
  if (!ix)
    return fail(
      `indexing needs the Archnemesis server (it takes the upload from the person's machine).${a.action === "start" ? `\n\n${MANUAL_MAP}` : ""}`,
    );
  switch (a.action) {
    case "start":
      return ok(await ix.start(a.path));
    case "scan":
      if (!a.ticket) throw new ToolError("scan takes the ticket start printed");
      return ok(ix.scan(a.ticket, a.system));
    case "import": {
      if (!a.ticket || !a.under)
        throw new ToolError("import takes the ticket and under: the box the code goes in");
      if (!a.dry_run && !host.canEdit)
        return fail(`${host.actor.name} can read this design but not edit it`);
      const under = object(host.index(), a.under);
      // In steps, letting other calls in between (a big repo is seconds of work), and saying
      // how it's going when the client asked.
      const steps = a.dry_run ? 2 : 4;
      await c.progress?.(0, steps, "planning the import");
      await breathe();
      const plan = ix.importPlan(a.ticket, idOf(under), a.calls);
      await c.progress?.(1, steps, `planned: ${plan.ops.length} changes`);
      if (a.dry_run || !plan.ops.length) {
        const crowded = a.dry_run ? crowding(host.index(), plan.ops) : [];
        const warn = crowded.length
          ? `\nViews this would crowd, past the ${DEFAULT_LIMITS.boxes} boxes that read at a glance: ${crowded.join(", ")}. Group what goes in them first (components inside the box, each with a path pattern), or exclude kinds from the view (exclude: [{kind: library}]).`
          : "";
        return ok(
          `${a.dry_run ? "Dry run, nothing changed: " : "Nothing to change: "}${plan.summary}${warn}`,
        );
      }
      await breathe();
      await host.commit(plan.ops, plan.label);
      await c.progress?.(2, steps, "written; applying the views' rules");
      await breathe();
      host.applyRules?.();
      await c.progress?.(4, steps, "done");
      return ok(`Imported (undo with write {undo: true}): ${plan.summary}`);
    }
    case "progress":
      if (!a.text?.trim()) throw new ToolError("progress takes text: what you're on");
      ix.progress({ text: a.text.trim().slice(0, 140), step: a.step, of: a.of, done: a.done });
      return ok(a.done ? "Shown as done." : "Shown.");
    default:
      throw new ToolError(
        `no action "${String(a.action)}"; actions: start, scan, import, progress`,
      );
  }
}
