// Archnemesis's server: one process holding every design's live document (Yjs, synced over
// WebSockets at /sync), a small JSON API, the MCP endpoint, and the app itself (Vite in
// dev, the built files in production).
//
// By default it listens on loopback only and trusts whoever reaches it. Every setting, its
// default and its meaning is in server/config.ts (`archnm config` prints them). The pieces
// are built in app.ts and the API's routes are in routes/; this file only opens the port.
import "./env-compat.ts";
import http from "node:http";
import { join } from "node:path";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";

const config = loadConfig();
const { listen, paths } = config;
// Everything Archnemesis writes (database, backups, recovered copies, design files) is its own
// account's alone: no other account on the machine reads tokens or designs.
process.umask(0o077);

const app = await createApp(config);
const server = http.createServer();
// Agents' MCP clients keep connections open between calls: with Node's 5s keep-alive, a socket
// the server had just closed was reused for the next call, which failed with ECONNRESET
// (several agents at once). Keep idle sockets longer than clients do.
server.keepAliveTimeout = 120_000;
server.headersTimeout = 125_000;
const vite = listen.dev
  ? await (
      await import("vite")
    ).createServer({
      root: paths.root,
      configFile: join(paths.root, "vite.config.ts"),
      server: { middlewareMode: true, hmr: { server } },
      appType: "spa",
    })
  : null;

const fallback = vite
  ? (req: http.IncomingMessage, res: http.ServerResponse) => void vite.middlewares(req, res)
  : undefined;
server.on("request", (req, res) => void app.handle(req, res, fallback));
// Live sync. Vite's own HMR socket shares the server; it ignores /sync and we ignore it.
server.on("upgrade", app.upgrade);

await app.ready();
server.listen(listen.port, listen.host, () => {
  console.log(
    `archnm on ${listen.publicUrl}${listen.dev ? " (dev)" : ""} · auth ${app.ctx.auth.describe()}`,
  );
});

// A bug in one request or timer is logged, not the end of the server (and of everyone's
// session with it). systemd or the container host still restarts it if it really dies.
process.on("uncaughtException", (e) => console.error("archnm: uncaught:", e));
process.on("unhandledRejection", (e) => console.error("archnm: unhandled rejection:", e));

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    // Forks commit what they have waiting first; give that a few seconds at most.
    const done = () => {
      server.close();
      void vite?.close();
      process.exit(0);
    };
    setTimeout(done, 8000).unref();
    void app.close().finally(done);
  });
}
