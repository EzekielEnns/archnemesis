// Keeps a folder of architecture files (shared/files.ts) and the live document in step.
//
//   document -> files  a second after edits settle: give new things keys, write what changed
//   files -> document  when something else changes a file (git pull, an agent, an editor):
//                      read the whole folder, check it, and apply the difference as one
//                      batch, logged as "files". If the folder has errors nothing is applied,
//                      and the first error shows in everyone's tabs.
//
// On start, whichever side changed last wins: the files, if they differ from what Archnemesis
// last wrote (someone pulled while it was off); otherwise the document.
//
// A mirror (the main of a design that follows git) only reads: the folder is the repo's
// checkout of main, the document follows it, and nothing is ever written back, so the
// checkout stays clean for the next pull.
//
// Files are written atomically (a temporary file, then rename), so a reader never sees half
// a file.
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  watch,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { applyOps, appendLog, type Actor } from "../shared/doc.ts";
import { isGeneratedAgents } from "../shared/agentsmd.ts";
import { isOurs } from "../shared/ours.ts";
import {
  check,
  keyOps,
  readFiles,
  toOps,
  writeFiles,
  hasDesignFile,
  type FConfig,
  type Problem,
} from "../shared/files.ts";
import type { Op } from "../shared/model.ts";
import type { Live } from "./live.ts";

const FILES: Actor = { id: "files", name: "files", kind: "system" };
const SERVER: Actor = { id: "archnm", name: "archnm", kind: "system" };
/** Does this folder hold a design file (archnm.yaml, or atlas.yaml from before the rename)? */
export const hasDesignFolder = (dir: string): boolean =>
  hasDesignFile({ has: (f) => existsSync(join(dir, f)) });

export { isOurs };

/**
 * May archnm write this path in a design's folder? Only its own files (`isOurs`: one level
 * deep, no "..", no slashes in names), and never through a symlinked folder, so nothing in
 * the model can make it write anywhere else on the server.
 */
export function writable(dir: string, rel: string): boolean {
  if (
    !isOurs(rel) ||
    rel.split("/").some((part) => part === ".." || part === "." || part.toLowerCase() === ".git")
  )
    return false;
  // Every folder on the way (code/ goes deep), not only the first.
  const parts = rel.split("/");
  try {
    for (let i = 1; i < parts.length; i++) {
      const sub = join(dir, ...parts.slice(0, i));
      if (existsSync(sub) && lstatSync(sub).isSymbolicLink()) return false;
    }
    const full = join(dir, rel);
    if (existsSync(full) && lstatSync(full).isSymbolicLink()) return false;
  } catch {
    return false;
  }
  return true;
}

/**
 * The design's files in a folder. Symlinks are skipped: a repo could otherwise point
 * model/x.yaml at any file on the server (or a folder at itself). A file that vanishes
 * mid-read (a checkout in progress) is skipped; the watcher reads again once it settles.
 */
export function readFolder(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string, depth: number) => {
    // Only code/ goes deeper than one folder.
    const inCode = relative(dir, d).split("\\").join("/").startsWith("code");
    if (depth > (inCode ? 32 : 3) || !existsSync(d)) return;
    for (const name of readdirSync(d)) {
      // Hidden names are skipped, but not inside code/: a repo's .github/ or .storybook/ is code
      // the import mapped (unread, the fork's first write deleted 40 of their files).
      if (name.startsWith(".") && (!inCode || name === ".git" || name === "." || name === ".."))
        continue;
      const p = join(d, name);
      try {
        const st = lstatSync(p);
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) walk(p, depth + 1);
        else if (st.isFile()) {
          const rel = relative(dir, p).split("\\").join("/");
          if (isOurs(rel)) out.set(rel, readFileSync(p, "utf8"));
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
  };
  walk(dir, 0);
  return out;
}

/** After a code file goes, the folders it leaves empty under code/ go too. */
function pruneEmpty(dir: string, rel: string): void {
  const parts = rel.split("/");
  if (parts[0] !== "code") return;
  for (let i = parts.length - 1; i >= 1; i--) {
    const d = join(dir, ...parts.slice(0, i));
    try {
      if (lstatSync(d).isSymbolicLink() || readdirSync(d).length) return;
      rmdirSync(d);
    } catch {
      return;
    }
  }
}

/**
 * The folder is only behind Archnemesis, not edited: every file there is what Archnemesis would write
 * now, and some are missing (files Archnemesis wasn't allowed to write yet, as code/ before it
 * was one of its own). Then writing catches it up; reading would delete what's missing.
 */
export function behind(onDisk: Map<string, string>, expected: Map<string, string>): boolean {
  let missing = false;
  for (const p of expected.keys()) if (p !== "AGENTS.md" && !onDisk.has(p)) missing = true;
  if (!missing) return false;
  for (const [p, t] of onDisk) if (p !== "AGENTS.md" && expected.get(p) !== t) return false;
  return true;
}

const hash = (files: Map<string, string>) =>
  createHash("sha256")
    .update(
      [...files]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([p, t]) => `${p}\n${t}`)
        .join("\0"),
    )
    .digest("hex");

export class FileSync {
  private written = new Map<string, string>();
  private writeTimer: NodeJS.Timeout | null = null;
  private readTimer: NodeJS.Timeout | null = null;
  /** What archnm.yaml says (the name, what `forbid` refuses). */
  config: FConfig = {};
  private stop: (() => void) | null = null;
  problems: Problem[] = [];
  private live: Live;
  readonly dir: string;
  readonly mirror: boolean;
  private unlisten: (() => void) | null = null;

  constructor(live: Live, dir: string, opts: { mirror?: boolean } = {}) {
    this.live = live;
    this.dir = dir;
    this.mirror = opts.mirror ?? false;
  }

  /** The folder's Archnemesis files. */
  private readDir(): Map<string, string> {
    return readFolder(this.dir);
  }

  start(): void {
    mkdirSync(this.dir, { recursive: true });
    const onDisk = this.readDir();
    const meta = this.live.doc.getMap<string>("meta");
    if (this.mirror) {
      // The document is whatever the checkout says.
      this.written = new Map();
      if (onDisk.size) this.guard("read", () => this.apply(onDisk));
    } else {
      if (
        onDisk.size &&
        hash(onDisk) !== meta.get("filesHash") &&
        !behind(onDisk, writeFiles(this.live.state, this.live.config()))
      ) {
        console.log(`archnm: reading ${this.dir} (changed since Archnemesis last wrote it)`);
        this.written = new Map();
        this.guard("read", () => this.apply(onDisk));
      }
      this.guard("write", () => this.flush());
      this.unlisten = this.live.onChange(() => this.scheduleWrite());
    }
    const w = watch(this.dir, { recursive: true }, (_e, name) => {
      const rel = name ? String(name).split("\\").join("/") : "";
      if (rel && !isOurs(rel) && !(this.mirror && rel === "landscape.yaml")) return;
      if (this.readTimer) clearTimeout(this.readTimer);
      this.readTimer = setTimeout(() => this.guard("read", () => this.onFilesChanged()), 300);
    });
    // The folder went away or can't be watched: say so, don't take the server down.
    w.on("error", (e) => console.error(`archnm: watching ${this.dir}:`, e.message));
    this.stop = () => w.close();
  }

  close(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.flush();
    }
    if (this.readTimer) clearTimeout(this.readTimer);
    this.unlisten?.();
    this.stop?.();
  }

  private scheduleWrite(): void {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.guard("write", () => this.flush());
    }, 1000);
  }

  /** Run timer work so a failure (a full disk, a bad entry) is logged, never fatal. */
  private guard(what: string, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      console.error(
        `archnm: ${what} ${this.dir}:`,
        e instanceof Error ? (e.stack ?? e.message) : e,
      );
    }
  }

  /**
   * Write the document out: only files whose contents changed, and remove ones no longer
   * needed. Not while the folder has errors: that would overwrite someone's half-finished
   * edit. Writing resumes once the folder reads cleanly again.
   */
  flush(): void {
    if (this.mirror) return;
    if (this.broken()) {
      // Edits made while the files are broken: when the fixed files come in they win, so
      // keep a copy of Archnemesis's version first (see apply).
      this.editedWhileBroken = true;
      return;
    }
    const keys = keyOps(this.live.state);
    if (keys.length)
      applyOps(this.live.doc, this.live.state, keys, SERVER, "gave new things file keys", SERVER, {
        pin: false,
      });
    const files = writeFiles(this.live.state, this.live.config());
    const onDisk = readFolder(this.dir);
    for (const [path, text] of files) {
      if (onDisk.get(path) === text) continue;
      if (path === "AGENTS.md" && !isGeneratedAgents(onDisk.get(path))) continue;
      if (!writable(this.dir, path)) {
        console.error(
          `archnm: ${this.live.design}: refused to write ${JSON.stringify(path)}: not one of Archnemesis's files in the design's folder`,
        );
        continue;
      }
      const full = join(this.dir, path);
      mkdirSync(dirname(full), { recursive: true });
      const tmp = join(dirname(full), `.${path.split("/").pop()}.${process.pid}.tmp`);
      writeFileSync(tmp, text);
      renameSync(tmp, full);
    }
    for (const path of onDisk.keys())
      if (!files.has(path) && path !== "AGENTS.md" && writable(this.dir, path)) {
        rmSync(join(this.dir, path));
        pruneEmpty(this.dir, path);
      }
    this.written = files;
    const meta = this.live.doc.getMap<string>("meta");
    const h = hash(files);
    if (meta.get("filesHash") !== h) this.live.doc.transact(() => meta.set("filesHash", h), SERVER);
  }

  /** Edits were made while the folder had errors (so they were never written). */
  private editedWhileBroken = false;

  /**
   * Before fixed files replace edits made while they were broken: Archnemesis's version, as
   * files, in recovered/ next to the database, and a line in the history saying where.
   */
  private keepCopy(): void {
    if (!this.live.state.objects.size) return; // nothing of Archnemesis's to lose
    const at = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
    const dir = join(
      this.live.stateDir,
      "recovered",
      this.live.key.replace(/[^a-z0-9._-]/gi, "_"),
      at,
    );
    try {
      for (const [path, text] of writeFiles(this.live.state, this.live.config())) {
        if (!isOurs(path)) continue;
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), text, { mode: 0o600 });
      }
    } catch (e) {
      console.error(`archnm: couldn't keep a copy in ${dir}:`, e);
      return;
    }
    console.warn(
      `archnm: ${this.live.key}: the files were fixed; edits made in Archnemesis while they were broken are replaced by them. Archnemesis's version is in ${dir}`,
    );
    this.live.doc.transact(
      () =>
        appendLog(this.live.doc, {
          actor: FILES,
          label:
            "files fixed: edits made here while they were broken are replaced by them (Archnemesis kept a copy on the server)",
          at: new Date().toISOString(),
          ids: [],
        }),
      FILES,
    );
  }

  private broken(): boolean {
    return this.problems.some((p) => p.level === "error");
  }

  private onFilesChanged(): void {
    const files = this.readDir();
    const same =
      files.size === this.written.size && [...files].every(([p, t]) => this.written.get(p) === t);
    if (same) return;
    // Still changing (a pull or checkout halfway through): wait for it to settle.
    if (hash(this.readDir()) !== hash(files)) {
      if (this.readTimer) clearTimeout(this.readTimer);
      this.readTimer = setTimeout(() => this.guard("read", () => this.onFilesChanged()), 300);
      return;
    }
    this.apply(files);
  }

  /** Check the folder and apply it to the document; on errors, say so and change nothing. */
  private apply(files: Map<string, string>, raw: Map<string, string> = files): void {
    const { model, problems } = readFiles(files);
    this.problems = [...problems, ...check(model)];
    // A folder without archnm.yaml isn't a design: most likely deleted, or caught halfway
    // through a checkout. Reading it would delete everything, so treat it as broken.
    if (files.size && !hasDesignFile(files))
      this.problems.unshift({
        level: "error",
        file: "archnm.yaml",
        message: "missing (is the folder being replaced?)",
      } as Problem);
    else if (!files.size && this.live.state.objects.size)
      this.problems.unshift({
        level: "error",
        file: "archnm.yaml",
        message: "the folder is empty; not deleting the design",
      } as Problem);
    else {
      // Most of the design gone at once is far likelier a deleted folder or a bad checkout
      // than an edit. Deleting that much is done in Archnemesis, where it can be undone.
      const had = this.live.state.objects.size;
      const keeps = model.objects.length;
      const noModel = ![...files.keys()].some((p) => p.startsWith("model/"));
      if (!this.mirror && had && (noModel || (had >= 10 && keeps < had / 2)))
        this.problems.unshift({
          level: "error",
          file: "model/",
          message: `these files would delete ${had - keeps} of ${had} objects; not applied (delete them in Archnemesis instead, or restore the files)`,
        } as Problem);
    }
    const errors = this.problems.filter((p) => p.level === "error");
    if (errors.length) {
      const first = errors[0]!;
      console.error(
        `archnm: not applying ${this.dir}: ${errors.length} error(s), first: ${first.file}: ${first.message}`,
      );
      this.live.doc.transact(
        () =>
          appendLog(this.live.doc, {
            actor: FILES,
            label: `files not applied, and not overwritten until fixed: ${first.file}: ${first.message}${errors.length > 1 ? ` (+${errors.length - 1} more)` : ""}`,
            at: new Date().toISOString(),
            ids: [],
          }),
        FILES,
      );
      return;
    }
    this.config = model.config;
    this.live.setConfig(model.config);
    let ops: Op[];
    try {
      ops = toOps(this.live.state, model);
    } catch (e) {
      // A shape reading let through but applying can't take: report it like any error.
      this.problems.unshift({
        level: "error",
        file: "(files)",
        message: `couldn't apply: ${e instanceof Error ? e.message : String(e)}`,
      });
      console.error(`archnm: not applying ${this.dir}:`, e);
      return;
    }
    if (ops.length && this.editedWhileBroken && !this.mirror) this.keepCopy();
    this.editedWhileBroken = false;
    // The design's name lives in archnm.yaml too.
    if (model.config.name) this.live.setName(model.config.name);
    if (!ops.length) {
      this.written = raw;
      return;
    }
    const changed = [...files.keys()].filter((p) => this.written.get(p) !== files.get(p));
    const removed = [...this.written.keys()].filter((p) => !files.has(p));
    const what = [...changed, ...removed.map((p) => `-${p}`)];
    applyOps(
      this.live.doc,
      this.live.state,
      ops,
      FILES,
      `files changed: ${what.slice(0, 3).join(", ")}${what.length > 3 ? ` +${what.length - 3}` : ""}`,
      FILES,
      {
        pin: false,
      },
    );
    this.live.applyRules();
    // Write back the canonical form (and anything the rules added); a mirror never writes.
    if (!this.mirror) this.scheduleWrite();
  }
}
