// One design: /api/d/<key>/... Finds the design (someone else's private design answers exactly like
// one that isn't there), then hands the request to the area it belongs to: git.ts, import.ts and
// render.ts, or answers it here (what the design is, its model, history, files, edits, sharing).
import { isThreadOp, type Op } from "../../shared/model.ts";
import type { DesignAction, Who } from "../access.ts";
import type { Call, Ctx } from "../app.ts";
import type { GitSync } from "../gitsync.ts";
import { dropLocalRepo } from "../gitsync.ts";
import { body, json } from "../http.ts";
import type { GuideReply, Live } from "../live.ts";
import { touched } from "../touched.ts";
import { gitRoutes } from "./git.ts";
import { importRoutes } from "./import.ts";
import { renderRoutes } from "./render.ts";
import { shareRoutes } from "./share.ts";
import { statsKey } from "../../shared/libstats.ts";
import { changedWithContext } from "../../shared/whatsnew.ts";

/** A call on one design: /api/d/<key><sub>[/<arg>]. */
export interface DesignCall extends Call {
  live: Live;
  /** "" or "/state", "/ops", ... */
  sub: string;
  /** What follows the sub: a box, a view, a version. */
  arg: string | undefined;
  /** Set when the design follows a git repo. */
  git: GitSync | undefined;
  /** Who is asking as far as access goes: a person, or a guest on a link. */
  viewer: Who;
}

/** An edit's label: one line of plain text (it ends up in history and commit messages). */
function cleanLabel(label: unknown): string {
  const s =
    typeof label === "string"
      ? label
          .replace(/[\r\n\t]+/g, " ")
          .trim()
          .slice(0, 200)
      : "";
  return s || "edit";
}

function info(ctx: Ctx, d: DesignCall): void {
  const { live, who, git, viewer, pass } = d;
  const { perms } = ctx.hub;
  const a = ctx.hub.access(live.design);
  const may = (x: DesignAction) => perms.can(viewer, live.key, x, pass);
  json(d.res, 200, {
    key: live.key,
    design: live.design,
    branch: live.branch,
    mode: live.mode,
    name: live.name(),
    doc: live.docId(),
    git: !!git,
    // What you may do here, so the app can hide what you can't (the server checks again).
    can: { view: true, fork: may("fork"), edit: may("edit"), manage: may("manage") },
    canEdit: may("edit"),
    // You're here on a share link: without it you couldn't see this.
    viaLink: !!viewer && !perms.can(viewer, live.key, "view"),
    guest: viewer?.kind === "guest",
    private: a.private,
    mine: perms.owns(who, live.key),
    owned: !!a.owner,
  });
}

/** Delete a design (not a fork, not one that follows a real git repo): its owner, or an admin for a team design. */
async function remove(ctx: Ctx, { res, who, live }: DesignCall): Promise<void> {
  const { hub } = ctx;
  if (live.branch)
    return json(res, 400, { error: "that's a fork: discard it from the branch menu" });
  if (!hub.perms.can(who, live.design, "manage"))
    return json(res, 403, {
      error: "only its owner (or an admin, for a team design) deletes a design",
    });
  try {
    await dropLocalRepo(hub, live.design);
    hub.remove(live.design, `${who?.name ?? "someone"} deleted ${live.name()}`);
  } catch (e) {
    return json(res, 409, { error: (e as Error).message });
  }
  json(res, 200, { ok: true });
}

/** Share a private design with the team, or take it back: its owner only. */
async function share(ctx: Ctx, { req, res, who, live }: DesignCall): Promise<void> {
  const { hub } = ctx;
  if (!hub.perms.owns(who, live.design) || !hub.perms.can(who, live.design, "manage"))
    return json(res, 403, { error: "only its owner shares a design" });
  const b = (await body(req)) as { private?: unknown };
  try {
    hub.setPrivate(live.design, b.private === true);
  } catch (e) {
    return json(res, 409, { error: (e as Error).message });
  }
  json(res, 200, hub.access(live.design));
}

/** What's new on a fork against what it started from, and where it plugs in (✦). */
async function whatsNew(_ctx: Ctx, { res, live, git }: DesignCall): Promise<void> {
  const base = live.branch && git ? await git.baseState(live.key).catch(() => null) : null;
  json(
    res,
    200,
    base ? changedWithContext(base, live.state) : { changed: [], context: [], connections: [] },
  );
}

function state(_ctx: Ctx, { res, live }: DesignCall): void {
  const s = live.state;
  json(res, 200, {
    objects: [...s.objects.values()],
    connections: [...s.connections.values()],
    diagrams: [...s.diagrams.values()],
    placements: [...s.placements.values()],
    flows: [...s.flows.values()],
    entities: [...s.entities.values()],
  });
}

/** Where someone went (recorded only when they turn it on in their browser). */
async function trail(ctx: Ctx, { req, res, who, live }: DesignCall): Promise<void> {
  const b = (await body(req, 256 * 1024)) as { session?: unknown; events?: unknown };
  if (typeof b.session !== "string" || !Array.isArray(b.events))
    return json(res, 400, { error: "{session, events}" });
  const events = b.events
    .filter(
      (e): e is { at: string } =>
        !!e && typeof e === "object" && typeof (e as { at?: unknown }).at === "string",
    )
    .slice(0, 500);
  ctx.hub.store.addTrail(
    live.design,
    live.key,
    b.session.slice(0, 40),
    who?.name ?? "someone",
    events,
  );
  json(res, 200, { ok: true });
}

/** The person answers a guided step (Next / Back / Stop / a question) for a waiting agent. */
async function guide(_ctx: Ctx, { req, res, who, live }: DesignCall): Promise<void> {
  const b = (await body(req)) as { seq?: number; action?: string; text?: string };
  const action = b.action as GuideReply["action"];
  if (typeof b.seq !== "number" || !["next", "back", "stop", "ask"].includes(action))
    return json(res, 400, { error: "{seq, action: next|back|stop|ask, text?}" });
  const ok = live.reply(who!, b.seq, {
    action,
    ...(action === "ask" && b.text ? { text: String(b.text).slice(0, 1000) } : {}),
  });
  json(
    res,
    ok ? 200 : 409,
    ok ? { ok: true } : { error: "that step isn't yours, or it's moved on" },
  );
}

/** The design as of one of main's past versions, to look at (read-only in the browser). */
async function versionAt({ res, arg, git }: DesignCall): Promise<void> {
  if (!git) return json(res, 404, { error: "it doesn't follow a git repo" });
  try {
    const st = await git.stateAt(decodeURIComponent(arg!));
    json(
      res,
      200,
      Object.fromEntries(
        Object.entries(st).map(([k, v]) => [k, [...(v as Map<string, unknown>).values()]]),
      ),
    );
  } catch (e) {
    json(res, 404, { error: (e as Error).message });
  }
}

/** Who's touched a box: its sources' recent commits, by author (server/touched.ts). */
async function touchedBy(ctx: Ctx, { res, live, arg }: DesignCall): Promise<void> {
  const o =
    live.state.objects.get(decodeURIComponent(arg!)) ??
    [...live.state.objects.values()].find((x) => x.key === decodeURIComponent(arg!));
  if (!o) return json(res, 404, { error: "no such box" });
  json(
    res,
    200,
    await touched(o.sources ?? [], {
      github: ctx.github,
      owner: live.config().github,
      localRoot: ctx.config.paths.sourceRoot,
    }),
  );
}

/** Where the files are on the server is for admins; what's wrong with them is for anyone. */
function files(ctx: Ctx, { res, who, live }: DesignCall): void {
  json(res, 200, {
    dir: ctx.auth.authorize(who, "admin") ? (live.files?.dir ?? null) : null,
    problems: live.files?.problems ?? [],
  });
}

async function ops(ctx: Ctx, { req, res, who, live }: DesignCall): Promise<void> {
  if (!ctx.hub.perms.can(who, live.key, "edit"))
    return json(res, 403, { error: "you can read but not edit" });
  const { ops, label } = (await body(req)) as { ops?: Op[]; label?: string };
  if (!Array.isArray(ops)) return json(res, 400, { error: "ops must be an array" });
  // Git's main is only ever changed by git, except for notes, which aren't in its files.
  if (live.mode === "mirror" && !ops.every((op) => isThreadOp(op, live.state.notes)))
    return json(res, 409, { error: `${live.design}'s main follows git: edit it on a fork` });
  const ids = live.commit(who!, ops, cleanLabel(label));
  json(res, 200, { touched: ids });
}

/** Library stats for this design's libraries, by statsKey (cached; never in the files). */
function libstats(ctx: Ctx, { res, live }: DesignCall): void {
  const stats: Record<string, unknown> = {};
  for (const o of live.state.objects.values())
    if (o.kind === "library" && o.package) stats[statsKey(o.package)] = ctx.libstats.get(o.package);
  json(res, 200, { enabled: ctx.libstats.enabled, stats });
}

/** The routes answered here, by "<METHOD> <sub>". The rest of a path (arg) is checked where it matters. */
async function ownRoutes(ctx: Ctx, d: DesignCall): Promise<boolean> {
  // Only a few take something after the name; anything else with more on the end isn't a route.
  if (d.arg && !["/versions", "/at", "/touched"].includes(d.sub)) return false;
  switch (`${d.req.method} ${d.sub}`) {
    case "GET ":
      return (info(ctx, d), true);
    case "DELETE ":
      return (await remove(ctx, d), true);
    case "POST /share":
      return (await share(ctx, d), true);
    case "GET /libstats":
      return (libstats(ctx, d), true);
    case "GET /new":
      return (await whatsNew(ctx, d), true);
    case "GET /state":
      return d.arg ? false : (state(ctx, d), true);
    case "POST /trail":
      return (await trail(ctx, d), true);
    case "POST /guide":
      return (await guide(ctx, d), true);
    case "GET /versions":
      // Main's past versions (a design that follows git): the commits that changed its files.
      if (d.arg) return false;
      return (
        json(
          d.res,
          200,
          d.git
            ? { versions: await d.git.versions() }
            : { versions: [], why: "it doesn't follow a git repo" },
        ),
        true
      );
    case "GET /at":
      return d.arg ? (await versionAt(d), true) : false;
    case "GET /touched":
      return d.arg ? (await touchedBy(ctx, d), true) : false;
    case "GET /log":
      return (json(d.res, 200, d.live.recent(200)), true);
    case "GET /files":
      return (files(ctx, d), true);
    case "POST /ops":
      return (await ops(ctx, d), true);
    default:
      return false;
  }
}

/** What a guest may read of a design (GET only; index.ts lets nothing else through). */
const GUEST_SUBS = [
  "",
  "/state",
  "/new",
  "/log",
  "/files",
  "/libstats",
  "/versions",
  "/at",
  "/touched",
  "/render",
  "/git",
];

export async function designRoutes(ctx: Ctx, call: Call): Promise<boolean> {
  const { res, path, who, guest, pass } = call;
  const { hub } = ctx;
  const m = /^\/api\/d\/([^/]+)(\/[a-z]+)?(?:\/([^/]+))?$/.exec(path);
  let name: string | undefined;
  try {
    name = m ? decodeURIComponent(m[1]!) : undefined;
  } catch {
    return (json(res, 400, { error: "bad design name in the URL" }), true);
  }
  if (!m) return false;
  // Someone else's private design answers exactly like one that isn't there.
  const found = name === undefined ? undefined : hub.get(name);
  const viewer: Who = guest ?? who;
  if (found) await hub.perms.prepare(viewer, found.key);
  const live = found && hub.perms.can(viewer, found.key, "view", pass) ? found : undefined;
  // A guest only reads what a link shows: no other area of the design answers them.
  if (guest && !GUEST_SUBS.includes(m[2] ?? ""))
    return (json(res, 401, { error: "not signed in" }), true);
  if (!live) {
    // A guest is only told they're not signed in, whatever they asked for.
    if (guest) return (json(res, 401, { error: "not signed in" }), true);
    return (
      json(res, 404, {
        error: `no design "${name}"`,
        designs: hub.list(who).map((d) => d.key),
      }),
      true
    );
  }
  const d: DesignCall = {
    ...call,
    live,
    sub: m[2] ?? "",
    arg: m[3],
    git: hub.git.get(live.design),
    viewer,
  };
  return (
    (await gitRoutes(ctx, d)) ||
    (await importRoutes(ctx, d)) ||
    (await renderRoutes(ctx, d)) ||
    (await shareRoutes(ctx, d)) ||
    (await ownRoutes(ctx, d))
  );
}
