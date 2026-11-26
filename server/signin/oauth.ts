// Sign in from an agent (Claude Code, or any MCP client) without copying a token: the MCP OAuth flow.
// The client finds Archnemesis's endpoints (the two /.well-known documents), registers itself
// (dynamic client registration), and opens the browser on /oauth/authorize. There the
// person signs in to Archnemesis the usual way and presses Allow; the client swaps the one-time
// code for a token (PKCE, S256 only).
//
// The token it gets is a personal token (personal.ts): it acts as that person, with their
// role at the time it's used, shows in their token list and can be revoked there. No
// refresh tokens: when it runs out, the client asks the person to sign in again.
//
// Codes and pending sign-ins live in memory for a few minutes (one Archnemesis process);
// registered clients are kept in the database, since a client registers once.
import { createHash, randomBytes } from "node:crypto";
import type { PersonalTokens } from "./personal.ts";

const CLIENT_KEY = "oauthclient:";
const PENDING_MS = 10 * 60_000;
const CODE_MS = 2 * 60_000;
const TTL_S = 180 * 86_400;

interface SettingsStore {
  setting(key: string): string | null;
  setSetting(key: string, value: string): void;
}

interface Client {
  name: string;
  redirectUris: string[];
  created: string;
}

interface Request {
  clientId: string;
  clientName: string;
  redirectUri: string;
  challenge: string;
  state: string | null;
  at: number;
}

interface Code {
  req: Request;
  owner: string;
  login: string;
  at: number;
}

export class OAuthError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** A redirect a client may use: https anywhere, or http on this machine (Claude Code's). */
function redirectOk(u: string): boolean {
  try {
    const url = new URL(u);
    if (url.hash) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

const s256 = (v: string) => createHash("sha256").update(v).digest("base64url");

export class OAuth {
  private pending = new Map<string, Request>();
  private codes = new Map<string, Code>();
  private store: SettingsStore;
  private tokens: PersonalTokens;
  private base: string;
  private now: () => number;

  constructor(
    store: SettingsStore,
    tokens: PersonalTokens,
    baseUrl: string,
    now: () => number = Date.now,
  ) {
    this.store = store;
    this.tokens = tokens;
    this.base = baseUrl.replace(/\/$/, "");
    this.now = now;
  }

  /** RFC 9728: what protects /mcp, and who signs people in for it. */
  resourceMetadata() {
    return {
      resource: `${this.base}/mcp`,
      authorization_servers: [this.base],
      bearer_methods_supported: ["header"],
      resource_name: "archnm",
    };
  }

  /** RFC 8414: Archnemesis's endpoints. */
  serverMetadata() {
    return {
      issuer: this.base,
      authorization_endpoint: `${this.base}/oauth/authorize`,
      token_endpoint: `${this.base}/oauth/token`,
      registration_endpoint: `${this.base}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    };
  }

  /** The WWW-Authenticate header on a 401 from /mcp: where to start. */
  challenge(): string {
    return `Bearer resource_metadata="${this.base}/.well-known/oauth-protected-resource"`;
  }

  /** RFC 7591: a public client (no secret) registers its redirect addresses. */
  register(b: Record<string, unknown>) {
    const uris = Array.isArray(b.redirect_uris)
      ? b.redirect_uris.filter((u): u is string => typeof u === "string")
      : [];
    if (!uris.length || uris.length > 5 || !uris.every(redirectOk))
      throw new OAuthError(
        "invalid_redirect_uri",
        "redirect_uris: 1 to 5 https addresses, or http on localhost",
      );
    const name =
      (typeof b.client_name === "string" ? b.client_name : "")
        .replace(/[\u0000-\u001f]/g, "")
        .trim()
        .slice(0, 60) || "An MCP client";
    const id = `archnm_client_${randomBytes(12).toString("base64url")}`;
    const client: Client = {
      name,
      redirectUris: uris,
      created: new Date(this.now()).toISOString(),
    };
    this.store.setSetting(CLIENT_KEY + id, JSON.stringify(client));
    return {
      client_id: id,
      client_name: name,
      redirect_uris: uris,
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      client_id_issued_at: Math.floor(this.now() / 1000),
    };
  }

  private client(id: string): Client | null {
    // atlas_client_ ids were registered before the rename.
    const v =
      id.startsWith("archnm_client_") || id.startsWith("atlas_client_")
        ? this.store.setting(CLIENT_KEY + id)
        : null;
    return v ? (JSON.parse(v) as Client) : null;
  }

  /**
   * GET /oauth/authorize. Before the client and its redirect check out, errors are shown
   * (never sent to an address nobody vouched for); after, they go back to the client.
   */
  begin(q: URLSearchParams): { pending: string } | { redirect: string } {
    const clientId = q.get("client_id") ?? "";
    const redirectUri = q.get("redirect_uri") ?? "";
    const client = this.client(clientId);
    if (!client)
      throw new OAuthError(
        "invalid_client",
        "this client isn't registered with Archnemesis: remove it from your agent and add it again",
      );
    if (!client.redirectUris.includes(redirectUri))
      throw new OAuthError("invalid_request", "redirect_uri isn't one the client registered");
    const back = (error: string, description: string) => ({
      redirect: this.withParams(redirectUri, {
        error,
        error_description: description,
        state: q.get("state"),
      }),
    });
    if (q.get("response_type") !== "code") return back("unsupported_response_type", "only code");
    const challenge = q.get("code_challenge") ?? "";
    if (q.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge))
      return back("invalid_request", "PKCE with S256 is required");
    const resource = q.get("resource");
    if (
      resource &&
      resource.replace(/\/$/, "") !== `${this.base}/mcp` &&
      resource.replace(/\/$/, "") !== this.base
    )
      return back("invalid_target", "that isn't this Archnemesis");
    this.sweep();
    const id = randomBytes(18).toString("base64url");
    this.pending.set(id, {
      clientId,
      clientName: client.name,
      redirectUri,
      challenge,
      state: q.get("state"),
      at: this.now(),
    });
    return { pending: id };
  }

  /** What the Allow page shows. */
  describe(id: string): { client: string; to: string } | null {
    const r = this.live(id);
    return r ? { client: r.clientName, to: new URL(r.redirectUri).host } : null;
  }

  /** The person pressed Allow (or Deny): where the browser goes next. */
  decide(id: string, allow: boolean, who: { owner: string; login: string }): string {
    const r = this.live(id);
    if (!r)
      throw new OAuthError(
        "invalid_request",
        "this sign-in ran out: start it again from your agent",
      );
    this.pending.delete(id);
    if (!allow)
      return this.withParams(r.redirectUri, {
        error: "access_denied",
        error_description: "the person said no",
        state: r.state,
      });
    const code = randomBytes(24).toString("base64url");
    this.codes.set(code, { req: r, owner: who.owner, login: who.login, at: this.now() });
    return this.withParams(r.redirectUri, { code, state: r.state, iss: this.base });
  }

  /** POST /oauth/token. */
  token(f: URLSearchParams) {
    if (f.get("grant_type") !== "authorization_code")
      throw new OAuthError("unsupported_grant_type", "only authorization_code");
    const code = f.get("code") ?? "";
    const c = this.codes.get(code);
    // One use, whatever happens next.
    this.codes.delete(code);
    if (!c || this.now() - c.at > CODE_MS)
      throw new OAuthError("invalid_grant", "that code is unknown, used or ran out");
    if (f.get("client_id") !== c.req.clientId)
      throw new OAuthError("invalid_grant", "the code was for another client");
    if (f.get("redirect_uri") !== c.req.redirectUri)
      throw new OAuthError("invalid_grant", "redirect_uri doesn't match");
    if (s256(f.get("code_verifier") ?? "") !== c.req.challenge)
      throw new OAuthError("invalid_grant", "code_verifier doesn't match");
    const { token } = this.tokens.make(c.owner, c.login, c.req.clientName);
    return { access_token: token, token_type: "Bearer", expires_in: TTL_S };
  }

  private live(id: string): Request | null {
    const r = this.pending.get(id);
    return r && this.now() - r.at < PENDING_MS ? r : null;
  }

  private sweep() {
    const t = this.now();
    for (const [k, r] of this.pending) if (t - r.at > PENDING_MS) this.pending.delete(k);
    for (const [k, c] of this.codes) if (t - c.at > CODE_MS) this.codes.delete(k);
  }

  private withParams(uri: string, params: Record<string, string | null>): string {
    const u = new URL(uri);
    for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
    return u.toString();
  }
}
