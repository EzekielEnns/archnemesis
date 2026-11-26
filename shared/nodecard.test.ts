import { describe, expect, it } from "vitest";
import {
  addNote,
  detectRef,
  linkName,
  noteItems,
  parsePackage,
  parseSignature,
  removeNote,
} from "./nodecard.ts";

describe("detectRef", () => {
  it("tells links, images, docs and code apart", () => {
    expect(detectRef("https://grafana.example/d/orders")).toBe("link");
    expect(detectRef("https://example.com/a.png?x=1")).toBe("image");
    expect(detectRef("assets/erd.svg")).toBe("image");
    expect(detectRef("docs/orders/states.md")).toBe("doc");
    expect(detectRef("orbit:services/orders/src/main.rs")).toBe("code");
    expect(detectRef("src/ui/NodeCard.tsx#L12")).toBe("code");
    expect(detectRef("just words")).toBeNull();
    expect(detectRef("")).toBeNull();
  });
});

describe("notes", () => {
  const md = "- [ ] Idempotency keys\n- [ ] Split pricing?\n  more on it\n- [x] Move to sqlx 0.8";
  it("reads each bullet as a note, keeping its continuation lines", () => {
    expect(noteItems(md)).toEqual([
      "[ ] Idempotency keys",
      "[ ] Split pricing?\n  more on it",
      "[x] Move to sqlx 0.8",
    ]);
    expect(noteItems("")).toEqual([]);
    expect(noteItems("One paragraph.\n\nAnother.")).toEqual(["One paragraph.", "Another."]);
  });
  it("adds on top and removes by position, staying a markdown list", () => {
    expect(addNote("- b", "a")).toBe("- a\n- b");
    expect(addNote("", "first\nsecond line")).toBe("- first\n  second line");
    expect(removeNote("- a\n- b\n- c", 1)).toBe("- a\n- c");
  });
});

describe("linkName", () => {
  it("names docs sites by their first path segment", () => {
    expect(linkName("https://docs.rs/sqlx")).toBe("sqlx docs");
  });
});

describe("parsePackage", () => {
  it("reads a name, an ecosystem and a version", () => {
    expect(parsePackage("axum")).toEqual({ name: "axum" });
    expect(parsePackage("react@18")).toEqual({ name: "react", version: "18" });
    expect(parsePackage("cargo:sqlx@0.8")).toEqual({
      ecosystem: "cargo",
      name: "sqlx",
      version: "0.8",
    });
    expect(parsePackage("@stripe/stripe-js")).toEqual({ name: "@stripe/stripe-js" });
    expect(parsePackage("not a package")).toBeNull();
  });
});

describe("parseSignature", () => {
  it("takes the name and keeps the rest as its signature", () => {
    expect(parseSignature("create_order")).toEqual({ name: "create_order" });
    expect(parseSignature("create_order()")).toEqual({ name: "create_order" });
    expect(parseSignature("create_order(Cart, UserId) → Order")).toEqual({
      name: "create_order",
      signature: "(Cart, UserId) -> Order",
    });
    expect(parseSignature("Cart::total(&self) -> Money")).toEqual({
      name: "Cart::total",
      signature: "(&self) -> Money",
    });
    expect(parseSignature("(nope)")).toBeNull();
  });
});
