// Personal tokens: how an agent (Claude Code, say, or a script) gets into an Archnemesis whose people sign in
// with a browser (gcip, iap, tailscale). Someone signed in makes one in the app; it acts as
// them, with whatever role the lists give them at the time it's used, so taking them off
// the lists takes effect at once. Only a hash is kept; the token is shown once. They run
// out after TTL_DAYS and can be revoked.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const PREFIX = "archnm_pat_";
/** Tokens issued before the rename start with this; they still work. */
const OLD_PREFIX = "atlas_pat_";
export const isPersonalToken = (t: string | null | undefined): t is string =>
  !!t && (t.startsWith(PREFIX) || t.startsWith(OLD_PREFIX));
const KEY = "pat:";
const TTL_DAYS = 180;

interface Saved {
  hash: string;
  /** The principal it acts as ("google:sam@…") and their login, for the role lists. */
  owner: string;
  login: string;
  label: string;
  created: string;
  used: string | null;
}

export interface TokenInfo {
  id: string;
  label: string;
  created: string;
  used: string | null;
  expires: string;
}

interface SettingsStore {
  setting(key: string): string | null;
  setSetting(key: string, value: string): void;
  deleteSetting(key: string): void;
  settings(prefix: string): { key: string; value: string }[];
}

const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");

export class PersonalTokens {
  private byHash = new Map<string, { id: string; saved: Saved }>();
  private store: SettingsStore;
  private now: () => number;

  constructor(store: SettingsStore, now: () => number = Date.now) {
    this.store = store;
    this.now = now;
    for (const { key, value } of store.settings(KEY)) {
      const saved = JSON.parse(value) as Saved;
      this.byHash.set(saved.hash, { id: key.slice(KEY.length), saved });
    }
  }

  /** A new token for `owner`; the token itself is only ever in this return value. */
  make(owner: string, login: string, label: string): { token: string; info: TokenInfo } {
    const id = randomBytes(6).toString("hex");
    const token = `${PREFIX}${randomBytes(32).toString("base64url")}`;
    const saved: Saved = {
      hash: hashOf(token),
      owner,
      login,
      label: label.trim().slice(0, 60) || "Agent",
      created: new Date(this.now()).toISOString(),
      used: null,
    };
    this.store.setSetting(KEY + id, JSON.stringify(saved));
    this.byHash.set(saved.hash, { id, saved });
    return { token, info: this.info(id, saved) };
  }

  /** Who a token acts as, or null (unknown, revoked or run out). */
  check(token: string | null | undefined): { owner: string; login: string } | null {
    if (!isPersonalToken(token)) return null;
    const h = hashOf(token);
    const hit = this.byHash.get(h);
    if (!hit || !timingSafeEqual(Buffer.from(hit.saved.hash), Buffer.from(h))) return null;
    if (this.now() > Date.parse(hit.saved.created) + TTL_DAYS * 86_400_000) return null;
    // When it was last used, to the hour (not a write per request).
    const hour = new Date(this.now()).toISOString().slice(0, 13);
    if (hit.saved.used?.slice(0, 13) !== hour) {
      hit.saved.used = new Date(this.now()).toISOString();
      this.store.setSetting(KEY + hit.id, JSON.stringify(hit.saved));
    }
    return { owner: hit.saved.owner, login: hit.saved.login };
  }

  /** Someone's own tokens. */
  list(owner: string): TokenInfo[] {
    return [...this.byHash.values()]
      .filter((t) => t.saved.owner === owner)
      .map((t) => this.info(t.id, t.saved))
      .sort((a, b) => b.created.localeCompare(a.created));
  }

  /** Revoke one of `owner`'s tokens; false if it isn't theirs. */
  revoke(owner: string, id: string): boolean {
    const hit = [...this.byHash.values()].find((t) => t.id === id && t.saved.owner === owner);
    if (!hit) return false;
    this.store.deleteSetting(KEY + id);
    this.byHash.delete(hit.saved.hash);
    return true;
  }

  private info(id: string, s: Saved): TokenInfo {
    return {
      id,
      label: s.label,
      created: s.created,
      used: s.used,
      expires: new Date(Date.parse(s.created) + TTL_DAYS * 86_400_000).toISOString(),
    };
  }
}
