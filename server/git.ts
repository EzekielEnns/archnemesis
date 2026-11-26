// Git, for designs synced with a repo. One clone per design, driven with the plain `git`
// command, one command at a time per clone.
//
// Archnemesis never edits a working tree. The clone's checkout only ever follows origin's main
// (detached), so it stays a clean mirror the file watcher reads. Forks are written straight
// into commits with plumbing (a throwaway index, write-tree, commit-tree), and merges are
// made with `merge-tree --write-tree`, so nothing is ever half-written on disk.
import { isGeneratedAgents } from "../shared/agentsmd.ts";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export class GitError extends Error {
  readonly code: number | null;
  constructor(message: string, code: number | null = null) {
    super(message);
    this.code = code;
  }
}

export interface Person {
  name: string;
  email: string;
}

interface RunOpts {
  env?: Record<string, string>;
  input?: string;
  cwd?: string;
  /** Exit codes that aren't errors (the output is returned as usual). */
  ok?: number[];
}

const COMMITTER: Person = { name: "archnm", email: "archnm@localhost" };

/** A clone of one remote, at `dir`. */
export class Repo {
  private lock: Promise<unknown> = Promise.resolve();
  readonly dir: string;
  /** What origin points at (switched to https when a GitHub App token is used). */
  remote: string;
  /** Extra environment for every command: credentials, without them on the command line. */
  auth: (() => Promise<Record<string, string>>) | null = null;

  /** The environment and ssh command git runs with (server/config.ts). */
  private readonly env: NodeJS.ProcessEnv;
  private readonly sshCommand: string;

  constructor(dir: string, remote: string, git: { env: NodeJS.ProcessEnv; sshCommand: string }) {
    this.dir = dir;
    this.remote = remote;
    this.env = git.env;
    this.sshCommand = git.sshCommand;
  }

  /** Run `fn` with the clone to itself: git work on one clone never interleaves. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lock.then(fn, fn);
    this.lock = next.catch(() => {});
    return next;
  }

  private format?: string;
  /** The repo's object ids: "sha1" (nearly every repo) or "sha256". */
  async objectFormat(): Promise<string> {
    this.format ??= (
      await this.git(["rev-parse", "--show-object-format"]).catch(() => "unknown")
    ).trim();
    return this.format;
  }

  /** Run one git command that reads `input` and answers in bytes (cat-file --batch). */
  async gitBytes(args: string[], input: string): Promise<Buffer> {
    const auth = this.auth ? await this.auth() : {};
    return new Promise((resolve, reject) => {
      const child = execFile(
        "git",
        args,
        {
          cwd: this.dir,
          encoding: "buffer",
          env: {
            ...this.env,
            GIT_TERMINAL_PROMPT: "0",
            GIT_ASKPASS: "true",
            LC_ALL: "C",
            GIT_ALLOW_PROTOCOL: this.remote.startsWith("/") ? "file" : "https:ssh",
            ...auth,
          },
          maxBuffer: 1024 * 1024 * 1024,
          timeout: 2 * 60_000,
          killSignal: "SIGKILL",
        },
        (err, stdout, stderr) => {
          if (err)
            return reject(
              new GitError(
                `git ${args[0]}: ${(stderr.toString() || err.message)
                  .trim()
                  .split("\n")
                  .slice(-3)
                  .join(" ")
                  .replace(/\/\/[^/@\s]+@/g, "//")}`,
                1,
              ),
            );
          resolve(stdout);
        },
      );
      child.stdin?.end(input);
    });
  }

  /** Run one git command in the clone (not queued: call inside exclusive). */
  async git(args: string[], opts: RunOpts = {}): Promise<string> {
    const auth = this.auth ? await this.auth() : {};
    return new Promise((resolve, reject) => {
      const child = execFile(
        "git",
        args,
        {
          cwd: opts.cwd ?? this.dir,
          env: {
            ...this.env,
            GIT_TERMINAL_PROMPT: "0",
            GIT_ASKPASS: "true",
            LC_ALL: "C",
            // Only the transports Archnemesis means to use: no ext::, no file:// to a remote
            // that isn't a local repo Archnemesis was told to use.
            GIT_ALLOW_PROTOCOL: this.remote.startsWith("/") ? "file" : "https:ssh",
            // A remote that stalls gives up instead of holding the clone's queue forever.
            GIT_HTTP_LOW_SPEED_LIMIT: "1000",
            GIT_HTTP_LOW_SPEED_TIME: "60",
            GIT_SSH_COMMAND: this.sshCommand,
            ...auth,
            ...opts.env,
          },
          maxBuffer: 64 * 1024 * 1024,
          // Nothing waits on git for ever: everything for this clone queues behind it.
          timeout: args[0] === "clone" || args[0] === "fetch" ? 10 * 60_000 : 2 * 60_000,
          killSignal: "SIGKILL",
        },
        (err, stdout, stderr) => {
          if (err && (err as { killed?: boolean }).killed)
            return reject(new GitError(`git ${args[0]}: took too long, stopped`, 124));
          const code = err
            ? ((err as NodeJS.ErrnoException & { code?: unknown }).code as unknown)
            : 0;
          const exit = typeof code === "number" ? code : err ? 1 : 0;
          if (!err || opts.ok?.includes(exit)) return resolve(stdout.trimEnd());
          // Never pass credentials on: a URL with user:token@ in it is cut down to the host.
          const why = (stderr || err.message)
            .trim()
            .split("\n")
            .slice(-3)
            .join(" ")
            .replace(/\/\/[^/@\s]+@/g, "//");
          reject(new GitError(`git ${args[0]}: ${why}`, exit));
        },
      );
      if (opts.input !== undefined) child.stdin?.end(opts.input);
    });
  }

  // The methods below are single steps; callers string them together inside exclusive().

  /** Clone the remote if it isn't here yet. */
  async ensure(): Promise<void> {
    if (existsSync(join(this.dir, ".git"))) {
      await this.git(["remote", "set-url", "origin", "--", this.remote]);
      return;
    }
    mkdirSync(dirname(this.dir), { recursive: true });
    await this.git(["clone", "-q", "--no-checkout", "--", this.remote, this.dir], {
      cwd: dirname(this.dir),
    });
  }

  async fetch(): Promise<void> {
    await this.git(["fetch", "-q", "--prune", "origin"]);
  }

  /** The commit a remote branch points at, or null if it doesn't exist (an empty repo). */
  async remoteHead(branch: string): Promise<string | null> {
    const out = await this.git(
      ["rev-parse", "--verify", "-q", `refs/remotes/origin/${branch}^{commit}`],
      { ok: [1] },
    );
    return out || null;
  }

  /** Move the clone's checkout to `sha` (detached). Only ever done to follow origin's main. */
  async checkout(sha: string): Promise<void> {
    await this.git(["checkout", "-q", "--force", "--detach", sha]);
  }

  async isAncestor(a: string, b: string): Promise<boolean> {
    return this.git(["merge-base", "--is-ancestor", a, b]).then(
      () => true,
      () => false,
    );
  }

  /** How many commits `to` has that `from` doesn't. */
  async count(from: string, to: string): Promise<number> {
    return Number(await this.git(["rev-list", "--count", `${from}..${to}`]));
  }

  /** Does `commit` have `path` (a file)? */
  async has(commit: string, path: string): Promise<boolean> {
    return this.git(["cat-file", "-e", `${commit}:${path}`]).then(
      () => true,
      () => false,
    );
  }

  /** The tree at `path` in `commit` ("" for the root), or null if it isn't there. */
  async subtree(commit: string, path: string): Promise<string | null> {
    const out = await this.git(
      ["rev-parse", "-q", "--verify", `${commit}:${path.replace(/\/+$/, "")}`],
      { ok: [1, 128] },
    );
    return out || null;
  }

  /** The files under `subpath` in `commit` that `owned` picks, by path relative to it. */
  async filesAt(
    commit: string,
    subpath: string,
    owned: (rel: string) => boolean,
  ): Promise<Map<string, string>> {
    const prefix = subpath ? `${subpath.replace(/\/+$/, "")}/` : "";
    const names = (
      await this.git(["ls-tree", "-r", "-z", "--name-only", commit, "--", prefix || "."])
    )
      .split("\0")
      .filter(Boolean);
    const out = new Map<string, string>();
    const want = names.filter((n) => n.startsWith(prefix) && owned(n.slice(prefix.length)));
    if (!want.length) return out;
    // One git for all of them, not one each (3,800 git shows made a propose take 90s).
    const buf = await this.gitBytes(
      ["cat-file", "--batch"],
      want.map((n) => `${commit}:${n}\n`).join(""),
    );
    let at = 0;
    for (const n of want) {
      const nl = buf.indexOf(10, at);
      const head = buf.subarray(at, nl).toString("utf8");
      const size = /^\S+ blob (\d+)$/.exec(head)?.[1];
      if (size === undefined) {
        // "<name> missing": gone between ls-tree and here; skip it, as before.
        at = nl + 1;
        continue;
      }
      const start = nl + 1;
      out.set(
        n.slice(prefix.length),
        buf
          .subarray(start, start + Number(size))
          .toString("utf8")
          .trimEnd(),
      );
      at = start + Number(size) + 1;
    }
    return out;
  }

  /** The last `n` commits on `ref` that changed `path`, newest first. */
  async log(
    ref: string,
    path: string,
    n: number,
  ): Promise<{ sha: string; date: string; author: string; subject: string }[]> {
    const out = await this.git([
      "log",
      `-n${n}`,
      "--format=%H%x1f%aI%x1f%an%x1f%s%x1e",
      ref,
      "--",
      path.replace(/\/+$/, "") || ".",
    ]);
    return out
      .split("\x1e")
      .map((r) => r.trim())
      .filter(Boolean)
      .map((r) => {
        const [sha = "", date = "", author = "", subject = ""] = r.split("\x1f");
        return { sha, date, author, subject };
      });
  }

  /** The commit messages' bodies in `from..to`, oldest first. */
  async bodies(from: string | null, to: string): Promise<string[]> {
    const out = await this.git([
      "log",
      "--reverse",
      "--format=%B%x00",
      from ? `${from}..${to}` : to,
    ]);
    return out
      .split("\0")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  async treeOf(commit: string): Promise<string> {
    return this.git(["rev-parse", `${commit}^{tree}`]);
  }

  /**
   * A commit holding `files` at `subpath`, on top of `start`'s tree (the rest of the repo is
   * kept as it is), or null when that's exactly `parents[0]`'s tree already. `owned` says
   * which paths under `subpath` Archnemesis manages; others found there are left alone.
   */
  async commitFiles(o: {
    start: string | null;
    parents: string[];
    subpath: string;
    files: Map<string, string>;
    owned: (rel: string) => boolean;
    message: string;
    author: Person;
  }): Promise<string | null> {
    const index = join(tmpdir(), `archnm-index-${process.pid}-${crypto.randomUUID()}`);
    const env = { GIT_INDEX_FILE: index };
    const prefix = o.subpath ? `${o.subpath.replace(/\/+$/, "")}/` : "";
    try {
      await this.git(o.start ? ["read-tree", o.start] : ["read-tree", "--empty"], { env });
      const present = (await this.git(["ls-files", "-z", "--", prefix || "."], { env }))
        .split("\0")
        .filter(Boolean);
      // An AGENTS.md a person wrote stays theirs: Archnemesis only replaces its own.
      let files = o.files;
      if (o.start && present.includes(`${prefix}AGENTS.md`)) {
        const mine = await this.git(["cat-file", "blob", `${o.start}:${prefix}AGENTS.md`]).then(
          isGeneratedAgents,
          () => true,
        );
        if (!mine) files = new Map([...files].filter(([rel]) => rel !== "AGENTS.md"));
      }
      const stale = present.filter(
        (p) =>
          p.startsWith(prefix) &&
          o.owned(p.slice(prefix.length)) &&
          (p !== `${prefix}AGENTS.md` || files.has("AGENTS.md")),
      );
      if (stale.length)
        await this.git(["update-index", "--force-remove", "-z", "--stdin"], {
          env,
          input: stale.join("\0") + "\0",
        });
      const lines: string[] = [];
      // A file as it already is in the start tree keeps its blob: only new text is written, one
      // git each (a hash-object per file, 3,800 of them, on every commit). Blob ids
      // are worked out here for a SHA-1 repo; any other kind asks git for every one.
      const had = new Map<string, string>();
      if (o.start && (await this.objectFormat()) === "sha1")
        for (const row of (
          await this.git(["ls-tree", "-r", "-z", o.start, "--", prefix || "."])
        ).split("\0")) {
          const m = /^100644 blob ([0-9a-f]{40})\t(.*)$/s.exec(row);
          if (m) had.set(m[2]!, m[1]!);
        }
      for (const [rel, text] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
        const was = had.get(`${prefix}${rel}`);
        const body = Buffer.from(text, "utf8");
        const mine = was
          ? createHash("sha1").update(`blob ${body.length}\0`).update(body).digest("hex")
          : undefined;
        const blob =
          was && mine === was
            ? was
            : await this.git(["hash-object", "-w", "--stdin"], { input: text });
        lines.push(`100644 blob ${blob}\t${prefix}${rel}`);
      }
      if (lines.length)
        await this.git(["update-index", "--index-info"], { env, input: lines.join("\n") + "\n" });
      const tree = await this.git(["write-tree"], { env });
      if (o.parents.length === 1 && (await this.treeOf(o.parents[0]!)) === tree) return null;
      return await this.commitTree(tree, o.parents, o.message, o.author);
    } finally {
      rmSync(index, { force: true });
    }
  }

  async commitTree(
    tree: string,
    parents: string[],
    message: string,
    author: Person,
  ): Promise<string> {
    return this.git(["commit-tree", tree, ...parents.flatMap((p) => ["-p", p]), "-F", "-"], {
      input: message.endsWith("\n") ? message : `${message}\n`,
      env: {
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
        GIT_COMMITTER_NAME: COMMITTER.name,
        GIT_COMMITTER_EMAIL: COMMITTER.email,
      },
    });
  }

  /**
   * Merge `theirs` into `ours` without a working tree: the merged tree, or null on a
   * conflict (nothing is written anywhere).
   */
  async mergeTree(ours: string, theirs: string): Promise<string | null> {
    const out = await this.git(["merge-tree", "--write-tree", "--no-messages", ours, theirs], {
      ok: [1],
    });
    // Exit 1 (conflicts) still prints the tree, then the conflicted files; a clean merge
    // prints just the tree.
    const lines = out.split("\n");
    return lines.length === 1 && /^[0-9a-f]{40,64}$/.test(lines[0]!) ? lines[0]! : null;
  }

  /** Point a branch on the remote at `sha` (a fast-forward; never forced). */
  async push(sha: string, branch: string): Promise<void> {
    await this.git(["push", "-q", "origin", `${sha}:refs/heads/${branch}`]);
  }

  async deleteRemote(branch: string): Promise<void> {
    await this.git(["push", "-q", "origin", "--delete", branch], { ok: [1] });
  }

  /** Make a new bare repository at `dir` (for a design with nowhere else to go yet). */
  static async initBare(
    dir: string,
    branch: string,
    git: { env: NodeJS.ProcessEnv; sshCommand: string },
  ): Promise<void> {
    mkdirSync(dir, { recursive: true });
    const r = new Repo(dir, dir, git);
    await r.git(["init", "-q", "--bare", `--initial-branch=${branch}`, dir]);
  }
}

/** A git author for someone in Archnemesis: their real address when Archnemesis knows it. */
export function personFor(id: string, name: string): Person {
  const login = id.replace(/^(ts|agent|local|token):/, "");
  // Tailscale's GitHub logins look like "name@github": GitHub's no-reply address is theirs.
  const gh = /^([A-Za-z0-9-]+)@github$/.exec(login);
  if (gh) return { name, email: `${gh[1]}@users.noreply.github.com` };
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(login)) return { name, email: login };
  return { name, email: `${login.replace(/[^A-Za-z0-9._-]/g, "-") || "someone"}@archnm.invalid` };
}
