// github: sign in with GitHub, through the GitHub App this server already has (server/github.ts;
// ARCHNM_GITHUB_*). The person is their GitHub login, so ARCHNM_ADMINS / ARCHNM_EDITORS /
// ARCHNM_VIEWERS list GitHub logins (octocat), not emails. Signing in also connects their GitHub
// account for pull requests, so they are not asked twice.
//
// /auth/github/start sets a cookie that ties the flow to this browser and sends them to GitHub;
// GitHub returns to the App's registered callback, /api/github/callback (routes/github.ts), which
// checks the cookie and the one-time state, then signs them in through the core's session.
import type { GitHub } from "../../github.ts";
import { GitHubError } from "../../github.ts";
import type { AuthProvider, ProviderContext } from "../provider.ts";

/** The cookie that ties a GitHub sign-in to the browser that started it. */
export const GITHUB_BINDING_COOKIE = "archnm_gh";

export function githubProvider(github: GitHub, ctx: ProviderContext): AuthProvider {
  return {
    id: "github",
    openToInternet: true,
    describe: () => ({
      kind: "buttons",
      buttons: [{ label: "Sign in with GitHub", start: "/auth/github/start" }],
    }),
    identify: () => null,
    async ready() {
      if (!github.configured)
        throw new Error(
          "ARCHNM_AUTH=github signs people in with the GitHub App, which isn't set up: set ARCHNM_GITHUB_APP_ID, ARCHNM_GITHUB_CLIENT_ID, ARCHNM_GITHUB_CLIENT_SECRET and ARCHNM_GITHUB_PRIVATE_KEY (or ARCHNM_GITHUB_PRIVATE_KEY_FILE)",
        );
    },
    async routes(req, res, path) {
      if (req.method !== "GET" || path !== "/auth/github/start") return false;
      const back = new URL(req.url ?? "", ctx.config.publicUrl).searchParams.get("back");
      try {
        const { url, binding } = github.signInUrl(back ?? "");
        res.appendHeader(
          "set-cookie",
          `${GITHUB_BINDING_COOKIE}=${binding}; Path=/api/github; HttpOnly; SameSite=Lax; Max-Age=3600${ctx.config.secure ? "; Secure" : ""}`,
        );
        res.writeHead(302, { location: url, "cache-control": "no-store" }).end();
      } catch (e) {
        if (!(e instanceof GitHubError)) throw e;
        res.writeHead(302, { location: ctx.failed(e.message) }).end();
      }
      return true;
    },
  };
}
