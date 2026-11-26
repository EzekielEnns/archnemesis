// The first-run welcome: what is shown when (one decision from three facts), the one thing this
// browser remembers about it, the words an agent is given, and the state the pieces share.
// The pieces are in Welcome.tsx; src/workspace/WelcomeHost.tsx puts them on the page.
import { useSyncExternalStore } from "react";
import type { McpSetup } from "../../shared/api.ts";
import { setStored, stored } from "../storage";

/** The one key: "seen" once the welcome has been shown, "never" once it was told to stay away. */
export const WELCOME_KEY = "archnm.welcome";
// The first-open "connect your agent" card this replaced: dismissing it counts as having seen this.
const OLD_CARD_KEYS = ["archnm.agent-card", "archnm.agent-card.oauth", "archnm.agent-card.token"];

export type Memory = "seen" | "never" | null;

export function readMemory(): Memory {
  const v = stored(WELCOME_KEY);
  if (v === "seen" || v === "never") return v;
  return OLD_CARD_KEYS.some((k) => stored(k) === "1") ? "seen" : null;
}

const remember = (m: "seen" | "never"): void => setStored(WELCOME_KEY, m);

/** Where this page runs: what an agent can do here, and so which steps are true. */
export type Place = "server" | "page-agent" | "page";

/** A server has an MCP address; a static page with WebMCP can take an agent in the page; else neither. */
export function placeOf(mcp: McpSetup | null, webmcp: boolean): Place {
  return mcp ? "server" : webmcp ? "page-agent" : "page";
}

/** What the canvas shows besides the design: the welcome, a hint on an empty design, a tip, or nothing. */
export type Mode = "welcome" | "hint" | "tip" | "none";

/**
 * The welcome is for the first empty design a browser opens; after that an empty design gets a
 * quiet hint (unless told "never"); a design that came from a link gets only a tip.
 */
export function modeOf(a: { memory: Memory; empty: boolean; fromLink: boolean }): Mode {
  if (a.fromLink) return "tip";
  if (!a.empty) return "none";
  if (a.memory === null) return "welcome";
  return a.memory === "seen" ? "hint" : "none";
}

// --- designs that came from a link ------------------------------------------------------

const fromLink = new Set<string>();

/** A link that carries a design just opened this design (see OpenShared). */
export const markOpenedFromLink = (design: string): void => void fromLink.add(design);

/** The design was opened from a link (a GitHub one is read-only and says where it is from). */
export const isFromLink = (design: string, from: string | null): boolean =>
  from !== null || fromLink.has(design);

// --- what the agent is given ------------------------------------------------------------

export const MAP_ASK =
  "Map this repo into Archnemesis. Start with its apps, databases and the connections between them, then add the code inside each app. Tell me what you guessed.";
export const MAP_ASK_PUBLIC =
  "Map the repo at <link to a public repo> into Archnemesis. Read its README and main folders, then draw its apps, databases and the connections between them. Tell me what you guessed.";
export const PLAN_ASK =
  "Plan this feature in Archnemesis: <describe the feature>. Start from what is already drawn, add what the feature needs as planned boxes and connections, and tell me what it touches.";

/** The image name in the README's Docker commands. It is private and not final: change it here. */
/** Chrome's own setting for offering a page's tools to agents (WebMCP), while it is a trial. */
export const WEBMCP_FLAG = "chrome://flags/#enable-webmcp-testing";
/** Claude Code, given a Chrome it can drive with WebMCP on (Chrome DevTools MCP). */
export const WEBMCP_CLAUDE =
  "claude mcp add chrome-devtools --scope user -- npx -y chrome-devtools-mcp@latest --categoryExperimentalWebmcp --chromeArg=--enable-features=WebMCP";
export const WEBMCP_ASK = "Use the Archnemesis tools on this page to draw my system.";

export const IMAGE_NAME = "archnm";
/** Running Archnemesis on your own machine: README.md, "1. Docker (the default)". */
export const RUN_LOCAL: readonly string[] = [
  `docker build -t ${IMAGE_NAME} .`,
  `docker run -p 5190:5190 -v archnm-data:/data -v "$PWD/architecture:/architecture" -v "$PWD/tokens.json:/run/archnm/tokens.json:ro" ${IMAGE_NAME}`,
];

// --- the state the pieces share ----------------------------------------------------------

/** Which steps the open panel shows: the four ways in, or one of the agent ways (local: run it yourself). */
export type Detail = "map" | "connect" | "local" | null;

export interface WelcomeUi {
  /** The panel is open. */
  panel: boolean;
  detail: Detail;
  /** The "Getting started" chip is showing (it is only ever for this visit). */
  chip: boolean;
  /** After "Start blank": say which keys place a box, then what to do with one. */
  coach: boolean;
  /** The shared-link tip is showing. */
  tip: boolean;
  /** The chip should take focus when it appears (the panel was tucked into it). */
  focusChip: boolean;
  /** The panel has been opened on its own once this visit. */
  auto: boolean;
}

const START: WelcomeUi = {
  panel: false,
  detail: null,
  chip: false,
  coach: false,
  tip: true,
  focusChip: false,
  auto: false,
};
let ui: WelcomeUi = START;
const listeners = new Set<() => void>();

function set(patch: Partial<WelcomeUi>): void {
  ui = { ...ui, ...patch };
  for (const l of listeners) l();
}

/** The shared state as it is now. */
export const getWelcomeUi = (): WelcomeUi => ui;

export function useWelcomeUi(): WelcomeUi {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => void listeners.delete(l)),
    getWelcomeUi,
  );
}

/** Back to a fresh visit (tests). */
export function resetWelcome(): void {
  fromLink.clear();
  set(START);
}

/** The welcome opens on its own, once: this browser has now seen it. */
export function autoOpen(): void {
  if (ui.auto) return;
  remember("seen");
  set({ panel: true, detail: null, auto: true });
}

/** "Getting started" under ?, or the chip: open the panel (at one of its two agent ways, or the four). */
export function openWelcome(detail: Detail = null): void {
  set({ panel: true, detail, chip: false, coach: false, auto: true });
}

/** Esc, or a way in taken: the panel goes into the chip. */
export function tuck(o: { coach?: boolean } = {}): void {
  set({ panel: false, detail: null, chip: true, focusChip: true, coach: o.coach ?? false });
}

export const clearChipFocus = (): void => void (ui = { ...ui, focusChip: false });

export const showDetail = (detail: Detail): void => set({ detail });

/** "Don't show this again", or the chip's close button. */
export function hideForGood(): void {
  remember("never");
  set({ panel: false, detail: null, chip: false, coach: false, focusChip: false });
}

export const endCoach = (): void => set({ coach: false });

/** The shared-link tip: put it back (? → What is this?) or put it away. */
export const showTip = (on: boolean): void => set({ tip: on });
