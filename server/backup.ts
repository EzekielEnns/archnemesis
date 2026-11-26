// Copies of the database, so a dead disk or a bad edit isn't the end: the files hold the
// architecture (and git holds the files), but comment threads, history, forks and GitHub
// sign-ins only live here.
//
// Every few hours a consistent copy goes to a folder, named by time, and the newest are kept
// (ARCHNM_BACKUP_HOURS, ARCHNM_BACKUP_DIR, ARCHNM_BACKUP_KEEP: see server/config.ts; the dir
// can be off). These sit on the same disk: point the folder at
// another one, or have restic/Litestream/a bucket sync take it off the machine.
//
// To restore: stop Archnemesis, copy a backup over the database file (and delete its -wal and
// -shm files), start Archnemesis.
import { mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DocStore } from "./store.ts";

// atlas- is the old name: backups made before the rename are still listed and pruned.
const NAME = /^(?:archnm|atlas)-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.sqlite$/;

export interface BackupOptions {
  dir: string;
  everyMs: number;
  keep: number;
}

/** Take one backup now, then drop the oldest beyond `keep`. Returns its path. */
export async function backupNow(
  store: DocStore,
  o: BackupOptions,
  at = new Date(),
): Promise<string> {
  mkdirSync(o.dir, { recursive: true });
  const name = `archnm-${at.toISOString().slice(0, 19).replace(/:/g, "-")}Z.sqlite`;
  const tmp = join(o.dir, `.${name}.tmp`);
  rmSync(tmp, { force: true });
  await store.backupTo(tmp);
  renameSync(tmp, join(o.dir, name));
  const all = readdirSync(o.dir)
    .filter((f) => NAME.test(f))
    .sort((a, b) => (a.replace(/^[a-z]+-/, "") < b.replace(/^[a-z]+-/, "") ? -1 : 1));
  for (const old of all.slice(0, Math.max(0, all.length - o.keep)))
    rmSync(join(o.dir, old), { force: true });
  return join(o.dir, name);
}

/** Back up a minute after start, then on the interval. A failed backup is logged, not fatal. */
export function startBackups(store: DocStore, o: BackupOptions): () => void {
  const run = () =>
    backupNow(store, o).then(
      (p) => console.log(`archnm: backed up the database to ${p}`),
      (e: unknown) => console.error("archnm: backup failed:", e),
    );
  const first = setTimeout(run, 60_000);
  const every = setInterval(run, o.everyMs);
  first.unref();
  every.unref();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
