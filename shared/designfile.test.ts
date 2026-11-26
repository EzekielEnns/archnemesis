// The design's settings file is archnm.yaml; folders from before the rename have atlas.yaml,
// which is still read.
import { describe, expect, it } from "vitest";
import { hasDesignFile, normalizeDesignFile, readFiles } from "./files.ts";

describe("the design file's old name", () => {
  it("reads atlas.yaml", () => {
    const { model, problems } = readFiles(new Map([["atlas.yaml", "name: Old\nversion: 2\n"]]));
    expect(problems).toEqual([]);
    expect(model.config.name).toBe("Old");
  });

  it("reads archnm.yaml", () => {
    const { model, problems } = readFiles(new Map([["archnm.yaml", "name: New\nversion: 2\n"]]));
    expect(problems).toEqual([]);
    expect(model.config.name).toBe("New");
  });

  it("prefers archnm.yaml when a folder has both", () => {
    const files = new Map([
      ["atlas.yaml", "name: Old\nversion: 2\n"],
      ["archnm.yaml", "name: New\nversion: 2\n"],
    ]);
    expect(readFiles(files).model.config.name).toBe("New");
    expect([...normalizeDesignFile(files).keys()]).toEqual(["archnm.yaml"]);
  });

  it("finds a design file under either name", () => {
    expect(hasDesignFile(new Map([["atlas.yaml", ""]]))).toBe(true);
    expect(hasDesignFile(new Map([["archnm.yaml", ""]]))).toBe(true);
    expect(hasDesignFile(new Map([["model/a.yaml", ""]]))).toBe(false);
  });
});
