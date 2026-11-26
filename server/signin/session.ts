// Archnemesis's own sign-in cookie, for providers where the browser signs in once (a button on
// the sign-in page) rather than carrying proof on every request. It holds who you are and when it runs out, signed (HMAC-SHA256) with a
// key made from ARCHNM_TOKEN_KEY, so a restart keeps everyone signed in. Without that key a
// random one is made at start, and a restart signs everyone out.
//
// It doesn't hold a role: roles come from ARCHNM_ADMINS/EDITORS/VIEWERS on every request,
// so taking someone off the lists takes effect at once.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const COOKIE = "archnm_session";
/** How long a sign-in lasts. */
const SESSION_S = 24 * 3600;

export interface Session {
  /** The person's Identity.id, and the provider that signed them in (a cookie from another provider is no use). */
  id: string;
  provider: string;
  login: string;
  name: string | null;
}

export class Sessions {
  private key: Buffer;
  private now: () => number;

  constructor(opts: { secret?: string; now?: () => number } = {}) {
    // The salt still says "atlas": it is a key-derivation constant, not a name.
    const own = opts.secret;
    this.key = own
      ? createHash("sha256").update(`atlas sessions:${own}`).digest()
      : randomBytes(32);
    this.now = opts.now ?? (() => Date.now() / 1000);
  }

  /** The cookie value for someone who just signed in. */
  make(s: Session): string {
    const body = Buffer.from(
      JSON.stringify({
        i: s.id,
        p: s.provider,
        e: s.login,
        n: s.name,
        x: Math.floor(this.now()) + SESSION_S,
      }),
    ).toString("base64url");
    return `${body}.${this.sign(body)}`;
  }

  /** Who a cookie value belongs to, or null if it's forged or has run out. */
  read(value: string | null | undefined): Session | null {
    if (!value) return null;
    const [body, sig] = value.split(".");
    if (!body || !sig) return null;
    const want = Buffer.from(this.sign(body));
    const got = Buffer.from(sig);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
    try {
      const c = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
        i?: string;
        p?: string;
        e?: string;
        n?: string | null;
        x?: number;
      };
      if (typeof c.x !== "number" || c.x < this.now()) return null;
      // A cookie from before providers (no id, no provider) is no sign-in: they sign in again.
      if (typeof c.e !== "string" || typeof c.i !== "string" || typeof c.p !== "string")
        return null;
      return { id: c.i, provider: c.p, login: c.e, name: c.n ?? null };
    } catch {
      return null;
    }
  }

  private sign(body: string): string {
    return createHmac("sha256", this.key).update(body).digest("base64url");
  }
}

/** One cookie's value from a Cookie header. */
export function cookie(header: string | string[] | undefined | null, name: string): string | null {
  const h = Array.isArray(header) ? header.join("; ") : header;
  if (!h) return null;
  for (const part of h.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Set-Cookie for a session (or, with null, to sign out). Secure when Archnemesis is on https. */
export function sessionCookie(value: string | null, secure: boolean): string {
  const attrs = ["Path=/", "HttpOnly", "SameSite=Lax", ...(secure ? ["Secure"] : [])];
  return value
    ? [`${COOKIE}=${value}`, `Max-Age=${SESSION_S}`, ...attrs].join("; ")
    : [`${COOKIE}=`, "Max-Age=0", ...attrs].join("; ");
}
