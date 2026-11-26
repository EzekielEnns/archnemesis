// The backend that talks to the Node server: its HTTP API, and a live document over a
// WebSocket (Hocuspocus), cached in IndexedDB so a design opens at once and keeps working
// through a dropped connection.
import { HocuspocusProvider } from "@hocuspocus/provider";
import { IndexeddbPersistence } from "y-indexeddb";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";
import type { GitHubStatus, GitInfo, HereEntry, StateJson } from "../../shared/api.ts";
import type { WhatsNew } from "../../shared/whatsnew.ts";
import { linkPresence } from "../../shared/presence-link.ts";
import { forgetShare, shareTokenFor } from "../share";
import { NAME_KEY, setStored, stored, TOKEN_KEY, leavingForGitHub } from "../storage";
import {
  BackendError,
  type Backend,
  type DesignDoc,
  type DocConnection,
  type DocHandlers,
  type InstanceConfig,
  type Me,
  type OauthAsk,
  type TokenInfo,
  type VersionInfo,
} from "./types.ts";

/** The headers a request carries: the token (when there is one) and the name you chose. */
function authHeaders(): Record<string, string> {
  const token = stored(TOKEN_KEY);
  return {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    "x-archnm-name": stored(NAME_KEY) ?? "",
  };
}

/** A share link held for the design a call is about, and for nothing else. */
function shareHeader(path: string): Record<string, string> {
  const doc = /^\/api\/d\/([^/?]+)/.exec(path)?.[1];
  const token = doc ? shareTokenFor(decodeURIComponent(doc)) : null;
  return token ? { "x-archnm-share": token } : {};
}

interface Req {
  method?: string;
  body?: unknown;
  /** Send the token and name (most calls do; the cookie-only ones don't). */
  auth?: boolean;
  /** Mark the request as JSON (sent with a body, and by the calls that always did). */
  json?: boolean;
  signal?: AbortSignal;
  keepalive?: boolean;
}

/** Make a request; a network failure is a BackendError("offline"), never a bare TypeError. */
async function send(path: string, o: Req = {}): Promise<Response> {
  const headers: Record<string, string> = {
    ...(o.json || o.body !== undefined ? { "content-type": "application/json" } : {}),
    ...(o.auth ? authHeaders() : {}),
    ...shareHeader(path),
  };
  try {
    return await fetch(path, {
      method: o.method ?? "GET",
      headers,
      ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
      ...(o.signal ? { signal: o.signal } : {}),
      ...(o.keepalive ? { keepalive: true } : {}),
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new BackendError("offline", "couldn't reach the server");
  }
}

type Fallback = (status: number) => string;
const statusText: Fallback = (s) => `${s}`;

/** The refusal as an error: the server's own words, else `fallback`'s. */
async function refusal(res: Response, fallback: Fallback): Promise<BackendError> {
  const j = (await res.json().catch(() => ({}))) as { error?: string };
  const code = res.status === 401 ? "signin" : res.status === 404 ? "missing" : "refused";
  return new BackendError(code, j.error ?? fallback(res.status), res.status);
}

/** The JSON answer, or the refusal thrown. */
async function answer<T>(res: Response, fallback: Fallback = statusText): Promise<T> {
  if (!res.ok) throw await refusal(res, fallback);
  return (await res.json().catch(() => ({}))) as T;
}

const post = <T = unknown>(path: string, body: unknown = {}, fallback?: Fallback): Promise<T> =>
  send(path, { method: "POST", body, auth: true }).then((r) => answer<T>(r, fallback));

const docPath = (doc: string, sub = "") => `/api/d/${encodeURIComponent(doc)}${sub}`;

/** The live document: the cache, then the server, with presence linked to the connection. */
function openDocument(info: DesignDoc, ydoc: Y.Doc, h: DocHandlers): DocConnection {
  // The cache is keyed by the document's id, so a fresh server never sees stale data.
  const cache = new IndexeddbPersistence(`archnm-${info.doc}`, ydoc);
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const token = stored(TOKEN_KEY);
  // A share link rides in the sync connection's auth message (never its address), after the token.
  const share = shareTokenFor(info.key);
  let synced = false;
  const provider = new HocuspocusProvider({
    // The name you chose, if any (else the server uses your GitHub name, or "You").
    url: `${proto}//${location.host}/sync?name=${encodeURIComponent(stored(NAME_KEY) ?? "")}`,
    name: info.key,
    document: ydoc,
    token: `${token ?? "local"}${share ? `\nshare:${share}` : ""}`,
    onSynced: () => {
      synced = true;
      h.onStatus("live");
    },
    onStatus: ({ status }) => {
      if (status === "disconnected") h.onStatus("offline");
      else if (status === "connected" && synced) h.onStatus("live");
    },
    onAuthenticationFailed: () => {
      // A link that stopped working (revoked or run out) is let go, and the page opens again
      // without it; otherwise it's the sign-in token that no longer works.
      if (share) {
        forgetShare(info.key);
        location.reload();
        return;
      }
      setStored(TOKEN_KEY, null);
      h.onStatus("signin");
    },
    onStateless: ({ payload }) => {
      if (payload === "hb") return;
      try {
        const m = JSON.parse(payload) as { type?: string; to?: string; why?: string };
        if (m.type === "git") h.onEvent({ type: "git" });
        if (m.type === "moved" && m.to) h.onEvent({ type: "moved", to: m.to, why: m.why ?? "" });
        if (m.type === "deleted") h.onEvent({ type: "deleted", why: m.why ?? "" });
        if (m.type === "here")
          h.onEvent({ type: "here", people: (m as { people?: HereEntry[] }).people ?? [] });
      } catch {
        /* not ours */
      }
    },
  });
  const unlink = linkPresence(provider);
  return {
    awareness: provider.awareness as Awareness | null,
    close() {
      unlink();
      provider.destroy();
      void cache.destroy();
    },
  };
}

/** GitHub's manifest flow wants a form post from the browser. */
function postForm(action: string, manifest: string): void {
  const f = document.createElement("form");
  f.method = "post";
  f.action = action;
  const i = document.createElement("input");
  i.type = "hidden";
  i.name = "manifest";
  i.value = manifest;
  f.append(i);
  document.body.append(f);
  f.submit();
}

function gitApi(): NonNullable<Backend["git"]> {
  return {
    info: async (key) => {
      const res = await send(docPath(key, "/git"), { auth: true, json: true });
      if (!res.ok) throw await refusal(res, statusText);
      return (await res.json()) as GitInfo | null;
    },
    follow: (key, o) => post(docPath(key, "/git"), o),
    sync: (key) => post(docPath(key, "/sync")),
    fork: (key, name) => post(docPath(key, "/fork"), { name }),
    edit: (key, batches) => post(docPath(key, "/edit"), { batches }),
    saveNotes: async (doc, ops, label) => void (await post(docPath(doc, "/ops"), { ops, label })),
    merge: (doc) => post(docPath(doc, "/merge")),
    propose: (doc) => post(docPath(doc, "/propose")),
    discard: async (doc) => void (await post(docPath(doc, "/discard"))),
    whatsNew: async (doc) => {
      const res = await send(docPath(doc, "/new"), { auth: true });
      return res.ok ? ((await res.json()) as WhatsNew) : null;
    },
  };
}

function githubApi(): NonNullable<Backend["github"]> {
  return {
    status: async () => answer<GitHubStatus>(await send("/api/github", { auth: true })),
    repos: async () => answer(await send("/api/github/repos", { auth: true })),
    branches: async (repo) =>
      answer(
        await send(`/api/github/branches?repo=${encodeURIComponent(repo)}`, { auth: true }),
        (s) => `couldn't read ${repo} (${s})`,
      ),
    setup: async (org) => {
      const r = await post<{ action: string; manifest: string }>("/api/github/setup", {
        org,
        back: location.hash,
      });
      leavingForGitHub();
      postForm(r.action, r.manifest);
    },
    login: async () => {
      const r = await post<{ url: string }>("/api/github/login", { back: location.hash });
      location.assign(r.url);
    },
    logout: async () => void (await post("/api/github/logout")),
    disconnect: async () => void (await post("/api/github/disconnect")),
  };
}

function oauthApi(getConfig: () => Promise<InstanceConfig>): NonNullable<Backend["oauth"]> {
  const couldnt: Fallback = (s) => `Couldn't continue (${s}).`;
  return {
    read: async (id) => {
      const r = await send(`/api/oauth/${encodeURIComponent(id)}`);
      if (r.status === 401) return { kind: "signin", page: (await getConfig()).signin };
      return {
        kind: "ask",
        ...(await answer<Omit<Extract<OauthAsk, { kind: "ask" }>, "kind">>(r, couldnt)),
      };
    },
    decide: async (id, allow) => {
      const r = await send(`/api/oauth/${encodeURIComponent(id)}`, {
        method: "POST",
        json: true,
        body: { allow },
      });
      const j = await answer<{ redirect?: string }>(r, couldnt);
      if (!j.redirect) throw new BackendError("failed", couldnt(r.status), r.status);
      return j.redirect;
    },
  };
}

function designsApi(): Backend["designs"] {
  return {
    list: async () => answer(await send("/api/designs", { auth: true })),
    async info(doc) {
      const d = await answer<DesignDoc>(await send(docPath(doc), { auth: true }));
      return {
        key: d.key,
        name: d.name,
        doc: d.doc,
        mode: d.mode,
        git: d.git,
        canEdit: d.canEdit !== false,
        ...(d.can ? { can: d.can } : {}),
        ...(d.viaLink ? { viaLink: true } : {}),
        ...(d.guest ? { guest: true } : {}),
      };
    },
    async create(name, opts) {
      const from = opts?.example ? "example" : undefined;
      const b = await answer<{ key?: string }>(
        await send("/api/designs", { method: "POST", auth: true, body: { name, from } }),
        () => "couldn't create it",
      );
      if (!b.key) throw new BackendError("failed", "couldn't create it");
      // A server with ARCHNM_EXAMPLES=off makes an empty design instead: say so, and don't keep it.
      if (opts?.example) {
        const made = await answer<StateJson>(await send(docPath(b.key, "/state"), { auth: true }));
        if (!made.objects.length) {
          await send(docPath(b.key), { method: "DELETE", auth: true, json: true }).catch(
            () => null,
          );
          throw new BackendError("refused", "This server has the example turned off.");
        }
      }
      return { key: b.key };
    },
    remove: async (key) =>
      void (await answer(
        await send(docPath(key), { method: "DELETE", auth: true, json: true }),
        (s) => `that didn't work (${s})`,
      )),
    open: openDocument,
    state: async (doc) => answer<StateJson>(await send(docPath(doc, "/state"), { auth: true })),
    share: async (key, priv) =>
      void (await answer(
        await send(docPath(key, "/share"), { method: "POST", auth: true, body: { private: priv } }),
        (s) => `that didn't work (${s})`,
      )),
  };
}

function linksApi(): NonNullable<Backend["links"]> {
  const refused: Fallback = (s) => `that didn't work (${s})`;
  return {
    list: async (doc) => answer(await send(docPath(doc, "/links"), { auth: true }), refused),
    create: async (doc, days) => post(docPath(doc, "/links"), { days }, refused),
    revoke: async (doc, id) =>
      void (await answer(
        await send(docPath(doc, `/links/${encodeURIComponent(id)}`), {
          method: "DELETE",
          auth: true,
          json: true,
        }),
        refused,
      )),
    copy: (doc) => post(docPath(doc, "/copy"), {}, () => "couldn't make a copy"),
    holds: (doc) => shareTokenFor(doc) !== null,
  };
}

function versionsApi(): NonNullable<Backend["versions"]> {
  return {
    async list(key) {
      const r = await send(docPath(key, "/versions"), { auth: true });
      return r.ok ? ((await r.json()) as { versions: VersionInfo[] }).versions : [];
    },
    at: async (key, sha) =>
      answer<StateJson>(
        await send(docPath(key, `/at/${sha}`), { auth: true }),
        () => `couldn't read ${sha.slice(0, 7)}`,
      ),
  };
}

function tokensApi(): NonNullable<Backend["tokens"]> {
  return {
    list: async () => {
      const r = await send("/api/tokens");
      return r.ok ? ((await r.json()) as TokenInfo[]) : [];
    },
    create: async (label) =>
      (
        await answer<{ token: string }>(
          await send("/api/tokens", { method: "POST", body: { label } }),
          () => "Couldn't make a token.",
        )
      ).token,
    revoke: async (id) =>
      void (await send(`/api/tokens/${encodeURIComponent(id)}`, { method: "DELETE" })),
  };
}

function iconsApi(): Backend["icons"] {
  const url = (technology: string) =>
    `/api/icon?tech=${encodeURIComponent(technology)}&color=brand&v=3`;
  return {
    async search(q, signal) {
      const r = await send(`/api/icons?q=${encodeURIComponent(q.trim())}`, { signal });
      return r.ok ? ((await r.json()) as { title: string }[]).map((x) => x.title) : [];
    },
    async svg(technology) {
      const r = await send(url(technology));
      return r.ok ? r.text() : null;
    },
    url,
  };
}

/** What goes back to the server about this page: reports, the call log, the trail, guided steps. */
function pageApis(): Pick<Backend, "report" | "telemetry" | "trail" | "guide" | "insights"> {
  return {
    report: {
      async send(r) {
        const b = await answer<{ id?: number }>(
          await send("/api/report", { method: "POST", auth: true, body: r }),
          (s) => `the server answered ${s}`,
        );
        if (typeof b.id !== "number")
          throw new BackendError("failed", "the server answered without an id");
        return b.id;
      },
    },
    telemetry: {
      call(body) {
        void send("/api/telemetry/call", { method: "POST", auth: true, body }).catch(() => null);
      },
      async feedback(body) {
        const r = await send("/api/telemetry/feedback", {
          method: "POST",
          auth: true,
          body,
        }).catch(() => null);
        return r?.ok ? ((await r.json()) as { id?: number }).id : undefined;
      },
    },
    trail: {
      send(doc, session, events, keepalive) {
        void send(docPath(doc, "/trail"), {
          method: "POST",
          auth: true,
          body: { session, events },
          keepalive,
        }).catch(() => {});
      },
    },
    guide: { reply: async (doc, r) => void (await post(docPath(doc, "/guide"), r)) },
    insights: {
      touched: async (doc, id) =>
        answer(
          await send(docPath(doc, `/touched/${encodeURIComponent(id)}`), { auth: true }),
          (s) => `couldn't read it (${s})`,
        ),
      libstats: async (doc) => answer(await send(docPath(doc, "/libstats"), { auth: true })),
    },
  };
}

export function createServerBackend(): Backend {
  let cached: InstanceConfig | null = null;
  const config = async (): Promise<InstanceConfig> => {
    const j = await answer<{
      auth: InstanceConfig["auth"];
      mcp?: InstanceConfig["mcp"];
      localRepos?: boolean;
      signin?: InstanceConfig["signin"];
    }>(await send("/api/config"));
    cached = {
      auth: j.auth,
      mcp: j.mcp ?? null,
      localRepos: j.localRepos ?? true,
      signin: j.signin ?? { kind: "none" },
    };
    return cached;
  };

  return {
    config,
    async me(): Promise<Me> {
      if (cached?.signin.kind === "token" && !stored(TOKEN_KEY))
        throw new BackendError("signin", "sign in");
      const res = await send("/api/me", { auth: true });
      if (res.status === 401) {
        setStored(TOKEN_KEY, null);
        throw new BackendError("signin", "sign in", 401);
      }
      const me = await answer<Me & { roles?: string[] }>(res);
      return { id: me.id, name: me.name, kind: me.kind, admin: !!me.roles?.includes("admin") };
    },
    designs: designsApi(),
    links: linksApi(),
    versions: versionsApi(),
    git: gitApi(),
    github: githubApi(),
    tokens: tokensApi(),
    signIn: {
      withToken(token) {
        setStored(TOKEN_KEY, token.trim());
        location.reload();
      },
      start(url) {
        // A path on this server, never another site; it brings the browser back to where it is now.
        if (!url.startsWith("/") || url.startsWith("//")) return;
        const back = encodeURIComponent(location.pathname + location.hash);
        location.assign(`${url}${url.includes("?") ? "&" : "?"}back=${back}`);
      },
      async signOut() {
        setStored(TOKEN_KEY, null);
        if (cached?.signin.kind === "buttons")
          await send("/api/signout", { method: "POST" }).catch(() => {});
        location.reload();
      },
    },
    oauth: oauthApi(() => (cached ? Promise.resolve(cached) : config())),
    icons: iconsApi(),
    ...pageApis(),
  };
}
