import { describe, expect, it } from "vitest";
import { parseHash } from "./route";

describe("parseHash", () => {
  it("reads a design key in any case as lowercase", () => {
    expect(parseHash("#/Acme/d/d_ABC")).toEqual({
      design: "acme",
      diagramId: "d_ABC",
      objectId: null,
    });
    expect(parseHash("#/Acme@Readable-Map")).toEqual({
      design: "acme@readable-map",
      diagramId: null,
      objectId: null,
    });
  });
  it("leaves lowercase links as they are", () => {
    expect(parseHash("#/shop/d/d_1/o/api")).toEqual({
      design: "shop",
      diagramId: "d_1",
      objectId: "api",
    });
  });
  it("reads a note in a link", () => {
    expect(parseHash("#/shop@x/d/d_1/n/n_2")).toEqual({
      design: "shop@x",
      diagramId: "d_1",
      objectId: null,
      noteId: "n_2",
    });
  });
});
