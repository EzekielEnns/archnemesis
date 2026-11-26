// What the app asks of whatever keeps its designs. The Node server is one answer (HTTP, a live
// WebSocket, git, GitHub, sign-in); the static build's is another (everything in this browser,
// no network). The app asks for a capability (`backend.git?`, `backend.github?`, ...) and shows
// the matching UI only when it's there: it never checks which backend it has.
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";
import type {
  BranchChoice,
  DesignCan,
  DesignInfo,
  DocMode,
  SignInPage,
  GitHubStatus,
  GitInfo,
  HereEntry,
  McpSetup,
  PullState,
  RepoChoice,
  ShareLink,
  ShareReach,
  StateJson,
  TouchedInfo,
} from "../../shared/api.ts";
import type { Actor } from "../../shared/doc.ts";
import type { LibStats } from "../../shared/libstats.ts";
import type { Op } from "../../shared/model.ts";
import type { TrailEvent } from "../../shared/trail.ts";
import type { WhatsNew } from "../../shared/whatsnew.ts";

/**
 * Why a call failed: "signin" (not signed in), "missing" (no such design), "offline" (couldn't
 * reach it), "refused" (it said no; the message says why), "failed" (anything else).
 */
export type BackendErrorCode = "signin" | "missing" | "offline" | "refused" | "failed";

export class BackendError extends Error {
  readonly code: BackendErrorCode;
  readonly status: number | null;
  constructor(code: BackendErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = "BackendError";
    this.code = code;
    this.status = status;
  }
}

export interface InstanceConfig {
  /** The sign-in provider's id ("local", "tokens", "oidc", ...). */
  auth: string;
  /** What the one sign-in page shows. */
  signin: SignInPage;
  /** How to connect an agent over MCP (null: this backend has none to offer). */
  mcp: McpSetup | null;
  /** Whether a repo can be kept on the instance's own disk. */
  localRepos: boolean;
}

/** Who you are here. */
export interface Me extends Actor {
  admin: boolean;
}

/** A design as the store opens it. */
export interface DesignDoc {
  key: string;
  name: string;
  /** The document's id: caches are keyed by it. */
  doc: string;
  mode: DocMode;
  git: boolean;
  canEdit: boolean;
  /** A design opened from somewhere else, read-only ("owner/repo@ref"): what the banner says. */
  from?: string;
  /** What you may do here (view, fork, edit, manage), where the backend says: the UI hides the rest. */
  can?: DesignCan;
  /** You're here on a share link: without it you couldn't see this design. */
  viaLink?: boolean;
  /** You're here without an account, on a link to a public repo's design. */
  guest?: boolean;
}

/** Something pushed to an open document (by the server, never made up locally). */
export type DocEvent =
  | { type: "git" }
  | { type: "moved"; to: string; why: string }
  | { type: "deleted"; why: string }
  | { type: "here"; people: HereEntry[] };

export interface DocHandlers {
  /** "live" once the document has loaded (and after a reconnect), "offline" while it can't sync. */
  onStatus(status: "live" | "offline" | "signin"): void;
  onEvent(event: DocEvent): void;
}

/** An open document: presence (null where there are no other people) and a way to let go. */
export interface DocConnection {
  awareness: Awareness | null;
  close(): void;
}

export interface VersionInfo {
  sha: string;
  date: string;
  author: string;
  subject: string;
}

interface Proposal {
  url: string | null;
  branch: string;
  changes: string[];
  pr: PullState | null;
  signIn: boolean;
}

export interface FollowOptions {
  remote?: string;
  path?: string;
  branch?: string;
  local?: boolean;
  addHere?: boolean;
}

export interface TokenInfo {
  id: string;
  label: string;
  created: string;
  used: string | null;
  expires: string;
}

/** What the Allow page shows: a client asking to act as you, or that you must sign in first. */
export type OauthAsk =
  | { kind: "signin"; page: SignInPage }
  | { kind: "ask"; client: string; to: string; you: string; login: string };

interface ReportInput {
  kind: "bug" | "feature";
  text: string;
  design: string;
  context?: Record<string, unknown>;
}

/** What opening a shared link, or a folder, gave: the local design to go to. */
export interface SharedOpen {
  key: string;
  /** A read-only view of a design on GitHub, not a copy of your own. */
  readOnly: boolean;
  from?: string;
  /** This link was opened before: `key` is the copy made then. */
  existing?: boolean;
}

/**
 * Designs that travel with nothing in between (the static build): in a link, in a .zip or a
 * folder, or from a public GitHub repository. Optional: a backend with a server shares through
 * the server instead, and the app hides these actions where this is absent.
 */
export interface PortableCapability {
  /** A link that carries the design (`tooBig`: it wouldn't fit in a link). */
  link(key: string): Promise<{ url: string; length: number } | { tooBig: true }>;
  /** Save the design's files as a .zip. */
  download(key: string): Promise<void>;
  /** Pick a .zip or a folder of a design's files and open it as a new design (null: cancelled). */
  openFiles(kind: "zip" | "folder"): Promise<{ key: string } | null>;
  /** Open what a `#~d=` or `#~gh=` link says (the fragment without the `#`). */
  openShared(fragment: string, o?: { again?: boolean }): Promise<SharedOpen>;
  /** A design of your own, copied from a local one or a read-only one from GitHub. */
  copy(key: string): Promise<{ key: string }>;
  /** The fragment that opens a read-only design again (null: it isn't one). */
  fragmentOf(key: string): string | null;
  /** On a fork opened from GitHub: what changed against the repository's main branch. */
  whatsNew(doc: string): Promise<WhatsNew | null>;
}

export interface Backend {
  /** How this instance works: sign-in mode, the MCP address, what it can keep. */
  config(): Promise<InstanceConfig>;
  /** Who you are (throws "signin" when you aren't signed in). */
  me(): Promise<Me>;

  designs: {
    list(): Promise<DesignInfo[]>;
    /** A design or fork by document name (throws "missing"). */
    info(doc: string): Promise<DesignDoc>;
    /** `example`: start from the example shop instead of an empty design. */
    create(name: string, opts?: { example?: boolean }): Promise<{ key: string }>;
    remove(key: string): Promise<void>;
    /** Open a design's document into `ydoc`: cached here, kept in step with the backend. */
    open(info: DesignDoc, ydoc: Y.Doc, handlers: DocHandlers): DocConnection;
    /** The whole model as JSON (Export). */
    state(doc: string): Promise<StateJson>;
    /** Make a design private to you, or share it with the team. */
    share?(key: string, priv: boolean): Promise<void>;
  };

  /** Share links to a design: making, listing and revoking them, and making your own copy from one. */
  links?: {
    list(doc: string): Promise<{ links: ShareLink[]; reach: ShareReach }>;
    /** A new link (optionally ending after `days`); its address, with the token, is only in this answer. */
    create(doc: string, days: number | null): Promise<{ url: string; link: ShareLink }>;
    revoke(doc: string, id: string): Promise<void>;
    /** A new private design of yours, copied from this document as it is now. */
    copy(doc: string): Promise<{ key: string }>;
    /** Whether this tab holds a share link for the design (it may open without signing in). */
    holds(doc: string): boolean;
  };

  /** Main's past versions, and the design as of one of them. */
  versions?: {
    list(key: string): Promise<VersionInfo[]>;
    at(key: string, sha: string): Promise<StateJson>;
  };

  /** A design that follows a git repo: status, forks, proposals. */
  git?: {
    /** Forks and history are kept in this browser, and main is edited directly (no "your edit went to a fork"). */
    inBrowser?: boolean;
    info(key: string): Promise<GitInfo | null>;
    follow(key: string, o: FollowOptions): Promise<GitInfo>;
    sync(key: string): Promise<GitInfo>;
    fork(key: string, name?: string): Promise<{ doc: string }>;
    /** Edits made on main: they go to your fork (made on the first). */
    edit(
      key: string,
      batches: { ops: Op[]; label: string }[],
    ): Promise<{ doc: string; created: boolean; errors: string[] }>;
    /** Notes aren't in git: they go on main itself. */
    saveNotes(doc: string, ops: Op[], label: string): Promise<void>;
    merge(doc: string): Promise<{ result: string }>;
    propose(doc: string): Promise<Proposal>;
    discard(doc: string): Promise<void>;
    /** On a fork: what changed since it started (null: nothing to say). */
    whatsNew(doc: string): Promise<WhatsNew | null>;
  };

  /** GitHub: Archnemesis's app, and who you are there. `setup`, `login` leave the page. */
  github?: {
    status(): Promise<GitHubStatus>;
    repos(): Promise<RepoChoice[]>;
    branches(repo: string): Promise<BranchChoice[]>;
    setup(org?: string): Promise<void>;
    login(): Promise<void>;
    logout(): Promise<void>;
    disconnect(): Promise<void>;
  };

  /** Personal tokens for scripts. */
  tokens?: {
    list(): Promise<TokenInfo[]>;
    create(label: string): Promise<string>;
    revoke(id: string): Promise<void>;
  };

  /** Signing in and out. `withToken` and `signOut` reload the page; `start` leaves it. */
  signIn?: {
    withToken(token: string): void;
    /** A button: the browser goes to the provider's start URL, and comes back to where it was, signed in. */
    start(url: string): void;
    signOut(): Promise<void>;
  };

  /** The Allow page an MCP client sends you to. */
  oauth?: {
    read(id: string): Promise<OauthAsk>;
    /** Allow or deny: where to send the browser next. */
    decide(id: string, allow: boolean): Promise<string>;
  };

  /** Who touched a box (git), and the library stats job. */
  insights?: {
    touched(doc: string, id: string): Promise<TouchedInfo>;
    libstats(doc: string): Promise<{ enabled: boolean; stats: Record<string, LibStats | null> }>;
  };

  /** Designs that travel in a link, a .zip or from public GitHub (the static build). */
  portable?: PortableCapability;

  /** Technology logos (Simple Icons). */
  icons: {
    search(q: string, signal?: AbortSignal): Promise<string[]>;
    /** A logo as SVG text (null: none by that name). */
    svg(technology: string, color?: "brand"): Promise<string | null>;
    /** The same logo as a plain URL for an <img>, where the backend can serve one. */
    url?(technology: string): string;
  };

  /** Bug reports and feature requests. */
  report?: { send(r: ReportInput): Promise<number> };

  /** The call log and feedback for agents in this page (WebMCP). */
  telemetry?: {
    call(body: Record<string, unknown>): void;
    feedback(body: Record<string, unknown>): Promise<number | undefined>;
  };

  /** Where you went, when you record it. */
  trail?: { send(doc: string, session: string, events: TrailEvent[], keepalive: boolean): void };

  /** The person's answer to a guided step an agent over MCP is waiting on. */
  guide?: {
    reply(doc: string, r: { seq: number; action: string; text?: string }): Promise<void>;
  };
}
