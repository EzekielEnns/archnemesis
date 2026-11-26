// Test support: a Config for a scratch folder, with nothing from the developer's own
// environment in it (only what git and node need to run).
import { join } from "node:path";
import type { Auth } from "./auth.ts";
import { createAuth } from "./auth/load.ts";
import { loadConfig, type Config } from "./config.ts";

/** A config whose database, designs and state live in `dir`; `env` adds to it. */
export function testConfig(dir: string, env: Record<string, string> = {}): Config {
  return loadConfig({
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    ARCHNM_DB: join(dir, "archnm.sqlite"),
    ARCHNM_ROOT: join(dir, "designs"),
    ARCHNM_BACKUP_DIR: "off",
    ...env,
  });
}

/** The auth settings for one mode, with the settings that mode insists on filled in. */
export function authConfig(mode: string, env: Record<string, string> = {}): Config["auth"] {
  return loadConfig({
    ARCHNM_AUTH: mode,
    ARCHNM_IAP_AUDIENCE: "/projects/123/global/backendServices/456",
    ARCHNM_GCIP_PROJECT: "test-project",
    ARCHNM_GCIP_API_KEY: "test-key",
    ...env,
  }).auth;
}

/** A started Auth for these settings (ARCHNM_AUTH among them), its providers' network calls answered by `fetchFn`. */
export async function startedAuth(
  env: Record<string, string>,
  fetchFn?: typeof fetch,
): Promise<Auth> {
  const auth = await createAuth(
    loadConfig({
      ARCHNM_IAP_AUDIENCE: "/projects/123/global/backendServices/456",
      ...env,
    }),
    { fetch: fetchFn },
  );
  await auth.ready();
  return auth;
}
