// The shapes the app and the server share over the wire (type declarations only).
// The app imports these from here, never from server/.
import type { Connection, Diagram, Flow, ModelObject, Placement } from "./model.ts";

export interface PullState {
  number: number;
  url: string;
  state: "open" | "draft" | "merged" | "closed";
  /** The latest decision from reviewers, if any. */
  review: "approved" | "changes" | null;
}

/** A branch of a repo, and the folders on it that hold an Archnemesis design ("" is the root). */
export interface BranchChoice {
  name: string;
  default: boolean;
  designs: string[];
}

/** A repo Archnemesis's app can reach, for the connect form. */
export interface RepoChoice {
  name: string;
  url: string;
  private: boolean;
  branch: string;
}

/** What the branch menu shows: main, the forks, and how each stands. */
export interface GitInfo {
  design: string;
  remote: string;
  /** A repo Archnemesis made for itself, next to its database. */
  local: boolean;
  path: string;
  branch: string;
  /** Where pull requests go (null: none; forks merge inside Archnemesis instead). */
  forge: { kind: string; name: string; web: string } | null;
  /** On GitHub: whether Archnemesis's GitHub App is set up, and installed on this repo. */
  app: { configured: boolean; installed: boolean; installUrl: string | null } | null;
  main: string | null;
  syncedAt: string | null;
  syncing: boolean;
  error: string | null;
  forks: ForkInfo[];
}

export interface ForkInfo {
  doc: string;
  name: string;
  branch: string;
  by: string | null;
  agent: boolean;
  createdAt: string;
  base: string | null;
  head: string | null;
  /** Edits not committed yet (they're saved a minute after they settle). */
  pending: boolean;
  /** A commit is being made and pushed right now. */
  saving: boolean;
  /** Commits on main the fork doesn't have. */
  behind: number;
  present: number;
  proposedAt: string | null;
  /** Its pull request, when Archnemesis opened one on GitHub. */
  pr: PullState | null;
}

/** One person (or agent) connected to one document, for "who's on Archnemesis". */
export interface HereEntry {
  doc: string;
  docName: string;
  diagram: string | null;
  diagramName: string | null;
  user: { id: string; name: string; color: string; kind: "human" | "agent" | "system" };
  /** An agent: what it last did, and who it works for. */
  activity?: string;
  for?: string;
  /** An agent: when it last called a tool (ms since epoch). */
  at?: number;
  /** An agent on a long job: what it's on, and how far through (progress). */
  progress?: Progress;
}

/** What an agent on a long job says it's on: "Importing app-fe", 3 of 8. */
export interface Progress {
  text: string;
  step?: number;
  of?: number;
  /** Finished: shown a little longer, then gone. */
  done?: boolean;
}

export interface DesignInfo {
  key: string;
  name: string;
  objects: number;
  diagrams: number;
  present: number;
  forks: number;
  git: boolean;
  /** Only its owner sees it (until they share it with the team). */
  private: boolean;
  /** You made it: you may delete or share it. */
  mine: boolean;
}

export interface GitHubStatus {
  configured: boolean;
  slug: string | null;
  owner: string | null;
  installUrl: string | null;
  /** The app comes from the server's environment (so it can't be disconnected here). */
  fixed?: boolean;
  /** Your GitHub login, if you've signed in with GitHub here. */
  login: string | null;
}

/** How to connect an agent to this Archnemesis (from the server's config). */
export interface McpSetup {
  /** The plain MCP address, for any MCP client. */
  url: string;
  /** Claude Code's command, the example client. */
  command: string;
  note: string | null;
  /** People sign in here: personal tokens are made (and listed, to revoke) here. */
  personal?: boolean;
  /** Claude Code (and other clients that do OAuth) sign in through the browser (/mcp → this name → Authenticate). */
  oauth?: string;
  /** The command with a token in place of signing in, for scripts. */
  tokenCommand?: string;
  /** The same tools through the channel, so @agent reaches a running Claude Code session. */
  channel?: { download: string; command: string; start: string };
}

/**
 * What the one sign-in page shows (the server's auth provider decides, server/auth/provider.ts):
 * nothing to do (local, or a proxy already signed you in), a token to paste, or one button per
 * way in. A button's `start` is a path on the server that the browser navigates to.
 */
export type SignInPage =
  | { kind: "none" }
  | { kind: "token"; hint: string }
  | { kind: "buttons"; buttons: { label: string; start: string }[] };

/** How a document is edited: directly, not at all (git's main: edits fork), or as a fork. */
export type DocMode = "edit" | "mirror" | "fork";

/** Who has touched a box's sources, from git (read when asked). */
export interface TouchedInfo {
  people: { name: string; login?: string; commits: number; withAgent: number; last: string }[];
  looked: { source: string; commits: number }[];
  missed: { source: string; why: string }[];
}

/** A design's whole model as JSON (a past version, or an export). */
export interface StateJson {
  objects: ModelObject[];
  connections: Connection[];
  diagrams: Diagram[];
  placements: Placement[];
  flows: Flow[];
  entities: unknown[];
  arrows?: unknown[];
  boundaries?: unknown[];
  decisions?: unknown[];
}

/** What you may do with a design or fork, as the server decides (the app hides the rest; the server checks again). */
export interface DesignCan {
  view: boolean;
  /** Make your own copy of it (a branch where you may edit it, else a private copy). */
  fork: boolean;
  edit: boolean;
  /** Delete it, share it, make or revoke its links, connect it to a repo. */
  manage: boolean;
}

/** One share link, as the app is shown it (never its token, which is shown once, when it is made). */
export interface ShareLink {
  id: string;
  /** The document it opens: a design's key, or "<design>@<fork>". */
  doc: string;
  /** Who made it. */
  by: string;
  created: string;
  expires: string | null;
  revoked: string | null;
  lastUsed: string | null;
  /** Whether it works right now. */
  active: boolean;
}

/**
 * Who a link to a design reaches, as the server knows it: "signin" (they sign in here and get
 * past the role lists first) or "anyone" (a public GitHub repo's design, and the host allows
 * viewing without signing in).
 */
export interface ShareReach {
  kind: "signin" | "anyone";
  /** The design follows a public GitHub repo. */
  publicRepo: boolean;
  /** The host allows viewing public repos' designs without signing in (ARCHNM_PUBLIC_LINKS). */
  publicLinks: boolean;
}
