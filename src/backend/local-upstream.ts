// A local design that remembers the public GitHub repository it was forked from (the static
// build): it can pull what changed there by reading the public repository again. Nothing is
// ever sent to GitHub but plain reads, with nothing about the visitor; pushing back needs a
// server (your own Archnemesis).
import * as Y from "yjs";
import type { GhSpec } from "../../shared/ghlink.ts";
import { sameFiles, toFiles, type GitCore } from "./local-core.ts";
import { fetchGhDesign } from "./github-public.ts";
import { applyModel, filesOfDoc, giveKeys, loadModel, readWithProblems } from "./portable-files.ts";
import { BackendError } from "./types.ts";

/** The repository a design was forked from, and where it was when last pulled. */
export interface Upstream {
  owner: string;
  repo: string;
  /** The branch or tag the link named (null: the repository's default). */
  branch: string | null;
  /** The design's folder in the repository ("" for the top). */
  folder: string;
  pulledAt: string;
  /** The version of main that matched the repository then. */
  pulledSha: string | null;
}

const NEEDS_SERVER =
  "Pushing to a repository needs your own Archnemesis (self-hosted). Here, forks live in this browser.";
export const refusedHere = () => new BackendError("refused", NEEDS_SERVER);

/** A design read from files, written out as this app writes it (so two can be compared). */
function normal(found: Map<string, string>, name: string) {
  const { model, error } = readWithProblems(found);
  if (error) throw new BackendError("refused", error);
  const tmp = new Y.Doc();
  loadModel(tmp, model, "tmp", name);
  return { model, files: toFiles(filesOfDoc(tmp)) };
}

/** Remember where a design came from: its main as it is now matches the repository. */
async function adopt(
  core: GitCore,
  key: string,
  spec: GhSpec,
  folder: string,
  subject: string,
): Promise<void> {
  const made = await core.record(core.find(key), subject, true);
  core.patch(key, {
    upstream: {
      owner: spec.owner,
      repo: spec.repo,
      branch: spec.ref,
      folder,
      pulledAt: new Date().toISOString(),
      pulledSha: made?.sha ?? null,
    },
  });
  core.ping(key);
}

/** Pull what changed on the public repository into main (when main has nothing of its own to lose). */
async function sync(core: GitCore, key: string): Promise<void> {
  const rec = core.find(key);
  const up = rec.upstream;
  if (!up) return;
  const found = await fetchGhDesign(
    { owner: up.owner, repo: up.repo, ref: up.branch, path: up.folder },
    core.deps.fetch ?? fetch.bind(globalThis),
  );
  // Written out the way main is, so the two compare (the name is main's own).
  const name = await core.host.withDoc(rec, (y) => y.getMap<string>("meta").get("name") ?? "");
  const incoming = normal(found.files, name);
  const now = await core.files(rec);
  const stamp = (sha: string | null) =>
    core.patch(key, { upstream: { ...up, pulledAt: new Date().toISOString(), pulledSha: sha } });
  if (sameFiles(incoming.files, now)) return stamp(up.pulledSha);
  const was = up.pulledSha ? await core.deps.versions.files(key, up.pulledSha) : null;
  if (was && !sameFiles(was, now))
    throw new BackendError(
      "refused",
      "Main has changes of its own, so it can't take the repository's changes on top. Fork it again from the link to start fresh, or merge your forks first and compare.",
    );
  await core.host.withDoc(rec, (ydoc) => {
    giveKeys(ydoc);
    applyModel(ydoc, incoming.model, "pulled from GitHub");
  });
  const made = await core.record(rec, `Pulled from ${up.owner}/${up.repo}`, true);
  stamp(made?.sha ?? up.pulledSha);
  core.ping(key);
}

export function createUpstream(core: GitCore) {
  return {
    sync: (key: string) => sync(core, key),
    adopt: (key: string, spec: GhSpec, folder: string, subject: string) =>
      adopt(core, key, spec, folder, subject),
  };
}
