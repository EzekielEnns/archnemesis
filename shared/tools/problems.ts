// What `archnm check` would say about a design held live, and the index of a state.
import type { ModelState } from "../doc.ts";
import { check, readFiles, writeFiles, type FConfig, type Problem } from "../files.ts";
import { buildIndex, projectDiagram, type ModelIndex } from "../project.ts";
import { viewProblems } from "../score.ts";

export const indexOf = (s: ModelState): ModelIndex =>
  buildIndex({
    objects: s.objects.values(),
    connections: s.connections.values(),
    diagrams: s.diagrams.values(),
    placements: s.placements.values(),
    flows: s.flows.values(),
    arrows: s.arrows.values(),
    notes: s.notes.values(),
    replies: s.replies.values(),
    boundaries: s.boundaries.values(),
    decisions: s.decisions.values(),
    entities: s.entities.values(),
  });

/** A design as files, read back and checked: what a write starts from and lens problems reports. */
export interface FilesRead {
  files: Map<string, string>;
  read: ReturnType<typeof readFiles>;
  checked: Problem[];
}

// Kept per version of a design (its index is new after every change) and config: a big design
// is a second of YAML each way, and a dry run, the write after it and a lens all start here.
const kept = new WeakMap<ModelIndex, { config: FConfig; got: FilesRead }>();

/** The design as files, read back and checked; with `idx` (this state's index), kept until the next change. */
export function filesOf(state: ModelState, config: FConfig = {}, idx?: ModelIndex): FilesRead {
  const hit = idx && kept.get(idx);
  if (hit && hit.config === config) return hit.got;
  // With archnm.yaml's own forbid patterns, so an agent's edit is held to them too.
  const files = writeFiles(state, config);
  const read = readFiles(files);
  const got = { files, read, checked: check(read.model) };
  if (idx) kept.set(idx, { config, got });
  return got;
}

/** Problems with a model, as `archnm check` would report them on its files. */
export function problemsOf(state: ModelState, config: FConfig = {}, index?: ModelIndex): Problem[] {
  const got = filesOf(state, config, index);
  const problems = got.read.problems;
  const idx = index ?? indexOf(state);
  // An overlap with a box folded away on that view isn't one anybody sees: its stored
  // position just waits for it to unfold.
  const shownOn = new Map<string, Set<string>>();
  const shown = (view: string): Set<string> => {
    let s = shownOn.get(view);
    if (!s) {
      const d = [...idx.diagrams.values()].find((x) => (x.key ?? x.id) === view);
      s = new Set(
        d ? projectDiagram(idx, d.id).nodes.map((n) => idx.objects.get(n.id)?.key ?? n.id) : [],
      );
      shownOn.set(view, s);
    }
    return s;
  };
  const found = [...problems, ...got.checked].filter((p) => {
    const m = /^layout\/(.+)\.json$/.exec(p.file);
    const o = m && /^(\S+) and (\S+) overlap$/.exec(p.message);
    return !o || (shown(m[1]!).has(o[1]!) && shown(m[1]!).has(o[2]!));
  });
  // How readable the diagrams are, once the files themselves are sound.
  return found.some((p) => p.level === "error")
    ? found
    : [...found, ...viewProblems(idx, config.limits)];
}
