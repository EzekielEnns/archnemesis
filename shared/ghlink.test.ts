import { describe, expect, it } from "vitest";
import { forkOf, ghText, parseGhSpec } from "./ghlink.ts";

describe("GitHub design links", () => {
  it("reads owner/repo, a branch with slashes, and a folder", () => {
    expect(parseGhSpec("acme/designs@archnm/shop/zeek-11-26:shop")).toEqual({
      owner: "acme",
      repo: "designs",
      ref: "archnm/shop/zeek-11-26",
      path: "shop",
    });
    expect(parseGhSpec("acme/designs")).toEqual({
      owner: "acme",
      repo: "designs",
      ref: null,
      path: null,
    });
    expect(parseGhSpec("acme/designs:")).toMatchObject({ path: "" });
    expect(parseGhSpec("acme/designs:a/b/")).toMatchObject({ path: "a/b" });
    expect(parseGhSpec("acme/designs%40main")).toMatchObject({ ref: "main" });
  });

  it("writes what it reads", () => {
    for (const t of ["a/b", "a/b@main", "a/b:x/y", "a/b@archnm/d/f:d"])
      expect(ghText(parseGhSpec(t)!)).toBe(t);
  });

  it("refuses anything that isn't a plain owner/repo, ref and folder", () => {
    for (const bad of [
      "",
      "acme",
      "acme/designs/extra",
      "-x/y",
      "a b/c",
      "acme/designs@../x",
      "acme/designs@a b",
      "acme/designs:../x",
      "acme/designs:a/../b",
      "acme/designs:<script>",
      "https://github.com/acme/designs",
      "acme/designs@%zz",
      "acme/..",
    ])
      expect(parseGhSpec(bad), bad).toBeNull();
  });

  it("knows a fork's branch", () => {
    expect(forkOf("archnm/shop/zeek-11-26")).toEqual({ design: "shop", fork: "zeek-11-26" });
    expect(forkOf("atlas/shop/a/b")).toEqual({ design: "shop", fork: "a/b" });
    expect(forkOf("main")).toBeNull();
    expect(forkOf(null)).toBeNull();
  });
});
