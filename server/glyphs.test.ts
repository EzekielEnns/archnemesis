// A label's characters the render font hasn't got are drawn as the nearest it has (trial 14: "⇄").
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { covered, drawable } from "./render.ts";

const has = covered(
  new Uint8Array(
    readFileSync(
      createRequire(import.meta.url).resolve(
        "@expo-google-fonts/inter/400Regular/Inter_400Regular.ttf",
      ),
    ),
  ),
);

describe("drawable", () => {
  it("swaps what Inter lacks for what it has, and keeps the rest", () => {
    expect(has.has("⇄".codePointAt(0)!)).toBe(false);
    expect(drawable("sync ⇄ live ✦ café → ok ﬁle", has)).toBe("sync ↔ live ★ café → ok file");
  });
});
