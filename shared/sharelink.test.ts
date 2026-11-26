import { describe, expect, it } from "vitest";
import { seedOps } from "./seed.ts";
import { deflateRaw } from "./deflate.ts";
import { readFiles } from "./files.ts";
import { filesFromOps } from "./filesFromOps.ts";
import { decodeDesign, encodeDesign, fingerprint, LINK_VERSION, MAX_DECODED } from "./sharelink.ts";

const example = () => filesFromOps(seedOps(), { name: "Shop" });

/** A link whose body is any JSON, made the way encodeDesign makes it. */
async function linkOf(value: unknown): Promise<string> {
  const bytes = await deflateRaw(new TextEncoder().encode(JSON.stringify(value)));
  return `a1.${Buffer.from(bytes).toString("base64url")}`;
}

describe("design links", () => {
  it("round-trips the example design, files and layout intact", async () => {
    const files = example();
    expect([...files.keys()].some((p) => p.startsWith("layout/"))).toBe(true);
    const text = await encodeDesign(files);
    expect(text.startsWith(LINK_VERSION)).toBe(true);
    expect(text).toMatch(/^a1\.[A-Za-z0-9_-]+$/);
    const back = await decodeDesign(text);
    const { "AGENTS.md": generated, ...rest } = Object.fromEntries(files);
    expect(generated).toBeDefined();
    expect(back).toEqual(new Map(Object.entries(rest)));
    expect(readFiles(back).problems.filter((p) => p.level === "error")).toEqual([]);
  });

  it("is stable: the same design makes the same link", async () => {
    const files = example();
    expect(await encodeDesign(files)).toBe(await encodeDesign(new Map(files)));
  });

  it("rejects text without the version prefix, and a newer version, in plain words", async () => {
    await expect(decodeDesign("hello")).rejects.toThrow(/doesn't hold a design/);
    await expect(decodeDesign("a2.abcd")).rejects.toThrow(/newer version/);
    await expect(decodeDesign("")).rejects.toThrow(/doesn't hold a design/);
  });

  it("rejects garbage and a link cut short", async () => {
    await expect(decodeDesign("a1.")).rejects.toThrow(/doesn't hold a design/);
    await expect(decodeDesign("a1.!!!not-base64!!!")).rejects.toThrow(/doesn't hold a design/);
    await expect(decodeDesign("a1.AAAAAAAA")).rejects.toThrow(/doesn't hold a design/);
    const good = await encodeDesign(example());
    await expect(decodeDesign(good.slice(0, good.length >> 1))).rejects.toThrow(
      /doesn't hold a design/,
    );
  });

  it("rejects something that is not a map of strings", async () => {
    await expect(decodeDesign(await linkOf([1, 2]))).rejects.toThrow(/doesn't hold a design/);
    await expect(decodeDesign(await linkOf({ "archnm.yaml": 5 }))).rejects.toThrow(
      /doesn't hold a design/,
    );
    await expect(decodeDesign(await linkOf("text"))).rejects.toThrow(/doesn't hold a design/);
    await expect(decodeDesign(await linkOf({ "notes.txt": "x" }))).rejects.toThrow(
      /no design files/,
    );
  });

  it("drops files that aren't a design's, and paths that climb", async () => {
    const text = await encodeDesign(
      new Map([
        ["archnm.yaml", "name: A\n"],
        ["../evil.yaml", "x"],
        ["model/a.yaml", "{}"],
        ["README.md", "hi"],
      ]),
    );
    expect([...(await decodeDesign(text)).keys()]).toEqual(["archnm.yaml", "model/a.yaml"]);
  });

  it("refuses a design that is over the size cap, going in or coming out", async () => {
    const huge = new Map([["archnm.yaml", "a".repeat(MAX_DECODED + 10)]]);
    await expect(encodeDesign(huge)).rejects.toThrow(/too big/);
    // A small link that expands past the cap (it compresses very well).
    const bomb = await linkOf({ "archnm.yaml": "a".repeat(MAX_DECODED + 10) });
    expect(bomb.length).toBeLessThan(20000);
    await expect(decodeDesign(bomb)).rejects.toThrow(/too big/);
  });

  it("fingerprints equal text equally and different text differently", () => {
    expect(fingerprint("a1.abc")).toBe(fingerprint("a1.abc"));
    expect(fingerprint("a1.abc")).not.toBe(fingerprint("a1.abd"));
  });
});
