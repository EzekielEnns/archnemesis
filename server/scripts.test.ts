// The scripts Archnemesis hands out are built when dist/ lacks them, once, and say what's wrong when they can't be.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Scripts } from "./scripts.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "archnm-scripts-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the scripts Archnemesis hands out", () => {
  it("builds a missing one once, however many ask at the same time", async () => {
    let builds = 0;
    const s = new Scripts(dir, async (config) => {
      builds++;
      expect(config).toBe("vite.index.config.ts");
      mkdirSync(join(dir, "dist"), { recursive: true });
      writeFileSync(join(dir, "dist", "archnm-index.cjs"), "console.log(1)");
    });
    const [a, b] = await Promise.all([s.ensure("archnm-index.cjs"), s.ensure("archnm-index.cjs")]);
    expect(a.ok && b.ok).toBe(true);
    expect(builds).toBe(1);
    const r = await s.read("archnm-index.cjs");
    expect(r.ok && r.data.toString()).toBe("console.log(1)");
    await s.ensure("archnm-index.cjs");
    expect(builds).toBe(1);
  });

  it("says exactly what's wrong when it can't build one", async () => {
    const s = new Scripts(dir, async () => {
      throw new Error("Cannot find package 'vite'");
    });
    const r = await s.ensure("archnm-index.cjs");
    expect(r).toEqual({
      ok: false,
      error: "dist/archnm-index.cjs is missing and building it failed: Cannot find package 'vite'",
    });
  });
});
