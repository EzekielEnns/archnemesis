// Claude Code (or any MCP client) signing in through the browser, where the server has
// sign-in (gcip): the OAuth endpoints the client calls, and the app's Allow page.
import type { Call, Ctx } from "../app.ts";
import { archnmHeader, body, json, text } from "../http.ts";
import { OAuthError } from "../signin/oauth.ts";
import type http from "node:http";

/** The Allow page for an MCP client signing in: only someone signed in to the app itself (the cookie, not a token: a token can't hand out more of itself). */
export async function oauthAllowPage(ctx: Ctx, { req, res, path, who }: Call): Promise<boolean> {
  if (!path.startsWith("/api/oauth/")) return false;
  const { oauth } = ctx;
  const id = decodeURIComponent(path.slice("/api/oauth/".length));
  if (!oauth || who!.kind !== "human" || req.headers.authorization || archnmHeader(req, "token"))
    return (json(res, 404, { error: "no MCP sign-in here" }), true);
  const login = who!.id.slice(who!.id.indexOf(":") + 1);
  if (req.method === "GET") {
    const d = oauth.describe(id);
    if (d) json(res, 200, { ...d, you: who!.name, login });
    else json(res, 404, { error: "this sign-in ran out: start it again from your agent" });
    return true;
  }
  if (req.method === "POST") {
    if (!String(req.headers["content-type"] ?? "").startsWith("application/json"))
      return (json(res, 415, { error: "send JSON" }), true);
    const b = (await body(req, 1024)) as { allow?: unknown };
    try {
      json(res, 200, { redirect: oauth.decide(id, b.allow === true, { owner: who!.id, login }) });
    } catch (e) {
      if (e instanceof OAuthError) json(res, 410, { error: e.message });
      else throw e;
    }
    return true;
  }
  return (json(res, 405, { error: "method not allowed" }), true);
}

/** /.well-known/* and /oauth/*: answered here, never by the app (a clean 404 where there's no sign-in to do). */
export async function oauthEndpoints(
  ctx: Ctx,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  path: string,
): Promise<void> {
  if (await endpoints(ctx, req, res, path)) return;
  json(res, 404, {
    error: "not_found",
    error_description: ctx.oauth
      ? "no such endpoint"
      : "this Archnemesis has no sign-in: no need to Authenticate",
  });
}

async function endpoints(
  ctx: Ctx,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  path: string,
): Promise<boolean> {
  const { oauth } = ctx;
  if (!oauth) return false;
  if (
    req.method === "GET" &&
    (path === "/.well-known/oauth-protected-resource" ||
      path === "/.well-known/oauth-protected-resource/mcp")
  )
    return (json(res, 200, oauth.resourceMetadata()), true);
  if (req.method === "GET" && path === "/.well-known/oauth-authorization-server")
    return (json(res, 200, oauth.serverMetadata()), true);
  const fail = (status: number, e: unknown) => {
    if (!(e instanceof OAuthError)) throw e;
    json(res, status, { error: e.code, error_description: e.message });
  };
  if (req.method === "POST" && path === "/oauth/register") {
    try {
      json(res, 201, oauth.register((await body(req, 16_384)) as Record<string, unknown>));
    } catch (e) {
      fail(400, e);
    }
    return true;
  }
  if (req.method === "GET" && path === "/oauth/authorize") {
    const base = ctx.config.listen.publicUrl;
    try {
      const r = oauth.begin(new URL(req.url ?? "", base).searchParams);
      res
        .writeHead(302, {
          location: "redirect" in r ? r.redirect : `${base}/#~authorize=${r.pending}`,
          "cache-control": "no-store",
        })
        .end();
    } catch (e) {
      if (!(e instanceof OAuthError)) throw e;
      res
        .writeHead(400, { "content-type": "text/plain; charset=utf-8" })
        .end(`archnm: ${e.message}\n`);
    }
    return true;
  }
  if (req.method === "POST" && path === "/oauth/token") {
    try {
      json(res, 200, oauth.token(new URLSearchParams(await text(req, 16_384))));
    } catch (e) {
      fail(400, e);
    }
    return true;
  }
  return false;
}
