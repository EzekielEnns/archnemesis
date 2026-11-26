// Sharing one design by link, and making your own copy of what you were shown:
//   GET    /api/d/<doc>/links         the links to it (who may manage it), and who a link reaches
//   POST   /api/d/<doc>/links         {days?}: a new link; the token is in this answer only
//   DELETE /api/d/<doc>/links/<id>    revoke one (open connections on it close)
//   POST   /api/d/<doc>/copy          {name?}: a private copy of it, owned by you
// <doc> is a design's key or a fork's "<design>@<fork>". Who may do what is server/access.ts.
import { slug } from "../../shared/model.ts";
import type { Ctx } from "../app.ts";
import { body, json } from "../http.ts";
import { KEY_RE } from "../live.ts";
import type { DesignCall } from "./design.ts";

const DAY = 86_400_000;

async function list(ctx: Ctx, d: DesignCall): Promise<void> {
  const { perms } = ctx.hub;
  await perms.prepare(d.who, d.live.key, true);
  json(d.res, 200, { links: perms.links.list(d.live.key), reach: perms.reach(d.live.key) });
}

async function make(ctx: Ctx, d: DesignCall): Promise<void> {
  const { hub, config } = ctx;
  const b = (await body(d.req, 4096)) as { days?: unknown };
  const days = b.days === undefined || b.days === null ? null : Number(b.days);
  if (days !== null && !(days > 0 && days <= 365))
    return json(d.res, 400, {
      error: "days: a number from 1 to 365, or leave it out for no expiry",
    });
  const made = hub.perms.links.make(d.live.key, d.who!, days === null ? null : days * DAY);
  json(d.res, 201, {
    // The token is shown once, here, in the part of the address after the # (never sent to a server by the browser).
    url: `${config.listen.publicUrl}/#/${d.live.key}~share=${made.token}`,
    link: made.info,
  });
}

function revoke(ctx: Ctx, d: DesignCall): void {
  const id = decodeURIComponent(d.arg ?? "");
  if (!ctx.hub.perms.links.revoke(d.live.key, id))
    return json(d.res, 404, { error: "no such link" });
  ctx.hub.closeLinks(id);
  json(d.res, 200, { ok: true });
}

/** A new private design copied from this document as it is now (not a branch pushed to anyone's repo). */
async function copy(ctx: Ctx, d: DesignCall): Promise<void> {
  const { hub } = ctx;
  const b = (await body(d.req, 4096)) as { name?: unknown };
  const name =
    typeof b.name === "string" && b.name.trim()
      ? b.name.trim().slice(0, 80)
      : `${d.live.name()} (copy)`;
  const stem = slug(d.live.design).slice(0, 40) || "copy";
  let key = `${stem}-copy`;
  for (let n = 2; hub.get(key) || !KEY_RE.test(key); n++) key = `${stem}-copy-${n}`;
  const made = await hub.create(name, key, "empty", d.who, d.live);
  await ctx.startInGit(made);
  json(d.res, 201, { key: made.key, name: made.name(), doc: made.docId() });
}

export async function shareRoutes(ctx: Ctx, d: DesignCall): Promise<boolean> {
  const { req, res, who, live, sub } = d;
  const { perms } = ctx.hub;
  if (sub === "/copy" && req.method === "POST") {
    if (!who || !perms.can(who, live.key, "fork", d.pass))
      return (json(res, 403, { error: "you can't make a copy of this" }), true);
    return (await copy(ctx, d), true);
  }
  if (sub !== "/links") return false;
  const ok = (m: string) => req.method === m && (m === "DELETE" ? !!d.arg : !d.arg);
  if (!ok("GET") && !ok("POST") && !ok("DELETE")) return false;
  // Links are made and ended by people who manage the design (never an agent).
  if (!perms.canShare(who, live.key))
    return (json(res, 403, { error: "only its owner (or an admin) manages its links" }), true);
  if (req.method === "GET") await list(ctx, d);
  else if (req.method === "POST") await make(ctx, d);
  else revoke(ctx, d);
  return true;
}
