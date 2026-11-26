import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { backupNow } from "./backup.ts";
import { loadConfig } from "./config.ts";
import { DocStore } from "./store.ts";

describe("backups", () => {
  it("copies the database and keeps the newest few", async () => {
    const dir = mkdtempSync(join(tmpdir(), "archnm-backup-"));
    const store = new DocStore(join(dir, "archnm.sqlite"));
    store.setSetting("hello", "world");
    const o = { dir: join(dir, "backups"), everyMs: 1, keep: 2 };
    for (const t of ["2026-11-20T01:00:00Z", "2026-11-20T02:00:00Z", "2026-11-20T03:00:00Z"])
      await backupNow(store, o, new Date(t));
    const kept = readdirSync(o.dir).sort();
    expect(kept).toEqual([
      "archnm-2026-11-20T02-00-00Z.sqlite",
      "archnm-2026-11-20T03-00-00Z.sqlite",
    ]);
    const copy = new DatabaseSync(join(o.dir, kept[1]!));
    expect(copy.prepare("SELECT value FROM settings WHERE key = 'hello'").get()).toMatchObject({
      value: "world",
    });
    store.close();
  });

  it("is on by default next to the database, and can be turned off", () => {
    expect(loadConfig({ ARCHNM_DB: "/data/archnm.sqlite" }).backups).toMatchObject({
      dir: "/data/backups",
      keep: 28,
    });
    expect(loadConfig({ ARCHNM_DB: "/data/archnm.sqlite", ARCHNM_BACKUP_DIR: "off" }).backups).toBe(
      null,
    );
  });
});
