// The server reads and writes only its own files in a design's folder: now including code/
// (as deep as the source tree) and libraries.yaml, never through a symlink or "..".
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Principal } from "./auth.ts";
import { testConfig } from "./testing.ts";
import { Auth } from "./auth.ts";
import { behind, isOurs, readFolder, writable } from "./files.ts";
import { Hub } from "./live.ts";
import { DocStore } from "./store.ts";

describe("design folder files", () => {
  it("knows code files and libraries.yaml as its own", () => {
    expect(isOurs("code/s-chan/crates/board/src/hub/routes.rs.yaml")).toBe(true);
    expect(isOurs("code/s-chan/crates/board/_.yaml")).toBe(true);
    expect(isOurs("libraries.yaml")).toBe(true);
    expect(isOurs("code/x.yaml")).toBe(false);
    expect(isOurs("code/../model/x.yaml")).toBe(false);
    expect(isOurs("code/a/./b.yaml")).toBe(false);
    expect(isOurs("node_modules/a/b.yaml")).toBe(false);
  });

  it("reads deep code files, and nothing deep anywhere else", () => {
    const dir = mkdtempSync(join(tmpdir(), "archnm-files-"));
    const deep = join(dir, "code/s-chan/crates/board/src/hub");
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, "routes.rs.yaml"), "objects: []\n");
    writeFileSync(join(dir, "libraries.yaml"), "objects: []\n");
    mkdirSync(join(dir, "model/deep/er"), { recursive: true });
    writeFileSync(join(dir, "model/deep/er/x.yaml"), "objects: []\n");
    const files = readFolder(dir);
    expect([...files.keys()].sort()).toEqual([
      "code/s-chan/crates/board/src/hub/routes.rs.yaml",
      "libraries.yaml",
    ]);
  });

  it("won't write through a symlinked folder anywhere on the way", () => {
    const dir = mkdtempSync(join(tmpdir(), "archnm-files-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "archnm-else-"));
    mkdirSync(join(dir, "code/s-chan"), { recursive: true });
    symlinkSync(elsewhere, join(dir, "code/s-chan/crates"));
    expect(writable(dir, "code/s-chan/crates/board/_.yaml")).toBe(false);
    expect(writable(dir, "code/s-chan/other.rs.yaml")).toBe(true);
  });

  it("a folder that's only missing files Archnemesis would write is behind, not edited", () => {
    const want = new Map([
      ["model/a.yaml", "a"],
      ["code/r/x.rs.yaml", "x"],
      ["AGENTS.md", "g"],
    ]);
    expect(behind(new Map([["model/a.yaml", "a"]]), want)).toBe(true);
    // Someone changed a file: read it (and let the delete guard judge).
    expect(behind(new Map([["model/a.yaml", "b"]]), want)).toBe(false);
    // Nothing missing: not behind (the hash decides as before).
    expect(
      behind(
        new Map([
          ["model/a.yaml", "a"],
          ["code/r/x.rs.yaml", "x"],
        ]),
        want,
      ),
    ).toBe(false);
  });

  it("round-trips a folder with atlas.yaml (the old name) to one with only archnm.yaml", async () => {
    const dir = mkdtempSync(join(tmpdir(), "archnm-files-"));
    const alice: Principal = { id: "ts:alice", name: "Alice", kind: "human", roles: ["admin"] };
    const open = () =>
      new Hub(
        new DocStore(join(dir, "archnm.sqlite")),
        new Auth(testConfig(dir).auth),
        testConfig(dir),
      );
    const first = open();
    await first.start();
    const objects = (await first.create("Shop", "shop", "example", alice)).state.objects.size;
    await first.close();
    const folder = join(dir, "designs", "shop");
    expect(existsSync(join(folder, "archnm.yaml"))).toBe(true);
    // As an install from before the rename left it.
    renameSync(join(folder, "archnm.yaml"), join(folder, "atlas.yaml"));
    const second = open();
    await second.start();
    expect(second.designs.get("shop")!.state.objects.size).toBe(objects);
    await second.close();
    expect(readdirSync(folder)).toContain("archnm.yaml");
    expect(readdirSync(folder)).not.toContain("atlas.yaml");
    expect(isOurs("atlas.yaml")).toBe(true);
  });
});
