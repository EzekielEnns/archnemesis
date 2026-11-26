// What the first-run welcome shows when, and what this browser remembers about it.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpSetup } from "../../shared/api.ts";

const kept = new Map<string, string>();
beforeEach(() => {
  kept.clear();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => kept.get(k) ?? null,
    setItem: (k: string, v: string) => void kept.set(k, v),
    removeItem: (k: string) => void kept.delete(k),
  });
});

const state = await import("./welcomeState.ts");
const mcp = { url: "http://127.0.0.1:5190/mcp", command: "claude mcp add", note: null } as McpSetup;

describe("which situation applies", () => {
  it("a server has an MCP address; a page has WebMCP or nothing", () => {
    expect(state.placeOf(mcp, false)).toBe("server");
    expect(state.placeOf(mcp, true)).toBe("server");
    expect(state.placeOf(null, true)).toBe("page-agent");
    expect(state.placeOf(null, false)).toBe("page");
  });
});

describe("what shows on the canvas", () => {
  const base = { memory: null, empty: true, fromLink: false } as const;
  it("the welcome, on the first empty design a browser opens", () => {
    expect(state.modeOf(base)).toBe("welcome");
  });
  it("only a quiet hint on an empty design once it has been seen", () => {
    expect(state.modeOf({ ...base, memory: "seen" })).toBe("hint");
  });
  it("nothing once it was told never to come back, or when the design has boxes", () => {
    expect(state.modeOf({ ...base, memory: "never" })).toBe("none");
    expect(state.modeOf({ ...base, empty: false })).toBe("none");
    expect(state.modeOf({ ...base, memory: "seen", empty: false })).toBe("none");
  });
  it("only the tip over a design from a link, whatever else is true", () => {
    expect(state.modeOf({ ...base, fromLink: true })).toBe("tip");
    expect(state.modeOf({ memory: "seen", empty: false, fromLink: true })).toBe("tip");
  });
});

describe("what this browser remembers", () => {
  beforeEach(() => state.resetWelcome());
  it("nothing at first; one key afterwards", () => {
    expect(state.readMemory()).toBeNull();
    state.autoOpen();
    expect(state.readMemory()).toBe("seen");
    expect([...kept.keys()]).toEqual([state.WELCOME_KEY]);
    state.hideForGood();
    expect(state.readMemory()).toBe("never");
    expect(kept.size).toBe(1);
  });
  it("opens on its own once a visit, and not again after being tucked away", () => {
    state.autoOpen();
    state.tuck();
    state.autoOpen();
    const ui = state.getWelcomeUi();
    expect(ui.panel).toBe(false);
  });
  it("counts the old first-open agent card, once dismissed, as having seen it", () => {
    kept.set("archnm.agent-card.oauth", "1");
    expect(state.readMemory()).toBe("seen");
  });
  it("hiding for good takes the panel away; ? brings the panel back", () => {
    state.autoOpen();
    state.hideForGood();
    expect(state.getWelcomeUi()).toMatchObject({ panel: false });
    state.openWelcome();
    expect(state.getWelcomeUi()).toMatchObject({ panel: true });
  });
  it("Start blank tucks the panel and starts the coach", () => {
    state.autoOpen();
    state.tuck({ coach: true });
    expect(state.getWelcomeUi()).toMatchObject({ panel: false, coach: true });
  });
  it("knows a design that a link opened", () => {
    expect(state.isFromLink("shop", null)).toBe(false);
    state.markOpenedFromLink("shop");
    expect(state.isFromLink("shop", null)).toBe(true);
    expect(state.isFromLink("other", "owner/repo@main")).toBe(true);
  });
});

describe("running it on your own machine", () => {
  it("shows the README's commands", () => {
    const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
    for (const c of state.RUN_LOCAL) expect(readme).toContain(c);
  });
});
