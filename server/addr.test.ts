import { describe, expect, it } from "vitest";
import { clientAddr } from "./addr.ts";

const req = (xff: string | string[] | undefined, socket = "10.0.0.1") => ({
  socket: { remoteAddress: socket },
  headers: { "x-forwarded-for": xff },
});

describe("clientAddr", () => {
  it("believes no header when there is no proxy", () => {
    expect(clientAddr(req("1.2.3.4"), 0)).toBe("10.0.0.1");
  });
  it("takes the entry the one proxy added", () => {
    expect(clientAddr(req("1.2.3.4"), 1)).toBe("1.2.3.4");
  });
  it("ignores what the client put in front", () => {
    expect(clientAddr(req("6.6.6.6, 1.2.3.4"), 1)).toBe("1.2.3.4");
    expect(clientAddr(req("6.6.6.6, 1.2.3.4, 172.16.0.9"), 2)).toBe("1.2.3.4");
  });
  it("falls back to the socket when the header is short or missing", () => {
    expect(clientAddr(req(undefined), 1)).toBe("10.0.0.1");
    expect(clientAddr(req("1.2.3.4"), 2)).toBe("10.0.0.1");
  });
  it("reads repeated headers as one list", () => {
    expect(clientAddr(req(["6.6.6.6", "1.2.3.4"]), 1)).toBe("1.2.3.4");
  });
});
