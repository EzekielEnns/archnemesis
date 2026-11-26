import { LANDSCAPE_RULES } from "../shared/landscape.ts";
import { linkNoteOps } from "../shared/notes.ts";
import type { FConfig } from "../shared/files.ts";
// The live documents on the server, one per design. Hocuspocus relays every edit between
// open tabs over WebSockets, and the server is itself a participant holding each document
// open, so agents, the API and the file writer always have it.
//
// Hub: the one sync server, database and sign-in, and the list of designs.
// Live: one document: a design's main, or one of its forks ("<design>@<fork>"). Keeps a
// plain mirror of its model (for reads and for checking batches), stores every update in
// SQLite as it happens, keeps its folder of files, tidies references left dangling by
// concurrent edits, and gives each agent its own undo.
//
// A design is in one of two modes. On its own, its main is edited directly and written to
// ARCHNM_ROOT/<design>. Once it follows a git repo (server/gitsync.ts), its main is a
// read-only mirror of the repo's main, and edits happen on forks, which live only in the
// database until they're committed to their branch.
import type http from "node:http";
import { Hocuspocus } from "@hocuspocus/server";
import { WebSocketServer, type WebSocket } from "ws";
import * as Y from "yjs";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  ModelError,
  applyOps,
  emptyState,
  logEntryOk,
  logOf,
  mirror,
  readState,
  fill,
  sweep,
  UndoSteps,
  type CommitOpts,
  type Actor,
  type LogEntry,
  type ModelState,
} from "../shared/doc.ts";
import { isThreadOp, makeDiagram, slug, type Op, type Placement } from "../shared/model.ts";
import { buildIndex, type ModelIndex } from "../shared/project.ts";
import type { Who } from "./access.ts";
import { Auth, type Principal } from "./auth.ts";
import { Links } from "./links.ts";
import { GUEST, Perms, splitToken, type ConnContext } from "./perms.ts";
import { guestUser, Presence } from "./presence.ts";
import { githubSource, RepoAccess, type RepoSource } from "./repoaccess.ts";
import { clientAddr } from "./addr.ts";
import type { Config } from "./config.ts";

/** An agent showing its person around: where their tabs go, and what to look at. */
export interface Guide {
  /** The person whose tabs follow ("local:*": anyone local). */
  for: string;
  by: string;
  diagram: string;
  object?: string | null;
  flow?: string | null;
  step?: number;
  /** Several boxes to frame together ("the API layer"). */
  objects?: string[];
  /** Light up boxes with this tag, as the tag filter does. */
  tag?: string | null;
  /** Code or docs to read for this step: repo@ref:path[:line] or URLs. */
  refs?: string[];
  say: string;
  /** The agent is waiting for Next / Back / a question (MCP point wait). */
  waiting?: boolean;
  /** A point wait call is open right now. Between calls a press is kept for the next one. */
  listening?: boolean;
  /** Goes up with every point, so a tab moves once per step. */
  seq: number;
}

/** What the person did with a guided step. */
export interface GuideReply {
  action: "next" | "back" | "stop" | "ask";
  text?: string;
}
import { viewOps } from "../shared/views.ts";
import { layoutOps, structureOf } from "../shared/layout.ts";
import { projectDiagram } from "../shared/project.ts";
import { seedOps } from "../shared/seed.ts";
import { codeSeedOps } from "./seed.ts";
import { DocStore, type ForkRow } from "./store.ts";
import { FileSync, FolderCopy, hasDesignFolder } from "./files.ts";
import { GitSync } from "./gitsync.ts";
import type { GitHub } from "./github.ts";
import { stopAwarenessTimer } from "../shared/presence-link.ts";

const SERVER: Actor = { id: "archnm", name: "archnm", kind: "system" };

const actorOf = (p: Principal): Actor => ({
  id: p.id,
  name: p.name,
  kind: p.kind,
  ...(p.session ? { session: p.session } : {}),
});

/** Who sent a transaction, when it came in over a browser's socket (Hocuspocus tags it). */
function senderOf(origin: unknown): Principal | null {
  const o = origin as { source?: string; connection?: { context?: Partial<ConnContext> } } | null;
  return o?.source === "connection" ? (o.connection?.context?.principal ?? null) : null;
}

export type Seed = "example" | "empty" | "code";

/** What a fresh Archnemesis names its one empty design (the local backend uses the same). */
const FIRST_DESIGN = "My design";

export interface DesignInfo {
  key: string;
  name: string;
  objects: number;
  diagrams: number;
  /** People and agents connected right now, on main and every fork. */
  present: number;
  /** Open forks. */
  forks: number;
  /** Whether it follows a git repo. */
  git: boolean;
  /** Only its owner sees it (layer 1); otherwise the whole team does (layer 2). */
  private: boolean;
  /** Whether you made it (so you may delete it or share it). */
  mine: boolean;
}

/** Who a design belongs to, kept on the server so nobody editing it can change it. */
export interface Access {
  owner: string | null;
  private: boolean;
}

export type Mode = "edit" | "mirror" | "fork";

export const KEY_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

export class Hub {
  readonly hocuspocus: Hocuspocus<ConnContext>;
  /** Each design's main document, by key. */
  readonly designs = new Map<string, Live>();
  /** Every open fork, by document name ("<design>@<fork>"). */
  readonly forks = new Map<string, Live>();
  /** Designs that follow a git repo. */
  readonly git = new Map<string, GitSync>();
  /** The GitHub App, when one is set up (main.ts sets it). */
  github: GitHub | null = null;
  /** What GitHub says about repos, when it isn't GitHub itself (tests). */
  repoSource: RepoSource | null = null;
  private wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  private heartbeat: NodeJS.Timeout | null = null;
  readonly store: DocStore;
  readonly root: string;
  /** Where Archnemesis keeps its own state next to the database (clones, local repos). */
  readonly stateDir: string;
  private auth: Auth;
  readonly config: Config;
  /** Who may do what to a design (server/perms.ts): every decision goes through it. */
  readonly perms: Perms;
  /** Who's on Archnemesis, as each viewer may see (server/presence.ts). */
  readonly presence: Presence;

  constructor(store: DocStore, auth: Auth, config: Config) {
    this.store = store;
    this.auth = auth;
    this.config = config;
    this.presence = new Presence(this);
    this.perms = new Perms(
      this,
      new Links(store),
      new RepoAccess(
        () =>
          this.repoSource ?? (this.github ? githubSource(this.github, config.github.api) : null),
      ),
      config.auth.publicLinks,
      auth.provider.id === "github",
    );
    this.root = config.paths.designsRoot;
    this.stateDir = config.paths.stateDir;
    this.hocuspocus = new Hocuspocus<ConnContext>({
      name: "archnm",
      quiet: true,
      // Every update is stored as it happens (Live), so there's nothing to debounce-store.
      debounce: 0,
      // A socket that hasn't answered a ping (every 10s) for 30s is gone: its presence goes too.
      timeout: 30_000,
      onAuthenticate: async ({
        token,
        requestParameters,
        requestHeaders,
        connectionConfig,
        documentName,
      }) => {
        // Behind tailscale serve the identity comes from headers on the upgrade request.
        const { bearer, share } = splitToken(token);
        const principal = this.auth.identify({
          token: bearer,
          name: requestParameters.get("name"),
          headers: requestHeaders,
        });
        // A share link rides in the auth message, never the URL; checked once, at the edge.
        const pass = this.perms.present(share, requestHeaders.get("x-archnm-addr") ?? "");
        const who: Who = principal ?? (pass ? GUEST : null);
        if (!who) throw new Error("not signed in");
        await this.perms.prepare(who, documentName);
        // Someone else's private design doesn't exist, as far as you can tell.
        if (!this.perms.can(who, documentName, "view", pass))
          throw new Error(principal ? `no design ${documentName}` : "not signed in");
        // Read-only from the first message on (set again in `connected`, which runs later): the
        // server drops the updates of anyone who may not edit, whatever their client does.
        if (!this.perms.can(who, documentName, "edit") || this.get(documentName)?.mode === "mirror")
          connectionConfig.readOnly = true;
        return {
          principal: principal ?? null,
          guest: !principal,
          pass,
          linkId: this.perms.linkId(pass),
          guestId: `guest:${randomUUID().slice(0, 8)}`,
        } satisfies ConnContext;
      },
      onConnect: async ({ documentName }) => {
        // Exact here: the live document is kept under this name, so "Acme" would be a second copy.
        if (documentName !== documentName.toLowerCase() || !this.get(documentName))
          throw new Error(`no design ${documentName}`);
      },
      // A guest's awareness is rewritten here: whatever name its browser claims, it's "Guest".
      beforeHandleAwareness: async ({ context, states }) => {
        if (context?.guest) for (const st of states.values()) st.user = guestUser(context.guestId);
      },
      connected: async ({ connection, context, documentName }) => {
        // A mirror of git's main is never edited directly: the browser forks instead.
        const who: Who = context.principal ?? GUEST;
        if (!this.perms.can(who, documentName, "edit") || this.get(documentName)?.mode === "mirror")
          connection.readOnly = true;
        // A new tab hears who's on now (as it may see them), even when its arrival doesn't change the list.
        setTimeout(
          () =>
            connection.sendStateless(
              JSON.stringify({
                type: "here",
                people: this.presence.here({ who, pass: context.pass }),
              }),
            ),
          500,
        );
      },
      // Who's on Archnemesis anywhere: every change to anyone's presence, and every socket that
      // closes, sends each tab its own list (debounced; server/presence.ts), so people on other
      // designs and forks show too, to those who may see them.
      onAwarenessUpdate: async () => this.presence.changed(),
      onDisconnect: async () => this.presence.changed(),
      onLoadDocument: async ({ document, documentName }) => {
        // Presence ends when a client's socket closes, never on a timer (shared/presence-link.ts).
        stopAwarenessTimer(document.awareness as unknown as { _checkInterval?: unknown });
        this.store.load(documentName, document);
      },
    });
  }

  /** Open every design there is: in the database, or a folder of files under the root. */
  /** The design(s) a fresh Archnemesis started with (this run): the server puts them in git like any new design. */
  readonly seeded: Live[] = [];

  async start(): Promise<void> {
    const keys = new Set(this.store.docs().filter((d) => !d.includes("@")));
    if (existsSync(this.root)) {
      for (const name of readdirSync(this.root))
        if (KEY_RE.test(name) && hasDesignFolder(join(this.root, name))) keys.add(name);
    }
    for (const key of [...keys].sort()) await this.open(key, "empty");
    // A fresh Archnemesis starts with one empty design; the example shop is there on request
    // (create a design from "example").
    if (!this.designs.size) this.seeded.push(await this.create(FIRST_DESIGN, slug(FIRST_DESIGN)));
    // Designs that follow git: clone/fetch, mirror main, reopen their forks.
    for (const b of this.store.bindings()) {
      const main = this.designs.get(b.design);
      if (!main) continue;
      // The state folder was moved (a new volume, the rename from atlas): a design's own
      // repo moved with it, so follow it there instead of the path it had.
      const moved = join(this.stateDir, "git", `${b.design}.git`);
      if (
        b.remote.startsWith("/") &&
        b.remote !== moved &&
        !existsSync(b.remote) &&
        existsSync(moved)
      ) {
        b.remote = moved;
        this.store.setBinding(b);
      }
      const g = new GitSync(this, main, b);
      this.git.set(b.design, g);
      // Keeps retrying in the background if the repo can't be reached right now.
      await g.boot();
    }
    // A heartbeat to every client. Clients reconnect when they've heard nothing for 30s,
    // which catches a dead server or a half-open socket, so an idle document needs
    // something to say; presence doesn't renew on a timer (shared/presence-link.ts).
    this.heartbeat = setInterval(() => {
      for (const d of this.hocuspocus.documents.values()) d.broadcastStateless("hb");
      // A link that ran out or was revoked ends the connections open on it.
      this.closeLinks();
    }, 10_000);
  }

  /** A design's main by key, or a fork by its document name. */
  get(name: string): Live | undefined {
    // Keys are lowercase; "Acme" typed in a link or by an agent means "acme".
    const k = name.trim().toLowerCase();
    return this.designs.get(k) ?? this.forks.get(k);
  }

  /** People and agents connected to one document right now. */
  present(doc: string): number {
    return [...(this.hocuspocus.documents.get(doc)?.awareness.getStates().values() ?? [])].filter(
      (s) => (s as { user?: unknown }).user,
    ).length;
  }

  list(who: Who = null, all = false): DesignInfo[] {
    return [...this.designs.values()]
      .filter((d) => all || this.perms.can(who, d.key, "view"))
      .map((d) => {
        const forks = [...this.forks.values()].filter((f) => f.design === d.key);
        // Still opening (no document yet): left out until it's ready.
        if (!d.ready) return null;
        return {
          key: d.key,
          name: d.name(),
          objects: d.state.objects.size,
          diagrams: d.state.diagrams.size,
          present: this.present(d.key) + forks.reduce((n, f) => n + this.present(f.key), 0),
          forks: forks.length,
          git: this.git.has(d.key),
          private: this.access(d.key).private,
          mine: this.perms.owns(who, d.key),
        };
      })
      .filter((d): d is NonNullable<typeof d> => d !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Open a fork's document: a copy of `from` when it's new, else what's stored. */
  async openFork(row: ForkRow, from: Live): Promise<Live> {
    const live = new Live(this, row.doc, null, { design: row.design, branch: row.name });
    this.forks.set(row.doc, live);
    try {
      await live.start("empty", undefined, from);
    } catch (e) {
      this.forks.delete(row.doc);
      live.close();
      throw e;
    }
    return live;
  }

  /** Close a fork: its tabs are told where to go, then it stops being served. */
  dropFork(doc: string, to: string, why: string): void {
    const live = this.forks.get(doc);
    if (!live) return;
    this.broadcast(doc, { type: "moved", to, why });
    this.perms.links.drop(doc, false);
    this.forks.delete(doc);
    live.close();
    // Give the tabs a moment to hear it before their connections go.
    setTimeout(() => {
      for (const c of this.connectionsOf(doc)) c.close({ code: 4404, reason: "fork closed" });
    }, 1500);
  }

  /**
   * Stop taking edits from the tabs already on a document (it just became git's main), and
   * have them reload, which reconnects them read-only.
   */
  freeze(doc: string, why: string): void {
    for (const c of this.connectionsOf(doc)) c.readOnly = true;
    this.broadcast(doc, { type: "moved", to: doc, why });
  }

  /** The tabs' connections to a document (Hocuspocus keys its map by them). */
  private connectionsOf(
    doc: string,
  ): { readOnly: boolean; close(e?: { code: number; reason: string }): void }[] {
    const d = this.hocuspocus.documents.get(doc) as unknown as
      { connections?: Map<{ readOnly: boolean; close(e?: unknown): void }, unknown> } | undefined;
    return [...(d?.connections?.keys() ?? [])];
  }

  /** Close the connections on a share link that no longer works (all of one link, or every dead one). */
  closeLinks(only?: string): void {
    for (const d of this.hocuspocus.documents.values())
      for (const c of d.connections.keys() as Iterable<{
        context?: ConnContext;
        close(e?: { code: number; reason: string }): void;
      }>) {
        const id = c.context?.linkId;
        if (id && (id === only || (!only && !this.perms.links.valid(id))))
          c.close({ code: 4403, reason: "that link no longer works" });
      }
  }

  /** A small message to every tab on a document (not part of the document). */
  broadcast(doc: string, payload: unknown): void {
    this.hocuspocus.documents.get(doc)?.broadcastStateless(JSON.stringify(payload));
  }

  // --- who sees a design ------------------------------------------------------------------
  //
  // Three layers: what you're doing yourself (your private designs, your forks), what the
  // team sees (shared designs), and what's kept in git (a design that follows a repo, whose
  // main mirrors it). A design you make starts private; sharing it moves it to the team.
  // Designs from before owners existed, and every git design, belong to the team.

  /** A design's owner and whether it's private. */
  access(design: string): Access {
    const owner = this.store.setting(`design.owner:${design}`);
    return {
      owner,
      private:
        !!owner && this.store.setting(`design.private:${design}`) === "1" && !this.git.has(design),
    };
  }

  /** Make a design private to its owner, or share it with the team. */
  setPrivate(design: string, priv: boolean): void {
    if (priv && this.git.has(design))
      throw new ModelError("a design that follows git is the team's: it can't be private");
    if (priv && !this.access(design).owner)
      throw new ModelError("this design has no owner, so it can't be private");
    this.store.setSetting(`design.private:${design}`, priv ? "1" : "0");
    this.presence.changed(true);
  }

  /**
   * Delete a design that doesn't follow git. Its files move aside (under the state folder's
   * deleted/), its history leaves the database, and anyone on it is sent elsewhere.
   */
  remove(design: string, why: string): void {
    const live = this.designs.get(design);
    if (!live) throw new ModelError(`no design "${design}"`);
    if (this.git.has(design))
      throw new ModelError(
        `${design} follows a git repo: it isn't deleted here (reconnect it instead)`,
      );
    if (this.designs.size <= 1) throw new ModelError("it's the only design: make another first");
    // The files go aside first: if that fails, nothing else has changed and it stays listed.
    const dir = join(this.root, design);
    if (existsSync(dir)) {
      const aside = join(this.stateDir, "deleted");
      mkdirSync(aside, { recursive: true });
      moveDir(dir, join(aside, `${design}-${new Date().toISOString().replace(/[:.]/g, "-")}`));
    }
    this.broadcast(design, { type: "deleted", why });
    this.designs.delete(design);
    live.close();
    this.store.dropDoc(design);
    this.store.deleteSetting(`design.owner:${design}`);
    this.store.deleteSetting(`design.private:${design}`);
    this.perms.links.drop(design, true);
    setTimeout(() => {
      for (const c of this.connectionsOf(design)) c.close({ code: 4404, reason: "design deleted" });
    }, 1500);
    this.presence.changed(true);
  }

  /** A new design, empty (one blank diagram) or a copy of the example shop. */
  async create(
    name: string,
    key?: string,
    from: Seed = "empty",
    owner?: Principal | null,
    /** Start as a copy of this document's current state (a private copy someone makes of a design or fork). */
    copyOf?: Live,
  ): Promise<Live> {
    const k = key?.trim().toLowerCase() ?? slug(name);
    if (!KEY_RE.test(k))
      throw new ModelError(
        `"${k}" can't be a design key: lowercase letters, digits and -, up to 48`,
      );
    if (this.designs.has(k)) throw new ModelError(`there's already a design "${k}"`);
    if (!this.config.limits.examples) from = "empty";
    // Each design is a live document and a watched folder: not an unlimited supply.
    const max = this.config.limits.maxDesigns;
    if (this.designs.size >= max)
      throw new ModelError(
        `there are already ${this.designs.size} designs, the most this Archnemesis allows (ARCHNM_MAX_DESIGNS)`,
      );
    // Yours alone until you share it (an agent's goes to the person it works for).
    // An agent working for "anyone local" has no one person to give it to: the team gets it.
    const ownerId = !owner
      ? null
      : owner.kind === "agent"
        ? owner.for && owner.for !== "local:*"
          ? owner.for
          : null
        : owner.id;
    if (ownerId) {
      this.store.setSetting(`design.owner:${k}`, ownerId);
      this.store.setSetting(`design.private:${k}`, "1");
    }
    return this.open(k, from, name, copyOf);
  }

  private async open(key: string, seed: Seed, name?: string, copyOf?: Live): Promise<Live> {
    const live = new Live(this, key, join(this.root, key), { design: key, branch: null });
    // Registered first: opening its document goes through onConnect, which looks it up.
    this.designs.set(key, live);
    try {
      await live.start(seed, name, copyOf);
    } catch (e) {
      this.designs.delete(key);
      live.close();
      throw e;
    }
    return live;
  }

  /** Hand a WebSocket upgrade on /sync to Hocuspocus. */
  upgrade(req: http.IncomingMessage, socket: import("node:stream").Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      const url = new URL(req.url ?? "/", "http://archnm");
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers))
        if (typeof v === "string") headers.set(k, v);
      // Where the socket really comes from (never a header the client sent): link checks are limited per address.
      headers.set("x-archnm-addr", clientAddr(req, this.config.auth.proxies));
      const request = new Request(url, { headers });
      const client = this.hocuspocus.handleConnection(ws, request);
      ws.on("message", (data: Buffer) => client.handleMessage(new Uint8Array(data)));
      ws.on("close", (code: number, reason: Buffer) =>
        client.handleClose({ code, reason: reason.toString() } as CloseEvent),
      );
      ws.on("pong", () => client.touch());
      // A bad frame (too big, malformed) closes this socket; it never reaches the process.
      ws.on("error", (e: Error) => {
        console.warn("archnm: socket error:", e.message);
        ws.terminate();
      });
      const ping = setInterval(() => ws.readyState === ws.OPEN && ws.ping(), 10_000);
      ws.on("close", () => clearInterval(ping));
    });
  }

  async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.presence.closeTimers();
    // Commit what forks have waiting, so nothing typed in the last minute is lost.
    await Promise.allSettled([...this.git.values()].map((g) => g.close()));
    for (const d of this.designs.values()) d.close();
    for (const f of this.forks.values()) f.close();
    this.wss.close();
    this.hocuspocus.closeConnections();
    this.store.close();
  }
}

export class Live {
  readonly state: ModelState = emptyState();
  doc!: Y.Doc;
  private conn: { disconnect(): Promise<void> | void } | null = null;
  /** The document's name: the design's key for main, "<design>@<fork>" for a fork. */
  readonly key: string;
  /** The design it belongs to. */
  readonly design: string;
  /** The fork's name; null for main. */
  readonly branch: string | null;
  /** Its folder of files; null for a fork (forks are written straight into git). */
  files: FileSync | null;
  private undos = new Map<string, { actor: Actor; steps: UndoSteps }>();
  private listeners = new Set<(entries: LogEntry[]) => void>();
  private sweepTimer: NodeJS.Timeout | null = null;
  private version = 0;
  private idx: { v: number; index: ModelIndex } | null = null;
  private hub: Hub;

  constructor(
    hub: Hub,
    key: string,
    dir: string | null,
    where: { design: string; branch: string | null },
  ) {
    this.hub = hub;
    this.key = key;
    this.design = where.design;
    this.branch = where.branch;
    this.ownDir = dir;
    this.files = dir ? new FileSync(this, dir) : null;
  }

  /** The design's own folder (before it followed a checkout). */
  private ownDir: string | null;

  /** Set when the design follows git: main is read-only even before its mirror is up. */
  followsGit = false;

  get mode(): Mode {
    return this.branch ? "fork" : this.files?.mirror || this.followsGit ? "mirror" : "edit";
  }

  /** Where Archnemesis keeps its own state, next to the database. */
  get stateDir(): string {
    return this.hub.stateDir;
  }

  /** Bumped by every change; lets a fork tell whether it has anything new to commit. */
  get changes(): number {
    return this.version;
  }

  /**
   * Load (or create) the document, keep it open for the life of the server, and sync its
   * files. A new fork starts as a copy of `from`.
   */
  async start(seed: Seed, name?: string, from?: Live): Promise<void> {
    const fresh = this.hub.store.isNew(this.key);
    const conn = await this.hub.hocuspocus.openDirectConnection(this.key, {
      principal: { id: "archnm", name: "archnm", kind: "agent", roles: ["admin"] },
      guest: false,
      pass: null,
      linkId: null,
      guestId: "archnm",
    });
    this.conn = conn;
    this.doc = conn.document!;
    // Copied before the mirror and the store are attached: the copy is the fork's first
    // stored update, and the mirror is filled from it below.
    if (fresh && from) Y.applyUpdate(this.doc, Y.encodeStateAsUpdate(from.doc), SERVER);
    mirror(this.doc, this.state, (tr) => {
      if (!tr.changed.size) return;
      this.version++;
      if (tr.origin !== SERVER) this.scheduleSweep();
      for (const fn of this.changeListeners) fn();
    });
    // The mirror only sees later changes; fill it with what was loaded.
    fill(this.state, readState(this.doc));
    this.version++;

    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === "load") return;
      this.hub.store.append(this.key, update, originActor(origin));
    });
    const log = logOf(this.doc);
    log.observe((ev) => {
      const added = ev.changes.added;
      const entries: LogEntry[] = [];
      for (const item of added)
        for (const c of item.content.getContent()) if (logEntryOk(c)) entries.push(c);
      if (entries.length) for (const fn of this.listeners) fn(entries);
    });
    this.guardSenders();

    const meta = this.doc.getMap<string>("meta");
    if (fresh && from) {
      // Its own id (browsers cache by it) and a note of what it is.
      this.doc.transact(() => {
        meta.set("id", crypto.randomUUID());
        meta.set("branch", this.branch ?? "");
        meta.delete("filesHash");
        // A copy made of a design is a design of its own, with its own name.
        if (name) meta.set("name", name);
      }, SERVER);
      this.hub.store.append(this.key, Y.encodeStateAsUpdate(this.doc), "archnm");
      this.hub.store.compact(this.key);
    } else if (fresh) {
      const ops: Op[] =
        seed === "example"
          ? seedOps()
          : seed === "code"
            ? codeSeedOps()
            : [
                // Follows the model, so what's written (write, apply) shows up without placing it.
                {
                  op: "diagram.put",
                  diagram: makeDiagram({
                    name: "Landscape",
                    key: "landscape",
                    rules: LANDSCAPE_RULES,
                  }),
                },
              ];
      // A design that starts from files gets everything from them instead.
      if (!this.files || !hasDesignFolder(this.files.dir))
        applyOps(
          this.doc,
          this.state,
          ops,
          SERVER,
          seed === "example" ? "example landscape" : "new design",
        );
      this.hub.store.compact(this.key);
    }
    // A fresh id per document: browsers key their offline cache by it, so a deleted
    // database never gets resurrected from an old tab's cache.
    this.doc.transact(() => {
      if (!meta.get("id")) meta.set("id", crypto.randomUUID());
      if (name && !meta.get("name")) meta.set("name", name);
    }, SERVER);
    this.files?.start();
    // Note what keep-tidy diagrams look like now, so only later changes lay them out.
    void this.keepTidy();
  }

  /**
   * A browser writes to the document directly, so it could claim to be someone else. What
   * it sends is checked against who it signed in as: a history entry in someone else's
   * name (or a malformed one) is taken out, and a note or reply it starts, or re-signs, is
   * put back in its sender's name. Editing someone else's note (resolving it) keeps theirs.
   */
  private guardSenders(): void {
    const log = logOf(this.doc);
    log.observe((ev, tr) => {
      const p = senderOf(tr.origin);
      if (!p) return;
      const bad = new Set<unknown>();
      for (const item of ev.changes.added)
        for (const e of item.content.getContent())
          if (!logEntryOk(e) || e.actor.id !== p.id) bad.add(e);
      if (!bad.size) return;
      console.warn(
        `archnm: ${this.key}: took out ${bad.size} history entr${bad.size === 1 ? "y" : "ies"} ${p.id} wrote in someone else's name`,
      );
      queueMicrotask(() =>
        this.doc.transact(() => {
          const all = log.toArray();
          for (let i = all.length - 1; i >= 0; i--) if (bad.has(all[i])) log.delete(i, 1);
        }, SERVER),
      );
    });
    for (const table of ["notes", "replies"] as const) {
      const map = this.doc.getMap<unknown>(table);
      map.observeDeep((events, tr) => {
        const p = senderOf(tr.origin);
        if (!p) return;
        const mine = { id: p.id, name: p.name, kind: p.kind === "agent" ? "agent" : "human" };
        const authorId = (a: unknown) => (a as { id?: unknown } | undefined)?.id;
        const fix: [Y.Map<unknown>, unknown][] = [];
        for (const ev of events) {
          if (ev.target === map) {
            // A whole record set: a new note or reply. It's the sender's.
            for (const k of (ev as Y.YMapEvent<unknown>).keysChanged) {
              const rec = map.get(k);
              if (rec instanceof Y.Map && authorId(rec.get("author")) !== p.id)
                fix.push([rec, mine]);
            }
          } else if (ev.target instanceof Y.Map && ev.target.parent === map) {
            // A field of an existing one: the author can't be changed to someone else.
            const change = (ev as Y.YMapEvent<unknown>).changes.keys.get("author");
            if (!change) continue;
            const now = ev.target.get("author");
            if (authorId(now) !== p.id && authorId(now) !== authorId(change.oldValue))
              fix.push([ev.target, change.oldValue ?? mine]);
          }
        }
        if (fix.length) {
          console.warn(
            `archnm: ${this.key}: ${p.id} wrote ${table} in someone else's name; put back`,
          );
          queueMicrotask(() =>
            this.doc.transact(
              () => fix.forEach(([rec, author]) => rec.set("author", author)),
              SERVER,
            ),
          );
        }
      });
    }
  }

  /** Follow a checkout read-only (git's main), instead of writing a folder of our own. */
  follow(dir: string): void {
    this.files?.close();
    this.files = new FileSync(this, dir, { mirror: true });
    this.files.start();
  }

  private copy: FolderCopy | null = null;
  /**
   * Whether the design's own folder keeps a copy of main. Yes while main follows a repo
   * Archnemesis keeps itself, so the files people commit with their code stay current; no
   * for a real remote, where the repo is the place to look.
   */
  keepCopy(on: boolean): void {
    if (on === !!this.copy) return;
    this.copy?.close();
    this.copy = on && this.ownDir ? new FolderCopy(this, this.ownDir) : null;
    this.copy?.start();
  }

  /** Connecting to git failed: back to the design's own folder, edited directly again. */
  unfollow(): void {
    this.followsGit = false;
    this.keepCopy(false);
    if (!this.files?.mirror) return;
    this.files.close();
    this.files = this.ownDir ? new FileSync(this, this.ownDir) : null;
    this.files?.start();
  }

  docId(): string {
    return this.doc.getMap<string>("meta").get("id") ?? "";
  }

  name(): string {
    return this.doc.getMap<string>("meta").get("name") ?? this.key;
  }

  /**
   * archnm.yaml's settings (its rules), kept in the document so a fork carries them, a
   * commit writes them back and check holds an agent's edits to them.
   */
  config(): FConfig {
    try {
      return {
        ...(JSON.parse(this.doc.getMap<string>("meta").get("config") ?? "{}") as FConfig),
        name: this.name(),
      };
    } catch {
      return { name: this.name() };
    }
  }

  setConfig(config: FConfig): void {
    const { name: _, ...rest } = config;
    const v = JSON.stringify(rest);
    const meta = this.doc.getMap<string>("meta");
    if (meta.get("config") !== v) this.doc.transact(() => meta.set("config", v), SERVER);
  }

  setName(name: string): void {
    const n = name.trim().slice(0, 80);
    if (n && n !== this.name())
      this.doc.transact(() => this.doc.getMap<string>("meta").set("name", n), SERVER);
  }

  /** The awareness of this design's document (presence), shared with every tab. */
  awareness(): { setLocalState(s: unknown): void } | null {
    return (
      (this.hub.hocuspocus.documents.get(this.key)?.awareness as unknown as {
        setLocalState(s: unknown): void;
      }) ?? null
    );
  }

  index(): ModelIndex {
    if (this.idx?.v !== this.version) {
      this.idx = {
        v: this.version,
        index: buildIndex({
          objects: this.state.objects.values(),
          connections: this.state.connections.values(),
          diagrams: this.state.diagrams.values(),
          placements: this.state.placements.values(),
          flows: this.state.flows.values(),
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

  /** Apply a batch as `p`; every open tab sees it at once. Throws ModelError on a bad batch. */
  commit(p: Principal, ops: Op[], label: string, opts?: CommitOpts): string[] {
    // Threads are the one thing on git's main that git doesn't hold (they aren't in the files).
    if (this.mode === "mirror" && !ops.every((op) => isThreadOp(op, this.state.notes)))
      throw new ModelError(
        `${this.design}'s main follows git, so it isn't edited directly: edits go to a fork`,
      );
    const { actor, steps } = this.undoFor(p);
    // A copy: the session's actor is renamed by the next call's as, and the log keeps what it's given.
    const ids = steps.apply(this.state, ops, { ...actor }, label, opts);
    if (p.kind === "agent") this.showAgent(p, ids, label);
    return ids;
  }

  /**
   * Agents show up like people do: a dot in everyone's top bar, the boxes they just
   * touched outlined in their colour, and what they said they were doing. The server has
   * one presence slot, so the latest agent wins it; it clears after a quiet spell.
   */
  private agentTimer: NodeJS.Timeout | null = null;
  /** Where an agent is walking its person through (MCP point): kept in its presence. */
  private guide: Guide | null = null;
  private guideTimer: NodeJS.Timeout | null = null;
  private guideState: Record<string, unknown> = {};

  /** Steer the tabs of the person `p` works for to a view (a box, a flow step), with a line to read. */
  point(p: Principal, g: Omit<Guide, "for" | "seq" | "by">): void {
    const awareness = this.awareness();
    if (!awareness || !p.for) return;
    this.guide = { ...g, for: p.for, by: p.id, seq: (this.guide?.seq ?? 0) + 1 };
    this.guideState = {
      user: { id: p.id, name: p.name, color: "#c084fc", kind: "agent" },
      diagram: g.diagram,
      cursor: null,
      selected: g.object ? [g.object] : (g.objects ?? []),
      moving: [],
      activity: g.say,
      guide: this.guide,
    };
    awareness.setLocalState(this.guideState);
    if (this.agentTimer) clearTimeout(this.agentTimer);
    if (this.guideTimer) clearTimeout(this.guideTimer);
    // A walkthrough waits for the person between steps, so it ends only after a long quiet
    // spell; a plain "look here" is read in seconds and goes after a few minutes.
    this.guideTimer = setTimeout(() => this.endGuide(), (g.waiting ? 30 : 5) * 60_000);
  }

  private replies = new Map<number, { resolve: (r: GuideReply | null) => void }[]>();
  private answered = new Map<number, GuideReply>();

  /** Wait for the person's Next / Back / Stop / question on step `seq`; null when `ms` runs out. */
  waitReply(seq: number, ms: number): Promise<GuideReply | null> {
    const done = this.answered.get(seq);
    if (done) return Promise.resolve(done);
    return new Promise((resolve) => {
      const list = this.replies.get(seq) ?? [];
      const entry = { resolve };
      list.push(entry);
      this.replies.set(seq, list);
      this.setListening();
      setTimeout(() => {
        const l = this.replies.get(seq);
        if (l?.includes(entry)) {
          l.splice(l.indexOf(entry), 1);
          resolve(null);
          this.setListening();
        }
      }, ms);
    });
  }

  private listenTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Tell the tab whether a wait call is open. Going quiet waits a few seconds: an agent
   * that's still there calls again straight away, and the bar shouldn't flicker.
   */
  private setListening(): void {
    const on = [...this.replies.values()].some((l) => l.length > 0);
    if (this.listenTimer) clearTimeout(this.listenTimer);
    const apply = () => {
      if (!this.guide || this.guide.listening === on) return;
      this.guide = { ...this.guide, listening: on };
      this.guideState = { ...this.guideState, guide: this.guide };
      this.awareness()?.setLocalState(this.guideState);
    };
    if (on) apply();
    else this.listenTimer = setTimeout(apply, 4000);
  }

  /** The person answered a guided step. Only whoever is being guided can. */
  reply(who: Principal, seq: number, r: GuideReply): boolean {
    const g = this.guide;
    if (!g || g.seq !== seq) return false;
    if (!(g.for === who.id || (g.for === "local:*" && who.id.startsWith("local:")))) return false;
    this.answered.set(seq, r);
    if (this.answered.size > 50) this.answered.delete(this.answered.keys().next().value!);
    for (const w of this.replies.get(seq) ?? []) w.resolve(r);
    this.replies.delete(seq);
    this.setListening();
    if (r.action === "stop") this.endGuide();
    else if (this.guide) {
      // The bar stops offering Next until the agent's next point.
      this.guide = { ...this.guide, waiting: false };
      this.guideState = { ...this.guideState, guide: this.guide };
      this.awareness()?.setLocalState(this.guideState);
    }
    return true;
  }

  get guideSeq(): number | null {
    return this.guide?.seq ?? null;
  }

  endGuide(): void {
    this.guide = null;
    if (this.guideTimer) clearTimeout(this.guideTimer);
    this.awareness()?.setLocalState(null);
  }

  private showAgent(p: Principal, ids: string[], label: string): void {
    const awareness = this.awareness();
    if (!awareness) return;
    const idx = this.index();
    const objects = ids.filter((id) => idx.objects.has(id));
    const diagram = objects.map((id) => [...(idx.placedOn.get(id) ?? [])][0]).find(Boolean) ?? null;
    awareness.setLocalState({
      user: { id: p.id, name: p.name, color: "#c084fc", kind: "agent" },
      diagram,
      cursor: null,
      selected: objects.slice(0, 40),
      moving: [],
      activity: label,
      // An edit mid-walkthrough doesn't end it.
      ...(this.guide ? { guide: this.guide } : {}),
    });
    if (this.agentTimer) clearTimeout(this.agentTimer);
    if (!this.guide) this.agentTimer = setTimeout(() => awareness.setLocalState(null), 15_000);
  }

  /** Undo `p`'s last step (only theirs; dry: only say it). What it was, or null when there's nothing to undo. */
  undo(p: Principal, dry = false): string | null {
    return this.undoFor(p).steps.undo(dry);
  }

  recent(n = 50): LogEntry[] {
    return logOf(this.doc).toArray().filter(logEntryOk).slice(-n);
  }

  private changeListeners = new Set<() => void>();
  /** Called after every change to the document, from anyone. */
  onChange(fn: () => void): () => void {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  onLog(fn: (entries: LogEntry[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  close(): void {
    this.files?.close();
    this.copy?.close();
    this.copy = null;
    if (this.sweepTimer) clearTimeout(this.sweepTimer);
    if (this.agentTimer) clearTimeout(this.agentTimer);
    // Let Hocuspocus unload the document once its tabs are gone too (a closed fork).
    void this.conn?.disconnect();
    this.conn = null;
  }

  /** Has start() finished (the document is there to read)? */
  get ready(): boolean {
    return this.conn !== null;
  }

  private undoFor(p: Principal): { actor: Actor; steps: UndoSteps } {
    // Each MCP session of an agent has its own undo (workers sharing a fork don't undo each other), under its current name.
    const key = p.session ? `${p.id}#${p.session}` : p.id;
    let u = this.undos.get(key);
    if (!u) {
      const actor = actorOf(p);
      u = { actor, steps: new UndoSteps(this.doc, actor) };
      this.undos.set(key, u);
    } else if (u.actor.name !== p.name) u.actor.name = p.name;
    return u;
  }

  /** Where a diagram that follows rules last had each box it dropped ("diagram|object"). */
  private dropped = new Map<string, Placement>();

  /** Bring every diagram that follows rules in line with the model as it is now. */
  applyRules(): void {
    const idx = this.index();
    // A box that comes back (an undone move out of a box's scope) goes back where it was.
    const recall = (d: string, id: string) => this.dropped.get(`${d}|${id}`);
    const ops = [...idx.diagrams.values()]
      .filter((d) => d.rules)
      .flatMap((d) => viewOps(idx, d.id, recall));
    if (!ops.length) return;
    for (const op of ops) {
      if (op.op === "placement.delete") {
        const was = idx.placements.get(op.diagramId)?.get(op.objectId);
        if (was) this.dropped.set(`${op.diagramId}|${op.objectId}`, was);
      } else if (op.op === "placement.put")
        this.dropped.delete(`${op.placement.diagramId}|${op.placement.objectId}`);
    }
    try {
      applyOps(this.doc, this.state, ops, SERVER, "diagrams followed the model", SERVER, {
        pin: false,
      });
    } catch (e) {
      console.error("applying diagram rules:", e);
    }
  }

  private scheduleSweep(): void {
    if (this.sweepTimer) clearTimeout(this.sweepTimer);
    this.sweepTimer = setTimeout(() => {
      this.sweepTimer = null;
      sweep(this.doc, this.state, SERVER);
      const moved = linkNoteOps(this.state);
      if (moved.length) {
        try {
          applyOps(this.doc, this.state, moved, SERVER, "moved links onto their boxes", SERVER, {
            pin: false,
          });
        } catch (e) {
          console.error("moving links:", e);
        }
      }
      this.applyRules();
      void this.keepTidy();
    }, 400);
  }

  /** What each keep-tidy diagram looked like (its direction and structure) when last laid out. */
  private tidied = new Map<string, string>();
  private tidying = false;

  /**
   * Keep tidy: a diagram that asks for it is laid out again when a box or arrow comes or
   * goes, or its direction changes. Moving a box doesn't count, so a hand placement stays
   * until the next change of structure. The first look (a server start) only takes note.
   */
  async keepTidy(): Promise<void> {
    if (this.tidying) return;
    this.tidying = true;
    try {
      const idx = this.index();
      for (const d of idx.diagrams.values()) {
        if (!d.tidy || !d.keepTidy) {
          this.tidied.delete(d.id);
          continue;
        }
        const sig = `${d.tidy}|${structureOf(projectDiagram(idx, d.id))}`;
        const was = this.tidied.get(d.id);
        this.tidied.set(d.id, sig);
        // The first pass after start learns how things are; a view made after that is new
        // and gets laid out the first time it's seen.
        if (was === sig || (was === undefined && !this.tidySeen)) continue;
        const ops = await layoutOps(this.index(), d.id, d.tidy, this.config().tags);
        if (!ops.length) continue;
        try {
          applyOps(this.doc, this.state, ops, SERVER, `kept ${d.name} tidy`, SERVER, {
            pin: false,
          });
        } catch (e) {
          console.error("keeping a diagram tidy:", e);
        }
      }
      this.tidySeen = true;
    } finally {
      this.tidying = false;
    }
  }
  private tidySeen = false;
}

function originActor(origin: unknown): string | null {
  if (origin && typeof origin === "object") {
    const o = origin as { id?: string; source?: string; connection?: { context?: ConnContext } };
    if (o.source === "connection") return o.connection?.context?.principal?.id ?? null;
    if (typeof o.id === "string") return o.id;
  }
  return null;
}

/**
 * Move a folder, across filesystems too (the designs and the state dir often live on
 * different ones, where rename fails with EXDEV): copy, then remove the original. A copy
 * that fails partway is removed again, so the original is never left half-moved.
 */
function moveDir(from: string, to: string): void {
  try {
    renameSync(from, to);
    return;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
  }
  try {
    cpSync(from, to, { recursive: true, preserveTimestamps: true });
  } catch (e) {
    rmSync(to, { recursive: true, force: true });
    throw e;
  }
  rmSync(from, { recursive: true, force: true });
}
