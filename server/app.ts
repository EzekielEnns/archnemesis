// The server's pieces, built from a Config: the store, the hub of live designs, sign-in, GitHub,
// telemetry, uploads, scripts and the MCP endpoint. createApp() returns them as a context
// (what the routes in routes/ use) and a request handler; it doesn't listen, so tests can use
// it and main.ts only has to open the port.
import type http from "node:http";
import type { Duplex } from "node:stream";
import { ModelError } from "../shared/doc.ts";
import type { Guest } from "./access.ts";
import { bearer, type Auth, type Principal } from "./auth.ts";
import { createAuth } from "./auth/load.ts";
import { startBackups } from "./backup.ts";
import type { Config } from "./config.ts";
import { bindDesign } from "./gitsync.ts";
import { GitHub } from "./github.ts";
import { archnmHeader, json, serveBuilt } from "./http.ts";
import { LibStatsJob } from "./libstats.ts";
import { Hub } from "./live.ts";
import { mcpHandler } from "./mcp.ts";
import { apiRoutes } from "./routes/index.ts";
import { oauthEndpoints } from "./routes/oauth.ts";
import { providerRoutes } from "./routes/signin.ts";
import { uploadRoutes } from "./routes/upload.ts";
import { Scripts, SCRIPTS, type Script } from "./scripts.ts";
import { OAuth } from "./signin/oauth.ts";
import { PersonalTokens } from "./signin/personal.ts";
import { DocStore } from "./store.ts";
import { openTelemetry, type Telemetry } from "./telemetry.ts";
import { Uploads } from "./uploads.ts";

/** What every route needs: the config and the live pieces built from it. */
export interface Ctx {
  config: Config;
  auth: Auth;
  hub: Hub;
  github: GitHub;
  /** Null when the log's database can't be opened. */
  telemetry: Telemetry | null;
  libstats: LibStatsJob;
  /** Only where people sign in with a browser (a button on the sign-in page): Claude Code then signs in the same way. */
  oauth: OAuth | null;
  /** Repos sent from people's own machines (MCP index start, then the script the server serves). */
  uploads: Uploads;
  /** The scripts the server hands out (curl … | node -). */
  scripts: Scripts;
  mcp: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
  /** Who is calling the HTTP API or the MCP. */
  identify: (req: http.IncomingMessage, agent?: boolean) => Principal | null;
  /** A new design starts in a git repo of its own on this server, when it can. */
  startInGit: (d: Awaited<ReturnType<Hub["create"]>>) => Promise<void>;
}

/** One request, as the routes see it. */
export interface Call {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  /** The URL's path, without the query. */
  path: string;
  /** Who is asking; null only before sign-in has been checked (or for a guest). */
  who: Principal | null;
  /** Someone with no account on a share link to a public repo's design (view only, GET only); else null. */
  guest: Guest | null;
  /** The share link they presented, already checked: its token (never logged), or null. */
  pass: string | null;
}

export interface App {
  ctx: Ctx;
  /** Answer a request; `fallback` serves whatever isn't the server's (the app: Vite in dev). */
  handle: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    fallback?: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  ) => Promise<void>;
  /** Live sync's WebSocket upgrade (at /sync). */
  upgrade: (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void;
  /** Anything to load before taking requests (sign-in keys). */
  ready: () => Promise<void>;
  close: () => Promise<void>;
}

export async function createApp(config: Config): Promise<App> {
  const { listen, paths } = config;
  const docStore = new DocStore(paths.db);
  const github = new GitHub(docStore, listen.publicUrl, config.github, config.auth.tokenKey);
  const auth = await createAuth(config, { github });
  // Agents' tool calls and their feedback, on this machine only (ARCHNM_TELEMETRY=off: no call log).
  const telemetry = openTelemetry(config.telemetry.dbPath, config.telemetry.calls);
  if (config.backups) startBackups(docStore, config.backups);
  const hub = new Hub(docStore, auth, config);
  auth.personal = new PersonalTokens(hub.store);
  // Claude Code signs in through the browser, where people here sign in with one.
  const oauth = auth.browserSignIn ? new OAuth(hub.store, auth.personal, listen.publicUrl) : null;
  // Someone who hasn't chosen a name goes by their GitHub one, once they've signed in.
  auth.defaultName = (id) => github.userName(id);
  hub.github = github;

  /**
   * A new design starts in a git repo of its own on this server (when it has a lasting disk), so
   * it has forks and history from the start; connecting GitHub later swaps the repo. If that
   * fails, the design still works, edited directly.
   */
  const startInGit = async (d: Awaited<ReturnType<Hub["create"]>>): Promise<void> => {
    if (!config.git.localRepos || !config.git.newInGit) return;
    await bindDesign(hub, d, { local: true }).catch((e) =>
      console.warn(`[git] ${d.key} stays out of git: ${(e as Error).message}`),
    );
  };

  await hub.start();
  // The design a fresh Archnemesis starts with follows git like any other new one: forks, read {diff} and propose work on it too.
  for (const d of hub.seeded) await startInGit(d);
  // Library stats (stars, people, licence, advisories) from deps.dev and GitHub, cached daily.
  // Off unless ARCHNM_LIBSTATS=on: it sends library names out, and a private package's name is private.
  const libstats = new LibStatsJob(
    hub.store,
    () =>
      [...hub.designs.values()].flatMap((l) =>
        [...l.state.objects.values()].flatMap((o) =>
          o.kind === "library" && o.package ? [o.package] : [],
        ),
      ),
    undefined,
    config.libstats,
  );
  libstats.start();

  const identify = (req: http.IncomingMessage, agent = false): Principal | null => {
    const name = archnmHeader(req, "name");
    // Behind IAP, Authorization carries Google's identity token for IAP itself; an Archnemesis
    // token then rides in X-Archnm-Token.
    const own = archnmHeader(req, "token");
    const token = (typeof own === "string" && own.trim()) || bearer(req.headers.authorization);
    return auth.identify({
      token,
      name: typeof name === "string" ? name : null,
      agent,
      headers: req.headers,
    });
  };

  const uploads = new Uploads();
  const scripts = new Scripts(paths.root);
  if (listen.dev) for (const s of Object.keys(SCRIPTS) as Script[]) void scripts.ensure(s);
  const mcp = mcpHandler({
    challenge: oauth?.challenge(),
    hub,
    uploads,
    scripts,
    identify: (req) => identify(req, true),
    baseUrl: listen.publicUrl,
    libstats: (p) => libstats.get(p),
    libstatsNow: (p) => libstats.now(p),
    experiments: config.experiments,
    created: startInGit,
    telemetry,
  });
  const ctx: Ctx = {
    config,
    auth,
    hub,
    github,
    telemetry,
    libstats,
    oauth,
    uploads,
    scripts,
    mcp,
    identify,
    startInGit,
  };

  const handle: App["handle"] = async (req, res, fallback) => {
    try {
      if (!listen.hosts.has(req.headers.host ?? "")) {
        res
          .writeHead(403)
          .end(
            `Archnemesis only answers on its own address, ${listen.publicUrl}, and this request came for ${req.headers.host ?? "no host"}. On another port, set ARCHNM_PORT to it (with Docker: -e ARCHNM_PORT=8080 -p 127.0.0.1:8080:8080); behind a domain, set ARCHNM_PUBLIC_URL.`,
          );
        return;
      }
      const origin = req.headers.origin;
      if (req.method !== "GET" && req.method !== "HEAD" && origin && !listen.origins.has(origin)) {
        res.writeHead(403).end("cross-origin request refused");
        return;
      }
      const path = new URL(req.url ?? "/", listen.publicUrl).pathname;
      if (path.startsWith("/api/")) return await apiRoutes(ctx, req, res, path);
      if (path === "/mcp") return await mcp(req, res);
      if (path.startsWith("/auth/")) return await providerRoutes(ctx, req, res, path);
      if (await uploadRoutes(ctx, req, res, path)) return;
      // Not the app: a clean 404 (an MCP client looking for sign-in where there's none to do).
      if (path.startsWith("/.well-known/") || path.startsWith("/oauth/")) {
        await oauthEndpoints(ctx, req, res, path);
        return;
      }
      if (fallback) fallback(req, res);
      else await serveBuilt(res, paths.root, path);
    } catch (e) {
      const status = e instanceof ModelError || e instanceof SyntaxError ? 400 : 500;
      if (status === 500) console.error(e);
      if (!res.headersSent)
        json(res, status, { error: e instanceof Error ? e.message : String(e) });
      else res.end();
    }
  };

  const upgrade: App["upgrade"] = (req, socket, head) => {
    const path = new URL(req.url ?? "/", listen.publicUrl).pathname;
    if (path !== "/sync") return;
    const origin = req.headers.origin;
    if (!listen.hosts.has(req.headers.host ?? "") || (origin && !listen.origins.has(origin))) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    hub.upgrade(req, socket, head);
  };

  return { ctx, handle, upgrade, ready: () => auth.ready(), close: () => hub.close() };
}
