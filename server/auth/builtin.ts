// The providers that come with Archnemesis, by the name ARCHNM_AUTH gives them.
import type { Config } from "../config.ts";
import type { GitHub } from "../github.ts";
import { githubProvider } from "./providers/github.ts";
import { headerProvider } from "./providers/header.ts";
import { localProvider } from "./providers/local.ts";
import { oidcProvider } from "./providers/oidc.ts";
import { tokensProvider } from "./providers/tokens.ts";
import type { AuthProvider, ProviderContext } from "./provider.ts";

/** What some providers need from the rest of the server (nothing a custom provider gets). */
export interface BuiltinDeps {
  github?: GitHub;
}

export function builtinProvider(
  cfg: Config["auth"],
  ctx: ProviderContext,
  deps: BuiltinDeps = {},
): AuthProvider {
  if (cfg.header) return headerProvider(cfg.header, ctx);
  if (cfg.oidc) return oidcProvider(cfg.oidc, ctx);
  switch (cfg.builtin) {
    case "tokens":
      return tokensProvider();
    case "github":
      if (!deps.github) throw new Error("ARCHNM_AUTH=github needs the server's GitHub App");
      return githubProvider(deps.github, ctx);
    case "local":
      return localProvider();
    default:
      throw new Error(`ARCHNM_AUTH=${cfg.mode} is not a built-in provider`);
  }
}
