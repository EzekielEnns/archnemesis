import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { seedOps } from "./seed.ts";
import { filesFromOps } from "./filesFromOps.ts";
import { cleanPath, crc32, unzipDesign, zipFiles } from "./zip.ts";

const has = (cmd: string, arg: string) => spawnSync(cmd, [arg]).status === 0;

describe("zip", () => {
  it("computes the standard crc32", () => {
    expect(crc32(new TextEncoder().encode("123456789")).toString(16)).toBe("cbf43926");
  });

  it("round-trips a design through zip and unzip", async () => {
    const files = filesFromOps(seedOps(), { name: "Shop" });
    expect(await unzipDesign(zipFiles(files))).toEqual(files);
  });

  it.runIf(has("unzip", "-v"))("makes a zip the system unzip accepts, with the same text", () => {
    const files = new Map([
      ["archnm.yaml", "name: Café\n"],
      ["model/shop.yaml", "a: 1\n"],
    ]);
    const dir = mkdtempSync(join(tmpdir(), "zip-test-"));
    const zip = join(dir, "d.zip");
    writeFileSync(zip, zipFiles(files));
    execFileSync("unzip", ["-tq", zip]);
    execFileSync("unzip", ["-q", zip, "-d", join(dir, "out")]);
    expect(readFileSync(join(dir, "out", "archnm.yaml"), "utf8")).toBe("name: Café\n");
    expect(readFileSync(join(dir, "out", "model", "shop.yaml"), "utf8")).toBe("a: 1\n");
  });

  it.runIf(has("zip", "-v"))(
    "reads a zip made by the system zip tool, under one folder",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "zip-test-"));
      mkdirSync(join(dir, "repo-main", "arch", "model"), { recursive: true });
      writeFileSync(join(dir, "repo-main", "arch", "archnm.yaml"), "name: Deep\n".repeat(50));
      writeFileSync(join(dir, "repo-main", "arch", "model", "a.yaml"), "x: 1\n");
      writeFileSync(join(dir, "repo-main", "README.md"), "hi");
      execFileSync("zip", ["-qr", "r.zip", "repo-main"], { cwd: dir });
      const back = await unzipDesign(new Uint8Array(readFileSync(join(dir, "r.zip"))));
      expect([...back.keys()].sort()).toEqual(["archnm.yaml", "model/a.yaml"]);
      expect(back.get("archnm.yaml")).toBe("name: Deep\n".repeat(50));
    },
  );

  it("says plainly when it is not a zip, or has no design", async () => {
    await expect(unzipDesign(new TextEncoder().encode("hello world, not a zip"))).rejects.toThrow(
      /isn't a zip/,
    );
    await expect(unzipDesign(zipFiles(new Map([["README.md", "hi"]])))).rejects.toThrow(
      /no design/,
    );
  });

  it("cleans paths: nothing upward, nothing absolute", () => {
    expect(cleanPath("a/./b")).toBe("a/b");
    expect(cleanPath("../a")).toBeNull();
    expect(cleanPath("a/../../b")).toBeNull();
    expect(cleanPath("/etc/passwd")).toBeNull();
    expect(cleanPath("C:\\x")).toBeNull();
    expect(cleanPath("a\\b")).toBe("a/b");
  });

  it("refuses an entry that claims to unpack past the cap", async () => {
    const zip = zipFiles(new Map([["archnm.yaml", "x"]]));
    const v = new DataView(zip.buffer, zip.byteOffset);
    for (let i = 0; i < zip.length - 4; i++)
      if (v.getUint32(i, true) === 0x02014b50) v.setUint32(i + 24, 50_000_000, true);
    await expect(unzipDesign(zip)).rejects.toThrow(/too much/);
  });
});
