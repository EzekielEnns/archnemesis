// Every setting the server and the CLI read from the environment, in one place.
//
// loadConfig() reads the environment once, checks it, and returns a typed Config; the rest of
// the server is handed what it needs from that object and never reads process.env itself (an
// eslint rule keeps it so). Every variable is described once, in config-reference.ts, and
// `archnm config` prints that: add a variable there, read it here, and it shows up.
//
// server/env-compat.ts runs before this (the old ATLAS_* names are copied to ARCHNM_*).
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { HeaderConfig } from "./auth/providers/header.ts";
import type { OidcConfig } from "./auth/providers/oidc.ts";
import type { BackupOptions } from "./backup.ts";
import type { ForgeKind } from "./forge.ts";
import { GROUPS, VARIABLES, type Name } from "./config-reference.ts";

type Env = Record<string, string | undefined>;

/** The reference, for `archnm config`. */
export function describeConfig(env: Env = process.env): string {
  const out: string[] = [];
  for (const [group, title] of Object.entries(GROUPS)) {
    out.push(`${group}: ${title}`);
    for (const v of VARIABLES.filter((x) => x.group === group)) {
      const set = env[v.name];
      const now = set === undefined ? "" : `  [set: ${"secret" in v ? "(hidden)" : set}]`;
      out.push(`  ${v.name}${now}`, `      ${v.doc}`, `      default: ${v.default}`);
    }
    out.push("");
  }
  return out.join("\n").trimEnd();
}

export interface Config {
  listen: {
    host: string;
    port: number;
    /** Only this machine can reach it. */
    loopback: boolean;
    /** Vite serves the source tree (never off loopback). */
    dev: boolean;
    /** The address people use, without a trailing path. */
    publicUrl: string;
    /** Origins a state-changing request may come from. */
    origins: Set<string>;
    /** Host headers the server answers to. */
    hosts: Set<string>;
    /** The name Claude Code knows this server by. */
    mcpName: string;
  };
  paths: {
    /** The checkout the server runs from (where dist/ and data/ are by default). */
    root: string;
    db: string;
    designsRoot: string;
    /** Where git clones and other state live: next to the database. */
    stateDir: string;
    sourceRoot: string | undefined;
  };
  auth: {
    /** ARCHNM_AUTH as written: a built-in's name, "gcip", or the path of a provider module. */
    mode: string;
    /** The built-in provider it names (server/auth/providers/), or null for a module. */
    builtin: BuiltinAuth | null;
    /** The provider module to load (a path, or the gcip example's), or null for a built-in. */
    module: string | null;
    /** What providers are told about the server's address. */
    publicUrl: string;
    loopback: boolean;
    /** The ARCHNM_* variables, for a custom provider's own settings (the gcip example's, ...). */
    env: Record<string, string>;
    /** header, tailscale, iap and cloudflare-access: what to read from the request. */
    header: HeaderConfig | null;
    oidc: OidcConfig | null;
    tokensFile: string | undefined;
    admins: string[];
    editors: string[];
    viewers: string[];
    /** ARCHNM_OPEN=yes */
    openToAll: boolean;
    /** ARCHNM_PUBLIC_LINKS=on: a share link to a public GitHub repo's design works without signing in. Off unless set. */
    publicLinks: boolean;
    /** ARCHNM_PROXIES: how many reverse proxies sit in front (whose X-Forwarded-For entries to believe). */
    proxies: number;
    localName: string;
    tokenKey: string | undefined;
  };
  git: {
    /** A new design starts in a repo of its own on this server. */
    newInGit: boolean;
    /** Repos on this server's own disk may be offered (the disk lasts). */
    localRepos: boolean;
    pollMs: number;
    idleMs: number;
    maxMs: number;
    /** A design may follow a repo given as a path on this machine. */
    localRemotes: boolean;
    /** Patterns of remotes editors may connect designs to. */
    remotes: string[];
    /** host -> kind, github.com and gitlab.com included. */
    forges: Map<string, ForgeKind>;
    /** The environment git runs with. */
    env: NodeJS.ProcessEnv;
    sshCommand: string;
  };
  github: {
    web: string;
    api: string;
    /** The host in `web`. */
    host: string;
    /** The app from the environment, when all of it is there. */
    envApp: {
      id: number;
      slug: string;
      clientId: string;
      clientSecret: string;
      privateKey: string | undefined;
      privateKeyFile: string | undefined;
    } | null;
    /** Anyone may install the app Archnemesis registers. */
    appPublic: boolean;
  };
  backups: BackupOptions | null;
  telemetry: { calls: boolean; dbPath: string };
  libstats: { enabled: boolean; githubToken: string | undefined };
  /** Experiments that are on, by name (lower case). */
  experiments: string[];
  limits: { maxDesigns: number; examples: boolean };
}

export interface ClientConfig {
  server: string | undefined;
  token: string | undefined;
  dir: string;
}

/** The folder of the checkout this runs from. */
const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** data/archnm.sqlite; an install from before the rename has data/atlas.sqlite, which is opened in place. */
export function defaultDbPath(root: string): string {
  const fresh = join(root, "data", "archnm.sqlite");
  const old = join(root, "data", "atlas.sqlite");
  return !existsSync(fresh) && existsSync(old) ? old : fresh;
}

class ConfigError extends Error {}

const list = (v?: string) =>
  (v ?? "")
    .split(/[\s,]+/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);

/** A number from a variable, or the default; the error names the variable. */
function num(env: Env, name: Name, fallback: number, what: string, min = 0): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min)
    throw new ConfigError(`${name} must be ${what}, not "${raw}"`);
  return n;
}

/**
 * A yes/no setting: 1, true, yes or on; 0, false, no or off, in any case. Unset or empty is the
 * default; anything else is an error that names the variable.
 */
function flag(env: Env, name: Name, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new ConfigError(
    `${name} must be yes or no (1/true/yes/on, 0/false/no/off), not "${env[name]}"`,
  );
}

function parseForges(raw: string): Map<string, ForgeKind> {
  const m = new Map<string, ForgeKind>([
    ["github.com", "github"],
    ["gitlab.com", "gitlab"],
  ]);
  for (const pair of raw.split(",")) {
    const [host, kind] = pair.split("=").map((s) => s.trim().toLowerCase());
    if (host && (kind === "github" || kind === "gitlab" || kind === "forgejo" || kind === "gitea"))
      m.set(host, kind === "gitea" ? "forgejo" : kind);
  }
  return m;
}

// ARCHNM_GCIP_PROJECT, ARCHNM_GCIP_API_KEY, ARCHNM_GCIP_TENANT and ARCHNM_GCIP_AUTH_DOMAIN are
// not read here: they belong to the gcip example provider (examples/auth/gcip/provider.js), which takes them from Config["auth"].env (naming them here keeps the reference and this file in step).

function listenOf(env: Env): Config["listen"] {
  const host = env.ARCHNM_HOST ?? "127.0.0.1";
  const port = num(env, "ARCHNM_PORT", 5190, "a port number");
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(host);
  const publicUrl = env.ARCHNM_PUBLIC_URL ?? `http://${loopback ? "127.0.0.1" : host}:${port}`;
  let url: URL;
  try {
    url = new URL(publicUrl);
  } catch {
    throw new ConfigError(
      `ARCHNM_PUBLIC_URL must be a URL like https://archnm.example.com, not "${publicUrl}"`,
    );
  }
  return {
    host,
    port,
    loopback,
    // The dev server (Vite) serves the source tree as it is: only ever on loopback.
    dev: env.NODE_ENV !== "production" && loopback,
    publicUrl,
    origins: new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, url.origin]),
    hosts: new Set([`127.0.0.1:${port}`, `localhost:${port}`, url.host]),
    mcpName: (env.ARCHNM_MCP_NAME ?? "archnm").replace(/[^a-zA-Z0-9_-]/g, "") || "archnm",
  };
}

const BUILTIN_AUTH = [
  "local",
  "tokens",
  "tailscale",
  "iap",
  "cloudflare-access",
  "header",
  "oidc",
  "github",
] as const;
type BuiltinAuth = (typeof BUILTIN_AUTH)[number];

/** The gcip example is what ARCHNM_AUTH=gcip has always meant. */
const GCIP_MODULE = join(ROOT, "examples", "auth", "gcip", "provider.js");

const looksLikePath = (v: string) =>
  /^(\.{1,2}\/|\/|[A-Za-z]:[\\/])/.test(v) || /\.(m?js|ts)$/.test(v);

/** A required setting, or an error that names it and what it is for. */
function need(env: Env, name: Name, why: string): string {
  const v = env[name]?.trim();
  if (!v) throw new ConfigError(`${name} is needed: ${why}`);
  return v;
}

const url = (env: Env, name: Name, why: string): string => {
  const v = need(env, name, why);
  try {
    new URL(v);
  } catch {
    throw new ConfigError(`${name} must be a URL, not "${v}"`);
  }
  return v;
};

/** The "what do I read from the request" for header, tailscale, iap and cloudflare-access. */
function headerOf(env: Env, mode: string, allowOpen: boolean): HeaderConfig | null {
  if (mode === "tailscale")
    return {
      id: "tailscale",
      idPrefix: "ts",
      jwt: null,
      plain: {
        loginHeader: "tailscale-user-login",
        nameHeader: "tailscale-user-name",
        refuseHeader: "tailscale-funnel-request",
        localName: env.ARCHNM_LOCAL_NAME ?? "desktop",
        allowOpen,
      },
    };
  if (mode === "iap") {
    const audience = env.ARCHNM_IAP_AUDIENCE ?? "";
    // e.g. /projects/123456789/global/backendServices/987654321 (load balancer), or
    // /projects/123456789/locations/us-central1/services/archnm (IAP on a managed service).
    if (
      !/^\/projects\/\d+\/(global\/backendServices\/\d+|locations\/[a-z0-9-]+\/services\/[a-z0-9-]+|apps\/[a-z0-9-]+)$/.test(
        audience,
      )
    )
      throw new ConfigError(
        "ARCHNM_AUTH=iap needs ARCHNM_IAP_AUDIENCE, this service's IAP audience, like /projects/<number>/global/backendServices/<id>",
      );
    return {
      id: "iap",
      idPrefix: "google",
      jwt: {
        header: "x-goog-iap-jwt-assertion",
        jwksUrl: "https://www.gstatic.com/iap/verify/public_key-jwk",
        issuer: "https://cloud.google.com/iap",
        audience,
        loginClaim: "email",
        nameClaim: null,
        loginPrefix: "accounts.google.com:",
      },
      plain: null,
    };
  }
  if (mode === "cloudflare-access") {
    // https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
    let team = need(
      env,
      "ARCHNM_CLOUDFLARE_TEAM",
      "ARCHNM_AUTH=cloudflare-access needs your Zero Trust team domain, like acme.cloudflareaccess.com",
    )
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "");
    if (!team.includes(".")) team = `${team}.cloudflareaccess.com`;
    return {
      id: "cloudflare-access",
      idPrefix: "cf",
      jwt: {
        header: "cf-access-jwt-assertion",
        jwksUrl: `https://${team}/cdn-cgi/access/certs`,
        issuer: `https://${team}`,
        audience: need(
          env,
          "ARCHNM_CLOUDFLARE_AUD",
          "ARCHNM_AUTH=cloudflare-access needs the application's Audience (AUD) tag",
        ),
        loginClaim: "email",
        nameClaim: "name",
        loginPrefix: "",
      },
      plain: null,
    };
  }
  if (mode !== "header") return null;
  const jwtHeader = env.ARCHNM_HEADER_JWT?.trim().toLowerCase();
  const loginHeader = env.ARCHNM_HEADER_LOGIN?.trim().toLowerCase();
  if (jwtHeader && loginHeader)
    throw new ConfigError("set ARCHNM_HEADER_JWT or ARCHNM_HEADER_LOGIN, not both");
  if (jwtHeader)
    return {
      id: "header",
      idPrefix: "header",
      jwt: {
        header: jwtHeader,
        jwksUrl: url(
          env,
          "ARCHNM_HEADER_JWKS_URL",
          "where the proxy publishes the keys its JWT is signed with",
        ),
        issuer: need(env, "ARCHNM_HEADER_ISSUER", "the `iss` the proxy's JWT carries"),
        audience: need(env, "ARCHNM_HEADER_AUDIENCE", "the `aud` the proxy's JWT carries"),
        loginClaim: env.ARCHNM_HEADER_LOGIN_CLAIM?.trim() || "email",
        nameClaim: env.ARCHNM_HEADER_NAME_CLAIM?.trim() || "name",
        loginPrefix: "",
      },
      plain: null,
    };
  if (!loginHeader)
    throw new ConfigError(
      "ARCHNM_AUTH=header needs ARCHNM_HEADER_JWT (a header carrying a signed JWT) or ARCHNM_HEADER_LOGIN (a header with the login, trusted: loopback only)",
    );
  return {
    id: "header",
    idPrefix: "header",
    jwt: null,
    plain: {
      loginHeader,
      nameHeader: env.ARCHNM_HEADER_DISPLAY_NAME?.trim().toLowerCase() || null,
      refuseHeader: null,
      localName: null,
      allowOpen,
    },
  };
}

function oidcOf(env: Env, mode: string): OidcConfig | null {
  if (mode !== "oidc") return null;
  const why = "ARCHNM_AUTH=oidc signs people in with an OpenID Connect provider";
  return {
    issuer: url(
      env,
      "ARCHNM_OIDC_ISSUER",
      `${why}: its issuer URL, like https://keycloak.example.com/realms/acme`,
    ),
    clientId: need(
      env,
      "ARCHNM_OIDC_CLIENT_ID",
      `${why}: the client id registered for Archnemesis`,
    ),
    clientSecret: need(env, "ARCHNM_OIDC_CLIENT_SECRET", `${why}: that client's secret`),
    scopes: env.ARCHNM_OIDC_SCOPES?.trim() || "openid email profile",
    label: env.ARCHNM_OIDC_LABEL?.trim() || "Sign in",
    loginClaim: env.ARCHNM_OIDC_LOGIN_CLAIM?.trim() || "email",
  };
}

function authOf(env: Env, listen: Config["listen"]): Config["auth"] {
  // Personal: one person on their own machine. It wins over an ARCHNM_AUTH the image set.
  const personal = flag(env, "ARCHNM_PERSONAL", false);
  const mode = personal ? "local" : (env.ARCHNM_AUTH ?? "local");
  const builtin = (BUILTIN_AUTH as readonly string[]).includes(mode) ? (mode as BuiltinAuth) : null;
  const module =
    mode === "gcip" ? GCIP_MODULE : !builtin && looksLikePath(mode) ? resolve(mode) : null;
  if (!builtin && !module)
    throw new ConfigError(
      `ARCHNM_AUTH must be local, tokens, tailscale, iap, cloudflare-access, header, oidc, github, gcip or the path of a provider module (./provider.js), not ${mode}`,
    );
  const allowOpen = personal || flag(env, "ARCHNM_ALLOW_OPEN", false);
  const header = headerOf(env, mode, allowOpen);
  // Trusting a plain header (or no one at all) is only safe where nothing but the proxy reaches the port.
  if ((mode === "local" || header?.plain) && !listen.loopback && !allowOpen)
    throw new ConfigError(
      `ARCHNM_AUTH=${mode} trusts whoever reaches the port, so it only listens on loopback. Use ARCHNM_AUTH=tokens to listen on ${listen.host}.`,
    );
  if (mode === "tokens" && !env.ARCHNM_TOKENS)
    throw new ConfigError(
      "ARCHNM_AUTH=tokens needs ARCHNM_TOKENS, a JSON file of { token, id, name, kind, roles }",
    );
  return {
    mode,
    builtin,
    module,
    publicUrl: listen.publicUrl,
    loopback: listen.loopback,
    env: Object.fromEntries(
      Object.entries(env).filter(
        (e): e is [string, string] => e[0].startsWith("ARCHNM_") && e[1] !== undefined,
      ),
    ),
    header,
    oidc: oidcOf(env, mode),
    tokensFile: env.ARCHNM_TOKENS,
    admins: list(env.ARCHNM_ADMINS),
    editors: list(env.ARCHNM_EDITORS ?? env.ARCHNM_TAILSCALE_USERS),
    viewers: list(env.ARCHNM_VIEWERS),
    openToAll: flag(env, "ARCHNM_OPEN", false),
    publicLinks: flag(env, "ARCHNM_PUBLIC_LINKS", false),
    proxies: num(env, "ARCHNM_PROXIES", 0, "a count of reverse proxies"),
    localName: env.ARCHNM_LOCAL_NAME ?? "desktop",
    tokenKey: env.ARCHNM_TOKEN_KEY,
  };
}

function githubOf(env: Env): Config["github"] {
  const web = (env.ARCHNM_GITHUB_URL ?? "https://github.com").replace(/\/$/, "");
  const api = (
    env.ARCHNM_GITHUB_API ??
    (web === "https://github.com" ? "https://api.github.com" : `${web}/api/v3`)
  ).replace(/\/$/, "");
  const complete =
    env.ARCHNM_GITHUB_APP_ID &&
    env.ARCHNM_GITHUB_CLIENT_ID &&
    env.ARCHNM_GITHUB_CLIENT_SECRET &&
    (env.ARCHNM_GITHUB_PRIVATE_KEY || env.ARCHNM_GITHUB_PRIVATE_KEY_FILE);
  return {
    web,
    api,
    host: new URL(web).host,
    envApp: complete
      ? {
          id: Number(env.ARCHNM_GITHUB_APP_ID),
          slug: env.ARCHNM_GITHUB_APP_SLUG ?? "",
          clientId: env.ARCHNM_GITHUB_CLIENT_ID!,
          clientSecret: env.ARCHNM_GITHUB_CLIENT_SECRET!,
          privateKey: env.ARCHNM_GITHUB_PRIVATE_KEY,
          privateKeyFile: env.ARCHNM_GITHUB_PRIVATE_KEY_FILE,
        }
      : null,
    appPublic: flag(env, "ARCHNM_GITHUB_APP_PUBLIC", true),
  };
}

function gitOf(env: Env): Config["git"] {
  return {
    newInGit: flag(env, "ARCHNM_NEW_IN_GIT", true),
    // A repo kept on Archnemesis's own disk, for trying git out. Not where the disk doesn't last
    // (Litestream keeps the database, not the repos): it would vanish at the next restart.
    localRepos: !env.ARCHNM_LITESTREAM_URL,
    pollMs: num(env, "ARCHNM_GIT_POLL_MS", 30_000, "milliseconds above 0", 1),
    idleMs: num(env, "ARCHNM_GIT_IDLE_MS", 60_000, "milliseconds above 0", 1),
    maxMs: num(env, "ARCHNM_GIT_MAX_MS", 10 * 60_000, "milliseconds above 0", 1),
    localRemotes: flag(env, "ARCHNM_GIT_LOCAL_REMOTES", false),
    remotes: (env.ARCHNM_GIT_REMOTES ?? "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean),
    forges: parseForges(env.ARCHNM_FORGES ?? ""),
    env: { ...env },
    sshCommand:
      env.GIT_SSH_COMMAND ??
      "ssh -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=4",
  };
}

function backupsOf(env: Env, db: string): BackupOptions | null {
  if (db === ":memory:") return null;
  const dir = env.ARCHNM_BACKUP_DIR ?? join(dirname(db), "backups");
  if (dir === "off") return null;
  const hours = num(env, "ARCHNM_BACKUP_HOURS", 6, "above 0", Number.MIN_VALUE);
  const keep = Math.floor(num(env, "ARCHNM_BACKUP_KEEP", 28, "at least 1", 1));
  return { dir, everyMs: hours * 3_600_000, keep };
}

/**
 * Read the environment once. Throws a ConfigError that names the variable when one is wrong,
 * so the server stops at start with a message, not later with a stack.
 */
export function loadConfig(env: Env = process.env): Config {
  const listen = listenOf(env);
  const db = env.ARCHNM_DB ?? defaultDbPath(ROOT);
  return {
    listen,
    paths: {
      root: ROOT,
      db,
      // Each design's files live in a folder of its own under this.
      designsRoot: env.ARCHNM_ROOT ?? join(ROOT, "data", "designs"),
      stateDir: db === ":memory:" ? join(ROOT, "data") : dirname(db),
      sourceRoot: env.ARCHNM_SOURCE_ROOT,
    },
    auth: authOf(env, listen),
    git: gitOf(env),
    github: githubOf(env),
    backups: backupsOf(env, db),
    telemetry: {
      calls: flag(env, "ARCHNM_TELEMETRY", true),
      dbPath:
        env.ARCHNM_TELEMETRY_DB ||
        (db === ":memory:" ? ":memory:" : join(dirname(db), "telemetry.sqlite")),
    },
    libstats: {
      enabled: flag(env, "ARCHNM_LIBSTATS", false),
      githubToken: env.ARCHNM_LIBSTATS_GITHUB_TOKEN || undefined,
    },
    experiments: (env.ARCHNM_EXPERIMENTS ?? "")
      .split(",")
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean),
    limits: {
      maxDesigns: num(env, "ARCHNM_MAX_DESIGNS", 100, "a number of designs, 1 or more", 1),
      examples: flag(env, "ARCHNM_EXAMPLES", true),
    },
  };
}

/** What the CLI needs to reach a server and to find a design folder. */
export function loadClientConfig(env: Env = process.env): ClientConfig {
  return {
    server: env.ARCHNM_SERVER,
    token: env.ARCHNM_TOKEN,
    dir: env.ARCHNM_DIR ?? "architecture",
  };
}
