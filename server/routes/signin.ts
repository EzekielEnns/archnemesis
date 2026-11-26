// Signing in, and who you are: how the app learns to sign in (/api/config), the browser's
// sign-in and sign-out, /api/me, the flags waiting on your agent, and your personal tokens.
import type http from "node:http";
import { waitingFlags } from "../../shared/flags.ts";
import type { Call, Ctx } from "../app.ts";
import { body, json } from "../http.ts";
import { sessionCookie } from "../signin/session.ts";

/** The other way in, a Claude Code feature: the tools through the channel (a file the server serves, run by node), so @agent in a note reaches your running Claude Code session. With a token where the server wants one. */
function channelSetup(ctx: Ctx, token: string | null) {
  const { publicUrl, mcpName } = ctx.config.listen;
  const file = "~/.claude/archnm-channel.mjs";
  return {
    download: `curl -fsSo ${file} ${publicUrl}/archnm-channel.mjs`,
    command: `claude mcp remove -s user ${mcpName} 2>/dev/null; claude mcp add -s user ${token ? `-e ARCHNM_TOKEN=${token} ` : ""}${mcpName} -- node ${file} --server ${publicUrl}`,
    start: `claude --dangerously-load-development-channels server:${mcpName}`,
  };
}

/** How to connect an agent, for the app's first-open card: the MCP address, and Claude Code's commands as the example. */
function mcpSetup(ctx: Ctx) {
  const { publicUrl, mcpName } = ctx.config.listen;
  const withChannel = <T extends object>(x: T, token: string | null = null) => ({
    url: `${publicUrl}/mcp`,
    ...x,
    channel: channelSetup(ctx, token),
  });
  const base = `claude mcp add -s user --transport http ${mcpName} ${publicUrl}/mcp`;
  // Signed in with a browser: Claude Code signs in the same way (OAuth), and gets a
  // personal token that acts as you. Making one by hand stays, for scripts.
  // (Not by provider name: anything people sign in to with a browser gets the same.)
  if (ctx.auth.browserSignIn)
    return withChannel(
      {
        command: base,
        oauth: mcpName,
        tokenCommand: `${base} --header "X-Archnm-Token: <your token>"`,
        note: "The agent acts as you, with your role here. It shows in your tokens below; revoke it there.",
        personal: true,
      },
      "<your token>",
    );
  switch (ctx.auth.provider.id) {
    case "tokens":
      return withChannel(
        {
          command: `${base} --header "Authorization: Bearer <your agent token>"`,
          note: "Ask whoever runs Archnemesis for an agent token, and put it in place of <your agent token>.",
        },
        "<your agent token>",
      );
    case "tailscale":
      return withChannel({
        command: base,
        note: "Works from any machine on the tailnet; the agent acts as you.",
      });
    default:
      return withChannel({ command: base, note: null });
  }
}

/**
 * /auth/<provider id>/...: the provider's own routes (redirect flows, callbacks, a page of its
 * own). Only the provider whose id it is gets them; whatever it does wrong is a plain 500 and
 * signs no one in.
 */
export async function providerRoutes(
  ctx: Ctx,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  path: string,
): Promise<void> {
  const { provider } = ctx.auth;
  const mine = path === `/auth/${provider.id}` || path.startsWith(`/auth/${provider.id}/`);
  try {
    if (mine && provider.routes && (await provider.routes(req, res, path))) return;
  } catch (e) {
    console.error(`archnm: the ${provider.id} sign-in failed:`, e);
    if (!res.headersSent) json(res, 500, { error: "sign-in failed" });
    else res.end();
    return;
  }
  json(res, 404, { error: "not found" });
}

/** What the app needs before it connects, and the browser's sign-out. */
export async function signinRoutes(ctx: Ctx, { req, res, path }: Call): Promise<boolean> {
  const { auth, config } = ctx;
  const secure = config.listen.publicUrl.startsWith("https://");
  if (req.method === "GET" && path === "/api/config") {
    json(res, 200, {
      auth: auth.provider.id,
      signin: auth.signInPage(),
      mcp: mcpSetup(ctx),
      localRepos: config.git.localRepos,
    });
    return true;
  }
  if (req.method === "POST" && path === "/api/signin") {
    // The old way in (a Google ID token posted here) is gone: providers sign people in on their
    // own /auth/<id>/ routes. Kept so an old open tab gets a clean answer, and so server/api.test.ts
    // still pins it: JSON only, then not found.
    if (!String(req.headers["content-type"] ?? "").startsWith("application/json"))
      return (json(res, 415, { error: "send JSON" }), true);
    return (json(res, 404, { error: "sign in from the sign-in page" }), true);
  }
  if (req.method === "POST" && path === "/api/signout") {
    res.setHeader("set-cookie", sessionCookie(null, secure));
    json(res, 200, { ok: true });
    return true;
  }
  return false;
}

/** Your own personal tokens, made by you in the app (never by an agent). */
async function tokenRoutes(ctx: Ctx, { req, res, path, who }: Call): Promise<void> {
  const { auth } = ctx;
  if (!auth.personalTokens || !auth.personal || who!.kind !== "human")
    return json(res, 404, { error: "no personal tokens here" });
  const login = who!.id.slice(who!.id.indexOf(":") + 1);
  if (req.method === "GET" && path === "/api/tokens")
    return json(res, 200, auth.personal.list(who!.id));
  if (req.method === "POST" && path === "/api/tokens") {
    const b = (await body(req, 4096)) as { label?: unknown };
    return json(
      res,
      200,
      auth.personal.make(who!.id, login, typeof b.label === "string" ? b.label : ""),
    );
  }
  if (req.method === "DELETE") {
    // Exactly one id segment: "/api/tokens/a/b" is not a token.
    const id = /^\/api\/tokens\/([^/]+)$/.exec(path)?.[1];
    return id && auth.personal.revoke(who!.id, decodeURIComponent(id))
      ? json(res, 200, { ok: true })
      : json(res, 404, { error: "no such token" });
  }
  return json(res, 405, { error: "method not allowed" });
}

/** Who you are, what's waiting on your agent, and your tokens: for anyone signed in. */
export async function accountRoutes(ctx: Ctx, call: Call): Promise<boolean> {
  const { req, res, path, who } = call;
  const { hub, config } = ctx;
  if (req.method === "GET" && path === "/api/me") return (json(res, 200, who), true);
  // Flags waiting on the caller's agent (what `archnm channel` polls): open flags in every
  // design and fork they can see whose last word is from the person that agent works for.
  if (req.method === "GET" && path === "/api/flags") {
    const agent = ctx.identify(req, true);
    await hub.perms.warm(agent);
    const docs = [...hub.designs.values(), ...hub.forks.values()].filter(
      (d) => d.ready && hub.perms.can(agent, d.key, "view"),
    );
    const flags = docs.flatMap((d) =>
      waitingFlags(d.index(), d.key, agent?.for ?? "").map((f) => ({
        ...f,
        link: `${config.listen.publicUrl}/#/${f.doc}/d/${f.diagramId}/n/${f.id}`,
      })),
    );
    json(res, 200, {
      agent: agent ? { id: agent.id, name: agent.name, for: agent.for } : null,
      flags,
    });
    return true;
  }
  if (path === "/api/tokens" || path.startsWith("/api/tokens/")) {
    await tokenRoutes(ctx, call);
    return true;
  }
  return false;
}
