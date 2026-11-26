// A Host over a design held in memory: a Y doc of its own. For tests, scripts and anything
// that has a design but no server (an imported folder, the local demo).
import * as Y from "yjs";
import {
  applyOps,
  emptyState,
  logEntryOk,
  logOf,
  mirror,
  UndoSteps,
  type ModelState,
} from "../doc.ts";
import type { FConfig } from "../files.ts";
import type { Author, Op } from "../model.ts";
import type { ModelIndex } from "../project.ts";
import { viewOps } from "../views.ts";
import type { Canvas, Host } from "./host.ts";
import { indexOf } from "./problems.ts";

export interface MemHost extends Host {
  doc: Y.Doc;
}

export function memHost(
  o: {
    key?: string;
    actor?: Author;
    ops?: Op[];
    config?: FConfig;
    canvas?: Canvas;
    canEdit?: boolean;
    /** A fork's main: the host is then a fork (branch set) and read {diff} compares with this. */ base?: ModelState;
  } = {},
): MemHost {
  const doc = new Y.Doc();
  const state: ModelState = emptyState();
  let idx: ModelIndex | null = null;
  mirror(doc, state, () => {
    idx = null;
  });
  const system: Author = { id: "archnm", name: "archnm", kind: "system" };
  if (o.ops?.length) applyOps(doc, state, o.ops, system, "seed");
  const actor = o.actor ?? { id: "agent:test", name: "Test agent", kind: "agent" };
  const steps = new UndoSteps(doc, { actor: actor.id });
  let config = o.config ?? {};
  const host: MemHost = {
    doc,
    key: o.key ?? "test",
    branch: o.base ? `${o.key ?? "test"}-fork` : null,
    actor,
    canEdit: o.canEdit ?? true,
    state: () => state,
    index: () => (idx ??= indexOf(state)),
    config: () => config,
    commit(ops, label, opts) {
      for (const op of ops)
        if (op.op === "taggroup.put")
          config = { ...config, tags: { ...(config.tags ?? {}), [op.name]: op.group } };
      // host.actor, so a test can act as another session.
      steps.apply(state, ops, host.actor, label, opts);
    },
    applyRules() {
      const i = indexOf(state);
      const follow = [...state.diagrams.values()]
        .filter((d) => d.rules)
        .flatMap((d) => viewOps(i, d.id));
      // As the server does: Archnemesis's own, not in anyone's undo.
      if (follow.length) applyOps(doc, state, follow, system, "rules", system, { pin: false });
    },
    undo: (dry) => steps.undo(dry),
    recent: (n) => logOf(doc).toArray().filter(logEntryOk).slice(-n),
    url: (d, ob) => `archnm://${o.key ?? "test"}${d ? `/d/${d}` : ""}${ob ? `/o/${ob}` : ""}`,
    canvas: o.canvas,
    ...(o.base ? { base: async () => o.base! } : {}),
  };
  return host;
}
