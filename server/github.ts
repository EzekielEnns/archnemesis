// Archnemesis as a GitHub App: the one place that talks to GitHub's API.
//
// Setting it up is one click. /api/github/setup hands the browser a manifest (GitHub's
// "app manifest" flow): GitHub shows a filled-in "create app" page, and when you confirm,
// sends Archnemesis a code that Archnemesis trades for the new app's id, keys and secrets. They're kept
// in Archnemesis's database, or come from the environment instead (ARCHNM_GITHUB_*), e.g. from a
// secret manager on a cloud host.
//
// What the app is used for:
//   git      clone, fetch and push over https with an installation token (no ssh keys),
//            on the repos the app is installed on
//   people   "Sign in with GitHub" gives Archnemesis a token to act as you, so Propose opens the
//            pull request as you; nothing is opened on your behalf without it
//   status   the pull request's state (open, approved, merged, closed) shown on the fork
//
// Permissions it asks for: contents (write), pull requests (write), metadata (read).
// No webhooks: Archnemesis polls, so it works behind a tailnet or a firewall.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createSign,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { readFileSync } from "node:fs";
import type { Config } from "./config.ts";
import type { DocStore } from "./store.ts";
import type { BranchChoice, PullState, RepoChoice } from "../shared/api.ts";

export class GitHubError extends Error {
  readonly status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.status = status;
  }
}

export interface AppCreds {
  id: number;
  slug: string;
  clientId: string;
  clientSecret: string;
  pem: string;
  owner?: string;
  htmlUrl?: string;
}

interface UserToken {
  login: string;
  /** Their name on GitHub, if they've set one. */
  name?: string | null;
  token: string;
  refresh: string | null;
  expiresAt: number | null;
}

/** owner/repo from a GitHub remote URL (any of its shapes), or null. */
export function repoOf(remote: string, githubHost: string): { owner: string; repo: string } | null {
  const m =
    /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(
      remote.trim(),
    );
  if (!m || m[1]!.toLowerCase() !== githubHost) return null;
  return { owner: m[2]!, repo: m[3]! };
}

const same = (a?: string | null, b?: string | null) =>
  !!a && !!b && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export class GitHub {
  private store: DocStore;
  private baseUrl: string;
  private installTokens = new Map<string, { token: string; expires: number }>();
  /** One-time states for the setup and sign-in round trips. */
  private states = new Map<
    string,
    { kind: "setup" | "login"; principal: string; back: string; at: number; binding?: string }
  >();

  /** GitHub's web address and API address (server/config.ts: Enterprise has its own). */
  private readonly web: string;
  private readonly api: string;

  private readonly cfg: Config["github"];
  /** ARCHNM_TOKEN_KEY: what keeps the stored user tokens encrypted. */
  private readonly tokenKey: string | undefined;

  constructor(
    store: DocStore,
    baseUrl: string,
    cfg: Config["github"],
    tokenKey: string | undefined,
  ) {
    this.cfg = cfg;
    this.tokenKey = tokenKey;
    this.store = store;
    this.baseUrl = baseUrl;
    this.web = cfg.web;
    this.api = cfg.api;
  }

  // --- the app's own credentials ----------------------------------------------------------

  /** From the environment if set there, else from the database (the setup flow). */
  creds(): AppCreds | null {
    const e = this.cfg.envApp;
    if (e) {
      return {
        id: e.id,
        slug: e.slug,
        clientId: e.clientId,
        clientSecret: e.clientSecret,
        pem: e.privateKey ?? readFileSync(e.privateKeyFile!, "utf8"),
      };
    }
    const saved = this.store.setting("github_app");
    return saved ? (JSON.parse(saved) as AppCreds) : null;
  }

  /**
   * Forget the GitHub App and everyone's GitHub sign-ins (the app was deleted, or set up
   * under the wrong owner), so it can be set up again. The app itself stays on GitHub
   * until someone deletes it there. Not for an app given in the environment.
   */
  disconnect(): void {
    if (this.cfg.envApp)
      throw new GitHubError(
        "this Archnemesis's GitHub App comes from its environment (ARCHNM_GITHUB_*): change it there",
      );
    this.store.deleteSetting("github_app");
    this.store.deleteSettings("github_user:");
    this.installTokens.clear();
    this.repoList = null;
    this.branchLists.clear();
    this.refreshing.clear();
    this.etags.clear();
  }

  get configured(): boolean {
    return !!this.creds();
  }

  installUrl(): string | null {
    const c = this.creds();
    return c?.slug ? `${this.web}/apps/${c.slug}/installations/new` : null;
  }

  /** A short-lived JWT that proves Archnemesis is the app (for app-level API calls). */
  private jwt(): string {
    const c = this.creds();
    if (!c) throw new GitHubError("no GitHub App set up");
    const now = Math.floor(Date.now() / 1000);
    const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(c.id) }));
    const sig = createSign("RSA-SHA256").update(`${head}.${claims}`).sign(c.pem);
    return `${head}.${claims}.${b64url(sig)}`;
  }

  // --- setup (the manifest flow) -----------------------------------------------------------

  private newState(
    kind: "setup" | "login",
    principal: string,
    back: string,
    binding?: string,
  ): string {
    const now = Date.now();
    for (const [k, v] of this.states) if (now - v.at > 3600_000) this.states.delete(k);
    const s = randomBytes(18).toString("base64url");
    this.states.set(s, { kind, principal, back, at: now, binding });
    return s;
  }

  private takeState(s: string | null, kind: "setup" | "login") {
    const v = s ? this.states.get(s) : undefined;
    if (!v || v.kind !== kind)
      throw new GitHubError("that link expired or wasn't for this Archnemesis; start again");
    this.states.delete(s!);
    return v;
  }

  /** What the browser posts to GitHub to create the app (to an org with `org`). */
  setup(
    principal: string,
    opts: { org?: string; back?: string },
  ): { action: string; manifest: string } {
    if (this.configured)
      throw new GitHubError("a GitHub App is already set up for this Archnemesis");
    const state = this.newState("setup", principal, opts.back ?? "/");
    // App names are unique across all of GitHub: the host plus a short random suffix.
    const host =
      new URL(this.baseUrl).hostname
        .split(".")[0]!
        .replace(/[^a-z0-9-]/gi, "")
        .slice(0, 16) || "self";
    const manifest = appManifest({
      name: `archnm-${host}-${randomBytes(2).toString("hex")}`,
      baseUrl: this.baseUrl,
      redirect: `${this.baseUrl}/api/github/setup/done`,
      public: this.cfg.appPublic,
    });
    const where = opts.org
      ? `${this.web}/organizations/${encodeURIComponent(opts.org)}/settings/apps/new`
      : `${this.web}/settings/apps/new`;
    return { action: `${where}?state=${state}`, manifest: JSON.stringify(manifest) };
  }

  /** GitHub sent us back with a code: trade it for the app's credentials and keep them. */
  async finishSetup(
    code: string,
    state: string | null,
  ): Promise<{ back: string; installUrl: string }> {
    const st = this.takeState(state, "setup");
    const r = await fetch(`${this.api}/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: "POST",
      headers: { accept: "application/vnd.github+json" },
    });
    if (!r.ok)
      throw new GitHubError(
        `GitHub didn't accept the setup (${r.status}): ${(await r.text()).slice(0, 200)}`,
        r.status,
      );
    const a = (await r.json()) as {
      id: number;
      slug: string;
      client_id: string;
      client_secret: string;
      pem: string;
      owner?: { login: string };
      html_url: string;
    };
    const creds: AppCreds = {
      id: a.id,
      slug: a.slug,
      clientId: a.client_id,
      clientSecret: a.client_secret,
      pem: a.pem,
      owner: a.owner?.login,
      htmlUrl: a.html_url,
    };
    this.store.setSetting("github_app", JSON.stringify(creds));
    return { back: st.back, installUrl: `${this.web}/apps/${a.slug}/installations/new` };
  }

  // --- the app on a repo -------------------------------------------------------------------

  /**
   * A token for git and the API on one repo, from the app's installation there. Null when
   * there's no app, or it isn't installed on that repo (then plain git is used).
   */
  async repoToken(owner: string, repo: string): Promise<string | null> {
    if (!this.configured) return null;
    const key = `${owner}/${repo}`.toLowerCase();
    const hit = this.installTokens.get(key);
    if (hit && hit.expires - Date.now() > 5 * 60_000) return hit.token;
    const jwt = this.jwt();
    const inst = await fetch(`${this.api}/repos/${owner}/${repo}/installation`, {
      headers: { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json" },
    });
    if (inst.status === 404) return null;
    if (!inst.ok)
      throw new GitHubError(`GitHub: ${inst.status} looking up the app on ${key}`, inst.status);
    const { id } = (await inst.json()) as { id: number };
    const tok = await fetch(`${this.api}/app/installations/${id}/access_tokens`, {
      method: "POST",
      headers: { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json" },
      body: JSON.stringify({ repositories: [repo] }),
    });
    if (!tok.ok)
      throw new GitHubError(`GitHub: ${tok.status} getting a token for ${key}`, tok.status);
    const t = (await tok.json()) as { token: string; expires_at: string };
    this.installTokens.set(key, { token: t.token, expires: Date.parse(t.expires_at) });
    return t.token;
  }

  /**
   * Every repo Archnemesis's app is installed on, across all the accounts and orgs that
   * installed it: what the connect form offers to pick from. Cached for a minute.
   */
  async repos(): Promise<RepoChoice[]> {
    if (!this.configured) return [];
    if (this.repoList && Date.now() - this.repoList.at < 60_000) return this.repoList.list;
    const jwt = this.jwt();
    const get = async <T>(path: string, token: string, method = "GET"): Promise<T> => {
      const r = await fetch(`${this.api}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
        },
      });
      if (!r.ok) throw new GitHubError(`GitHub: ${r.status} listing the app's repos`, r.status);
      return (await r.json()) as T;
    };
    const list: RepoChoice[] = [];
    for (const inst of await get<{ id: number }[]>("/app/installations?per_page=100", jwt)) {
      const { token } = await get<{ token: string }>(
        `/app/installations/${inst.id}/access_tokens`,
        jwt,
        "POST",
      );
      const r = await get<{
        repositories: { full_name: string; private: boolean; default_branch: string }[];
      }>("/installation/repositories?per_page=100", token);
      for (const repo of r.repositories)
        list.push({
          name: repo.full_name,
          url: `${this.web}/${repo.full_name}.git`,
          private: repo.private,
          branch: repo.default_branch,
        });
    }
    list.sort((a, b) => a.name.localeCompare(b.name));
    this.repoList = { at: Date.now(), list };
    return list;
  }
  private repoList: { at: number; list: RepoChoice[] } | null = null;

  /**
   * A repo's branches, each with the folders that hold an Archnemesis design ("" is the root):
   * what the connect form offers once a repo is picked. Cached for a minute.
   */
  async branches(fullName: string): Promise<BranchChoice[]> {
    const [owner, repo] = fullName.split("/");
    if (!owner || !repo || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo))
      throw new GitHubError(`"${fullName}" isn't owner/repo`);
    const key = `${owner}/${repo}`.toLowerCase();
    const hit = this.branchLists.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit.list;
    const token = await this.repoToken(owner, repo);
    if (!token)
      throw new GitHubError(
        `Archnemesis's GitHub App isn't on ${owner}/${repo}: Connect GitHub and add it`,
      );
    const get = async <T>(path: string): Promise<T> => {
      const r = await fetch(`${this.api}${path}`, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
        },
      });
      if (!r.ok) throw new GitHubError(`GitHub: ${r.status} reading ${owner}/${repo}`, r.status);
      return (await r.json()) as T;
    };
    const repoInfo = await get<{ default_branch: string }>(`/repos/${owner}/${repo}`);
    const all = await get<{ name: string; commit: { sha: string } }[]>(
      `/repos/${owner}/${repo}/branches?per_page=100`,
    );
    const list: BranchChoice[] = [];
    // The tree of each (up to 30 branches): where archnm.yaml files are.
    for (const b of all.slice(0, 30)) {
      const t = await get<{ tree: { path: string; type: string }[] }>(
        `/repos/${owner}/${repo}/git/trees/${b.commit.sha}?recursive=1`,
      );
      const designs = t.tree
        .filter(
          (e) => e.type === "blob" && /(^|\/)(archnm|atlas)\.yaml$/.test(e.path), // atlas.yaml is the old name
        )
        .map((e) => e.path.replace(/(^|\/)(archnm|atlas)\.yaml$/, "").replace(/\/$/, ""));
      list.push({ name: b.name, default: b.name === repoInfo.default_branch, designs });
    }
    // Branches with a design first, then the default one, then the rest by name.
    list.sort(
      (a, b) =>
        Number(!!b.designs.length) - Number(!!a.designs.length) ||
        Number(b.default) - Number(a.default) ||
        a.name.localeCompare(b.name),
    );
    this.branchLists.set(key, { at: Date.now(), list });
    return list;
  }
  private branchLists = new Map<string, { at: number; list: BranchChoice[] }>();

  /** git config (as environment) that sends the token to GitHub, never on the command line. */
  gitEnv(token: string): Record<string, string> {
    return {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `http.${this.web}/.extraheader`,
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
    };
  }

  httpsRemote(owner: string, repo: string): string {
    return `${this.web}/${owner}/${repo}.git`;
  }

  // --- people ----------------------------------------------------------------------------

  /** Where to send someone to sign in with GitHub; `back` is where they return to. */
  loginUrl(principal: string, back: string, binding?: string): string {
    const c = this.creds();
    if (!c) throw new GitHubError("no GitHub App set up for this Archnemesis yet");
    const state = this.newState("login", principal, back, binding);
    const redirect_uri = `${this.baseUrl}/api/github/callback`;
    return `${this.web}/login/oauth/authorize?${new URLSearchParams({ client_id: c.clientId, redirect_uri, state })}`;
  }

  /**
   * ARCHNM_AUTH=github: where to send someone who isn't signed in yet. Nobody is known, so the
   * state is tied to the browser instead: `binding` goes in a cookie that must come back with
   * the callback, so a link can't sign someone in as somebody else.
   */
  signInUrl(back: string): { url: string; binding: string } {
    const binding = randomBytes(18).toString("base64url");
    return { url: this.loginUrl("", back, binding), binding };
  }

  /**
   * GitHub sent the person back. For a sign-in (signInUrl) `signIn` is true, `binding` must be
   * the cookie the browser sent, and `principal` is who they are: "github:<login>".
   */
  async finishLogin(code: string, state: string | null, binding?: string | null) {
    const st = this.takeState(state, "login");
    const signIn = !st.principal;
    if (signIn && !same(st.binding, binding))
      throw new GitHubError("that sign-in wasn't started in this browser; start again");
    const t = await this.oauth({ code });
    const me = await this.call<{ login: string; name: string | null }>("GET", "/user", t.token);
    const principal = st.principal || `github:${me.login}`;
    this.saveUser(principal, { ...t, login: me.login, name: me.name });
    return { back: st.back, login: me.login, name: me.name, principal, signIn };
  }

  private async oauth(
    grant: { code: string } | { refresh_token: string },
  ): Promise<Omit<UserToken, "login">> {
    const c = this.creds()!;
    const r = await fetch(`${this.web}/login/oauth/access_token`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_id: c.clientId,
        client_secret: c.clientSecret,
        ...("code" in grant ? grant : { ...grant, grant_type: "refresh_token" }),
      }),
    });
    const j = (await r.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error_description?: string;
    };
    if (!j.access_token)
      throw new GitHubError(`GitHub sign-in failed: ${j.error_description ?? r.status}`);
    return {
      token: j.access_token,
      refresh: j.refresh_token ?? null,
      expiresAt: j.expires_in ? Date.now() + j.expires_in * 1000 : null,
    };
  }

  /** Someone's GitHub login, if they've signed in. */
  userLogin(principal: string): string | null {
    return this.loadUser(principal)?.login ?? null;
  }

  /** The name someone goes by on GitHub (else their login), if they've signed in here. */
  userName(principal: string): string | null {
    try {
      const raw = this.store.setting(`github_user:${principal}`);
      const u = raw ? (JSON.parse(raw) as { login?: string; name?: string | null }) : null;
      return (u?.name || u?.login || "").trim().slice(0, 40) || null;
    } catch {
      return null;
    }
  }

  signOut(principal: string): void {
    this.store.deleteSetting(`github_user:${principal}`);
  }

  /** A working token for someone (server/repoaccess.ts asks GitHub with it), refreshed if it has expired; null if they haven't signed in. */
  async userToken(principal: string): Promise<string | null> {
    const u = this.loadUser(principal);
    if (!u) return null;
    if (!u.expiresAt || u.expiresAt - Date.now() > 60_000) return u.token;
    if (!u.refresh) return (this.signOut(principal), null);
    // A refresh token works once: two calls at the same moment share one refresh.
    let p = this.refreshing.get(principal);
    if (!p) {
      p = (async () => {
        try {
          const t = await this.oauth({ refresh_token: u.refresh! });
          this.saveUser(principal, { ...t, login: u.login, name: u.name });
          return t.token;
        } catch (e) {
          // GitHub said no: they sign in again. A network blip keeps them signed in.
          if (e instanceof GitHubError) this.signOut(principal);
          return null;
        } finally {
          this.refreshing.delete(principal);
        }
      })();
      this.refreshing.set(principal, p);
    }
    return p;
  }
  private refreshing = new Map<string, Promise<string | null>>();

  // (The key salts below still say "atlas": changing them would sign everyone out of GitHub.)
  // Tokens are stored encrypted. The key comes from ARCHNM_TOKEN_KEY when it's set (from a
  // secret manager: then a copy of the database alone doesn't give the tokens away), else
  // from the app's client secret, which protects nothing if that's in the database too.
  // Changing it signs everyone out of GitHub (their tokens can't be read any more).
  private cipherKey(): Buffer {
    const own = this.tokenKey;
    return createHash("sha256")
      .update(
        own ? `atlas user tokens:key:${own}` : `atlas user tokens:${this.creds()!.clientSecret}`,
      )
      .digest();
  }

  private saveUser(principal: string, u: UserToken): void {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.cipherKey(), iv);
    const enc = Buffer.concat([c.update(JSON.stringify(u), "utf8"), c.final()]);
    this.store.setSetting(
      `github_user:${principal}`,
      JSON.stringify({
        login: u.login,
        name: u.name ?? null,
        box: Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64"),
      }),
    );
  }

  private loadUser(principal: string): UserToken | null {
    const raw = this.store.setting(`github_user:${principal}`);
    if (!raw || !this.configured) return null;
    try {
      const { box } = JSON.parse(raw) as { box: string };
      const b = Buffer.from(box, "base64");
      const d = createDecipheriv("aes-256-gcm", this.cipherKey(), b.subarray(0, 12));
      d.setAuthTag(b.subarray(12, 28));
      return JSON.parse(
        Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8"),
      ) as UserToken;
    } catch {
      return null;
    }
  }

  // --- pull requests -----------------------------------------------------------------------

  /** Until when GitHub asked Archnemesis to stop (rate limited); 0 when it hasn't. */
  private pausedUntil = 0;
  /** Last answer to each GET, by token and path: asked again with If-None-Match. */
  private etags = new Map<string, { etag: string; body: unknown }>();

  /**
   * One API call. Polite about limits: a GET sends the ETag of the last answer, and GitHub
   * doesn't count a "304 not modified" against the rate limit; when GitHub says the limit
   * is used up (or to slow down), every call waits out the time it gives.
   */
  async call<T>(method: string, path: string, token: string, body?: unknown): Promise<T> {
    if (Date.now() < this.pausedUntil)
      throw new GitHubError(
        `GitHub rate limit: Archnemesis waits until ${new Date(this.pausedUntil).toLocaleTimeString()}`,
        429,
      );
    const key = `${createHash("sha256").update(token).digest("hex").slice(0, 16)} ${path}`;
    const cached = method === "GET" ? this.etags.get(key) : undefined;
    const r = await fetch(`${this.api}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(cached ? { "if-none-match": cached.etag } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (r.status === 304 && cached) return cached.body as T;
    if (
      r.status === 429 ||
      (r.status === 403 &&
        (r.headers.get("x-ratelimit-remaining") === "0" || r.headers.get("retry-after")))
    ) {
      const after = Number(r.headers.get("retry-after"));
      const reset = Number(r.headers.get("x-ratelimit-reset"));
      this.pausedUntil =
        after > 0 ? Date.now() + after * 1000 : reset > 0 ? reset * 1000 : Date.now() + 60_000;
      console.warn(
        `archnm: GitHub rate limit; pausing calls until ${new Date(this.pausedUntil).toISOString()}`,
      );
      throw new GitHubError(
        `GitHub rate limit: Archnemesis waits until ${new Date(this.pausedUntil).toLocaleTimeString()}`,
        429,
      );
    }
    if (!r.ok) {
      const j = (await r.json().catch(() => ({}))) as {
        message?: string;
        errors?: { message?: string }[];
      };
      const why = [j.message, ...(j.errors ?? []).map((e) => e.message)].filter(Boolean).join(": ");
      throw new GitHubError(`GitHub ${r.status}: ${why || r.statusText}`, r.status);
    }
    const out = (await r.json()) as T;
    const etag = r.headers.get("etag");
    if (method === "GET" && etag) {
      if (this.etags.size > 500) this.etags.clear();
      this.etags.set(key, { etag, body: out });
    }
    return out;
  }

  /** Open a pull request as `principal` (or find the open one for that branch). */
  async openPull(
    principal: string,
    o: { owner: string; repo: string; head: string; base: string; title: string; body: string },
  ): Promise<PullState | null> {
    const token = await this.userToken(principal);
    if (!token) return null;
    const open = await this.call<{ number: number; html_url: string }[]>(
      "GET",
      `/repos/${o.owner}/${o.repo}/pulls?state=open&head=${encodeURIComponent(`${o.owner}:${o.head}`)}`,
      token,
    );
    const pr =
      open[0] ??
      (await this.call<{ number: number; html_url: string }>(
        "POST",
        `/repos/${o.owner}/${o.repo}/pulls`,
        token,
        { title: o.title, body: o.body, head: o.head, base: o.base },
      ));
    return { number: pr.number, url: pr.html_url, state: "open", review: null };
  }

  /** The latest commits that touched `path` on the default branch, with the app's token. */
  async commits(
    owner: string,
    repo: string,
    path: string,
    limit: number,
    token: string,
  ): Promise<
    { sha: string; name: string; login?: string; email: string; date: string; message: string }[]
  > {
    const list = await this.call<
      {
        sha: string;
        commit: { author: { name: string; email: string; date: string } | null; message: string };
        author: { login: string } | null;
      }[]
    >(
      "GET",
      `/repos/${owner}/${repo}/commits?path=${encodeURIComponent(path)}&per_page=${Math.min(100, limit)}`,
      token,
    );
    return list.map((c) => ({
      sha: c.sha,
      name: c.commit.author?.name ?? c.author?.login ?? "?",
      ...(c.author ? { login: c.author.login } : {}),
      email: c.commit.author?.email ?? "",
      date: c.commit.author?.date ?? "",
      message: c.commit.message,
    }));
  }

  /** Where a pull request stands, read with the app's token. */
  async pullState(owner: string, repo: string, number: number): Promise<PullState | null> {
    const token = await this.repoToken(owner, repo);
    if (!token) return null;
    const pr = await this.call<{
      html_url: string;
      state: string;
      merged: boolean;
      draft: boolean;
    }>("GET", `/repos/${owner}/${repo}/pulls/${number}`, token);
    const reviews = await this.call<{ user: { login: string } | null; state: string }[]>(
      "GET",
      `/repos/${owner}/${repo}/pulls/${number}/reviews?per_page=100`,
      token,
    );
    // Each reviewer's latest decision counts; one "changes requested" outweighs approvals.
    const last = new Map<string, string>();
    for (const r of reviews)
      if (
        r.user &&
        (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED" || r.state === "DISMISSED")
      )
        last.set(r.user.login, r.state);
    const decisions = [...last.values()];
    const review = decisions.includes("CHANGES_REQUESTED")
      ? "changes"
      : decisions.includes("APPROVED")
        ? "approved"
        : null;
    const state = pr.merged
      ? "merged"
      : pr.state === "closed"
        ? "closed"
        : pr.draft
          ? "draft"
          : "open";
    return { number, url: pr.html_url, state, review };
  }
}

/**
 * The GitHub App Archnemesis asks GitHub to create (the manifest flow), for `baseUrl`'s Archnemesis.
 * `redirect` is where GitHub sends the one-time code (Archnemesis itself, or scripts/github-app.ts).
 */
export function appManifest(o: {
  name: string;
  baseUrl: string;
  redirect: string;
  public: boolean;
}) {
  return {
    name: o.name,
    // Just the link on the app's page; GitHub wants a public-looking one.
    url: o.baseUrl.startsWith("https://") ? o.baseUrl : "https://github.com",
    description:
      "Architecture diagrams kept in git: Archnemesis pushes forks to branches and opens pull requests for review.",
    redirect_url: o.redirect,
    callback_urls: [`${o.baseUrl}/api/github/callback`],
    setup_url: `${o.baseUrl}/`,
    setup_on_update: false,
    // Public (the default): any account or org can install it, picking where on GitHub's
    // install page, like any other app. Private: only its owner can.
    public: o.public,
    request_oauth_on_install: false,
    // No webhook: GitHub refuses addresses it can't reach (a tailnet, localhost), and
    // Archnemesis polls instead.
    default_permissions: { contents: "write", pull_requests: "write", metadata: "read" },
  };
}
