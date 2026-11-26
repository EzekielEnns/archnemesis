// A design that follows a git repo: main mirrors the repo, edits happen on forks, forks
// are committed to their own branch, and merging a fork brings everyone back to main.
//
//   main    the clone's checkout, kept at origin's main (fetched every ARCHNM_GIT_POLL_MS, and on
//           "Sync now"); the design's main document mirrors it read-only (FileSync).
//   forks   documents "<design>@<name>", copies of main from a commit (their base). After
//           edits settle (ARCHNM_GIT_IDLE_MS, or at most every ARCHNM_GIT_MAX_MS) a fork's files are committed to
//           archnm/<design>/<name>, on top of its base, and pushed.
//   merge   a fork's branch is merged into main inside Archnemesis (merge-tree, no working tree)
//           and pushed; the next fetch sees main contains it, and the fork closes: its tabs
//           move to main. A fork merged anywhere else (a pull request) closes the same way.
//
// Everything is plain git, so the remote can be GitHub, a self-hosted forge, or a bare
// repo on disk. Pull requests and catching a fork up with a newer main come later
// (docs/ROADMAP.md).
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  appendLog,
  applyOps,
  emptyState,
  type Actor,
  type LogEntry,
  type ModelState,
} from "../shared/doc.ts";
import { changeHeadline, changeList, stateFromFiles } from "../shared/diff.ts";
import {
  DESIGN_FILE,
  keyOps,
  normalizeDesignFile,
  OLD_DESIGN_FILE,
  readFiles,
  writeFiles,
} from "../shared/files.ts";
import { slug, type Op } from "../shared/model.ts";
import type { Principal } from "./auth.ts";
import type { Config } from "./config.ts";
import { isOurs } from "./files.ts";
import { forgeName, forgeOf, proposeUrl, type Forge } from "./forge.ts";
import { GitError, personFor, Repo } from "./git.ts";
import { GitHubError, repoOf } from "./github.ts";
import type { GitInfo, PullState } from "../shared/api.ts";
import { KEY_RE, type Hub, type Live } from "./live.ts";
import type { Binding, ForkRow } from "./store.ts";

const SERVER: Actor = { id: "archnm", name: "archnm", kind: "system" };
const GIT: Actor = { id: "git", name: "git", kind: "system" };

interface ForkRun {
  row: ForkRow;
  live: Live;
  idle: NodeJS.Timeout | null;
  max: NodeJS.Timeout | null;
  /** The document's change count at the last commit (or open). */
  committedAt: number;
  /** A commit is being made right now. */
  saving: boolean;
  /** Commits that failed in a row: each retry waits longer. */
  failures: number;
  /** The commit in progress (or the last one): commits run one after another. */
  chain: Promise<unknown>;
  /** Who edited since the last commit, and what they said they did. */
  actors: Map<string, { name: string; n: number }>;
  labels: string[];
  behind: number;
  pr: PullState | null;
  unlisten: () => void;
}

/** A remote shown without anything secret in it (a token in an https URL). */
const safeRemote = (r: string) => r.replace(/\/\/[^/@]*@/, "//");

export class GitSync {
  readonly repo: Repo;
  private runs = new Map<string, ForkRun>();
  private timer: NodeJS.Timeout | null = null;
  private mainSha: string | null = null;
  private syncedAt: string | null = null;
  private syncing = false;
  private error: string | null = null;
  private closed = false;

  private hub: Hub;
  private readonly cfg: Config["git"];
  readonly main: Live;
  readonly binding: Binding;
  readonly forge: Forge | null;
  /** owner/repo when this is a GitHub repo, and whether Archnemesis reaches it through its app. */
  private gh: { owner: string; repo: string } | null;
  private viaApp = false;
  private appCheckedAt = 0;
  private started = false;
  /** Sync now was asked for while a sync was running: run once more after it. */
  private again = false;

  constructor(hub: Hub, main: Live, binding: Binding) {
    this.hub = hub;
    this.cfg = hub.config.git;
    this.main = main;
    this.binding = binding;
    this.forge = forgeOf(binding.remote, this.cfg.forges);
    this.gh = repoOf(binding.remote, hub.config.github.host);
    main.followsGit = true;
    this.repo = new Repo(join(hub.stateDir, "repos", binding.design), binding.remote, this.cfg);
  }

  /** Where the design lives, in words for people: "Acme/architecture, branch archnm-poc, folder archnm/". */
  where(): { repo: string; branch: string; folder: string; forks: string } {
    const b = this.binding;
    // Never the remote itself: it can carry a token, or a server path.
    const repo = this.gh
      ? `${this.gh.owner}/${this.gh.repo} on GitHub`
      : this.forge
        ? `a repo on ${new URL(b.remote.replace(/^git@([^:]+):/, "https://$1/")).hostname}`
        : "a repo Archnemesis keeps itself";
    return {
      repo,
      branch: b.branch,
      folder: this.filePrefix || "(the repo's root)",
      forks: `archnm/${b.design}/<fork>`,
    };
  }

  /** The design's folder inside the clone. */
  get folder(): string {
    return join(this.repo.dir, this.binding.path);
  }

  private get filePrefix(): string {
    return this.binding.path ? `${this.binding.path.replace(/\/+$/, "")}/` : "";
  }

  /** A fork's git branch: the one stored for it (forks made before the rename keep `atlas/...`). */
  branchOf(row: ForkRow): string {
    return row.branch ?? `atlas/${row.design}/${row.name}`;
  }

  /**
   * Clone (or reuse the clone), make sure main has the design, mirror it, and reopen the
   * forks. A repo that doesn't have the design yet gets it from Archnemesis: one commit on main.
   * `first`: the design is being connected now (not reopened after a restart).
   */
  async start(first = false, addHere = false): Promise<void> {
    const b = this.binding;
    await this.connectApp();
    await this.repo.exclusive(async () => {
      await this.repo.ensure();
      await this.repo.fetch();
    });
    let sha = await this.repo.remoteHead(b.branch);
    const hasDesign = sha
      ? (await this.repo.has(sha, `${this.filePrefix}${DESIGN_FILE}`)) ||
        (await this.repo.has(sha, `${this.filePrefix}${OLD_DESIGN_FILE}`))
      : false;
    if (!hasDesign) {
      // Only ever onto a branch Archnemesis starts, or where an admin asked for it: never quietly
      // onto a branch people already use, like main.
      if (sha && !(first && addHere))
        throw new GitError(
          `${safeRemote(b.remote)} has no Archnemesis design ${b.path ? `in ${b.path}/ ` : ""}on ${b.branch}. Follow a new branch (like "archnm") to start one there, or an admin can choose to add it to ${b.branch}.`,
        );
      // First time: what Archnemesis has becomes the repo's design.
      sha = await this.repo.exclusive(async () => {
        const files = this.filesOf(this.main);
        const commit = await this.repo.commitFiles({
          start: sha,
          parents: sha ? [sha] : [],
          subpath: b.path,
          files,
          owned: isOurs,
          message: `archnm: add ${this.main.name()}`,
          author: { name: "archnm", email: "archnm@localhost" },
        });
        if (commit) {
          await this.repo.push(commit, b.branch);
          await this.repo.fetch();
        }
        return (await this.repo.remoteHead(b.branch)) ?? commit;
      });
    } else if (
      first &&
      !this.main.files?.mirror &&
      this.main.state.objects.size &&
      this.hub.store.forks(b.design, null).length === 0
    ) {
      // The repo already has this design, and Archnemesis has its own copy: keep Archnemesis's as a
      // fork, so nothing is lost, before main starts following the repo.
      await this.repo.checkout(sha!);
      this.mainSha = sha;
      await this.fork(
        { id: "archnm", name: "archnm", kind: "human", roles: ["admin"] } as Principal,
        "before-git",
      );
    }
    if (!sha) throw new GitError(`couldn't put the design on ${b.branch}`);
    await this.repo.exclusive(() => this.repo.checkout(sha!));
    this.mainSha = sha;
    this.syncedAt = new Date().toISOString();
    if (!this.main.files?.mirror) this.main.follow(this.folder);
    this.main.keepCopy(this.isLocal());
    for (const row of this.hub.store.forks(b.design)) {
      if (this.runs.has(row.doc)) continue;
      const live = await this.hub.openFork(row, this.main);
      const run = this.track(row, live);
      await this.catchUncommitted(run);
    }
    this.started = true;
    await this.sync();
    this.timer ??= setInterval(() => void this.sync(), this.cfg.pollMs);
  }

  /**
   * Start after a restart. If the repo can't be reached (no network, say), keep the design
   * read-only and try again on every poll and on Sync now, instead of staying half-started.
   */
  async boot(): Promise<void> {
    try {
      await this.start();
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      console.error(`archnm: git for ${this.binding.design}:`, this.error);
      this.timer ??= setInterval(() => void this.sync(), this.cfg.pollMs);
    }
  }

  /**
   * On GitHub, use Archnemesis's GitHub App when it's installed on the repo: git over https with
   * the app's token. Otherwise git as configured on this machine (ssh keys, say). Checked
   * again every few minutes, so installing the app later just starts working.
   */
  private async connectApp(now = false): Promise<void> {
    const github = this.hub.github;
    if (!github?.configured || !this.gh || this.viaApp) return;
    // Every few minutes on its own; on Sync now, at most every 15s (it's a GitHub API call).
    if (Date.now() - this.appCheckedAt < (now ? 15_000 : 5 * 60_000)) return;
    this.appCheckedAt = Date.now();
    const { owner, repo } = this.gh;
    let token: string | null = null;
    try {
      token = await github.repoToken(owner, repo);
    } catch (e) {
      const why = `GitHub App: ${e instanceof Error ? e.message : String(e)}`;
      console.warn(`archnm: ${owner}/${repo}: ${why}`);
      // Asked for by someone: show them why, instead of a sync that seems to work.
      if (now) throw new GitError(why);
    }
    if (!token) return;
    const auth = async () => {
      const t = await github.repoToken(owner, repo);
      if (!t) throw new GitError(`Archnemesis's GitHub App was removed from ${owner}/${repo}`);
      return github.gitEnv(t);
    };
    const remote = github.httpsRemote(owner, repo);
    // An existing clone still points at the old remote: point it at the https one first,
    // and only then switch over, so a failure here leaves things as they were.
    if (existsSync(join(this.repo.dir, ".git")))
      await this.repo.exclusive(() => this.repo.git(["remote", "set-url", "origin", "--", remote]));
    this.repo.remote = remote;
    this.repo.auth = auth;
    this.viaApp = true;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    for (const run of this.runs.values()) {
      if (run.live.changes !== run.committedAt) await this.commit(run).catch(() => {});
      this.stopRun(run);
    }
  }

  // --- main -------------------------------------------------------------------------------

  /**
   * Fetch, move main to origin's main (the mirror reads the new files), then see where each
   * fork stands: behind main, merged into it (and so closed), and its pull request.
   * `now`: someone asked (Sync now), so also look for the GitHub App straight away.
   */
  async sync(now = false): Promise<void> {
    if (this.closed) return;
    if (this.syncing) {
      // Don't drop an explicit request: run again when this one ends.
      if (now) this.again = true;
      return;
    }
    // Couldn't start (repo unreachable at boot): starting is the sync.
    if (!this.started) {
      try {
        await this.start();
        this.error = null;
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
        this.announce();
      }
      return;
    }
    this.syncing = true;
    try {
      await this.connectApp(now);
      const sha = await this.repo.exclusive(async () => {
        await this.repo.fetch();
        const head = await this.repo.remoteHead(this.binding.branch);
        if (head && head !== this.mainSha) await this.repo.checkout(head);
        return head;
      });
      const moved = sha !== this.mainSha;
      this.mainSha = sha;
      this.error = null;
      this.syncedAt = new Date().toISOString();
      for (const run of [...this.runs.values()]) {
        // Merged (here or by a pull request), unless it's been edited since: then it stays
        // open and its next commit carries on from the merged branch.
        const pending = run.live.changes !== run.committedAt;
        if (!pending && run.row.head && sha) {
          // Each check awaits git: an edit can land meanwhile, and then the fork stays open.
          const clean = () => run.live.changes === run.committedAt;
          if ((await this.repo.isAncestor(run.row.head, sha)) && clean()) {
            this.closeFork(run, "merged", `${run.row.name} was merged into main`);
            continue;
          }
          // Squash- and rebase-merges leave no trace in the history, but main then has
          // exactly the fork's files.
          const [ours, theirs] = await this.repo.exclusive(() =>
            Promise.all([
              this.repo.subtree(sha, this.binding.path),
              this.repo.subtree(run.row.head!, this.binding.path),
            ]),
          );
          if (ours && ours === theirs && clean()) {
            this.closeFork(run, "merged", `${run.row.name} was merged into main`);
            continue;
          }
          // Its branch was deleted on the remote: the pull request was closed (or merged
          // with changes made there). The fork's edits stay in the database.
          if (
            !(await this.repo.exclusive(() => this.repo.remoteHead(this.branchOf(run.row)))) &&
            clean()
          ) {
            this.closeFork(
              run,
              "closed",
              `${run.row.name}'s branch was deleted on the remote, so it's closed`,
            );
            continue;
          }
        }
        run.behind = run.row.base && sha ? await this.repo.count(run.row.base, sha) : 0;
        await this.refreshPull(run);
      }
      if (moved) this.announce();
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.announce();
    } finally {
      this.syncing = false;
      if (this.again) {
        this.again = false;
        void this.sync(true);
      }
    }
  }

  /** Read where a fork's pull request stands (its review, whether it merged). */
  private async refreshPull(run: ForkRun): Promise<void> {
    if (!run.row.prNumber || !this.gh || !this.hub.github) return;
    // A merged or closed pull request doesn't change any more (sync closes the fork, or a
    // new one is opened), so it's not asked about again.
    if (run.pr && (run.pr.state === "merged" || run.pr.state === "closed")) return;
    try {
      const pr = await this.hub.github.pullState(this.gh.owner, this.gh.repo, run.row.prNumber);
      if (pr && JSON.stringify(pr) !== JSON.stringify(run.pr)) {
        run.pr = pr;
        this.announceSoon();
      }
    } catch (e) {
      // 404: the pull request is gone (or the app can't see it any more). Anything else,
      // a rate limit included, is tried again on the next sync.
      if (e instanceof GitHubError && e.status === 404) {
        run.row.prNumber = null;
        run.pr = null;
        this.hub.store.updateFork(run.row.doc, { prNumber: null });
      }
    }
  }

  // --- forks ------------------------------------------------------------------------------

  /**
   * A new fork of main, as `by`. `name` defaults to their name and the date. `from`: an open
   * fork to stack this one on (a plan on an unmerged map): it starts from that fork's head,
   * its branch from that fork's branch, and its diff and pull request are against it.
   */
  async fork(by: Principal, name?: string, from?: string): Promise<Live> {
    const parentRun = from ? this.runOf(from) : null;
    // The parent's edits so far, committed, so the new branch starts from them.
    if (parentRun) await this.commit(parentRun);
    const agent = by.kind === "agent";
    let base =
      slug(
        name ??
          (agent
            ? `agent-${by.name}`
            : `${by.name.split(/\s+/)[0]}-${new Date().toISOString().slice(5, 10)}`),
      ).slice(0, 40) || "fork";
    if (!KEY_RE.test(base)) base = "fork";
    let n = base;
    for (let i = 2; this.hub.store.forkNameTaken(this.binding.design, n); i++) n = `${base}-${i}`;
    const row: ForkRow = {
      doc: `${this.binding.design}@${n}`,
      design: this.binding.design,
      name: n,
      base: parentRun ? (parentRun.row.head ?? parentRun.row.base) : this.mainSha,
      head: null,
      parent: parentRun?.row.doc ?? null,
      status: "open",
      byId: by.id,
      byName: by.name,
      agent,
      createdAt: new Date().toISOString(),
      branch: `archnm/${this.binding.design}/${n}`,
    };
    this.hub.store.addFork(row);
    const live = await this.hub.openFork(row, parentRun?.live ?? this.main);
    const run = this.track(row, live);
    // A fork made from Archnemesis's own copy (before-git) has edits to commit straight away.
    // "atlas" is the system author id from before the rename.
    run.committedAt = by.id === "archnm" || by.id === "atlas" ? -1 : live.changes;
    if (run.committedAt === -1) this.schedule(run);
    this.announce();
    return live;
  }

  /**
   * Where an edit made on main goes: the fork `by` is already working on (people share the
   * most recent one; agents get their own), or a new one.
   */
  async forkFor(by: Principal): Promise<{ live: Live; created: boolean }> {
    const latest = this.openFork(by);
    if (latest) return { live: latest, created: false };
    return { live: await this.fork(by), created: true };
  }

  /** The fork `by` is working on, if one is open (nothing is made). */
  openFork(by: Principal): Live | null {
    const open = [...this.runs.values()].filter((r) =>
      by.kind === "agent" ? r.row.byId === by.id : !r.row.agent,
    );
    return open.sort((a, b) => (a.row.createdAt < b.row.createdAt ? 1 : -1))[0]?.live ?? null;
  }

  /** Apply batches made against main to `by`'s fork instead. */
  async editOnFork(
    by: Principal,
    batches: { ops: Op[]; label: string }[],
  ): Promise<{ live: Live; created: boolean; errors: string[] }> {
    const { live, created } = await this.forkFor(by);
    const errors: string[] = [];
    for (const b of batches) {
      try {
        live.commit(by, b.ops, b.label);
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }
    return { live, created, errors };
  }

  private track(row: ForkRow, live: Live): ForkRun {
    const run: ForkRun = {
      row,
      live,
      idle: null,
      max: null,
      committedAt: live.changes,
      saving: false,
      failures: 0,
      chain: Promise.resolve(),
      actors: new Map(),
      labels: [],
      behind: 0,
      pr: null,
      unlisten: () => {},
    };
    const offChange = live.onChange(() => this.schedule(run));
    const offLog = live.onLog((entries: LogEntry[]) => {
      for (const e of entries) {
        if (e.actor.kind === "system") continue;
        const a = run.actors.get(e.actor.id) ?? { name: e.actor.name, n: 0 };
        a.n++;
        run.actors.set(e.actor.id, a);
        run.labels.push(e.label);
      }
    });
    run.unlisten = () => {
      offChange();
      offLog();
    };
    this.runs.set(row.doc, run);
    return run;
  }

  private stopRun(run: ForkRun): void {
    if (run.idle) clearTimeout(run.idle);
    if (run.max) clearTimeout(run.max);
    run.unlisten();
  }

  /** Commit after edits settle, and at least every ARCHNM_GIT_MAX_MS while they don't. */
  private schedule(run: ForkRun): void {
    if (run.idle) clearTimeout(run.idle);
    run.idle = setTimeout(() => void this.commit(run).catch((e) => this.fail(e)), this.cfg.idleMs);
    run.max ??= setTimeout(() => void this.commit(run).catch((e) => this.fail(e)), this.cfg.maxMs);
    this.announceSoon();
  }

  private fail(e: unknown): void {
    this.error = e instanceof Error ? e.message : String(e);
    console.error(`archnm: git ${this.binding.design}: ${this.error}`);
    this.announce();
  }

  /** The design's files as Archnemesis writes them (giving new things their keys first). */
  private filesOf(live: Live): Map<string, string> {
    const keys = keyOps(live.state);
    if (keys.length)
      applyOps(live.doc, live.state, keys, SERVER, "gave new things file keys", SERVER, {
        pin: false,
      });
    return writeFiles(live.state, live.config());
  }

  /**
   * Commit a fork's files to its branch (if anything changed) and push it. One at a time
   * per fork: the idle timer, propose, merge and shutdown can all ask at once, and two
   * commits on the same parent would make the second push fail. A failed commit tries
   * again later, so edits are never left waiting for the next edit.
   */
  commit(run: ForkRun): Promise<string | null> {
    const next = run.chain.catch(() => {}).then(() => this.commitNow(run));
    run.chain = next;
    return next.then(
      (sha) => {
        run.failures = 0;
        return sha;
      },
      (e) => {
        // Try again later, waiting longer each time (30s, 1m, 2m … up to 10m, a little
        // randomised); a new edit tries straight after it settles, as usual.
        if (!this.closed && this.runs.get(run.row.doc) === run) {
          run.failures++;
          const wait =
            Math.min(10 * 60_000, Math.max(this.cfg.idleMs, 30_000) * 2 ** (run.failures - 1)) *
            (0.8 + Math.random() * 0.4);
          run.idle ??= setTimeout(() => void this.commit(run).catch((err) => this.fail(err)), wait);
        }
        throw e;
      },
    );
  }

  private async commitNow(run: ForkRun): Promise<string | null> {
    if (run.live.changes === run.committedAt) {
      this.clearTimers(run);
      return run.row.head;
    }
    run.saving = true;
    this.announce();
    try {
      return await this.commitFiles(run);
    } finally {
      run.saving = false;
      this.announce();
    }
  }

  private clearTimers(run: ForkRun): void {
    if (run.idle) clearTimeout(run.idle);
    if (run.max) clearTimeout(run.max);
    run.idle = run.max = null;
  }

  private async commitFiles(run: ForkRun): Promise<string | null> {
    // Keys first: giving new things their keys is an edit too, and it belongs in this
    // commit (taken after it, the fork would look unsaved and wait another round).
    const files = this.filesOf(run.live);
    const at = run.live.changes;
    this.clearTimers(run);
    const parent = run.row.head ?? run.row.base;
    const people = [...run.actors.entries()].sort((a, b) => b[1].n - a[1].n);
    const lead = people.find(([id]) => !id.startsWith("agent:")) ?? people[0];
    const author = lead
      ? personFor(lead[0], lead[1].name)
      : { name: run.row.byName ?? "archnm", email: "archnm@localhost" };
    const co = people
      .filter((p) => p !== lead)
      .map(([id, a]) => {
        const p = personFor(id, a.name);
        return `Co-authored-by: ${p.name} <${p.email}>`;
      });
    // What this commit covers; edits made while it's pushing go in the next one.
    const nLabels = run.labels.length;
    const covered = new Map([...run.actors].map(([id, a]) => [id, a.n]));
    const labels = [
      ...new Set(
        run.labels
          .map((l) =>
            String(l)
              .replace(/[\r\n\t]+/g, " ")
              .trim()
              .slice(0, 200),
          )
          .filter(Boolean),
      ),
    ];
    const title =
      labels.length === 1
        ? labels[0]!
        : labels.length
          ? `${labels[0]} (+${labels.length - 1} more)`
          : `update ${run.row.name}`;
    const message = [
      title.slice(0, 72),
      "",
      ...labels.slice(0, 30).map((l) => `- ${l}`),
      ...(co.length ? ["", ...co] : []),
      "",
      `Archnm-Fork: ${run.row.doc}`,
    ].join("\n");
    const sha = await this.repo.exclusive(async () => {
      // On top of the branch as it is on the remote: the database can be behind it (restored
      // from a backup, or a push whose answer was lost), and a push from an older commit
      // would be refused for good. The fork's document is the truth, so its files win.
      const tip = (await this.repo.remoteHead(this.branchOf(run.row))) ?? parent;
      const c = await this.repo.commitFiles({
        start: tip,
        parents: tip ? [tip] : [],
        subpath: this.binding.path,
        files,
        owned: isOurs,
        message,
        author,
      });
      if (c) await this.repo.push(c, this.branchOf(run.row));
      return c;
    });
    run.committedAt = at;
    run.labels = run.labels.slice(nLabels);
    for (const [id, n] of covered) {
      const a = run.actors.get(id);
      if (a && (a.n -= n) <= 0) run.actors.delete(id);
    }
    if (sha) {
      run.row.head = sha;
      this.hub.store.updateFork(run.row.doc, { head: sha });
    }
    this.announce();
    return run.row.head;
  }

  /** Main's history: the commits that changed the design's files, newest first. */
  async versions(
    n = 50,
  ): Promise<{ sha: string; date: string; author: string; subject: string }[]> {
    return this.repo.exclusive(() =>
      this.repo.log(`refs/remotes/origin/${this.binding.branch}`, this.binding.path, n),
    );
  }

  /** The design as it was at a commit: its files, read back into a model. */
  async stateAt(sha: string): Promise<ModelState> {
    if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error("not a commit");
    return stateFromFiles(
      await this.repo.exclusive(() => this.repo.filesAt(sha, this.binding.path, isOurs)),
    );
  }

  /**
   * After a restart, a fork's change count starts again, so "nothing new since the last
   * commit" can't be told from it. Compare its files with its last commit instead, and
   * commit the difference (edits made just before a crash, say).
   */
  private async catchUncommitted(run: ForkRun): Promise<void> {
    const at = run.row.head ?? run.row.base;
    if (!at) return;
    const ours = this.filesOf(run.live);
    const theirs = await this.repo.exclusive(() =>
      this.repo.filesAt(at, this.binding.path, isOurs),
    );
    const same =
      ours.size === theirs.size &&
      [...ours].every(([p, t]) => theirs.get(p)?.trimEnd() === t.trimEnd());
    if (same) return;
    run.committedAt = -1;
    this.schedule(run);
  }

  private isLocal(): boolean {
    return this.binding.remote.startsWith(join(this.hub.stateDir, "git"));
  }

  /** The GitHub repo this design follows, or null (another host, or a repo on this server). */
  githubRepo(): { owner: string; repo: string } | null {
    return this.gh;
  }

  /** Who started a fork (its owner may merge or discard it, besides an admin). */
  ownerOf(doc: string): string | null {
    return this.runs.get(doc)?.row.byId ?? null;
  }

  /**
   * What a fork is compared with: its parent fork as it is now (a stacked fork), else main at
   * its base commit, read from the files. Null for no fork or no base.
   */
  async baseState(doc: string): Promise<ModelState | null> {
    const row = this.runs.get(doc)?.row;
    const parent = row?.parent ? this.runs.get(row.parent) : undefined;
    if (parent) return stateFromFiles(this.filesOf(parent.live));
    return row?.base ? this.stateAt(row.base) : null;
  }

  /** The open fork a stacked fork was made from, if it's still open. */
  parentOf(doc: string): { doc: string; branch: string } | null {
    const p = this.runs.get(doc)?.row.parent;
    const run = p ? this.runs.get(p) : undefined;
    return run ? { doc: run.row.doc, branch: this.branchOf(run.row) } : null;
  }

  private runOf(doc: string): ForkRun {
    const run = this.runs.get(doc);
    if (!run) throw new GitError(`no open fork ${doc}`);
    return run;
  }

  /**
   * Merge a fork into main, inside Archnemesis: commit what's pending, merge its branch with
   * main (refusing on a conflict), push main, and sync, which closes the fork.
   */
  async merge(doc: string, by: Principal): Promise<string> {
    if (this.forge)
      throw new GitError(
        `${this.binding.design} is on ${forgeName(this.forge.kind)}: propose the fork and merge its pull request there`,
      );
    const run = this.runOf(doc);
    await this.commit(run);
    if (!run.row.head) {
      this.closeFork(run, "discarded", `${run.row.name} had no changes`);
      return "nothing to merge: the fork had no changes";
    }
    await this.repo.exclusive(async () => {
      await this.repo.fetch();
      const main = await this.repo.remoteHead(this.binding.branch);
      if (!main) throw new GitError("main is missing on the remote");
      if (await this.repo.isAncestor(run.row.head!, main)) return;
      const tree = await this.repo.mergeTree(main, run.row.head!);
      if (!tree)
        throw new GitError(
          `${run.row.name} conflicts with main: catching up with main comes next (it isn't built yet)`,
        );
      const p = personFor(by.id, by.name);
      const merge = await this.repo.commitTree(
        tree,
        [main, run.row.head!],
        `Merge ${this.branchOf(run.row)}\n\nMerged in Archnemesis by ${by.name}.\n`,
        p,
      );
      await this.repo.push(merge, this.binding.branch);
    });
    await this.sync();
    return `merged ${run.row.name} into ${this.binding.branch}`;
  }

  /**
   * Get a fork ready for review: commit what's pending, and give the forge's page for
   * opening a pull request from its branch, filled in with what changed and a link back to
   * the fork in Archnemesis. Null when the repo isn't on a forge (merge inside Archnemesis instead).
   */
  async propose(
    doc: string,
    link: string,
    by?: Principal,
  ): Promise<{
    url: string | null;
    branch: string;
    base: string;
    stacked: string | null;
    changes: string[];
    headline: string;
    pr: PullState | null;
    signIn: boolean;
  }> {
    const run = this.runOf(doc);
    await this.commit(run);
    if (!run.row.head) throw new GitError(`${run.row.name} has no changes to propose yet`);
    const branch = this.branchOf(run.row);
    const head = run.row.head;
    // A stacked fork is proposed against its parent's branch (committed first, so the pull
    // request shows only this fork's changes); once the parent is gone, against main.
    const parentRun = run.row.parent ? this.runs.get(run.row.parent) : undefined;
    if (parentRun) await this.commit(parentRun);
    const baseBranch = parentRun?.row.head ? this.branchOf(parentRun.row) : this.binding.branch;
    const from = parentRun ? (parentRun.row.head ?? parentRun.row.base) : run.row.base;
    const [bodies, before, after] = await this.repo.exclusive(
      async () =>
        [
          await this.repo.bodies(from, head),
          from ? await this.repo.filesAt(from, this.binding.path, isOurs) : null,
          await this.repo.filesAt(head, this.binding.path, isOurs),
        ] as const,
    );
    // What changed, from the files themselves; the edit labels are the fallback.
    // Protected fields as main's archnm.yaml says (a fork can't unprotect what it changes).
    const protect = readFiles(before ?? after).model.config.protect ?? [];
    // Most important first (the design's boxes, connections, flows, views), libraries last; and a headline of how many of each.
    const listed = changeList(
      before ? stateFromFiles(before) : emptyState(),
      stateFromFiles(after),
      protect,
    );
    const headline = changeHeadline(listed);
    let changes = listed.map((x) => x.t);
    if (
      before &&
      normalizeDesignFile(before).get(DESIGN_FILE) !== normalizeDesignFile(after).get(DESIGN_FILE)
    ) {
      // Which of the design's settings changed: new tag groups are an ordinary change, said as
      // such; anything else (protect, limits, github…) gets the warning (two tag
      // groups read as "⚠ the design's rules").
      const was = readFiles(before).model.config as Record<string, unknown>;
      const now = readFiles(after).model.config as Record<string, unknown>;
      const keys = [...new Set([...Object.keys(was), ...Object.keys(now)])].filter(
        (k) => JSON.stringify(was[k]) !== JSON.stringify(now[k]),
      );
      const tagsOf = (c: Record<string, unknown>) => (c.tags ?? {}) as Record<string, unknown>;
      const added = Object.keys(tagsOf(now)).filter((k) => !(k in tagsOf(was)));
      const onlyNewTags =
        keys.every((k) => k === "tags") &&
        Object.keys(tagsOf(was)).every(
          (k) => JSON.stringify(tagsOf(was)[k]) === JSON.stringify(tagsOf(now)[k]),
        );
      if (onlyNewTags && added.length)
        changes.unshift(
          `+ tag group${added.length === 1 ? "" : "s"} ${added.join(", ")} (archnm.yaml)`,
        );
      else if (keys.length)
        changes.unshift(`⚠ Changed archnm.yaml, the design's settings: ${keys.join(", ")}`);
    }
    if (!changes.length)
      changes = [
        ...new Set(
          bodies.flatMap((b) =>
            b
              .split("\n")
              .filter((l) => l.startsWith("- "))
              .map((l) => l.slice(2)),
          ),
        ),
      ];
    const people = [
      ...new Set(
        bodies.flatMap((b) => [...b.matchAll(/^Co-authored-by: (.+?) </gm)].map((m) => m[1]!)),
      ),
    ];
    const first = changes[0]
      ? changes[0][0]!.toLowerCase() + changes[0].slice(1)
      : `changes from ${run.row.name}`;
    const title =
      `${this.main.name()}: ${first}${changes.length > 1 ? ` (+${changes.length - 1} more)` : ""}`.slice(
        0,
        120,
      );
    // Names come from the model: they mustn't @-mention people or start markdown of their own.
    const inert = (t: string) =>
      t
        .replace(/[\r\n]+/g, " ")
        .replace(/@/g, "@\u200b")
        .replace(/^([#>|-])/, "\\$1");
    changes = changes.map(inert);
    const body = [
      `Changes to the **${inert(this.main.name())}** design, made in Archnemesis on the fork \`${run.row.name}\`${parentRun ? `, stacked on \`${parentRun.row.name}\` (merge that first; this shows only what ${run.row.name} adds)` : ""}.`,
      "",
      `Review it live: ${link}`,
      "",
      "### What changed",
      ...(headline ? [inert(headline), ""] : []),
      ...(changes.length ? changes.slice(0, 60).map((c) => `- ${c}`) : ["- (see the files)"]),
      ...(changes.length > 60 ? [`- …and ${changes.length - 60} more`] : []),
      ...(people.length ? ["", `With ${people.map(inert).join(", ")}.`] : []),
      "",
      "Merging this closes the fork in Archnemesis; everyone on it moves back to main.",
    ].join("\n");
    run.row.proposedAt = new Date().toISOString();
    this.hub.store.updateFork(doc, { proposedAt: run.row.proposedAt });
    // With Archnemesis's GitHub App on the repo and the person signed in to GitHub, Archnemesis opens
    // the pull request as them. Otherwise it hands back the forge's prefilled page.
    let pr: PullState | null = null;
    let signIn = false;
    if (by && this.viaApp && this.gh && this.hub.github) {
      pr = await this.hub.github.openPull(by.id, {
        ...this.gh,
        head: branch,
        base: baseBranch,
        title,
        body,
      });
      if (pr) {
        run.pr = pr;
        run.row.prNumber = pr.number;
        this.hub.store.updateFork(doc, { prNumber: pr.number });
      } else signIn = by.kind === "human";
    }
    this.announce();
    const prefilled = this.forge
      ? proposeUrl(this.forge, { branch, base: baseBranch, title, body })
      : null;
    return {
      url: pr?.url ?? prefilled,
      branch,
      base: baseBranch,
      stacked: parentRun?.row.doc ?? null,
      changes,
      headline,
      pr,
      signIn,
    };
  }

  /** Throw a fork away: its branch is deleted and its tabs move to main. */
  async discard(doc: string, by: Principal): Promise<void> {
    const run = this.runOf(doc);
    if (run.row.head)
      await this.repo.exclusive(() => this.repo.deleteRemote(this.branchOf(run.row)));
    this.closeFork(run, "discarded", `${by.name} discarded ${run.row.name}`);
  }

  private closeFork(run: ForkRun, status: "merged" | "discarded" | "closed", why: string): void {
    this.stopRun(run);
    this.runs.delete(run.row.doc);
    this.hub.store.updateFork(run.row.doc, { status });
    this.hub.dropFork(run.row.doc, this.binding.design, why);
    this.main.doc.transact(
      () =>
        appendLog(this.main.doc, { actor: GIT, label: why, at: new Date().toISOString(), ids: [] }),
      GIT,
    );
    this.announce();
  }

  // --- status -----------------------------------------------------------------------------

  info(): GitInfo {
    return {
      design: this.binding.design,
      remote: safeRemote(this.binding.remote),
      local: this.isLocal(),
      path: this.binding.path,
      branch: this.binding.branch,
      forge: this.forge
        ? { kind: this.forge.kind, name: forgeName(this.forge.kind), web: this.forge.web }
        : null,
      app: this.gh
        ? {
            configured: !!this.hub.github?.configured,
            installed: this.viaApp,
            installUrl: this.hub.github?.installUrl() ?? null,
          }
        : null,
      main: this.mainSha,
      syncedAt: this.syncedAt,
      syncing: this.syncing,
      error: this.error,
      forks: [...this.runs.values()].map((r) => ({
        doc: r.row.doc,
        name: r.row.name,
        branch: this.branchOf(r.row),
        by: r.row.byName,
        agent: r.row.agent,
        createdAt: r.row.createdAt,
        base: r.row.base,
        head: r.row.head,
        pending: r.live.changes !== r.committedAt,
        saving: r.saving,
        behind: r.behind,
        present: this.hub.present(r.row.doc),
        proposedAt: r.row.proposedAt ?? null,
        pr: r.pr,
      })),
    };
  }

  private soon: NodeJS.Timeout | null = null;
  private announceSoon(): void {
    this.soon ??= setTimeout(() => {
      this.soon = null;
      this.announce();
    }, 500);
  }

  /** Tell every tab on main and on the forks that the git status changed (they refetch). */
  private announce(): void {
    const msg = { type: "git" };
    this.hub.broadcast(this.binding.design, msg);
    for (const doc of this.runs.keys()) this.hub.broadcast(doc, msg);
  }
}

/**
 * A remote Archnemesis may clone: an https or ssh URL (git@host:path too). Never something git
 * would read as an option, another transport (ext::, file://), or a path on this machine,
 * unless ARCHNM_GIT_LOCAL_REMOTES=1 (tests, or a repo mounted into the container on purpose).
 */
function checkRemote(remote: string, localRemotes: boolean): void {
  const ok =
    /^https:\/\/[^\s/]+\/\S+$/.test(remote) ||
    /^ssh:\/\/[^\s/]+\/\S+$/.test(remote) ||
    /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s:][^\s]*$/.test(remote) ||
    (localRemotes && /^\/[^\s]*$/.test(remote));
  if (!ok || remote.startsWith("-"))
    throw new GitError(
      `Archnemesis only follows https or ssh remotes, like git@github.com:you/designs.git (not "${safeRemote(remote)}")`,
    );
}

/**
 * Who may point a design at this remote: admins anywhere, editors only where
 * ARCHNM_GIT_REMOTES allows ("github.com/acme/*, git.example.com/*"). Binding is what puts
 * Archnemesis's credentials (its GitHub App, the machine's ssh keys) to work on a repo, so it
 * isn't something every editor gets to aim.
 */
export function remoteAllowed(remote: string, admin: boolean, allowed: string[]): boolean {
  if (admin) return true;
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/i.exec(remote);
  if (!m) return false;
  const where = `${m[1]!.toLowerCase()}/${m[2]!}`;
  return allowed.some((p) =>
    new RegExp(
      `^${p
        .toLowerCase()
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, "[^/]+")}$`,
      "i",
    ).test(where),
  );
}

/**
 * Before a design is deleted: let go of its repo on this server, which is only Archnemesis's own
 * bookkeeping (forks and history). A real repo, or one with open forks, stays and says why.
 */
export async function dropLocalRepo(hub: Hub, design: string): Promise<void> {
  const g = hub.git.get(design);
  if (!g) return;
  const info = g.info();
  if (!info.local) return;
  if (info.forks.length)
    throw new GitError(
      `merge or discard its ${info.forks.length === 1 ? "fork" : `${info.forks.length} forks`} first`,
    );
  await g.close();
  hub.git.delete(design);
  hub.store.dropBinding(design);
  hub.designs.get(design)?.unfollow();
}

/** Make a design follow a repo. `local` makes a bare repo next to the database for it. */
export async function bindDesign(
  hub: Hub,
  main: Live,
  b: { remote?: string; path?: string; branch?: string; local?: boolean; addHere?: boolean },
): Promise<GitSync> {
  if (main.branch) throw new GitError("a fork can't follow a repo; its design can");
  // A design in its own repo on this server can move to a real one (GitHub, …) once its forks,
  // which are branches in that repo, are merged or discarded.
  const had = hub.git.get(main.key);
  if (had) {
    const info = had.info();
    if (!info.local || b.local)
      throw new GitError(`${main.key} already follows ${safeRemote(had.binding.remote)}`);
    if (info.forks.length)
      throw new GitError(
        `merge or discard its ${info.forks.length === 1 ? "fork" : `${info.forks.length} forks`} first: they're branches in the repo on this server`,
      );
    await had.close();
    hub.git.delete(main.key);
    main.unfollow();
  }
  const branch = (b.branch ?? "main").trim() || "main";
  // A plain branch name: no option-looking names, ranges, refspec or path tricks.
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(branch) ||
    /\.\.|\/\/|\.lock$|\/$|@\{/.test(branch)
  )
    throw new GitError(`"${branch}" isn't a branch name Archnemesis will use`);
  const path = (b.path ?? "").trim().replace(/^\/+|\/+$/g, "");
  if (
    /[\\:]/.test(path) ||
    path
      .split("/")
      .some((s) => (s === "" ? path !== "" : s === "." || s === ".." || s.toLowerCase() === ".git"))
  )
    throw new GitError(`"${path}" isn't a folder in the repo`);
  let remote = (b.remote ?? "").trim();
  if (b.local) {
    remote = join(hub.stateDir, "git", `${main.key}.git`);
    if (!existsSync(remote)) await Repo.initBare(remote, branch, hub.config.git);
  } else {
    if (!remote) throw new GitError("which repo? give its URL (or ask for a local one)");
    checkRemote(remote, hub.config.git.localRemotes);
  }
  const binding: Binding = { design: main.key, remote, path, branch };
  const g = new GitSync(hub, main, binding);
  try {
    await g.start(true, b.addHere === true);
  } catch (e) {
    // Not connected after all: main goes back to being edited directly.
    await g.close();
    main.unfollow();
    // Moving off the repo on this server didn't work: stay on it.
    if (had)
      await bindDesign(hub, main, { local: true, branch: had.binding.branch }).catch(() => {});
    throw e;
  }
  hub.store.setBinding(binding);
  hub.git.set(main.key, g);
  hub.freeze(main.key, "main now follows git");
  main.doc.transact(
    () =>
      appendLog(main.doc, {
        actor: GIT,
        label: `now follows ${safeRemote(remote)} (${branch})`,
        at: new Date().toISOString(),
        ids: [],
      }),
    GIT,
  );
  return g;
}
