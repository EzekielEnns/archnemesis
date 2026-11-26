// What the core hands every provider (ProviderContext, server/auth/provider.ts) and keeps for
// itself: signing a person in once a provider has said who they are. The role lists are checked
// here, so a provider cannot sign in someone they don't allow, and the cookie is the core's.
import type http from "node:http";
import type { Config } from "../config.ts";
import type { Roles } from "../signin/roles.ts";
import { sessionCookie, type Sessions } from "../signin/session.ts";
import { isLocalPath, type Identity, type ProviderContext } from "./provider.ts";

/** Whether a provider's answer is well formed; the reason when it is not. */
export function identityProblem(i: Identity): string | null {
  const text = (v: unknown) => typeof v === "string" && v.trim() !== "" && v.length <= 320;
  if (!i || typeof i !== "object") return "not an object";
  if (!text(i.id) || !text(i.login) || typeof i.name !== "string")
    return "id, login and name must be strings";
  if (!i.id.endsWith(`:${i.login}`))
    return `id must be "<prefix>:<login>" (got ${i.id} for ${i.login})`;
  return null;
}

export class Gate {
  readonly ctx: ProviderContext;
  /** Set once the provider exists: sessions made by another provider are no use. */
  providerId = "";
  private readonly base: string;
  private readonly roles: Roles;
  private readonly sessions: Sessions;

  constructor(
    cfg: Config["auth"],
    roles: Roles,
    sessions: Sessions,
    fetchFn: typeof fetch = fetch,
  ) {
    this.roles = roles;
    this.sessions = sessions;
    this.base = cfg.publicUrl.replace(/\/$/, "");
    const secure = this.base.startsWith("https://");
    this.ctx = {
      env: cfg.env,
      config: { publicUrl: this.base, loopback: cfg.loopback, secure },
      sessions: { signIn: (res, identity, back) => this.signIn(res, identity, back, secure) },
      failed: (message) => this.failed(message),
      safeRedirect: (target) => this.safeRedirect(target),
      log: {
        info: (m) => console.log(`archnm: ${m}`),
        warn: (m) => console.warn(`archnm: ${m}`),
      },
      fetch: fetchFn,
    };
  }

  safeRedirect(target: string | null | undefined): string {
    return `${this.base}${target && isLocalPath(target) ? target : "/"}`;
  }

  failed(message: string): string {
    return `${this.base}/#~signin-error=${encodeURIComponent(message.slice(0, 200))}`;
  }

  signIn(
    res: http.ServerResponse,
    identity: Identity,
    back: string | null | undefined,
    secure: boolean,
  ): { ok: boolean; redirect: string; error?: string } {
    const problem = identityProblem(identity);
    // A person never signs in as "the machine": that role is not one a browser flow may claim.
    if (problem || identity.machine) {
      const error = "that sign-in didn't check out; try again";
      this.ctx.log.warn(`refused a sign-in: ${problem ?? "machine identity"}`);
      return { ok: false, redirect: this.failed(error), error };
    }
    if (!this.roles.of(identity.login).length) {
      const error = `${identity.login} isn't allowed into this Archnemesis`;
      return { ok: false, redirect: this.failed(error), error };
    }
    res.appendHeader(
      "set-cookie",
      sessionCookie(
        this.sessions.make({
          id: identity.id,
          provider: this.providerId,
          login: identity.login,
          name: identity.name.trim().slice(0, 40) || null,
        }),
        secure,
      ),
    );
    return { ok: true, redirect: this.safeRedirect(back) };
  }
}
