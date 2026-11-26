// Keeping an eye on an open document (the static build): main's edits become a version once they
// settle; a fork's tell the page its changes moved, so the diff and the merge button stay current.
import type * as Y from "yjs";
import { logOf } from "../../shared/doc.ts";
import { subjectOf, type GitCore } from "./local-core.ts";

/** Edits to main settle for this long before a version is kept; and never wait longer than the max. */
const IDLE_MS = 20_000;
const MAX_MS = 120_000;
const PING_MS = 800;

/** Watch the document `key` (a design's main, or a fork "design@fork"). Returns a stop. */
export function watchDoc(core: GitCore, key: string, ydoc: Y.Doc): () => void {
  const fork = core.forks.byDoc(key);
  const rec = fork ? null : (core.host.designs.find(key) ?? null);
  if (!fork && !rec) return () => {};
  const design = fork?.design ?? key;
  const log = logOf(ydoc);
  let seen = log.length;
  let idle: ReturnType<typeof setTimeout> | null = null;
  let max: ReturnType<typeof setTimeout> | null = null;
  const clear = () => {
    if (idle) clearTimeout(idle);
    if (max) clearTimeout(max);
    idle = max = null;
  };
  const flush = () => {
    clear();
    const main = core.host.designs.find(design);
    if (fork || !main) return core.ping(design);
    const subject = subjectOf(log.toArray().slice(seen));
    seen = log.length;
    void core
      .record(main, subject)
      .then((v) => v && core.ping(design))
      .catch(() => undefined);
  };
  const onUpdate = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(flush, fork ? PING_MS : (core.deps.idleMs ?? IDLE_MS));
    max ??= setTimeout(flush, fork ? PING_MS : (core.deps.maxMs ?? MAX_MS));
  };
  const onHide = () => {
    if (!fork && idle) flush();
  };
  ydoc.on("update", onUpdate);
  if (typeof window !== "undefined") window.addEventListener("pagehide", onHide);
  // A design that has no history yet starts one.
  if (rec)
    void core.deps.versions
      .list(key)
      .then((l) => (l.length ? null : core.record(rec, "Started")))
      .catch(() => undefined);
  return () => {
    ydoc.off("update", onUpdate);
    if (typeof window !== "undefined") window.removeEventListener("pagehide", onHide);
    if (idle) flush();
    clear();
  };
}
