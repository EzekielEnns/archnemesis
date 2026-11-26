// Building the server's Auth from its config: a built-in provider, or a module the hoster wrote
// (ARCHNM_AUTH=./provider.js, or the gcip example). A module that is missing, doesn't export
// createProvider, throws, or returns something that isn't a provider stops the server at start
// with a message: nobody is let in by accident.
import { pathToFileURL } from "node:url";
import { Auth } from "../auth.ts";
import type { Config } from "../config.ts";
import { Roles } from "../signin/roles.ts";
import { Sessions } from "../signin/session.ts";
import { builtinProvider, type BuiltinDeps } from "./builtin.ts";
import { Gate } from "./gate.ts";
import { checkProvider, type AuthProvider, type ProviderContext } from "./provider.ts";

/** "local" and "tokens" mean something in the core (who may make personal tokens); a module can't take them. */
const RESERVED = ["local", "tokens"];

async function loadModule(path: string, ctx: ProviderContext): Promise<AuthProvider> {
  let mod: { createProvider?: unknown };
  try {
    mod = (await import(pathToFileURL(path).href)) as { createProvider?: unknown };
  } catch (e) {
    throw new Error(
      `ARCHNM_AUTH: couldn't load the provider ${path}: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  }
  if (typeof mod.createProvider !== "function")
    throw new Error(
      `ARCHNM_AUTH: ${path} must export createProvider(ctx), a function that returns the provider`,
    );
  const p = checkProvider(await mod.createProvider(ctx), path);
  if (RESERVED.includes(p.id)) throw new Error(`${path}: the provider id "${p.id}" is reserved`);
  return p;
}

/** The Auth for a config. `deps` is what the built-in providers may use; a module gets only its context. */
export async function createAuth(
  config: Config,
  deps: BuiltinDeps & { fetch?: typeof fetch } = {},
): Promise<Auth> {
  const cfg = config.auth;
  const roles = new Roles(cfg);
  const sessions = new Sessions({ secret: cfg.tokenKey });
  const gate = new Gate(cfg, roles, sessions, deps.fetch);
  const provider = cfg.module
    ? await loadModule(cfg.module, gate.ctx)
    : builtinProvider(cfg, gate.ctx, deps);
  return new Auth(cfg, { provider, roles, sessions, gate });
}
