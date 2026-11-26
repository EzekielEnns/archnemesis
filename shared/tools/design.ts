// design: the designs and their forks. What a host can do here varies: the server does all of
// it, a page lists and forks (and never deletes or discards).
import { ToolError, fail, ok, type Designs, type Out } from "./host.ts";

export const DESIGN_ACTIONS = ["list", "create", "fork", "propose", "delete", "discard"] as const;

export interface DesignArgs {
  action?: (typeof DESIGN_ACTIONS)[number];
  /** The design (or fork) to fork, propose or discard. */
  design?: string;
  name?: string;
  key?: string;
  from?: "empty" | "example" | "code";
  confirm?: boolean;
}

export async function design(
  designs: Designs | undefined,
  a: DesignArgs,
  o: { page?: boolean } = {},
): Promise<Out> {
  if (!designs) return fail("designs aren't managed from here");
  const action = a.action ?? "list";
  const missing = () =>
    fail(
      `${action} isn't available here${o.page ? " (in the page: list, create, fork and propose; delete and discard are the person's, from the menu)" : ""}`,
    );
  switch (action) {
    case "list": {
      const all = await designs.list();
      if (!all.length) return ok('no designs yet: design {action: "create", name}');
      const lines = all.flatMap((d) => [
        `${d.key}  ${d.name} · ${d.objects} boxes · ${d.views} views${d.git ? " · follows git" : d.private ? " · private" : ""}${d.present ? ` · ${d.present} here now` : ""} · ${d.url}`,
        ...(d.forks ?? []).map(
          (f) =>
            `  ${f.key}  fork by ${f.by}${f.pending ? " · unsaved edits" : ""}${f.behind ? ` · ${f.behind} behind main` : ""}${f.proposed ? " · proposed" : ""} · ${f.url}`,
        ),
      ]);
      return ok(
        [...lines, "Work on one: pass design: <key> (a fork's key works too)."].join("\n"),
        { designs: all.map((d) => d.key) },
      );
    }
    case "create": {
      if (!designs.create) return missing();
      if (!a.name?.trim()) throw new ToolError("a new design needs a name");
      const d = await designs.create({ name: a.name.trim(), key: a.key, from: a.from });
      const lines = [`Created ${d.key} "${d.name}": ${d.url}`];
      // Where writes go, first: a design that follows git is never written on main.
      if (d.writesTo)
        lines.push(
          `It follows git, so your writes go to your fork ${d.writesTo.key} (${d.writesTo.url}); design {action: "propose", design: "${d.writesTo.key}"} when it's done, and the person merges it. The tools use ${d.writesTo.key} from here on when you leave design out.`,
        );
      else lines.push(`The tools use ${d.key} from here on when you leave design out.`);
      if (d.views?.length)
        lines.push(
          `It starts with ${d.views.length === 1 ? "one view" : `${d.views.length} views`}: ${d.views.map((v) => `${v.key} (${v.rules ? "follows rules: the boxes they match show on it by themselves" : "hand-picked"})`).join(", ")}. Write views: {${d.views[0]!.key}: {boxes: [...]}} to hand-pick its boxes instead (that replaces its rules), or leave it and tidy it after a write (write {tidy: "${d.views[0]!.key}"}).`,
        );
      if (d.note) lines.push(d.note);
      return ok(lines.join("\n"), { key: d.writesTo?.key ?? d.key });
    }
    case "fork": {
      if (!designs.fork) return missing();
      const f = await designs.fork(a.design, a.name);
      const stack = f.stackedOn
        ? `\nStacked on ${f.stackedOn}: it starts with that fork's changes, and its diff (read {diff: true}) and pull request show only what you add on top.`
        : "";
      return ok(
        `Started ${f.key}: ${f.url}${stack}\nPass design: "${f.key}" to write on it; ${
          designs.propose
            ? `design {action: "propose", design: "${f.key}"} when it's ready.`
            : "when it's ready, the person merges it into main from the Branches panel (open that link to see it)."
        }`,
        { key: f.key },
      );
    }
    case "propose":
      if (!designs.propose) return missing();
      return ok(await designs.propose(a.design));
    case "delete":
      if (!designs.delete || o.page) return missing();
      if (!(a.key ?? a.design)) throw new ToolError("which design? key");
      return ok(await designs.delete((a.key ?? a.design)!, !!a.confirm));
    case "discard":
      if (!designs.discard || o.page) return missing();
      return ok(await designs.discard(a.design));
    default:
      throw new ToolError(
        `no action "${String(action)}"; actions: list, create, fork, propose, delete, discard`,
      );
  }
}
