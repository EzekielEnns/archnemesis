import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeConfig, loadClientConfig, loadConfig } from "./config.ts";
import { VARIABLES } from "./config-reference.ts";

describe("the reference", () => {
  const names = (file: string) =>
    new Set(
      readFileSync(join(import.meta.dirname, file), "utf8").match(
        /\b(?:ARCHNM_[A-Z0-9_]+|GIT_SSH_COMMAND|NODE_ENV)\b/g,
      ),
    );

  it("describes every variable config.ts reads, and config.ts reads every one described", () => {
    const read = names("config.ts");
    const described = new Set<string>(VARIABLES.map((v) => v.name));
    // Names that only appear in an error message or comment still count as read: they must be described.
    expect([...read].filter((n) => !described.has(n))).toEqual([]);
    expect([...described].filter((n) => !read.has(n))).toEqual([]);
  });

  it("prints each once, and hides secrets", () => {
    const text = describeConfig({ ARCHNM_TOKEN_KEY: "s3cret", ARCHNM_PORT: "6000" });
    const lines = text.split("\n").map((l) => l.trim().split(/\s/)[0]);
    for (const v of VARIABLES) expect(lines.filter((l) => l === v.name)).toHaveLength(1);
    expect(text).not.toContain("s3cret");
    expect(text).toContain("[set: 6000]");
  });
});

describe("loadConfig", () => {
  it("has defaults for a local run", () => {
    const c = loadConfig({});
    expect(c.listen).toMatchObject({ host: "127.0.0.1", port: 5190, loopback: true, dev: true });
    expect(c.listen.publicUrl).toBe("http://127.0.0.1:5190");
    expect(c.listen.hosts.has("localhost:5190")).toBe(true);
    expect(c.auth.mode).toBe("local");
    expect(c.git).toMatchObject({ newInGit: true, localRepos: true, pollMs: 30_000 });
    expect(c.github).toMatchObject({ web: "https://github.com", api: "https://api.github.com" });
    expect(c.backups).toMatchObject({ everyMs: 6 * 3_600_000, keep: 28 });
    expect(c.limits).toEqual({ maxDesigns: 100, examples: true });
    expect(c.libstats.enabled).toBe(false);
  });

  it("derives the public address, origins and hosts", () => {
    const c = loadConfig({
      ARCHNM_HOST: "0.0.0.0",
      ARCHNM_PORT: "8080",
      ARCHNM_AUTH: "tokens",
      ARCHNM_TOKENS: "t.json",
      ARCHNM_PUBLIC_URL: "https://archnm.example.com",
      NODE_ENV: "production",
    });
    expect(c.listen).toMatchObject({ loopback: false, dev: false });
    expect(c.listen.origins.has("https://archnm.example.com")).toBe(true);
    expect(c.listen.hosts.has("archnm.example.com")).toBe(true);
    expect(
      loadConfig({ ARCHNM_HOST: "10.0.0.2", ARCHNM_AUTH: "tokens", ARCHNM_TOKENS: "x" }).listen
        .publicUrl,
    ).toBe("http://10.0.0.2:5190");
  });

  it("turns off what is off", () => {
    expect(loadConfig({ ARCHNM_BACKUP_DIR: "off" }).backups).toBeNull();
    expect(loadConfig({ ARCHNM_DB: ":memory:" }).backups).toBeNull();
    expect(loadConfig({ ARCHNM_LITESTREAM_URL: "gs://b/p" }).git.localRepos).toBe(false);
    expect(loadConfig({ ARCHNM_NEW_IN_GIT: "0" }).git.newInGit).toBe(false);
    expect(loadConfig({ ARCHNM_TELEMETRY: "off" }).telemetry.calls).toBe(false);
    expect(loadConfig({ ARCHNM_EXAMPLES: "off" }).limits.examples).toBe(false);
  });

  it("puts telemetry next to the database unless told", () => {
    expect(loadConfig({ ARCHNM_DB: "/d/a.sqlite" }).telemetry.dbPath).toBe("/d/telemetry.sqlite");
    expect(loadConfig({ ARCHNM_TELEMETRY_DB: "/x/t.sqlite" }).telemetry.dbPath).toBe("/x/t.sqlite");
  });

  it("names the variable in every error", () => {
    const bad: [Record<string, string>, RegExp][] = [
      [{ ARCHNM_AUTH: "magic" }, /ARCHNM_AUTH must be/],
      [{ ARCHNM_AUTH: "tokens" }, /ARCHNM_TOKENS/],
      [{ ARCHNM_HOST: "0.0.0.0" }, /ARCHNM_AUTH=local .* only listens on loopback/],
      [{ ARCHNM_PORT: "http" }, /ARCHNM_PORT must be/],
      [{ ARCHNM_PUBLIC_URL: "nope" }, /ARCHNM_PUBLIC_URL must be a URL/],
      [{ ARCHNM_GIT_POLL_MS: "0" }, /ARCHNM_GIT_POLL_MS must be/],
      [{ ARCHNM_BACKUP_HOURS: "0" }, /ARCHNM_BACKUP_HOURS must be/],
      [{ ARCHNM_BACKUP_KEEP: "0" }, /ARCHNM_BACKUP_KEEP must be/],
      [{ ARCHNM_MAX_DESIGNS: "-1" }, /ARCHNM_MAX_DESIGNS must be/],
      [{ ARCHNM_AUTH: "iap" }, /ARCHNM_IAP_AUDIENCE/],
      // (gcip's own settings are checked by the example provider: server/auth/gcip-example.test.ts)
      [{ ARCHNM_AUTH: "oidc" }, /ARCHNM_OIDC_ISSUER/],
      [{ ARCHNM_AUTH: "oidc", ARCHNM_OIDC_ISSUER: "x y" }, /ARCHNM_OIDC_ISSUER must be a URL/],
      [{ ARCHNM_AUTH: "cloudflare-access" }, /ARCHNM_CLOUDFLARE_TEAM/],
      [{ ARCHNM_AUTH: "header" }, /ARCHNM_HEADER_JWT/],
      [{ ARCHNM_AUTH: "header", ARCHNM_HEADER_JWT: "x" }, /ARCHNM_HEADER_JWKS_URL/],
      [{ ARCHNM_NEW_IN_GIT: "maybe" }, /ARCHNM_NEW_IN_GIT must be yes or no/],
    ];
    for (const [env, message] of bad)
      expect(() => loadConfig(env), JSON.stringify(env)).toThrow(message);
  });

  it("reads every yes/no setting the same way, in any case", () => {
    const yes = ["1", "true", "yes", "on", "YES", "On", "TRUE"];
    const no = ["0", "false", "no", "off", "NO", "Off", "FALSE"];
    const settings: [string, (c: ReturnType<typeof loadConfig>) => boolean, boolean][] = [
      ["ARCHNM_NEW_IN_GIT", (c) => c.git.newInGit, true],
      ["ARCHNM_GIT_LOCAL_REMOTES", (c) => c.git.localRemotes, false],
      ["ARCHNM_GITHUB_APP_PUBLIC", (c) => c.github.appPublic, true],
      ["ARCHNM_TELEMETRY", (c) => c.telemetry.calls, true],
      ["ARCHNM_LIBSTATS", (c) => c.libstats.enabled, false],
      ["ARCHNM_EXAMPLES", (c) => c.limits.examples, true],
      ["ARCHNM_OPEN", (c) => c.auth.openToAll, false],
    ];
    for (const [name, read, fallback] of settings) {
      expect(read(loadConfig({})), `${name} unset`).toBe(fallback);
      expect(read(loadConfig({ [name]: "" })), `${name} empty`).toBe(fallback);
      for (const v of yes) expect(read(loadConfig({ [name]: v })), `${name}=${v}`).toBe(true);
      for (const v of no) expect(read(loadConfig({ [name]: v })), `${name}=${v}`).toBe(false);
    }
    for (const v of yes)
      expect(() => loadConfig({ ARCHNM_HOST: "0.0.0.0", ARCHNM_ALLOW_OPEN: v })).not.toThrow();
    for (const v of no)
      expect(() => loadConfig({ ARCHNM_HOST: "0.0.0.0", ARCHNM_ALLOW_OPEN: v })).toThrow(
        /loopback/,
      );
  });

  it("reads ARCHNM_AUTH as a built-in, gcip, or a path to a provider", () => {
    expect(loadConfig({ ARCHNM_AUTH: "gcip" }).auth).toMatchObject({ builtin: null, mode: "gcip" });
    expect(loadConfig({ ARCHNM_AUTH: "gcip" }).auth.module).toMatch(
      /examples\/auth\/gcip\/provider\.js$/,
    );
    expect(loadConfig({ ARCHNM_AUTH: "/auth/provider.js" }).auth).toMatchObject({
      builtin: null,
      module: "/auth/provider.js",
    });
    expect(loadConfig({ ARCHNM_AUTH: "./p.js" }).auth.module).toMatch(/\/p\.js$/);
    expect(
      loadConfig({
        ARCHNM_AUTH: "oidc",
        ARCHNM_OIDC_ISSUER: "https://i.example",
        ARCHNM_OIDC_CLIENT_ID: "c",
        ARCHNM_OIDC_CLIENT_SECRET: "s",
      }).auth.oidc,
    ).toMatchObject({ scopes: "openid email profile", label: "Sign in", loginClaim: "email" });
    expect(
      loadConfig({
        ARCHNM_AUTH: "cloudflare-access",
        ARCHNM_CLOUDFLARE_TEAM: "acme",
        ARCHNM_CLOUDFLARE_AUD: "t",
      }).auth.header?.jwt,
    ).toMatchObject({
      header: "cf-access-jwt-assertion",
      jwksUrl: "https://acme.cloudflareaccess.com/cdn-cgi/access/certs",
      issuer: "https://acme.cloudflareaccess.com",
      audience: "t",
    });
  });

  it("keeps public links off unless the hoster turns them on", () => {
    expect(loadConfig({}).auth.publicLinks).toBe(false);
    expect(loadConfig({ ARCHNM_PUBLIC_LINKS: "on" }).auth.publicLinks).toBe(true);
    expect(loadConfig({ ARCHNM_PUBLIC_LINKS: "no" }).auth.publicLinks).toBe(false);
  });

  it("lets the open listen beyond loopback only when told", () => {
    expect(() => loadConfig({ ARCHNM_HOST: "0.0.0.0", ARCHNM_ALLOW_OPEN: "1" })).not.toThrow();
  });

  it("reads the GitHub App from the environment only when all of it is there", () => {
    // The id alone isn't an app: it must not make the app "fixed" (undisconnectable).
    expect(loadConfig({ ARCHNM_GITHUB_APP_ID: "7" }).github.envApp).toBeNull();
    const c = loadConfig({
      ARCHNM_GITHUB_APP_ID: "7",
      ARCHNM_GITHUB_CLIENT_ID: "c",
      ARCHNM_GITHUB_CLIENT_SECRET: "s",
      ARCHNM_GITHUB_PRIVATE_KEY: "pem",
      ARCHNM_GITHUB_URL: "https://git.corp/",
    });
    expect(c.github.envApp).toMatchObject({ id: 7, clientId: "c", privateKey: "pem" });
    expect(c.github).toMatchObject({ web: "https://git.corp", api: "https://git.corp/api/v3" });
  });

  it("reads the lists and the old editors name", () => {
    const c = loadConfig({
      ARCHNM_ADMINS: "A@x.com, @y.com",
      ARCHNM_TAILSCALE_USERS: "b@x.com",
    });
    expect(c.auth).toMatchObject({ admins: ["a@x.com", "@y.com"], editors: ["b@x.com"] });
  });
});

describe("loadClientConfig", () => {
  it("is what the CLI reads", () => {
    expect(loadClientConfig({})).toEqual({
      server: undefined,
      token: undefined,
      dir: "architecture",
    });
    expect(
      loadClientConfig({ ARCHNM_SERVER: "http://s", ARCHNM_TOKEN: "t", ARCHNM_DIR: "d" }),
    ).toEqual({
      server: "http://s",
      token: "t",
      dir: "d",
    });
  });
});
