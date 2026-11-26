// The contract for a sign-in provider: what a hoster writes to put their own sign-in in front of
// Archnemesis. ARCHNM_AUTH names one of the built-in providers (server/auth/providers/), or is a
// path to an ES module that exports
//
//     export function createProvider(ctx /* ProviderContext */) { return { id, describe, identify, … } }
//
// (it may be async). examples/auth/ has working ones and a README.
//
// A provider answers one question: who is this request from? It does NOT decide what that person
// may do. Archnemesis does the rest, the same for every provider: the role lists (ARCHNM_ADMINS,
// ARCHNM_EDITORS, ARCHNM_VIEWERS) match Identity.login, the session cookie keeps a browser
// signed in, personal tokens and the static tokens file (ARCHNM_TOKENS) let agents and scripts
// in beside any provider, Claude Code signs in over MCP OAuth, and an agent is never more than
// an editor. A provider that fails, throws or returns something malformed signs nobody in.
//
// What a provider must keep to:
//  - identify() is synchronous: it also runs for WebSocket upgrades, on every request. Load keys
//    and the like in ready(), and say "no" (null) while they are not there.
//  - Never trust a header you did not verify. A header is only evidence of who someone is where
//    the network guarantees nothing else can set it (a proxy in front, on loopback), or when it
//    carries a signature you check.
//  - Redirect only to places on this server: ctx.sessions.signIn() and ctx.safeRedirect() give
//    you such addresses.
//  - Browser flows keep their own state (a random `state`, a nonce, a PKCE verifier), single
//    use, expiring, and tied to the browser that started them (a short-lived HttpOnly cookie).
import type http from "node:http";
import type { SignInPage } from "../../shared/api.ts";

export type { SignInPage };

/** Who a request is from. */
export interface Identity {
  /**
   * Stable and unique across providers: `<prefix>:<login>`, e.g. "google:sam@example.com" or
   * "github:octocat". It names the person's designs, personal tokens and presence. It must end
   * in `:` + login: anything else is refused.
   */
  id: string;
  /** What the role lists match: usually an email, or a username. Case does not matter. */
  login: string;
  /** What others see ("Sam Smith"). Empty: made from the login. */
  name: string;
  /**
   * Only for a provider that trusts the machine itself rather than a person (local; tailscale
   * for a request with no tailnet user): the one role it gets, whatever the lists say, and how
   * an agent running there is named. Never set it for a person who signed in.
   */
  machine?: { role: "viewer" | "editor" | "admin"; agent: { id: string; for: string } };
}

/** What identify() is given: whatever carried the request (HTTP, WebSocket, MCP). */
export interface ProviderCredentials {
  /** The bearer token: `Authorization: Bearer`, X-Archnm-Token, or the sync connection's token. */
  token: string | null;
  /** One request header, by name (any case), first value; null when absent or empty. */
  header(name: string): string | null;
  /** One cookie, by name. */
  cookie(name: string): string | null;
  /** The person's chosen name, which only the local provider uses. */
  name: string | null;
}

export interface AuthProvider {
  /** Lowercase letters, digits and dashes, starting with a letter. Its routes live at /auth/<id>/. */
  id: string;
  /** What the app's one sign-in page shows: nothing, a token field, or one button per way in. The page and its styling are the app's, never the provider's. */
  describe(): SignInPage;
  /** Who a request is from, or null. Must not throw, but if it does that means null. */
  identify(creds: ProviderCredentials): Identity | null;
  /**
   * Set when anyone on the internet could complete this provider's sign-in (a public identity
   * provider): Archnemesis then refuses to start with open role lists unless ARCHNM_OPEN=yes.
   */
  openToInternet?: boolean;
  /** Load keys, discover endpoints, check settings. Rejecting stops the server with the message. */
  ready?(): Promise<void>;
  /**
   * Anything under /auth/<id>/: redirect flows, callbacks, a page of your own for a vendor's
   * SDK. Return true when you answered. Errors are caught and answered with a 500.
   */
  routes?(req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<boolean>;
}

/** What a provider may ask of the core, and all it may. No hub, no database. */
export interface ProviderContext {
  /** The ARCHNM_* variables, for the provider's own settings (ARCHNM_OIDC_*, ARCHNM_GCIP_*, ...). */
  env: Readonly<Record<string, string | undefined>>;
  config: {
    /** The address people use, no trailing slash. */
    publicUrl: string;
    /** Archnemesis listens on this machine only. */
    loopback: boolean;
    /** Whether the address is https (cookies are then Secure). */
    secure: boolean;
  };
  sessions: {
    /**
     * Sign the person in: the role lists are checked here, and if they are on them the session
     * cookie is set on `res`. Returns where to send the browser (a URL on this server): the app,
     * back where they were going (`back`, the `?back=` the sign-in page added to your start URL),
     * or, when they are refused, the app's sign-in page with the reason. Send it as a 302, or
     * hand it to your own page.
     */
    signIn(
      res: http.ServerResponse,
      identity: Identity,
      back?: string | null,
    ): { ok: boolean; redirect: string; error?: string };
  };
  /** The app's sign-in page, showing `message`: where to send the browser when your flow failed. */
  failed(message: string): string;
  /** A URL on this server for a path (and #fragment) the browser asked to return to; the app's home for anything else. */
  safeRedirect(target: string | null | undefined): string;
  log: { info(message: string): void; warn(message: string): void };
  fetch: typeof fetch;
}

const ID = /^[a-z][a-z0-9-]*$/;

/** Whether a start URL is on this server: a path, never another site. */
export function isLocalPath(url: string): boolean {
  return url.startsWith("/") && !url.startsWith("//") && !url.includes("\\") && !/[\r\n]/.test(url);
}

/** The page a provider described, if it is valid. Throws what is wrong with it. */
export function checkPage(page: SignInPage): SignInPage {
  if (page.kind === "none") return { kind: "none" };
  if (page.kind === "token") return { kind: "token", hint: String(page.hint ?? "") };
  if (page.kind === "buttons" && Array.isArray(page.buttons) && page.buttons.length) {
    for (const b of page.buttons)
      if (
        typeof b.label !== "string" ||
        !b.label ||
        typeof b.start !== "string" ||
        !isLocalPath(b.start)
      )
        throw new Error(
          "a sign-in button needs a label and a start URL that is a path on this server",
        );
    return {
      kind: "buttons",
      buttons: page.buttons.map((b) => ({ label: b.label, start: b.start })),
    };
  }
  throw new Error(
    'describe() must return { kind: "none" }, { kind: "token", hint } or { kind: "buttons", buttons: [...] }',
  );
}

/** Throws what is wrong with a provider object (a custom module's export), else returns it. */
export function checkProvider(p: unknown, where: string): AuthProvider {
  const o = p as Partial<AuthProvider> | null;
  const bad = (why: string) => new Error(`${where}: ${why}`);
  if (!o || typeof o !== "object") throw bad("createProvider() must return an object");
  if (typeof o.id !== "string" || !ID.test(o.id))
    throw bad(
      "the provider's id must be lowercase letters, digits and dashes, starting with a letter",
    );
  for (const fn of ["describe", "identify"] as const)
    if (typeof o[fn] !== "function") throw bad(`the provider needs a ${fn}() function`);
  for (const fn of ["ready", "routes"] as const)
    if (o[fn] !== undefined && typeof o[fn] !== "function") throw bad(`${fn} must be a function`);
  try {
    checkPage(o.describe!());
  } catch (e) {
    throw bad(e instanceof Error ? e.message : String(e));
  }
  return o as AuthProvider;
}
