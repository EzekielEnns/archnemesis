// The JSON API: one module per area in this folder, tried in the order below. Each takes the
// context and the call and answers true when it handled the request.
//
// Reachable without signing in: /api/icons, /api/icon, /api/config, /api/signout
// and GitHub's two return trips (the one-time state in their URL says who started them).
// Everything after that needs someone who may read, else 401.
//
// API (each design is /api/d/<key>/...):
//   GET  /api/config            how to sign in (the provider's `signin` page description)
//   GET  /api/me                who you are
//   GET  /api/designs           every design      POST /api/designs {name, key?, from?}
//   GET  /api/d/<key>           its name and document id
//   GET  /api/d/<key>/touched/<box>   who's changed its sources lately, from git
//   GET  /api/d/<key>/render/<view>.svg|.png?flow=&step=   a view as an image
//   GET  /api/d/<key>/state     the whole model   GET /api/d/<key>/log   GET /api/d/<key>/files
//   GET  /api/d/<doc>/new       on a fork: what changed since it started, and where it plugs in
//   POST /api/d/<key>/ops       {ops, label}
//   POST /api/d/<key>/trail     {session, events}: moves made, when recording is on (`trail` reads them)
//
// Git (server/gitsync.ts); <doc> is a design's key or a fork's "<design>@<fork>":
//   GET  /api/d/<key>/git       whether it follows a repo, main, and every open fork
//   POST /api/d/<key>/git       {remote, path?, branch?} or {local: true}: follow a repo
//   POST /api/d/<key>/sync      fetch now
//   POST /api/d/<key>/fork      {name?}: a new fork of main
//   POST /api/d/<key>/edit      {batches: [{ops, label}]}: edits made on main, applied to
//                               your fork (made if you haven't one); answers with its doc
//   POST /api/d/<doc>/merge     merge a fork into main      POST /api/d/<doc>/discard
//
// MCP sign-in (where people sign in with a browser; server/signin/oauth.ts): /.well-known/oauth-protected-resource,
// /.well-known/oauth-authorization-server, /oauth/register, /oauth/authorize (on to the
// app's Allow page, #~authorize=<id>), /oauth/token; the page uses GET /api/oauth/<id>
// and POST /api/oauth/<id> {allow}.
import type http from "node:http";
import { clientAddr } from "../addr.ts";
import type { Call, Ctx } from "../app.ts";
import { json, shareToken } from "../http.ts";
import { GUEST } from "../perms.ts";
import { designRoutes } from "./design.ts";
import { designsRoutes } from "./designs.ts";
import { githubReturnRoutes, githubRoutes } from "./github.ts";
import { iconRoutes } from "./icons.ts";
import { oauthAllowPage } from "./oauth.ts";
import { accountRoutes, signinRoutes } from "./signin.ts";
import { telemetryRoutes } from "./telemetry.ts";

export async function apiRoutes(
  ctx: Ctx,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  path: string,
): Promise<void> {
  const open: Call = { req, res, path, who: null, guest: null, pass: null };
  if (
    iconRoutes(ctx, open) ||
    (await signinRoutes(ctx, open)) ||
    (await githubReturnRoutes(ctx, open))
  )
    return;

  const who = ctx.identify(req);
  // A share link, checked once here (a few wrong ones from an address and it's ignored a while).
  const pass = ctx.hub.perms.present(shareToken(req), clientAddr(req, ctx.config.auth.proxies));
  if (!ctx.auth.authorize(who, "read")) {
    // No sign-in: only a link to a public repo's design (ARCHNM_PUBLIC_LINKS), only reading it.
    const guest = !who && pass && guestMayAsk(ctx, req.method, path);
    if (!guest) return json(res, 401, { error: "not signed in" });
    if (await designRoutes(ctx, { req, res, path, who: null, guest: GUEST, pass })) return;
    return json(res, 401, { error: "not signed in" });
  }
  await ctx.hub.perms.warm(who);
  const call: Call = { req, res, path, who, guest: null, pass };

  for (const route of [
    oauthAllowPage,
    accountRoutes,
    githubRoutes,
    telemetryRoutes,
    designsRoutes,
    designRoutes,
  ])
    if (await route(ctx, call)) return;
  json(res, 404, { error: "not found" });
}

/** A guest only ever reads one design: GET /api/d/<key>/..., and only where the hoster allows it. */
function guestMayAsk(ctx: Ctx, method: string | undefined, path: string): boolean {
  return ctx.config.auth.publicLinks && method === "GET" && path.startsWith("/api/d/");
}
