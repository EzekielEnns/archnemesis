// A design and git (server/gitsync.ts): whether it follows a repo, following one, fetching, and
// the forks: making one, editing on one, merging or throwing it away, and proposing it.
// <doc> is a design's key or a fork's "<design>@<fork>".
import type { Op } from "../../shared/model.ts";
import type { Ctx } from "../app.ts";
import { GitError } from "../git.ts";
import { bindDesign, remoteAllowed, type GitSync } from "../gitsync.ts";
import { GitHubError } from "../github.ts";
import { body, json } from "../http.ts";
import type { DesignCall } from "./design.ts";

const POSTS = ["/git", "/sync", "/fork", "/edit", "/merge", "/discard", "/propose"];

/** Follow a repo: its own on this server ({local: true}), or one at a URL. */
async function follow(ctx: Ctx, d: DesignCall, b: Record<string, unknown>): Promise<void> {
  const { hub, auth, config } = ctx;
  const main = hub.designs.get(d.live.design)!;
  // Connecting a design to a repo is managing it (its owner, or an admin for a team design).
  if (!hub.perms.can(d.who, main.key, "manage"))
    return json(d.res, 403, { error: "only its owner (or an admin) connects a design to a repo" });
  const admin = auth.authorize(d.who, "admin");
  if (b.local === true && !config.git.localRepos)
    return json(d.res, 400, {
      error:
        "this Archnemesis has no lasting disk, so it can't keep a repo of its own: connect one on GitHub",
    });
  // A repo on the server, or one not on the list, is an admin's call: following git
  // makes main read-only for good.
  if (
    b.local === true
      ? !admin
      : !remoteAllowed(String(b.remote ?? "").trim(), admin, config.git.remotes)
  )
    return json(d.res, 403, {
      error: "only an admin connects a design to that repo (or list it in ARCHNM_GIT_REMOTES)",
    });
  const g = await bindDesign(hub, main, {
    remote: b.remote as string,
    path: b.path as string,
    branch: b.branch as string,
    local: b.local === true,
    addHere: admin && b.addHere === true,
  });
  json(d.res, 200, g.info());
}

/** Merge a fork, throw it away, or propose it: whoever started it, or an admin. */
async function forkEnd(ctx: Ctx, d: DesignCall, git: GitSync): Promise<void> {
  const { who, live, res } = d;
  if (!ctx.hub.perms.can(who, live.key, "manage"))
    return json(res, 403, {
      error: "only whoever started this fork (or an admin) can merge or discard it",
    });
  if (d.sub === "/merge") return json(res, 200, { result: await git.merge(live.key, who!) });
  await git.discard(live.key, who!);
  json(res, 200, { ok: true });
}

/** The git actions that need the design to follow a repo. */
async function onRepo(ctx: Ctx, d: DesignCall, git: GitSync, b: Record<string, unknown>) {
  const { res, who, live } = d;
  switch (d.sub) {
    case "/sync":
      await git.sync(true);
      return json(res, 200, git.info());
    case "/fork": {
      const f = await git.fork(
        who!,
        typeof b.name === "string" && b.name.trim() ? b.name : undefined,
      );
      return json(res, 201, { doc: f.key, branch: f.branch });
    }
    case "/edit": {
      const batches = Array.isArray(b.batches) ? (b.batches as { ops: Op[]; label: string }[]) : [];
      const r = await git.editOnFork(who!, batches);
      return json(res, 200, {
        doc: r.live.key,
        branch: r.live.branch,
        created: r.created,
        errors: r.errors,
      });
    }
    case "/propose":
      return json(
        res,
        200,
        await git.propose(live.key, `${ctx.config.listen.publicUrl}/#/${live.key}`, who!),
      );
    default:
      return forkEnd(ctx, d, git);
  }
}

export async function gitRoutes(ctx: Ctx, d: DesignCall): Promise<boolean> {
  const { req, res, who, live, git, sub } = d;
  if (req.method === "GET" && sub === "/git") {
    json(res, 200, git ? git.info() : null);
    return true;
  }
  if (req.method !== "POST" || !POSTS.includes(sub)) return false;
  // Starting a fork, editing, merging and proposing all write to the repo: those who may edit it.
  if (!ctx.hub.perms.can(who, live.key, "edit"))
    return (json(res, 403, { error: "you can read but not edit" }), true);
  const b = (await body(req)) as Record<string, unknown>;
  try {
    if (sub === "/git") await follow(ctx, d, b);
    else if (!git) json(res, 409, { error: `${live.design} doesn't follow a git repo` });
    else await onRepo(ctx, d, git, b);
  } catch (e) {
    if (e instanceof GitError || e instanceof GitHubError) {
      // Logged too: the person sees it, but whoever runs Archnemesis should be able to as well.
      console.warn(`archnm: ${live.design}${sub}: refused for ${who?.id}: ${e.message}`);
      return (json(res, 409, { error: e.message }), true);
    }
    throw e;
  }
  return true;
}
