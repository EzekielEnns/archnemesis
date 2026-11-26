// Forks and history in the static build, all in this browser. The server's Branches, kept the
// same way local.ts keeps designs: each design has a main (its own document) and forks (each a
// document of its own, started as a copy of main's state). Merging a fork into main is a
// Yjs merge, so edits made on main in the meantime are kept too and nothing ever conflicts.
// History is a list of versions of main (its files, see local-versions.ts): one on each merge,
// and one a little after direct edits to main settle.
//
// One difference from the server, on purpose: main stays directly editable here (a first-time
// visitor, or an agent, draws on it at once). Forks are for trying a change on the side.
import * as Y from "yjs";
import type { ForkInfo, GitInfo } from "../../shared/api.ts";
import { stateFromFiles } from "../../shared/diff.ts";
import { readState } from "../../shared/doc.ts";
import { slug } from "../../shared/model.ts";
import { fingerprint } from "../../shared/sharelink.ts";
import { changedWithContext, type WhatsNew } from "../../shared/whatsnew.ts";
import {
  createCore,
  filesKey,
  forkKey,
  sameFiles,
  type ForkRecord,
  type GitCore,
  type GitDeps,
  type GitHost,
} from "./local-core.ts";
import { giveKeys } from "./portable-files.ts";
import { createUpstream, refusedHere } from "./local-upstream.ts";
import { stateJsonOf, type VersionMeta } from "./local-versions.ts";
import { watchDoc } from "./local-watch.ts";
import type { DesignRecord } from "./local.ts";
import { BackendError, type Backend, type DesignDoc } from "./types.ts";

export type { GitDeps, GitHost } from "./local-core.ts";

const notFork = () => new BackendError("missing", "That isn't a fork.", 404);

async function forkInfo(core: GitCore, f: ForkRecord, list: VersionMeta[]): Promise<ForkInfo> {
  const { host, deps } = core;
  const now = await core.files({ key: forkKey(f), doc: f.doc });
  const base = f.base ? await deps.versions.files(f.design, f.base) : null;
  const changed = !base || !sameFiles(now, base);
  const at = f.base ? list.findIndex((v) => v.sha === f.base) : 0;
  return {
    doc: forkKey(f),
    name: f.name,
    branch: `archnm/${f.design}/${f.name}`,
    by: f.by,
    agent: false,
    createdAt: f.createdAt,
    base: f.base,
    head: changed ? fingerprint(filesKey(now)) : null,
    pending: false,
    saving: false,
    behind: Math.max(0, at),
    present: host.open.has(forkKey(f)) ? 1 : 0,
    proposedAt: f.proposedAt,
    pr: null,
  };
}

/** What the branch menu shows for a design: main, its upstream (if any), and its forks. */
async function gitInfo(
  core: GitCore,
  key: string,
  state: { syncing: Set<string>; errors: Map<string, string> },
): Promise<GitInfo> {
  const rec = core.find(key);
  const list = await core.deps.versions.list(key);
  const up = rec.upstream;
  return {
    design: key,
    remote: up ? `${up.owner}/${up.repo}` : "",
    local: false,
    inBrowser: true,
    path: up?.folder ?? "",
    branch: up?.branch ?? "main",
    forge: null,
    app: null,
    main: list[0]?.sha ?? null,
    syncedAt: up?.pulledAt ?? null,
    syncing: state.syncing.has(key),
    error: state.errors.get(key) ?? null,
    forks: await Promise.all(core.forks.of(key).map((f) => forkInfo(core, f, list))),
  };
}

/** A name for a new fork: the one asked for, else yours and the date; never one a fork has. */
function nameFor(core: GitCore, rec: DesignRecord, wanted?: string): string {
  const first = core.host.who().split(/\s+/)[0] || "fork";
  const today = new Date().toISOString().slice(5, 10);
  let base = slug(wanted?.trim() || `${first}-${today}`).slice(0, 40) || "fork";
  if (base === "main") base = "main-fork";
  let name = base;
  for (let i = 2; core.forks.of(rec.key).some((f) => f.name === name); i++) name = `${base}-${i}`;
  return name;
}

async function startFork(core: GitCore, key: string, wanted?: string): Promise<{ doc: string }> {
  const rec = core.find(key);
  // Boxes get their keys first, so the fork's changes line up with the version it starts from.
  await core.host.withDoc(rec, giveKeys);
  // The version it starts from: what's on main now, kept in the history.
  const made = await core.record(rec, "Edits before a fork");
  const base = made?.sha ?? (await core.deps.versions.list(key))[0]?.sha ?? null;
  const f: ForkRecord = {
    doc: crypto.randomUUID(),
    design: key,
    name: nameFor(core, rec, wanted),
    by: core.host.who(),
    createdAt: new Date().toISOString(),
    base,
    proposedAt: null,
  };
  await core.host.clone(rec, f.doc);
  core.forks.save([...core.forks.all(), f]);
  core.ping(key);
  return { doc: forkKey(f) };
}

/** A fork is over (merged or thrown away): its record and document go, and its tabs move to main. */
async function endFork(core: GitCore, f: ForkRecord, why: string): Promise<void> {
  core.forks.save(core.forks.all().filter((x) => x.doc !== f.doc));
  core.host.open.get(forkKey(f))?.handlers.onEvent({ type: "moved", to: f.design, why });
  await core.host.wipe(f.doc);
  core.ping(f.design);
}

async function mergeFork(core: GitCore, doc: string): Promise<{ result: string }> {
  const f = core.forks.byDoc(doc);
  if (!f) throw notFork();
  const rec = core.find(f.design);
  const update = await core.host.withDoc({ key: doc, doc: f.doc }, (y) => Y.encodeStateAsUpdate(y));
  // The fork's edits join main's, whatever main did meanwhile.
  await core.host.withDoc(rec, (main) => Y.applyUpdate(main, update, "merge"));
  await core.record(rec, `Merged ${f.name}`, true);
  await endFork(core, f, `Merged ${f.name} into main`);
  return { result: `Merged ${f.name} into main` };
}

async function changesOf(core: GitCore, doc: string): Promise<WhatsNew | null> {
  const f = core.forks.byDoc(doc);
  const base = f?.base ? await core.deps.versions.files(f.design, f.base) : null;
  if (!f || !base) return null;
  const now = await core.host.withDoc({ key: doc, doc: f.doc }, readState);
  return changedWithContext(stateFromFiles(new Map(Object.entries(base))), now);
}

export function createLocalGit(host: GitHost, deps: GitDeps) {
  const core = createCore(host, deps);
  const upstream = createUpstream(core);
  const state = { syncing: new Set<string>(), errors: new Map<string, string>() };

  const git: NonNullable<Backend["git"]> = {
    inBrowser: true,
    info: (key) => gitInfo(core, key, state),
    follow: () => Promise.reject(refusedHere()),
    async sync(key) {
      state.syncing.add(key);
      state.errors.delete(key);
      try {
        await upstream.sync(key);
      } catch (e) {
        state.errors.set(key, e instanceof Error ? e.message : String(e));
        throw e;
      } finally {
        state.syncing.delete(key);
      }
      return gitInfo(core, key, state);
    },
    fork: (key, name) => startFork(core, key, name),
    edit: () => Promise.reject(new BackendError("refused", "Main can be edited directly here.")),
    saveNotes: () =>
      Promise.reject(new BackendError("refused", "Main can be edited directly here.")),
    merge: (doc) => mergeFork(core, doc),
    async discard(doc) {
      const f = core.forks.byDoc(doc);
      if (!f) throw notFork();
      await endFork(core, f, `Discarded ${f.name}`);
    },
    propose: () => Promise.reject(refusedHere()),
    whatsNew: (doc) => changesOf(core, doc),
  };

  const versions: NonNullable<Backend["versions"]> = {
    list: (key) => deps.versions.list(core.find(key).key),
    async at(key, sha) {
      const files = await deps.versions.files(core.find(key).key, sha);
      if (!files) throw new BackendError("missing", "That version is gone.", 404);
      return stateJsonOf(files);
    },
  };

  return {
    git,
    versions,
    watch: (key: string, ydoc: Y.Doc) => watchDoc(core, key, ydoc),
    /** A fork, as the store opens it (null: not one). */
    docInfo(doc: string): DesignDoc | null {
      const f = core.forks.byDoc(doc);
      const rec = f ? host.designs.find(f.design) : null;
      if (!f || !rec) return null;
      return { key: doc, name: rec.name, doc: f.doc, mode: "fork", git: true, canEdit: true };
    },
    forkByDoc: core.forks.byDoc,
    forkCount: (design: string) => core.forks.of(design).length,
    adopt: upstream.adopt,
    /** A design is deleted: its forks and history go too. */
    async removeDesign(key: string): Promise<void> {
      for (const f of core.forks.of(key)) await host.wipe(f.doc);
      core.forks.save(core.forks.all().filter((f) => f.design !== key));
      await deps.versions.removeDesign(key);
    },
  };
}
