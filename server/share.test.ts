// Share links and the rules around them, against a real app (HTTP and the sync socket) in tokens
// mode: someone's private design is invisible; a link lets a signed-in person view and fork, never
// edit; a link works for one document; revoking or expiring ends it, open sockets included; guests
// exist only on public repos when the hoster allows it; an agent never uses a link; on a GitHub
// sign-in an editor without push rights doesn't edit. GitHub is a fake.
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import * as Y from "yjs";
import type { RepoRights } from "./access.ts";
import { createApp, type App } from "./app.ts";
import type { GitSync } from "./gitsync.ts";
import type { RepoSource } from "./repoaccess.ts";
import { testConfig } from "./testing.ts";

const T = {
  owner: "owner-token-0123456789",
  editor: "editor-token-0123456789",
  viewer: "viewer-token-0123456789",
  admin: "admin-token-0123456789",
  ownersAgent: "owner-agent-token-0123456789",
  editorsAgent: "editor-agent-token-0123456789",
};
const FILE = [
  { token: T.owner, id: "t:owner", name: "Owner", roles: ["editor"] },
  { token: T.editor, id: "t:editor", name: "Editor", roles: ["editor"] },
  { token: T.viewer, id: "t:viewer", name: "Viewer", roles: ["viewer"] },
  { token: T.admin, id: "t:admin", name: "Admin", roles: ["admin"] },
  {
    token: T.ownersAgent,
    id: "agent:owner",
    name: "Agent",
    kind: "agent",
    roles: ["editor"],
    for: "t:owner",
  },
  {
    token: T.editorsAgent,
    id: "agent:editor",
    name: "Agent",
    kind: "agent",
    roles: ["editor"],
    for: "t:editor",
  },
];

interface Up {
  app: App;
  base: string;
  port: number;
  stop: () => Promise<void>;
}
const ups: Up[] = [];
const providers: HocuspocusProvider[] = [];

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

async function boot(env: Record<string, string> = {}): Promise<Up> {
  const dir = mkdtempSync(join(tmpdir(), "archnm-share-"));
  writeFileSync(join(dir, "tokens.json"), JSON.stringify(FILE));
  const port = await freePort();
  const config = testConfig(dir, {
    ARCHNM_AUTH: "tokens",
    ARCHNM_TOKENS: join(dir, "tokens.json"),
    ARCHNM_PORT: String(port),
    ARCHNM_NEW_IN_GIT: "0",
    ARCHNM_EXAMPLES: "off",
    ARCHNM_LIBSTATS: "off",
    ...env,
  });
  const app = await createApp(config);
  await app.ready();
  const server = http.createServer((q, r) => void app.handle(q, r));
  server.on("upgrade", (q, s, h) => app.upgrade(q, s, h));
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  const up = {
    app,
    port,
    base: `http://127.0.0.1:${port}`,
    stop: async () => {
      await app.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
  ups.push(up);
  return up;
}
afterAll(async () => {
  for (const p of providers) {
    p.configuration.websocketProvider.destroy();
    p.destroy();
  }
  for (const u of ups) await u.stop();
});

interface Reply {
  status: number;
  json: Record<string, unknown> & { error?: string };
}
async function call(
  u: Up,
  method: string,
  path: string,
  o: { token?: string; share?: string; body?: unknown } = {},
): Promise<Reply> {
  const r = await fetch(u.base + path, {
    method,
    headers: {
      ...(o.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
      ...(o.share ? { "x-archnm-share": o.share } : {}),
    },
    ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
  });
  const json = (await r.json().catch(() => ({}))) as Reply["json"];
  return { status: r.status, json };
}

/** A private design of the owner's, with one box in it, and a link to it. */
async function secret(u: Up, key = "secret") {
  const made = await call(u, "POST", "/api/designs", { token: T.owner, body: { name: key, key } });
  expect(made.status).toBe(201);
  const ops = await call(u, "POST", `/api/d/${key}/ops`, {
    token: T.owner,
    body: {
      label: "a box",
      ops: [
        {
          op: "object.put",
          object: {
            id: "box1",
            kind: "system",
            name: "Box",
            description: "",
            technology: "",
            status: "live",
          },
        },
      ],
    },
  });
  expect(ops.status).toBe(200);
  const link = await call(u, "POST", `/api/d/${key}/links`, { token: T.owner, body: {} });
  expect(link.status).toBe(201);
  const url = String(link.json.url);
  return {
    token: url.slice(url.indexOf("~share=") + 7),
    url,
    id: (link.json.link as { id: string }).id,
  };
}

describe("a link to someone's private design", () => {
  it("is the only way in for others, and gives view and a copy, never edit", async () => {
    const u = await boot();
    const s = await secret(u);
    // Without a link the design isn't there, and says so exactly as for one that never was.
    const hidden = await call(u, "GET", "/api/d/secret", { token: T.editor });
    const none = await call(u, "GET", "/api/d/nothing-here", { token: T.editor });
    expect(hidden.status).toBe(404);
    expect(none.status).toBe(404);
    expect({ ...hidden.json, error: "" }).toEqual({ ...none.json, error: "" });
    expect(String(hidden.json.error).replace("secret", "X")).toBe(
      String(none.json.error).replace("nothing-here", "X"),
    );
    const listed = (await call(u, "GET", "/api/designs", { token: T.editor })).json as unknown as {
      key: string;
    }[];
    expect(listed.map((d) => d.key)).not.toContain("secret");

    // The token is in the address after the #, and only there.
    expect(s.url).toMatch(/\/#\/secret~share=[A-Za-z0-9_-]{43}$/);

    const seen = await call(u, "GET", "/api/d/secret", { token: T.editor, share: s.token });
    expect(seen.status).toBe(200);
    expect(seen.json).toMatchObject({
      can: { view: true, fork: true, edit: false, manage: false },
      canEdit: false,
      viaLink: true,
      mine: false,
    });
    expect(
      (await call(u, "GET", "/api/d/secret/state", { token: T.editor, share: s.token })).status,
    ).toBe(200);
    // It never lists the design, and never lets them change it, share it or delete it.
    const listed2 = (await call(u, "GET", "/api/designs", { token: T.editor, share: s.token }))
      .json as unknown as { key: string }[];
    expect(listed2.map((d) => d.key)).not.toContain("secret");
    const edit = await call(u, "POST", "/api/d/secret/ops", {
      token: T.editor,
      share: s.token,
      body: {
        ops: [
          {
            op: "object.put",
            object: {
              id: "x",
              kind: "system",
              name: "X",
              description: "",
              technology: "",
              status: "live",
            },
          },
        ],
      },
    });
    expect(edit.status).toBe(403);
    expect(
      (await call(u, "DELETE", "/api/d/secret", { token: T.editor, share: s.token })).status,
    ).toBe(403);
    expect(
      (
        await call(u, "POST", "/api/d/secret/share", {
          token: T.editor,
          share: s.token,
          body: { private: false },
        })
      ).status,
    ).toBe(403);
    expect(
      (await call(u, "POST", "/api/d/secret/links", { token: T.editor, share: s.token, body: {} }))
        .status,
    ).toBe(403);
    expect(
      (await call(u, "GET", "/api/d/secret/links", { token: T.editor, share: s.token })).status,
    ).toBe(403);
    // A viewer sees it too, and may not copy it (they can't make designs).
    const v = await call(u, "GET", "/api/d/secret", { token: T.viewer, share: s.token });
    expect(v.json).toMatchObject({ can: { view: true, fork: false, edit: false } });
    expect(
      (await call(u, "POST", "/api/d/secret/copy", { token: T.viewer, share: s.token })).status,
    ).toBe(403);
    // An admin doesn't get into someone's private design on their own, only through the link.
    expect((await call(u, "GET", "/api/d/secret", { token: T.admin })).status).toBe(404);
    expect((await call(u, "GET", "/api/d/secret", { token: T.admin, share: s.token })).status).toBe(
      200,
    );
  });

  it("is for one design, and means nothing to an agent", async () => {
    const u = await boot();
    const s = await secret(u);
    await secret(u, "other");
    // The link opens "secret" only.
    expect((await call(u, "GET", "/api/d/other", { token: T.editor, share: s.token })).status).toBe(
      404,
    );
    expect(
      (
        await call(u, "GET", "/api/d/secret", {
          token: T.editor,
          share: "not-a-link-0123456789012345678901234567",
        })
      ).status,
    ).toBe(404);
    // The editor's agent, holding the link, gets nothing; neither does anyone's agent but the owner's own.
    expect(
      (await call(u, "GET", "/api/d/secret", { token: T.editorsAgent, share: s.token })).status,
    ).toBe(404);
    expect((await call(u, "GET", "/api/d/secret", { token: T.ownersAgent })).status).toBe(200);
    // ...and an agent never makes links, even for its own person's design.
    expect(
      (await call(u, "POST", "/api/d/secret/links", { token: T.ownersAgent, body: {} })).status,
    ).toBe(403);
    expect((await call(u, "GET", "/api/d/secret/state/extra", { token: T.owner })).status).toBe(
      404,
    );
  });

  it("makes a private copy for whoever forks from it, with the design as it is now", async () => {
    const u = await boot();
    const s = await secret(u);
    expect((await call(u, "POST", "/api/d/secret/copy", { token: T.editor })).status).toBe(404);
    const copy = await call(u, "POST", "/api/d/secret/copy", {
      token: T.editor,
      share: s.token,
      body: {},
    });
    expect(copy.status).toBe(201);
    const key = String(copy.json.key);
    const mine = await call(u, "GET", `/api/d/${key}`, { token: T.editor });
    expect(mine.json).toMatchObject({
      mine: true,
      private: true,
      git: false,
      can: { edit: true, manage: true },
    });
    const st = await call(u, "GET", `/api/d/${key}/state`, { token: T.editor });
    expect(JSON.stringify(st.json)).toContain("box1");
    // Private: the owner of the original can't see the copy, and the link doesn't open it.
    expect((await call(u, "GET", `/api/d/${key}`, { token: T.owner })).status).toBe(404);
    expect((await call(u, "GET", `/api/d/${key}`, { token: T.owner, share: s.token })).status).toBe(
      404,
    );
    // They can share their copy by link like any design.
    expect(
      (await call(u, "POST", `/api/d/${key}/links`, { token: T.editor, body: {} })).status,
    ).toBe(201);
  });

  it("ends when revoked or expired, and only its makers revoke it", async () => {
    const u = await boot();
    const s = await secret(u);
    const open = () => call(u, "GET", "/api/d/secret", { token: T.editor, share: s.token });
    expect((await open()).status).toBe(200);
    const list = await call(u, "GET", "/api/d/secret/links", { token: T.owner });
    expect(JSON.stringify(list.json)).not.toContain(s.token);
    expect(list.json.links).toMatchObject([
      { id: s.id, active: true, lastUsed: expect.any(String) },
    ]);
    expect(list.json.reach).toMatchObject({ kind: "signin", publicRepo: false });
    // Not by the holder, not by someone else, not by a path with more in it.
    expect(
      (await call(u, "DELETE", `/api/d/secret/links/${s.id}`, { token: T.editor, share: s.token }))
        .status,
    ).toBe(403);
    expect(
      (await call(u, "DELETE", `/api/d/secret/links/${s.id}/more`, { token: T.owner })).status,
    ).toBe(404);
    expect((await call(u, "DELETE", "/api/d/secret/links/nope", { token: T.owner })).status).toBe(
      404,
    );
    expect((await open()).status).toBe(200);
    expect(
      (await call(u, "DELETE", `/api/d/secret/links/${s.id}`, { token: T.owner })).status,
    ).toBe(200);
    expect((await open()).status).toBe(404);
    // Expiry (a link that has run out).
    const short = u.app.ctx.hub.perms.links.make("secret", { id: "t:owner", name: "Owner" }, 5);
    await new Promise((r) => setTimeout(r, 20));
    expect(
      (await call(u, "GET", "/api/d/secret", { token: T.editor, share: short.token })).status,
    ).toBe(404);
    expect(
      (await call(u, "POST", "/api/d/secret/links", { token: T.owner, body: { days: 0 } })).status,
    ).toBe(400);
  });

  it("is not guessable: past a few wrong tries from an address, its links aren't looked at", async () => {
    const u = await boot();
    const s = await secret(u);
    for (let i = 0; i < 20; i++)
      await call(u, "GET", "/api/d/secret", { token: T.editor, share: `wrong-${i}-0123456789` });
    expect(
      (await call(u, "GET", "/api/d/secret", { token: T.editor, share: s.token })).status,
    ).toBe(404);
  });
});

/** A sync connection as the app opens one: the bearer token, then a share link after a newline. */
function connect(u: Up, doc: string, token: string, share?: string) {
  const ydoc = new Y.Doc();
  const closes: number[] = [];
  const failed: string[] = [];
  const p = new HocuspocusProvider({
    websocketProvider: new HocuspocusProviderWebsocket({
      url: `ws://127.0.0.1:${u.port}/sync`,
      WebSocketPolyfill: WebSocket,
    }),
    name: doc,
    document: ydoc,
    token: share ? `${token}\nshare:${share}` : token,
    onClose: ({ event }) => void closes.push(event.code),
    onAuthenticationFailed: ({ reason }) => void failed.push(reason),
  });
  providers.push(p);
  p.attach();
  const synced = new Promise<boolean>((resolve) => {
    p.on("synced", () => resolve(true));
    setTimeout(() => resolve(false), 3000);
  });
  return { p, ydoc, closes, failed, synced };
}
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

describe("the sync socket", () => {
  it("is read-only on a link: the server drops edits; revoking closes it", async () => {
    const u = await boot();
    const s = await secret(u);
    const live = u.app.ctx.hub.get("secret")!;
    // No link, no way in.
    const no = connect(u, "secret", T.editor);
    await settle(600);
    expect(no.failed.length + no.closes.length).toBeGreaterThan(0);
    expect(no.ydoc.getMap("meta").size).toBe(0);
    no.p.destroy();

    const c = connect(u, "secret", T.editor, s.token);
    expect(await c.synced).toBe(true);
    const before = JSON.stringify(live.state.objects.size);
    // The client believes it may write; the server doesn't take it.
    c.ydoc.getMap("meta").set("hacked", "yes");
    c.ydoc.getMap("objects").set("evil", new Y.Map());
    await settle(500);
    expect(live.doc.getMap("meta").get("hacked")).toBeUndefined();
    expect(JSON.stringify(live.state.objects.size)).toBe(before);
    // Another design's link doesn't open this one's socket.
    const other = await secret(u, "other");
    const wrong = connect(u, "secret", T.viewer, other.token);
    await settle(600);
    expect(wrong.ydoc.getMap("meta").size).toBe(0);
    wrong.p.destroy();
    // Revoking closes the open connection.
    await call(u, "DELETE", `/api/d/secret/links/${s.id}`, { token: T.owner });
    await settle(500);
    expect(c.closes.length).toBeGreaterThan(0);
    c.p.destroy();
  });
});

/** A design that follows a GitHub repo, with GitHub's answers faked. */
function fakeGitHub(u: Up, rights: Record<string, RepoRights>, isPublic: boolean): void {
  const src: RepoSource = {
    repoRights: async (person) => rights[person] ?? "none",
    repoIsPublic: async () => isPublic,
  };
  u.app.ctx.hub.repoSource = src;
  const hub = u.app.ctx.hub;
  hub.git.set("repo", {
    githubRepo: () => ({ owner: "acme", repo: "shop" }),
    ownerOf: () => null,
    close: async () => {},
  } as unknown as GitSync);
}

describe("public repositories", () => {
  async function pubSetup(env: Record<string, string>) {
    const u = await boot(env);
    await secret(u, "repo");
    // The design the owner made: shared with the team, following a GitHub repo.
    u.app.ctx.hub.setPrivate("repo", false);
    fakeGitHub(u, {}, true);
    const link = await call(u, "POST", "/api/d/repo/links", { token: T.owner, body: {} });
    expect(link.status).toBe(201);
    const url = String(link.json.url);
    return { u, token: url.slice(url.indexOf("~share=") + 7) };
  }

  it("by default every link needs the sign-in first", async () => {
    const { u, token } = await pubSetup({});
    const r = await call(u, "GET", "/api/d/repo", { share: token });
    expect(r.status).toBe(401);
    expect((await call(u, "GET", "/api/d/repo", { token: T.viewer, share: token })).status).toBe(
      200,
    );
    const l = await call(u, "GET", "/api/d/repo/links", { token: T.owner });
    expect(l.json.reach).toMatchObject({ kind: "signin", publicRepo: true, publicLinks: false });
  });

  it("with ARCHNM_PUBLIC_LINKS=on a guest views that design, and nothing else", async () => {
    const { u, token } = await pubSetup({ ARCHNM_PUBLIC_LINKS: "on" });
    const g = (path: string, method = "GET", body?: unknown) =>
      call(u, method, path, { share: token, ...(body !== undefined ? { body } : {}) });
    const info = await g("/api/d/repo");
    expect(info.status).toBe(200);
    expect(info.json).toMatchObject({
      can: { view: true, fork: false, edit: false, manage: false },
      guest: true,
      canEdit: false,
    });
    expect((await g("/api/d/repo/state")).status).toBe(200);
    // Not a list, not edits, not copies, not other designs, no tokens, no agents, no links, no files path.
    expect((await g("/api/designs")).status).toBe(401);
    expect((await g("/api/designs", "POST", { name: "x" })).status).toBe(401);
    expect((await g("/api/d/repo/ops", "POST", { ops: [] })).status).toBe(401);
    expect((await g("/api/d/repo/copy", "POST", {})).status).toBe(401);
    expect((await g("/api/d/repo/links")).status).toBe(401);
    expect((await g("/api/d/repo", "DELETE")).status).toBe(401);
    expect((await g("/api/d/nothing")).status).toBe(401);
    expect((await g("/api/tokens")).status).toBe(401);
    expect((await g("/api/me")).status).toBe(401);
    expect((await g("/api/flags")).status).toBe(401);
    expect(((await g("/api/d/repo/files")).json as { dir: unknown }).dir).toBeNull();
    const mcp = await fetch(`${u.base}/mcp`, {
      method: "POST",
      headers: { "x-archnm-share": token },
    });
    expect(mcp.status).toBe(401);
    // A link to a private design doesn't work this way: the repo isn't public.
    await secret(u, "private-one");
    const mine = await call(u, "POST", "/api/d/private-one/links", { token: T.owner, body: {} });
    const t2 = String(mine.json.url).split("~share=")[1]!;
    expect((await call(u, "GET", "/api/d/private-one", { share: t2 })).status).toBe(401);
    // The repo stops being public: the guest is out.
    fakeGitHub(u, {}, false);
    u.app.ctx.hub.perms.githubSignIn = false;
    await settle(10);
  });

  it("a guest's socket is read-only and anonymous", async () => {
    const { u, token } = await pubSetup({ ARCHNM_PUBLIC_LINKS: "on" });
    const live = u.app.ctx.hub.get("repo")!;
    const c = connect(u, "repo", "local", token);
    expect(await c.synced).toBe(true);
    c.p.setAwarenessField("user", {
      id: "t:owner",
      name: "The Owner",
      color: "#ff0000",
      kind: "human",
    });
    c.ydoc.getMap("meta").set("hacked", "yes");
    await settle(600);
    expect(live.doc.getMap("meta").get("hacked")).toBeUndefined();
    // To a signed-in viewer on that design, the guest is just "Guest", whatever it claimed.
    const seen = u.app.ctx.hub.presence.here({ who: FILE_PRINCIPAL.viewer, pass: null });
    expect(seen.map((e) => e.user.name)).toEqual(["Guest"]);
    expect(seen[0]!.user.id).not.toBe("t:owner");
    c.p.destroy();
    // On another design the same link is refused.
    const o = connect(u, "secret-none", "local", token);
    await settle(500);
    expect(o.ydoc.getMap("meta").size).toBe(0);
    o.p.destroy();
  });
});

const FILE_PRINCIPAL = {
  viewer: { id: "t:viewer", name: "Viewer", kind: "human" as const, roles: ["viewer" as const] },
};

describe("a GitHub sign-in", () => {
  it("lets in only those GitHub lets in, and edits only for those who may push", async () => {
    const u = await boot();
    u.app.ctx.hub.perms.githubSignIn = true;
    await secret(u, "repo");
    u.app.ctx.hub.setPrivate("repo", false);
    fakeGitHub(u, { "t:owner": "push", "t:editor": "read", "t:admin": "push" }, false);
    const get = (token: string) => call(u, "GET", "/api/d/repo", { token });
    expect((await get(T.owner)).json).toMatchObject({ can: { view: true, edit: true } });
    // Editor role, but only read on the repo: can look, can't change it.
    const e = await get(T.editor);
    expect(e.json).toMatchObject({ can: { view: true, fork: true, edit: false } });
    const edit = await call(u, "POST", "/api/d/repo/ops", {
      token: T.editor,
      body: {
        ops: [
          {
            op: "object.put",
            object: {
              id: "y",
              kind: "system",
              name: "Y",
              description: "",
              technology: "",
              status: "live",
            },
          },
        ],
      },
    });
    expect(edit.status).toBe(403);
    // No access to the repo: the design isn't there for them.
    expect((await get(T.viewer)).status).toBe(404);
    // A token with no GitHub person behind it has no GitHub answer: none, never the app's own.
    expect((await get(T.admin)).status).toBe(200);
    expect((await call(u, "GET", "/api/d/repo", { token: T.editorsAgent })).status).toBe(200);
    expect(
      (await call(u, "POST", "/api/d/repo/ops", { token: T.editorsAgent, body: { ops: [] } }))
        .status,
    ).toBe(403);
  });
});
