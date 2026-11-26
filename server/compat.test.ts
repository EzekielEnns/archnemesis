// What still works from before the rename (atlas -> archnm): the old env vars, database file,
// fork branches, personal tokens and generated AGENTS.md.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isGeneratedAgents } from "../shared/agentsmd.ts";
import { isPersonalToken } from "./signin/personal.ts";
import { defaultDbPath } from "./config.ts";
import { DocStore, type ForkRow } from "./store.ts";

describe("the old name still works", () => {
  it("copies ATLAS_* to ARCHNM_* and warns once, unless the new one is set", () => {
    const script = join(import.meta.dirname, "env-compat.ts");
    const run = (env: Record<string, string>) =>
      spawnSync(
        process.execPath,
        [
          "-e",
          `await import(${JSON.stringify(script)}); console.log(process.env.ARCHNM_PORT, process.env.ARCHNM_DB)`,
        ],
        { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8" },
      );
    const same = run({ ARCHNM_PORT: "1", ARCHNM_DB: "x" });
    expect(same.stdout.trim()).toBe("1 x");
    expect(same.stderr).toBe("");
    const old = run({ ATLAS_PORT: "2", ATLAS_DB: "old", ARCHNM_DB: "new" });
    expect(old.stdout.trim()).toBe("2 new");
    expect(old.stderr).toContain("ATLAS_PORT");
    expect(old.stderr).not.toContain("ATLAS_DB");
  });

  it("opens data/atlas.sqlite in place when there is no data/archnm.sqlite", () => {
    const root = mkdtempSync(join(tmpdir(), "archnm-db-"));
    expect(defaultDbPath(root)).toBe(join(root, "data", "archnm.sqlite"));
    mkdirSync(join(root, "data"));
    writeFileSync(join(root, "data", "atlas.sqlite"), "");
    expect(defaultDbPath(root)).toBe(join(root, "data", "atlas.sqlite"));
    writeFileSync(join(root, "data", "archnm.sqlite"), "");
    expect(defaultDbPath(root)).toBe(join(root, "data", "archnm.sqlite"));
  });

  it("keeps a stored fork branch, and none stored means the old atlas/ one", () => {
    const store = new DocStore(":memory:");
    const row = (name: string, branch?: string): ForkRow => ({
      doc: `shop@${name}`,
      design: "shop",
      name,
      base: null,
      head: null,
      status: "open",
      byId: null,
      byName: null,
      agent: false,
      createdAt: "2026-11-26T00:00:00Z",
      ...(branch ? { branch } : {}),
    });
    store.addFork(row("old"));
    store.addFork(row("new", "archnm/shop/new"));
    const forks = store.forks("shop");
    expect(forks.find((f) => f.name === "old")!.branch).toBeNull();
    expect(forks.find((f) => f.name === "new")!.branch).toBe("archnm/shop/new");
  });

  it("accepts personal tokens with either prefix", () => {
    expect(isPersonalToken("archnm_pat_abc")).toBe(true);
    expect(isPersonalToken("atlas_pat_abc")).toBe(true);
    expect(isPersonalToken("other_abc")).toBe(false);
  });

  it("knows an AGENTS.md generated under the old name", () => {
    expect(
      isGeneratedAgents(
        "<!-- atlas: generated from the file format and atlas.yaml; edits here are replaced -->\n",
      ),
    ).toBe(true);
    expect(isGeneratedAgents("# my own notes\n")).toBe(false);
  });
});
