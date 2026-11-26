import { describe, expect, it } from "vitest";
import { iconFor } from "./icons.ts";

describe("iconFor", () => {
  it("finds icons by title, slug, alias and first part", () => {
    expect(iconFor("Postgres")?.slug).toBe("postgresql");
    expect(iconFor("Go, gRPC")?.slug).toBe("go");
    expect(iconFor("React")?.slug).toBe("react");
    expect(iconFor("BigQuery")?.slug).toBe("googlebigquery");
    expect(iconFor("Node.js")?.slug).toBe("nodedotjs");
    expect(iconFor("Redis cluster")?.slug).toBe("redis");
    expect(iconFor("")).toBeUndefined();
    expect(iconFor("Totally made up")).toBeUndefined();
  });

  it("doesn't read a path as a technology", () => {
    expect(iconFor("node/")).toBeUndefined();
    expect(iconFor("crates/board/src/node/")).toBeUndefined();
    expect(iconFor("Rust, node/")?.slug).toBe("rust");
    expect(iconFor("Go/gRPC")?.slug).toBe("go");
  });
});
