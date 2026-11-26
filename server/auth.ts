// Who is asking, and may they? The one place in Archnemesis that decides what a request may do.
//
// Everything else (the API, live sync, the MCP) asks identify() for a Principal and
// authorize() whether it may act. WHO a request is from is the sign-in provider's job
// (server/auth/provider.ts: local, tokens, header, oidc, github, or one the hoster wrote); the
// rest is here, the same for every provider: the role lists (server/signin/roles.ts), the session
// cookie of someone who signed in with a browser, personal tokens, the static tokens file (it
// works beside every provider, for agents and scripts), and "an agent is at most an editor".
//
// The settings (ARCHNM_AUTH and what each provider reads) are listed by `archnm config`.
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import type { SignInPage } from "../shared/api.ts";
import { builtinProvider } from "./auth/builtin.ts";
import { Gate, identityProblem } from "./auth/gate.ts";
import { nameFromEmail } from "./auth/names.ts";
import {
  checkPage,
  type AuthProvider,
  type Identity,
  type ProviderCredentials,
} from "./auth/provider.ts";
import { isPersonalToken, type PersonalTokens } from "./signin/personal.ts";
import { COOKIE, cookie, Sessions } from "./signin/session.ts";
import { Roles } from "./signin/roles.ts";
import type { Config } from "./config.ts";

export type Role = "viewer" | "editor" | "admin";
export type Action = "read" | "edit" | "admin";

export interface Principal {
  id: string;
  name: string;
  kind: "human" | "agent";
  roles: Role[];
  /** An agent: the person it works for, whose open tabs it may steer (MCP point). "local:*" is anyone local. */
  for?: string;
  /** An agent's MCP session (short id): its own undo and its own name in history ("Agent · s-1a2b"). */
  session?: string;
}

interface TokenEntry extends Principal {
  token: string;
}

/** What identify() needs from a request, whatever carried it (HTTP, WebSocket, MCP). */
export interface Credentials {
  /** The bearer token: from `Authorization: Bearer`, or the sync connection's token. */
  token?: string | null;
  /** Hints for the local provider only (the person's chosen name, which client this is). */
  name?: string | null;
  agent?: boolean;
  /** The request's headers (a provider reads the identity a proxy adds). */
  headers?: Headers | Record<string, string | string[] | undefined>;
}

/** What a provider sees of a request. */
function credentialsOf(c: Credentials): ProviderCredentials {
  const h = c.headers;
  const header = (name: string): string | null => {
    if (!h) return null;
    const v = h instanceof Headers ? h.get(name) : h[name.toLowerCase()];
    const one = Array.isArray(v) ? v[0] : v;
    return one?.trim() || null;
  };
  return {
    token: c.token ?? null,
    header,
    cookie: (name) => cookie(header("cookie"), name),
    name: (c.name ?? "").trim() || null,
  };
}

export class Auth {
  readonly provider: AuthProvider;
  readonly roles: Roles;
  readonly sessions: Sessions;
  /** What providers are handed; the GitHub return route signs people in through it. */
  readonly gate: Gate;
  private readonly mode: string;
  private tokens: TokenEntry[] = [];
  private page: SignInPage;
  private warned = new Set<string>();

  constructor(
    cfg: Config["auth"],
    opts: { provider?: AuthProvider; roles?: Roles; sessions?: Sessions; gate?: Gate } = {},
  ) {
    this.mode = cfg.mode;
    this.roles = opts.roles ?? new Roles(cfg);
    this.sessions = opts.sessions ?? new Sessions({ secret: cfg.tokenKey });
    this.gate = opts.gate ?? new Gate(cfg, this.roles, this.sessions);
    this.provider = opts.provider ?? builtinProvider(cfg, this.gate.ctx);
    this.gate.providerId = this.provider.id;
    this.page = checkPage(this.provider.describe());
    // Anyone who can sign in to a public identity provider gets in: the lists are the gate.
    if (this.provider.openToInternet && this.roles.open() && !cfg.openToAll)
      throw new Error(
        `ARCHNM_AUTH=${cfg.mode} lets anyone who can sign in in: set ARCHNM_EDITORS and ARCHNM_VIEWERS (e.g. @yourcompany.com), or ARCHNM_OPEN=yes to allow everyone`,
      );
    if (cfg.mode === "tokens" && !cfg.tokensFile)
      throw new Error(
        "ARCHNM_AUTH=tokens needs ARCHNM_TOKENS, a JSON file of { token, id, name, kind, roles }",
      );
    if (cfg.tokensFile && this.provider.id !== "local") {
      this.tokens = (JSON.parse(readFileSync(cfg.tokensFile, "utf8")) as TokenEntry[]).map((t) => ({
        ...t,
        kind: t.kind ?? "human",
        roles: t.roles ?? ["editor"],
      }));
      if (this.tokens.some((t) => !t.token || t.token.length < 16))
        throw new Error("every token in ARCHNM_TOKENS needs 16+ characters");
    }
  }

  /** Anything to load before taking requests (keys, discovery). A failure stops the server. */
  async ready(): Promise<void> {
    await this.provider.ready?.();
    this.page = checkPage(this.provider.describe());
  }

  /** What the app's sign-in page shows. */
  signInPage(): SignInPage {
    return this.page;
  }

  /** For the startup line. */
  describe(): string {
    const id = this.provider.id;
    return id === "local" || id === "tokens"
      ? id
      : `${id} (${this.roles.describe()}${this.tokens.length ? `, ${this.tokens.length} token(s)` : ""})`;
  }

  /** Personal tokens (set by the server once its database is open), where people sign in with a browser. */
  personal: PersonalTokens | null = null;

  /** Whether people here can make personal tokens: they sign in as themselves some other way. */
  get personalTokens(): boolean {
    return this.provider.id !== "local" && this.provider.id !== "tokens";
  }

  /** Whether people here sign in with a browser (a button on the sign-in page): the MCP OAuth server and the session cookie apply. */
  get browserSignIn(): boolean {
    return this.page.kind === "buttons";
  }

  /** A name to use for someone who hasn't chosen one (their GitHub name, once they've signed in). */
  defaultName: (principalId: string) => string | null = () => null;

  /** The caller, or null if they aren't signed in. An agent is at most an editor, whoever it works for. */
  identify(c: Credentials): Principal | null {
    const p = this.who(c);
    return p && p.kind === "agent" && p.roles.includes("admin") ? { ...p, roles: ["editor"] } : p;
  }

  private who(c: Credentials): Principal | null {
    // A personal token acts as the person who made it, with their role now.
    if (isPersonalToken(c.token)) {
      const t = this.personalTokens ? this.personal?.check(c.token) : null;
      return t
        ? this.person(
            t.owner,
            t.login,
            this.defaultName(t.owner) ?? nameFromEmail(t.login),
            c.agent,
          )
        : null;
    }
    // A token, where there are any, is checked first: it's how an agent gets in when it
    // can't sign in the way people do.
    const byToken = this.byToken(c.token);
    if (byToken || this.mode === "tokens") return byToken;
    const creds = credentialsOf(c);
    // The browser's own sign-in cookie, where people sign in with a button.
    if (this.browserSignIn) {
      const s = this.sessions.read(creds.cookie(COOKIE));
      if (s && s.provider === this.provider.id)
        return this.person(s.id, s.login, s.name ?? nameFromEmail(s.login), c.agent);
    }
    const who = this.askProvider(creds);
    if (!who) return null;
    if (who.machine) return this.machine(who, c.agent);
    return this.person(who.id, who.login, who.name.trim() || nameFromEmail(who.login), c.agent);
  }

  /** The provider's answer, or null: whatever it does wrong (throws, answers nonsense) signs no one in. */
  private askProvider(creds: ProviderCredentials): Identity | null {
    try {
      const who = this.provider.identify(creds);
      if (!who) return null;
      const problem = identityProblem(who);
      if (!problem) return who;
      this.warnOnce(`the ${this.provider.id} provider returned a bad identity: ${problem}`);
    } catch (e) {
      this.warnOnce(
        `the ${this.provider.id} provider failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return null;
  }

  private warnOnce(message: string): void {
    if (this.warned.has(message)) return;
    this.warned.add(message);
    this.gate.ctx.log.warn(message);
  }

  /** The machine itself (local, or Tailscale with no tailnet user): its role, whatever the lists say. */
  private machine(who: Identity, agent?: boolean): Principal {
    const m = who.machine!;
    return agent
      ? { id: m.agent.id, name: "Agent", kind: "agent", roles: ["editor"], for: m.agent.for }
      : {
          id: who.id,
          name: who.name || this.defaultName(who.id) || "You",
          kind: "human",
          roles: [m.role],
        };
  }

  /** Someone signed in, with the roles the lists give them; none, no entry. */
  private person(id: string, login: string, name: string, agent?: boolean): Principal | null {
    const roles = this.roles.of(login);
    if (!roles.length) return null;
    // An agent acts for the person whose machine it runs on, under its own id and undo.
    return agent
      ? {
          id: `agent:${login}`,
          name: `Agent (${name.split(" ")[0]})`,
          kind: "agent",
          roles,
          for: id,
        }
      : { id, name, kind: "human", roles };
  }

  private byToken(token?: string | null): Principal | null {
    if (!token || !this.tokens.length) return null;
    const hit = this.tokens.find((t) => same(t.token, token));
    if (!hit) return null;
    const { token: _, ...principal } = hit;
    return principal;
  }

  authorize(p: Principal | null, action: Action): boolean {
    if (!p) return false;
    if (p.roles.includes("admin")) return true;
    if (action === "read") return p.roles.length > 0;
    if (action === "edit") return p.roles.includes("editor");
    return false;
  }
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function bearer(header: string | string[] | undefined): string | null {
  const v = Array.isArray(header) ? header[0] : header;
  const m = /^Bearer\s+(.+)$/i.exec(v ?? "");
  return m?.[1]?.trim() ?? null;
}
