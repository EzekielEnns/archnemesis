// GitHub: the app's setup and sign-in round trips, who is connected, and which repos and branches
// can be followed. The credentials and the API calls are server/github.ts.
import type { Call, Ctx } from "../app.ts";
import { GitHubError } from "../github.ts";
import { GITHUB_BINDING_COOKIE } from "../auth/providers/github.ts";
import { body, json } from "../http.ts";
import { cookie } from "../signin/session.ts";

/**
 * GitHub sends the browser back here, without our sign-in: the one-time state in the URL says
 * who started it, so these two don't need it.
 */
export async function githubReturnRoutes(ctx: Ctx, { req, res, path }: Call): Promise<boolean> {
  if (
    req.method !== "GET" ||
    (path !== "/api/github/setup/done" && path !== "/api/github/callback")
  )
    return false;
  const { github } = ctx;
  const base = ctx.config.listen.publicUrl;
  const q = new URL(req.url ?? "", base).searchParams;
  const home = (back: string) => `${base}/${back.startsWith("#/") ? back : ""}`;
  try {
    if (path === "/api/github/setup/done") {
      const r = await github.finishSetup(q.get("code") ?? "", q.get("state"));
      // Next: install the new app on the repos Archnemesis should use.
      res.writeHead(302, { location: r.installUrl }).end();
    } else {
      if (q.get("error")) throw new GitHubError(q.get("error_description") ?? q.get("error")!);
      const r = await github.finishLogin(
        q.get("code") ?? "",
        q.get("state"),
        cookie(req.headers.cookie, GITHUB_BINDING_COOKIE),
      );
      if (r.signIn && ctx.auth.provider.id === "github") {
        // ARCHNM_AUTH=github: this was someone signing in. The role lists decide, then the cookie.
        const done = ctx.auth.gate.ctx.sessions.signIn(
          res,
          { id: r.principal, login: r.login, name: r.name || r.login },
          r.back,
        );
        res.appendHeader("set-cookie", `${GITHUB_BINDING_COOKIE}=; Path=/api/github; Max-Age=0`);
        res.writeHead(302, { location: done.redirect, "cache-control": "no-store" }).end();
        return true;
      }
      res.writeHead(302, { location: home(r.back) }).end();
    }
  } catch (e) {
    res
      .writeHead(400, { "content-type": "text/plain; charset=utf-8" })
      .end(
        `archnm: ${e instanceof Error ? e.message : String(e)}\n\nGo back to ${base}/ and try again.`,
      );
  }
  return true;
}

/** The repos and branches an editor may pick from; each is one GitHub API call. */
async function listRoutes(ctx: Ctx, { req, res, path, who }: Call): Promise<boolean> {
  const { github, auth } = ctx;
  if (req.method !== "GET") return false;
  if (path === "/api/github/branches") {
    if (!auth.authorize(who, "edit")) return (json(res, 403, { error: "editors only" }), true);
    const repo = new URL(req.url ?? "", ctx.config.listen.publicUrl).searchParams.get("repo");
    try {
      json(res, 200, await github.branches(repo ?? ""));
    } catch (e) {
      if (e instanceof GitHubError) json(res, 409, { error: e.message });
      else throw e;
    }
    return true;
  }
  if (path === "/api/github/repos") {
    if (!auth.authorize(who, "edit")) return (json(res, 403, { error: "editors only" }), true);
    try {
      json(res, 200, await github.repos());
    } catch (e) {
      if (e instanceof GitHubError) json(res, 502, { error: e.message });
      else throw e;
    }
    return true;
  }
  return false;
}

/** Connect, disconnect, sign in and out of GitHub (POSTs, by someone signed in). */
async function actionRoutes(ctx: Ctx, { req, res, path, who }: Call): Promise<boolean> {
  const { github, auth } = ctx;
  if (req.method !== "POST" || !who) return false;
  const b = (await body(req)) as { org?: string; back?: string };
  try {
    if (path === "/api/github/setup") {
      // Registering Archnemesis's GitHub App is a one-time, instance-wide choice.
      if (!auth.authorize(who, "admin"))
        return (json(res, 403, { error: "only an admin connects Archnemesis to GitHub" }), true);
      json(res, 200, github.setup(who.id, { org: b.org?.trim() || undefined, back: b.back }));
      return true;
    }
    if (path === "/api/github/disconnect") {
      if (!auth.authorize(who, "admin"))
        return (
          json(res, 403, { error: "only an admin disconnects Archnemesis from GitHub" }),
          true
        );
      github.disconnect();
      json(res, 200, { ok: true });
      return true;
    }
    if (path === "/api/github/login") {
      json(res, 200, { url: github.loginUrl(who.id, b.back ?? "") });
      return true;
    }
    if (path === "/api/github/logout") {
      github.signOut(who.id);
      json(res, 200, { ok: true });
      return true;
    }
  } catch (e) {
    if (e instanceof GitHubError) return (json(res, 409, { error: e.message }), true);
    throw e;
  }
  return false;
}

/** /api/github...: signed-in people only. Anything under it that isn't a route is a 404. */
export async function githubRoutes(ctx: Ctx, call: Call): Promise<boolean> {
  const { req, res, path, who } = call;
  if (!path.startsWith("/api/github")) return false;
  const { github } = ctx;
  if (req.method === "GET" && path === "/api/github") {
    const c = github.creds();
    json(res, 200, {
      configured: !!c,
      slug: c?.slug ?? null,
      owner: c?.owner ?? null,
      installUrl: github.installUrl(),
      fixed: !!ctx.config.github.envApp,
      login: who ? github.userLogin(who.id) : null,
    });
    return true;
  }
  if ((await listRoutes(ctx, call)) || (await actionRoutes(ctx, call))) return true;
  json(res, 404, { error: "not found" });
  return true;
}
