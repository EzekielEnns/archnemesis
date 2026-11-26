// Characterisation of the HTTP API: status codes and response shapes for a representative set of
// routes, in local mode and in tokens mode, against a real server process. It pins what the
// server answers today so that restructuring it (routes, config) can't change it unnoticed.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

interface Running {
  base: string;
  port: number;
  dir: string;
  stop: () => Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

async function start(env: Record<string, string>, dir: string): Promise<Running> {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server: ChildProcess = spawn(process.execPath, ["server/main.ts"], {
    env: {
      ...process.env,
      ARCHNM_PORT: String(port),
      ARCHNM_HOST: "127.0.0.1",
      ARCHNM_BACKUP_DIR: "off",
      ARCHNM_DB: join(dir, "archnm.sqlite"),
      ARCHNM_ROOT: join(dir, "designs"),
      ARCHNM_LIBSTATS: "off",
      ARCHNM_NEW_IN_GIT: "0",
      ARCHNM_EXAMPLES: "off",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`archnm didn't start in 60 s:\n${log}`)), 60_000);
    const seen = (b: Buffer) => {
      log += b.toString();
      if (log.includes(`archnm on ${base}`)) {
        clearTimeout(t);
        resolve();
      }
    };
    server.stdout!.on("data", seen);
    server.stderr!.on("data", seen);
    server.on("exit", (code) => reject(new Error(`archnm exited (${code}):\n${log}`)));
  });
  return {
    base,
    port,
    dir,
    stop: async () => {
      if (server.exitCode === null) {
        server.kill("SIGTERM");
        await new Promise((r) => server.once("exit", r));
      }
    },
  };
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  json: unknown;
}

/** One request with full control of the headers (Host and Origin included). */
function call(
  s: Running,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Reply> {
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  const headers: Record<string, string> = {
    ...(payload ? { "content-type": "application/json" } : {}),
    ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    ...opts.headers,
  };
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: s.port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json: unknown = undefined;
        try {
          json = JSON.parse(text);
        } catch {
          // not JSON
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
      });
    });
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const dirs: string[] = [];
const servers: Running[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "archnm-api-"));
  dirs.push(d);
  return d;
};

afterAll(async () => {
  await Promise.all(servers.map((s) => s.stop()));
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const ADMIN = "admin-token-0123456789";
const EDITOR = "editor-token-0123456789";
const VIEWER = "viewer-token-0123456789";

describe("local mode", () => {
  let s: Running;
  beforeAll(async () => {
    s = await start({}, scratch());
    servers.push(s);
  }, 70_000);

  it("answers config and me without sign-in", async () => {
    const c = await call(s, "GET", "/api/config");
    expect(c.status).toBe(200);
    expect(c.headers["cache-control"]).toBe("no-store");
    expect(c.json).toMatchObject({
      auth: "local",
      localRepos: true,
      mcp: { url: `${s.base}/mcp`, note: null, channel: {} },
    });
    const me = await call(s, "GET", "/api/me");
    expect(me.status).toBe(200);
    expect(me.json).toMatchObject({ kind: "human", roles: expect.arrayContaining(["admin"]) });
  });

  it("lists, creates, reads and deletes a design", async () => {
    const first = (await call(s, "GET", "/api/designs")).json as { key: string }[];
    expect(first.map((d) => d.key)).toEqual(["my-design"]);
    expect((await call(s, "POST", "/api/designs", { body: {} })).status).toBe(400);
    const made = await call(s, "POST", "/api/designs", { body: { name: "Shop", key: "shop" } });
    expect(made.status).toBe(201);
    expect(made.json).toMatchObject({ key: "shop", name: "Shop", doc: expect.any(String) });
    const list = (await call(s, "GET", "/api/designs")).json as { key: string }[];
    expect(list.map((d) => d.key)).toEqual(["my-design", "shop"]);

    const info = await call(s, "GET", "/api/d/shop");
    expect(info.status).toBe(200);
    expect(info.json).toMatchObject({
      key: "shop",
      design: "shop",
      name: "Shop",
      git: false,
      canEdit: true,
      // New: what you may do here, whether you're here on a share link, and whether as a guest.
      can: { view: true, fork: true, edit: true, manage: true },
      viaLink: false,
      guest: false,
      private: true,
      mine: true,
      owned: true,
    });
    expect(Object.keys(info.json as object).sort()).toEqual(
      [
        "branch",
        "can",
        "canEdit",
        "guest",
        "viaLink",
        "design",
        "doc",
        "git",
        "key",
        "mine",
        "mode",
        "name",
        "owned",
        "private",
      ].sort(),
    );

    const state = await call(s, "GET", "/api/d/shop/state");
    expect(state.status).toBe(200);
    expect(Object.keys(state.json as object).sort()).toEqual([
      "connections",
      "diagrams",
      "entities",
      "flows",
      "objects",
      "placements",
    ]);
    const log = await call(s, "GET", "/api/d/shop/log");
    expect(log.status).toBe(200);
    expect(Array.isArray(log.json)).toBe(true);
    const files = await call(s, "GET", "/api/d/shop/files");
    expect(files.status).toBe(200);
    expect(files.json).toMatchObject({ problems: expect.any(Array) });
    expect(Object.keys(files.json as object).sort()).toEqual(["dir", "problems"]);

    const noOps = await call(s, "POST", "/api/d/shop/ops", { body: { ops: "nope" } });
    expect(noOps.status).toBe(400);
    expect(noOps.json).toEqual({ error: "ops must be an array" });
    const ops = await call(s, "POST", "/api/d/shop/ops", {
      body: {
        ops: [
          {
            op: "object.put",
            object: {
              id: "web",
              kind: "app",
              name: "Web",
              description: "",
              technology: "",
              status: "live",
            },
          },
        ],
        label: "add web",
      },
    });
    expect(ops.status).toBe(200);
    expect(ops.json).toEqual({ touched: ["web"] });

    const share = await call(s, "POST", "/api/d/shop/share", { body: { private: false } });
    expect(share.status).toBe(200);
    expect(share.json).toMatchObject({ private: false });

    const git = await call(s, "GET", "/api/d/shop/git");
    expect(git.status).toBe(200);
    expect(git.json).toBeNull();
    const sync = await call(s, "POST", "/api/d/shop/sync", { body: {} });
    expect(sync.status).toBe(409);
    expect(sync.json).toEqual({ error: "shop doesn't follow a git repo" });
    const fork = await call(s, "POST", "/api/d/shop/fork", { body: {} });
    expect(fork.status).toBe(409);
    const versions = await call(s, "GET", "/api/d/shop/versions");
    expect(versions.status).toBe(200);
    expect(versions.json).toEqual({ versions: [], why: "it doesn't follow a git repo" });
    const at = await call(s, "GET", "/api/d/shop/at/abc");
    expect(at.status).toBe(404);
    expect(at.json).toEqual({ error: "it doesn't follow a git repo" });
    expect((await call(s, "GET", "/api/d/shop/new")).json).toEqual({
      changed: [],
      context: [],
      connections: [],
    });
    const libstats = await call(s, "GET", "/api/d/shop/libstats");
    expect(libstats.json).toEqual({ enabled: false, stats: {} });
    expect((await call(s, "GET", "/api/d/shop/touched/nobody")).status).toBe(404);
    const render = await call(s, "GET", "/api/d/shop/render/nothing.txt");
    expect(render.status).toBe(400);
    expect(render.json).toEqual({ error: "render/<view>.svg or .png" });
    expect((await call(s, "GET", "/api/d/shop/render/nothing.svg")).status).toBe(404);
    const trail = await call(s, "POST", "/api/d/shop/trail", { body: {} });
    expect(trail.status).toBe(400);
    expect(trail.json).toEqual({ error: "{session, events}" });
    const guide = await call(s, "POST", "/api/d/shop/guide", { body: {} });
    expect(guide.status).toBe(400);
    const imp = await call(s, "POST", "/api/d/shop/import", { body: {} });
    expect(imp.status).toBe(400);
    expect((await call(s, "GET", "/api/d/shop/nothing")).status).toBe(404);

    const del = await call(s, "DELETE", "/api/d/shop");
    expect(del.status).toBe(200);
    expect(del.json).toEqual({ ok: true });
    expect((await call(s, "GET", "/api/d/shop")).status).toBe(404);
  });

  it("answers 404 for an unknown design and an unknown route", async () => {
    const d = await call(s, "GET", "/api/d/nope");
    expect(d.status).toBe(404);
    expect(d.json).toMatchObject({ error: 'no design "nope"', designs: expect.any(Array) });
    expect((await call(s, "GET", "/api/d/nope/state")).status).toBe(404);
    const bad = await call(s, "GET", "/api/d/%E0%A4%A");
    expect(bad.status).toBe(400);
    expect(bad.json).toEqual({ error: "bad design name in the URL" });
    const r = await call(s, "GET", "/api/nothing-here");
    expect(r.status).toBe(404);
    expect(r.json).toEqual({ error: "not found" });
  });

  it("serves icons, github state, telemetry and tokens routes", async () => {
    expect((await call(s, "GET", "/api/icons?q=git")).status).toBe(200);
    expect((await call(s, "GET", "/api/icon?tech=zzzznotatech")).status).toBe(404);
    const gh = await call(s, "GET", "/api/github");
    expect(gh.status).toBe(200);
    expect(gh.json).toMatchObject({ configured: false, slug: null, fixed: false });
    expect((await call(s, "GET", "/api/github/nothing")).status).toBe(404);
    expect((await call(s, "GET", "/api/telemetry")).status).toBe(200);
    expect((await call(s, "POST", "/api/telemetry/call", { body: {} })).status).toBe(400);
    expect((await call(s, "POST", "/api/telemetry/feedback", { body: {} })).status).toBe(400);
    expect((await call(s, "POST", "/api/report", { body: {} })).status).toBe(400);
    expect((await call(s, "GET", "/api/tokens")).json).toEqual({
      error: "no personal tokens here",
    });
    const flags = await call(s, "GET", "/api/flags");
    expect(flags.status).toBe(200);
    expect(flags.json).toMatchObject({ flags: [] });
    expect((await call(s, "GET", "/api/oauth/x")).status).toBe(404);
    expect((await call(s, "POST", "/api/signin", { body: {} })).status).toBe(404);
    const notJson = await call(s, "POST", "/api/signin", {
      headers: { "content-type": "text/plain" },
    });
    expect(notJson.status).toBe(415);
    expect(notJson.json).toEqual({ error: "send JSON" });
    expect((await call(s, "POST", "/api/signout", { body: {} })).json).toEqual({ ok: true });
  });

  it("refuses a cross-origin POST and a wrong Host", async () => {
    const x = await call(s, "POST", "/api/designs", {
      body: { name: "x" },
      headers: { origin: "http://evil.example" },
    });
    expect(x.status).toBe(403);
    expect(x.text).toBe("cross-origin request refused");
    const same = await call(s, "POST", "/api/designs", {
      body: { name: "Same" },
      headers: { origin: s.base },
    });
    expect(same.status).toBe(201);
    const getFrom = await call(s, "GET", "/api/config", { headers: { origin: "http://evil" } });
    expect(getFrom.status).toBe(200);
    const h = await call(s, "GET", "/api/config", { headers: { host: "evil.example" } });
    expect(h.status).toBe(403);
    expect(h.text).toBe("Archnemesis only answers on its own address");
  });

  it("reaches /mcp, 404s the OAuth documents, and serves the app", async () => {
    const mcp = await call(s, "GET", "/mcp");
    expect(mcp.status).toBe(405);
    const wk = await call(s, "GET", "/.well-known/oauth-authorization-server");
    expect(wk.status).toBe(404);
    expect(wk.json).toEqual({
      error: "not_found",
      error_description: "this Archnemesis has no sign-in: no need to Authenticate",
    });
    expect((await call(s, "GET", "/oauth/authorize")).status).toBe(404);
    const up = await call(s, "POST", "/upload/0123456789abcdef", { body: {} });
    expect(up.status).toBe(400);
    const home = await call(s, "GET", "/");
    expect(home.status).toBe(200);
    expect(home.headers["content-type"]).toContain("text/html");
  });
});

describe("tokens mode", () => {
  let s: Running;
  beforeAll(async () => {
    const dir = scratch();
    const file = join(dir, "tokens.json");
    writeFileSync(
      file,
      JSON.stringify([
        { token: ADMIN, id: "alex", name: "Alex", kind: "human", roles: ["admin"] },
        { token: EDITOR, id: "agent", name: "Agent", kind: "agent", roles: ["editor"] },
        { token: VIEWER, id: "viewer", name: "Viewer", kind: "human", roles: ["viewer"] },
      ]),
    );
    s = await start({ ARCHNM_AUTH: "tokens", ARCHNM_TOKENS: file }, dir);
    servers.push(s);
  }, 70_000);

  it("serves config without a token, but nothing else", async () => {
    const c = await call(s, "GET", "/api/config");
    expect(c.status).toBe(200);
    expect(c.json).toMatchObject({ auth: "tokens", localRepos: true });
    expect((c.json as { mcp: { note: string } }).mcp.note).toMatch(/agent token/);
    for (const path of ["/api/me", "/api/designs", "/api/flags", "/api/github", "/api/d/x"]) {
      const r = await call(s, "GET", path);
      expect(r.status, path).toBe(401);
      expect(r.json, path).toEqual({ error: "not signed in" });
    }
    const wrong = await call(s, "GET", "/api/me", { token: "wrong-token-0123456789" });
    expect(wrong.status).toBe(401);
  });

  it("knows who each token is", async () => {
    const me = await call(s, "GET", "/api/me", { token: ADMIN });
    expect(me.json).toMatchObject({ id: "alex", name: "Alex", kind: "human", roles: ["admin"] });
    const v = await call(s, "GET", "/api/me", { token: VIEWER });
    expect(v.json).toMatchObject({ id: "viewer", roles: ["viewer"] });
  });

  it("lets an editor make designs, a viewer read them but not edit", async () => {
    const made = await call(s, "POST", "/api/designs", {
      token: EDITOR,
      body: { name: "Shop", key: "shop" },
    });
    expect(made.status).toBe(201);
    expect(made.json).toMatchObject({ key: "shop" });
    const refused = await call(s, "POST", "/api/designs", {
      token: VIEWER,
      body: { name: "Nope" },
    });
    expect(refused.status).toBe(403);
    expect(refused.json).toEqual({ error: "you can read but not edit" });

    const list = await call(s, "GET", "/api/designs", { token: VIEWER });
    expect(list.status).toBe(200);
    expect((list.json as { key: string }[]).map((d) => d.key)).toEqual(["my-design", "shop"]);
    const info = await call(s, "GET", "/api/d/shop", { token: VIEWER });
    expect(info.json).toMatchObject({ canEdit: false, mine: false, owned: false });
    expect((await call(s, "GET", "/api/d/shop/state", { token: VIEWER })).status).toBe(200);
    expect((await call(s, "GET", "/api/d/shop/log", { token: VIEWER })).status).toBe(200);
    const files = await call(s, "GET", "/api/d/shop/files", { token: VIEWER });
    expect(files.json).toMatchObject({ dir: null });
    const adminFiles = await call(s, "GET", "/api/d/shop/files", { token: ADMIN });
    expect((adminFiles.json as { dir: string | null }).dir).toEqual(expect.any(String));

    const ops = { body: { ops: [], label: "nothing" } };
    const viewerOps = await call(s, "POST", "/api/d/shop/ops", { token: VIEWER, ...ops });
    expect(viewerOps.status).toBe(403);
    expect(viewerOps.json).toEqual({ error: "you can read but not edit" });
    const noToken = await call(s, "POST", "/api/d/shop/ops", ops);
    expect(noToken.status).toBe(401);
    const editorOps = await call(s, "POST", "/api/d/shop/ops", { token: EDITOR, ...ops });
    expect(editorOps.status).toBe(200);
    expect(editorOps.json).toEqual({ touched: [] });
    expect((await call(s, "POST", "/api/d/shop/import", { token: VIEWER, body: {} })).status).toBe(
      403,
    );
    expect((await call(s, "POST", "/api/d/shop/sync", { token: VIEWER, body: {} })).status).toBe(
      403,
    );
  });

  it("keeps sharing to the owner, deleting to the owner or an admin, telemetry to admins", async () => {
    const share = await call(s, "POST", "/api/d/shop/share", {
      token: VIEWER,
      body: { private: true },
    });
    expect(share.status).toBe(403);
    expect(share.json).toEqual({ error: "only its owner shares a design" });
    const del = await call(s, "DELETE", "/api/d/shop", { token: VIEWER });
    expect(del.status).toBe(403);
    expect((await call(s, "GET", "/api/telemetry", { token: EDITOR })).status).toBe(403);
    expect((await call(s, "GET", "/api/telemetry", { token: ADMIN })).status).toBe(200);
    expect((await call(s, "POST", "/api/telemetry/call", { token: EDITOR, body: {} })).status).toBe(
      400,
    );
    expect((await call(s, "POST", "/api/telemetry/call", { body: {} })).status).toBe(401);
    const gh = await call(s, "POST", "/api/github/setup", { token: EDITOR, body: {} });
    expect(gh.status).toBe(403);
    const admin = await call(s, "DELETE", "/api/d/shop", { token: ADMIN });
    expect(admin.status).toBe(200);
  });

  it("reaches /mcp only with a token, and has no OAuth", async () => {
    const without = await call(s, "POST", "/mcp", { body: {} });
    expect(without.status).toBe(401);
    const wk = await call(s, "GET", "/.well-known/oauth-authorization-server");
    expect(wk.status).toBe(404);
    expect((wk.json as { error: string }).error).toBe("not_found");
    expect((await call(s, "GET", "/api/nothing", { token: ADMIN })).status).toBe(404);
    const x = await call(s, "POST", "/api/designs", {
      token: ADMIN,
      body: { name: "x" },
      headers: { origin: "http://evil.example" },
    });
    expect(x.status).toBe(403);
  });
});
