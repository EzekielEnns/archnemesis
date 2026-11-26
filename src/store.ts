// The browser's side of the live document. Each tab holds a full copy of the Yjs document,
// synced with the server over a WebSocket (Hocuspocus) and cached in IndexedDB, so it opens
// instantly and keeps working through a dropped connection.
//
// Edits are batches of ops applied straight to the local copy (checked first, one
// transaction), so they show at once; Yjs carries them to everyone else. Undo is per tab and
// only ever undoes this tab's own edits. Plain copies of every record (the maps below) are
// kept current for the canvas and panels.
import { noteEdit } from "./trail";
import { backend } from "./backend";
import {
  BackendError,
  type DesignDoc,
  type DocConnection,
  type DocEvent,
  type FollowOptions,
} from "./backend/types.ts";
import { DESIGN_KEY, NAME_KEY, setStored, stored } from "./storage";
import type { DesignCan, DocMode, HereEntry, McpSetup, SignInPage } from "../shared/api.ts";
import type { FConfig } from "../shared/files.ts";
import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import {
  applyOps,
  emptyState,
  logEntryOk,
  logOf,
  mirror,
  pkey,
  undoManager,
  UndoSteps,
  type Actor,
  type CommitOpts,
  type LogEntry,
  type ModelState,
} from "../shared/doc.ts";
import {
  isThreadOp,
  type Connection,
  type Diagram,
  type Flow,
  type ModelObject,
  type Op,
  type Placement,
} from "../shared/model.ts";
import { buildIndex, type ModelIndex } from "../shared/project.ts";
import {
  carryToast,
  splitDoc,
  type GitHubStatus,
  type GitInfo,
  type RepoChoice,
  type BranchChoice,
} from "./route";

export type Connectivity = "loading" | "live" | "offline" | "signin" | "missing";

/** How a document is edited: directly, not at all (git's main: edits fork), or as a fork. */
export type Mode = DocMode;

export class Store {
  readonly doc = new Y.Doc();
  /** The document this store holds (a design's key, or "<design>@<fork>"), and its name once loaded. */
  readonly design: string;
  /** The design it belongs to, and the fork it is (null for main). */
  readonly designKey: string;
  readonly branch: string | null;
  designName: string;
  /** The design's archnm.yaml (tag groups, protected fields, limits), as the server read it. */
  config: FConfig = {};
  mode: Mode = "edit";
  /** False for a viewer: the server drops their edits, so the client never makes them. */
  canEdit = true;
  /** Where a read-only design came from ("owner/repo@ref" on GitHub); null for your own. */
  from: string | null = null;
  /** What the server says you may do here (all true where there's no server to say otherwise). */
  can: DesignCan = { view: true, fork: true, edit: true, manage: true };
  /** You're here on a share link: without it you couldn't see this. */
  viaLink = false;
  /** You're here without an account (a link to a public repo's design): view only, and signing in is how you fork. */
  guest = false;
  /** The design's git status, when it follows a repo. */
  git: GitInfo | null = null;
  /** Archnemesis's GitHub App, and who you are on GitHub (fetched when a design is on GitHub). */
  github: GitHubStatus | null = null;
  /** An edit on main went to a fork: open it. */
  onForked: ((doc: string, created: boolean, errors: string[]) => void) | null = null;
  /** This fork closed (merged or discarded): go where the server says. */
  onMoved: ((to: string, why: string) => void) | null = null;
  /** Everyone on Archnemesis right now, on any design or fork (the server sends it as it changes). */
  here: HereEntry[] = [];
  private forkQueue: { ops: Op[]; label: string; done: (e?: Error) => void }[] = [];
  private state: ModelState = emptyState();
  readonly objects: Map<string, ModelObject> = this.state.objects;
  readonly connections: Map<string, Connection> = this.state.connections;
  readonly diagrams: Map<string, Diagram> = this.state.diagrams;
  readonly placements: Map<string, Placement> = this.state.placements;
  readonly flows: Map<string, Flow> = this.state.flows;
  canUndo = false;
  canRedo = false;
  connectivity: Connectivity = "loading";
  /** The server's sign-in provider ("local", "tokens", "oidc", ...). */
  authMode = "local";
  /** What the one sign-in page shows. */
  signin: SignInPage = { kind: "none" };
  /** Whether this Archnemesis can keep a repo on its own disk (not where the disk doesn't last). */
  localRepos = true;
  /** Whether you're an admin here (connect repos on the server, set up the GitHub App). */
  isAdmin = false;
  /** How to connect an agent (from the server). */
  mcp: McpSetup | null = null;
  version = 0;
  /** Who this tab edits as; confirmed by the server once connected. */
  me: Actor = { id: "local:You", name: stored(NAME_KEY) || "You", kind: "human" };
  /** Presence: everyone else's cursor and selection (null where this backend has no one else). */
  awareness: Awareness | null = null;

  /** Called for changes made somewhere else (an agent, another tab), for a toast. */
  onRemote: ((entry: LogEntry) => void) | null = null;

  private listeners = new Set<() => void>();
  private idx: { version: number; index: ModelIndex } | null = null;
  private history: Y.UndoManager;
  /** The origin this tab's edits carry, so undo can tell them apart from everyone else's. */
  private origin = { tab: crypto.randomUUID() };
  private synced = false;

  constructor(design: string) {
    this.design = design;
    ({ design: this.designKey, branch: this.branch } = splitDoc(design));
    this.designName = this.designKey;
    mirror(this.doc, this.state, () => this.bump());
    this.history = undoManager(this.doc, this.origin);
    const changed = () => {
      this.canUndo = this.history.canUndo();
      this.canRedo = this.history.canRedo();
      this.bump();
    };
    this.history.on("stack-item-added", changed);
    this.history.on("stack-item-popped", changed);
    this.history.on("stack-cleared", changed);
    logOf(this.doc).observe((ev, tr) => {
      if (!this.synced || tr.local) return;
      for (const item of ev.changes.added) {
        for (const e of item.content.getContent())
          if (logEntryOk(e) && e.actor.id !== this.me.id) this.onRemote?.(e);
      }
    });
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getVersion = (): number => this.version;

  /** Looking at a past version (from git): read-only, until backToNow. */
  past: {
    sha: string;
    date: string;
    subject: string;
    index: ModelIndex;
    wasEditable: boolean;
  } | null = null;

  /** Main's past versions: the commits that changed the design's files, newest first. */
  async versions(): Promise<{ sha: string; date: string; author: string; subject: string }[]> {
    return (await backend.versions?.list(this.designKey)) ?? [];
  }

  /** Show the design as it was at a commit, read-only. Live edits carry on underneath. */
  async viewAt(v: { sha: string; date: string; subject: string }): Promise<void> {
    if (!backend.versions) throw new Error("there's no history here");
    const st = await backend.versions.at(this.designKey, v.sha);
    const index = buildIndex({
      objects: st.objects ?? [],
      connections: st.connections ?? [],
      diagrams: st.diagrams ?? [],
      placements: st.placements ?? [],
      flows: st.flows ?? [],
      arrows: (st.arrows ?? []) as never[],
      boundaries: (st.boundaries ?? []) as never[],
      decisions: (st.decisions ?? []) as never[],
      entities: (st.entities ?? []) as never[],
    });
    this.past = {
      sha: v.sha,
      date: v.date,
      subject: v.subject,
      index,
      wasEditable: this.past?.wasEditable ?? this.canEdit,
    };
    this.canEdit = false;
    this.bump();
  }

  backToNow(): void {
    if (!this.past) return;
    this.canEdit = this.past.wasEditable;
    this.past = null;
    this.bump();
  }

  /** The design as it is now (the live state, never a look into the past). */
  model(): ModelState {
    return this.state;
  }

  index(): ModelIndex {
    if (this.past) return this.past.index;
    return this.liveIndex();
  }

  /** The index of the design as it is now, even while looking into the past (what an agent reads, with model()). */
  liveIndex(): ModelIndex {
    if (this.idx?.version !== this.version) {
      this.idx = {
        version: this.version,
        index: buildIndex({
          objects: this.objects.values(),
          connections: this.connections.values(),
          diagrams: this.diagrams.values(),
          placements: this.placements.values(),
          flows: this.flows.values(),
          arrows: this.state.arrows.values(),
          notes: this.state.notes.values(),
          replies: this.state.replies.values(),
          boundaries: this.state.boundaries.values(),
          decisions: this.state.decisions.values(),
          entities: this.state.entities.values(),
        }),
      };
    }
    return this.idx.index;
  }

  /** The index with more in it, for drawing only (a diff puts main's deleted things back). */
  indexWith(extra: {
    objects: ModelObject[];
    connections: Connection[];
    placements: Placement[];
    diagrams?: Diagram[];
  }): ModelIndex {
    const add = <T>(m: Iterable<T>, more: T[]) => [...m, ...more];
    return buildIndex({
      objects: add(this.objects.values(), extra.objects),
      connections: add(this.connections.values(), extra.connections),
      diagrams: add(this.diagrams.values(), extra.diagrams ?? []),
      placements: add(this.placements.values(), extra.placements),
      flows: this.flows.values(),
      arrows: this.state.arrows.values(),
      notes: this.state.notes.values(),
      replies: this.state.replies.values(),
      boundaries: this.state.boundaries.values(),
      decisions: this.state.decisions.values(),
      entities: this.state.entities.values(),
    });
  }

  /** Connect: learn how to sign in, open the offline cache, then sync with the backend. */
  start(): () => void {
    let stopped = false;
    let conn: DocConnection | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let wait = 1000;
    const onEvent = (e: DocEvent) => {
      if (e.type === "git") void this.refreshGit();
      if (e.type === "moved") this.onMoved?.(e.to, e.why);
      if (e.type === "deleted") {
        carryToast(e.why ? `${e.why}` : "That design was deleted");
        this.setConnectivity("missing");
      }
      if (e.type === "here") {
        this.here = e.people;
        this.bump();
      }
    };
    const boot = async () => {
      const config = await backend.config();
      this.signin = config.signin;
      if (stopped) return;
      this.authMode = config.auth;
      this.localRepos = config.localRepos;
      this.mcp = config.mcp;
      try {
        const me = await backend.me();
        this.me = { id: me.id, name: me.name, kind: me.kind };
        this.isAdmin = me.admin;
      } catch (e) {
        // Not signed in: a share link in this tab may still open its design (a guest, if the host allows it).
        const link = backend.links?.holds(this.design);
        if (e instanceof BackendError && e.code === "signin" && !link)
          return this.setConnectivity("signin");
        if (!(e instanceof BackendError && e.code === "signin")) throw e;
      }
      if (stopped) return;

      let design: DesignDoc;
      try {
        design = await backend.designs.info(this.design);
      } catch (e) {
        if (e instanceof BackendError && e.code === "missing")
          return this.setConnectivity("missing");
        if (e instanceof BackendError && e.code === "signin") return this.setConnectivity("signin");
        throw e;
      }
      this.designName = design.name;
      this.mode = design.mode;
      this.canEdit = design.canEdit;
      this.from = design.from ?? null;
      if (design.can) this.can = design.can;
      this.viaLink = !!design.viaLink;
      this.guest = !!design.guest;
      // Remember the design, not the fork: a fork may be gone by the next visit.
      setStored(DESIGN_KEY, this.designKey);
      if (design.git) void this.refreshGit();
      if (stopped) return;

      // The name can change while open (archnm.yaml, another tab).
      const meta = this.doc.getMap<string>("meta");
      let configText = "";
      const readMeta = () => {
        const n = meta.get("name");
        let changed = false;
        if (n && n !== this.designName) {
          this.designName = n;
          changed = true;
        }
        const c = meta.get("config") ?? "";
        if (c !== configText) {
          configText = c;
          try {
            this.config = c ? (JSON.parse(c) as FConfig) : {};
          } catch {
            this.config = {};
          }
          changed = true;
        }
        if (changed) this.bump();
      };
      meta.observe(readMeta);
      readMeta();

      conn = backend.designs.open(design, this.doc, {
        onStatus: (status) => {
          if (status === "live") this.synced = true;
          this.setConnectivity(status);
        },
        onEvent,
      });
      this.awareness = conn.awareness;
      this.bump();
    };
    // The server may be restarting: keep trying (up to every 15s) until it answers.
    const attempt = () =>
      void boot().catch(() => {
        if (stopped) return;
        this.setConnectivity("offline");
        retry = setTimeout(attempt, wait);
        wait = Math.min(wait * 2, 15_000);
      });
    attempt();
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      conn?.close();
      conn = null;
      this.awareness = null;
    };
  }

  /** Sign in with a token (where the sign-in page asks for one), then reconnect. */
  signIn(token: string): void {
    backend.signIn?.withToken(token);
  }

  signOut(): void {
    void backend.signIn?.signOut();
  }

  /**
   * Apply a batch locally (it syncs from here). Rejects, changing nothing, if it's invalid.
   * On git's main nothing is edited here: the batch goes to your fork (made on the first
   * edit), and the fork opens.
   */
  /**
   * An agent working in this tab for the person (WebMCP): its edits are in its own name, with
   * the person's rights, and it has an undo of its own (the person's ⌘Z doesn't take them back,
   * and its undo doesn't take back theirs). On a design that follows git they go to the
   * person's fork, as theirs do.
   */
  helper(actor: Actor): {
    send(ops: Op[], label: string, opts?: CommitOpts): Promise<void>;
    undo(dry?: boolean): string | null;
  } {
    const steps = new UndoSteps(this.doc, { agent: actor.id, tab: this.origin.tab });
    return {
      send: async (ops, label, opts) => {
        if (!ops.length) return;
        if (this.mode === "mirror") return this.send(ops, label);
        if (this.connectivity === "signin") throw new Error("sign in to edit");
        if (!this.canEdit) throw new Error("you can view this design, not edit it");
        noteEdit(label, ops);
        steps.apply(this.state, ops, actor, label, opts);
      },
      undo: (dry) => steps.undo(dry),
    };
  }

  async send(ops: Op[], label: string): Promise<void> {
    if (!ops.length) return;
    if (this.connectivity === "signin") throw new Error("sign in to edit");
    if (!this.canEdit) throw new Error("you can view this design, not edit it");
    noteEdit(label, ops);
    if (this.mode === "mirror" && ops.every((op) => isThreadOp(op, this.state.notes))) {
      // Notes aren't in git: they go on main itself, through the server (this tab can't write main).
      await this.gitApi().saveNotes(this.design, ops, label);
      return;
    }
    if (this.mode === "mirror") {
      return new Promise((resolve, reject) => {
        this.forkQueue.push({ ops, label, done: (e) => (e ? reject(e) : resolve()) });
        // Gather a gesture's batches (a drag sends several) into one request, and send one
        // request at a time: two at once could each make a fork.
        if (!this.forkTimer && !this.forkBusy)
          this.forkTimer = setTimeout(() => void this.flushFork(), 120);
      });
    }
    applyOps(this.doc, this.state, ops, this.me, label, this.origin);
  }

  private async flushFork(): Promise<void> {
    this.forkTimer = null;
    this.forkBusy = true;
    try {
      while (this.forkQueue.length) {
        const queued = this.forkQueue;
        this.forkQueue = [];
        try {
          const r = await this.gitApi().edit(
            this.designKey,
            queued.map(({ ops, label }) => ({ ops, label })),
          );
          for (const q of queued) q.done();
          this.onForked?.(r.doc, r.created, r.errors);
        } catch (e) {
          for (const q of queued) q.done(e instanceof Error ? e : new Error(String(e)));
        }
      }
    } finally {
      this.forkBusy = false;
    }
  }
  private forkTimer: ReturnType<typeof setTimeout> | null = null;
  private forkBusy = false;

  /** The git side of the backend (only designs that follow a repo are edited through it). */
  private gitApi() {
    if (!backend.git) throw new Error("this version doesn't keep designs in git");
    return backend.git;
  }

  private githubApi() {
    if (!backend.github) throw new Error("this version has no GitHub");
    return backend.github;
  }

  async refreshGit(): Promise<void> {
    if (!backend.git) return;
    try {
      this.git = await backend.git.info(this.designKey);
    } catch {
      return;
    }
    if (this.git?.app && !this.github) await this.refreshGitHub();
    this.bump();
  }

  async refreshGitHub(): Promise<void> {
    if (!backend.github) return;
    try {
      this.github = await backend.github.status();
    } catch {
      /* keep what we had */
    }
    this.bump();
  }

  /** A repo's branches and where their designs are (null: couldn't read it, with why). */
  async githubBranches(repo: string): Promise<{ list: BranchChoice[] } | { error: string }> {
    try {
      return { list: await this.githubApi().branches(repo) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : `couldn't read ${repo}` };
    }
  }

  /** The repos Archnemesis's GitHub App is installed on (empty without one). */
  async githubRepos(): Promise<RepoChoice[]> {
    return (await backend.github?.repos().catch(() => [])) ?? [];
  }

  /** GitHub: set up Archnemesis's app (one click on GitHub), sign in or out. Each leaves the page. */
  githubAction = {
    setup: (org?: string) => this.githubApi().setup(org),
    login: () => this.githubApi().login(),
    logout: async () => {
      await this.githubApi().logout();
      await this.refreshGitHub();
    },
    disconnect: async () => {
      await this.githubApi().disconnect();
      await this.refreshGitHub();
    },
  };

  /** Git actions, from the branch menu. Each answers with what the server said. */
  gitAction = {
    follow: (o: FollowOptions) => this.gitApi().follow(this.designKey, o),
    sync: () => this.gitApi().sync(this.designKey),
    fork: (name?: string) => this.gitApi().fork(this.designKey, name),
    merge: () => this.gitApi().merge(this.design),
    propose: () => this.gitApi().propose(this.design),
    discard: () => this.gitApi().discard(this.design),
  };

  async undo(): Promise<void> {
    noteEdit("undo");
    this.history.undo();
  }

  async redo(): Promise<void> {
    noteEdit("redo");
    this.history.redo();
  }

  placement(diagramId: string, objectId: string): Placement | undefined {
    return this.placements.get(pkey(diagramId, objectId));
  }

  /** Recent changes, newest last. */
  log(n = 100): LogEntry[] {
    return logOf(this.doc).toArray().filter(logEntryOk).slice(-n);
  }

  /** A guest chose to sign in (to fork): show the sign-in; the link they came on still opens after. */
  askSignIn(): void {
    this.setConnectivity("signin");
  }

  private setConnectivity(c: Connectivity): void {
    if (this.connectivity === c) return;
    this.connectivity = c;
    this.bump();
  }

  private bump(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }
}
