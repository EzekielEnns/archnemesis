import { describe, expect, it } from "vitest";
import { dataFolder, parseLaunch, personalSettings, startupText } from "./personal.ts";

const start = (argv: string[]) => {
  const l = parseLaunch(argv);
  if (l.kind !== "start") throw new Error(`not a start: ${JSON.stringify(l)}`);
  return l;
};

describe("parseLaunch", () => {
  it("starts with no arguments or with start", () => {
    expect(start([])).toEqual({ kind: "start", port: undefined, dir: undefined, data: undefined });
    expect(start(["start", "--port", "5700"]).port).toBe(5700);
  });
  it("reads --port, --dir and --data, spaced or with =", () => {
    expect(start(["--port=5700", "--dir", "docs/arch", "--data=/tmp/x"])).toEqual({
      kind: "start",
      port: 5700,
      dir: "docs/arch",
      data: "/tmp/x",
    });
  });
  it("hands archnm subcommands to the CLI", () => {
    for (const c of ["check", "fmt", "explain", "outline", "init", "config"])
      expect(parseLaunch([c, "dir"])).toEqual({ kind: "cli" });
  });
  it("answers --help and --version", () => {
    expect(parseLaunch(["--help"])).toEqual({ kind: "help" });
    expect(parseLaunch(["-v"])).toEqual({ kind: "version" });
  });
  it("refuses a bad port, a missing value and an unknown option", () => {
    for (const argv of [
      ["--port", "abc"],
      ["--port", "70000"],
      ["--port"],
      ["--dir"],
      ["--nope"],
      ["serve"],
    ])
      expect(parseLaunch(argv).kind).toBe("error");
  });
});

describe("personalSettings", () => {
  const home = "/home/me";
  it("defaults: ./architecture here, port 5190, local sign-in, a per-user data folder", () => {
    const p = personalSettings(start([]), {}, "/work/shop", home);
    expect(p.designs).toBe("/work/shop/architecture");
    expect(p.port).toBe(5190);
    expect(p.url).toBe("http://127.0.0.1:5190");
    expect(p.env.ARCHNM_AUTH).toBe("local");
    expect(p.env.NODE_ENV).toBe("production");
    expect(p.data.startsWith("/home/me/.local/share/archnemesis/shop-")).toBe(true);
    expect(p.env.ARCHNM_DB).toBe(`${p.data}/archnm.sqlite`);
  });
  it("lets variables already set beat the defaults, and flags beat the variables", () => {
    const env = {
      ARCHNM_PORT: "6000",
      ARCHNM_ROOT: "/designs",
      ARCHNM_DB: "/db/a.sqlite",
      ARCHNM_AUTH: "tokens",
    };
    const p = personalSettings(start([]), env, "/work", home);
    expect([p.port, p.designs, p.env.ARCHNM_DB, p.env.ARCHNM_AUTH]).toEqual([
      6000,
      "/designs",
      "/db/a.sqlite",
      undefined,
    ]);
    const q = personalSettings(
      start(["--port", "6001", "--dir", "arch", "--data", "state"]),
      env,
      "/work",
      home,
    );
    expect([q.port, q.designs, q.env.ARCHNM_DB]).toEqual([
      6001,
      "/work/arch",
      "/work/state/archnm.sqlite",
    ]);
  });
});

describe("dataFolder", () => {
  it("keeps two folders with the same name apart, and follows XDG_DATA_HOME", () => {
    const a = dataFolder("/a/app", {}, "/h");
    const b = dataFolder("/b/app", {}, "/h");
    expect(a).not.toBe(b);
    expect(
      dataFolder("/a/app", { XDG_DATA_HOME: "/xdg" }, "/h").startsWith("/xdg/archnemesis/app-"),
    ).toBe(true);
  });
});

describe("startupText", () => {
  it("gives the address, the connect command and where things are saved", () => {
    const p = personalSettings(start(["--port", "5700"]), {}, "/work/shop", "/h");
    const t = startupText(p, "archnm");
    expect(t).toContain("http://127.0.0.1:5700");
    expect(t).toContain("claude mcp add -s user --transport http archnm http://127.0.0.1:5700/mcp");
    expect(t).toContain("/work/shop/architecture");
  });
});
