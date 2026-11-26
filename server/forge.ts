// Where a repo lives, as far as pull requests go. Everything else Archnemesis does is plain git;
// only proposing a change is forge-specific, and for now that's a link: the forge's own
// "new pull request" page, filled in, opened in the person's browser. The pull request is
// theirs (their account, their review flow) and Archnemesis holds no forge credentials.
//
// Recognised from the remote URL: github.com and gitlab.com, and Forgejo/Gitea/GitLab
// hosts named with ARCHNM_FORGES ("git.example.com=forgejo,gl.corp=gitlab"; server/config.ts
// reads it and passes the map in). Anything else
// has no pull requests: forks are merged inside Archnemesis, with a confirmation.

export type ForgeKind = "github" | "gitlab" | "forgejo";

export interface Forge {
  kind: ForgeKind;
  /** The repo's web page, e.g. https://github.com/acme/designs */
  web: string;
}

const NAMES: Record<ForgeKind, string> = { github: "GitHub", gitlab: "GitLab", forgejo: "Forgejo" };
export const forgeName = (k: ForgeKind) => NAMES[k];

/** The forge a remote is on, or null (a plain repo, a local one, an unknown host). */
export function forgeOf(remote: string, forges: Map<string, ForgeKind>): Forge | null {
  // git@host:owner/repo(.git) | ssh://git@host(:port)/owner/repo | https://(user@)host/owner/repo
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/i.exec(
    remote.trim(),
  );
  if (!m || remote.startsWith("/") || remote.startsWith("file:")) return null;
  const host = m[1]!.toLowerCase();
  const kind = forges.get(host);
  if (!kind) return null;
  return { kind, web: `https://${host}/${m[2]!.replace(/^\/+/, "")}` };
}

/** A branch name in a URL path: escaped, but its slashes kept (forges route on them). */
const ref = (b: string) => encodeURIComponent(b).replace(/%2F/g, "/");

/** The forge's page for opening a pull request from `branch` into `base`, filled in. */
export function proposeUrl(
  f: Forge,
  o: { branch: string; base: string; title: string; body: string },
): string {
  const q = (p: Record<string, string>) => new URLSearchParams(p).toString();
  const body = o.body.length > 6000 ? `${o.body.slice(0, 6000)}\n…` : o.body;
  switch (f.kind) {
    case "github":
      return `${f.web}/compare/${ref(o.base)}...${ref(o.branch)}?${q({ expand: "1", title: o.title, body })}`;
    case "gitlab":
      return `${f.web}/-/merge_requests/new?${q({
        "merge_request[source_branch]": o.branch,
        "merge_request[target_branch]": o.base,
        "merge_request[title]": o.title,
        "merge_request[description]": body,
      })}`;
    case "forgejo":
      return `${f.web}/compare/${ref(o.base)}...${ref(o.branch)}?${q({ title: o.title, body })}`;
  }
}
