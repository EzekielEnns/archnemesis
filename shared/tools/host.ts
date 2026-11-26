// The agent tools (docs/mcp-v2.md) are functions over a design, given a Host: what the place
// they run in can do. The server's MCP and the web app's WebMCP each make one, so the same
// code (and the same tests) answer both.
//
// Every tool returns text for the model (capped, steering, a ref on every line) and, where a
// script might be the caller, the same as data.
import type { CallsChoice } from "../codeindex.ts";
import type { CommitOpts, LogEntry, ModelState } from "../doc.ts";
import type { FConfig } from "../files.ts";
import type { LibStats } from "../libstats.ts";
import type { Author, Op, Package } from "../model.ts";
import type { ModelIndex } from "../project.ts";

export interface Out {
  text: string;
  /** The same answer as data, for tests and scripts in-process (not sent to MCP clients: they show it instead of the text). */
  data?: Record<string, unknown>;
  /** Pictures (render). */
  images?: { data: string; mimeType: string }[];
  isError?: boolean;
}

/** A mistake the caller can fix: said back to them, never thrown past the tool. */
export class ToolError extends Error {}

/** Where a tour stop, an open or a spotlight points. */
export interface Stop {
  diagram: string;
  object?: string | null;
  objects?: string[];
  flow?: string | null;
  /** From 0; -1 shows the whole flow. */
  step?: number;
  tag?: string | null;
  refs?: string[];
  say: string;
}

export interface StopReply {
  action: "next" | "back" | "stop" | "ask";
  text?: string;
}

/** What the person is looking at. */
interface Here {
  /** The design (or fork) they have open, when it's known. */
  design?: string;
  diagram?: string | null;
  selection?: string[];
  /** Their last moves, newest last, as lines. */
  recent?: string[];
  /** Anything to say about how this was found ("not signed in to Archnemesis in a browser"). */
  note?: string;
}

/** The person's canvas: what show drives and here reads. */
export interface Canvas {
  /** Show a stop. With wait, resolves when they answer (null: nothing pressed in time). */
  show(stop: Stop, wait?: { ms: number; signal?: AbortSignal }): Promise<StopReply | null>;
  /** The walkthrough is over: their view is theirs again. */
  end(): void;
  here(): Here;
  /** How many have this design open (0: nobody will see it). */
  watching?(): number;
}

interface DesignInfo {
  key: string;
  name: string;
  objects: number;
  views: number;
  git?: boolean;
  private?: boolean;
  present?: number;
  url: string;
  forks?: {
    key: string;
    by: string;
    pending?: boolean;
    behind?: number;
    proposed?: boolean;
    url: string;
  }[];
}

/** Designs and forks: what the server can do (a page sees only its own design). */
export interface Designs {
  list(): DesignInfo[] | Promise<DesignInfo[]>;
  /** writesTo: where writes go when the design follows git (the caller's fork); views: what it starts with. */
  create?(a: { name: string; key?: string; from?: "empty" | "example" | "code" }): Promise<{
    key: string;
    name: string;
    url: string;
    note?: string;
    writesTo?: { key: string; url: string };
    views?: { key: string; rules: boolean }[];
  }>;
  /** Without confirm: what would go. */
  delete?(key: string, confirm: boolean): Promise<string>;
  /** design: the one to fork (default: the only one, or the page's). */
  fork?(
    design: string | undefined,
    name?: string,
  ): Promise<{ key: string; url: string; stackedOn?: string }>;
  propose?(design: string | undefined): Promise<string>;
  discard?(design: string | undefined): Promise<string>;
}

/** The factory's static pass (server only: it hands out upload tickets). */
export interface Indexer {
  start(path?: string): string | Promise<string>;
  scan(ticket: string, system?: string): string;
  /** Plans the import; commit is done by the tool through the host. */
  importPlan(
    ticket: string,
    under: string,
    calls?: CallsChoice,
  ): { ops: Op[]; summary: string; label: string };
  progress(p: { text: string; step?: number; of?: number; done?: boolean }): void;
}

export interface Host {
  /** The design (or "<design>@<fork>") the tools work on. */
  key: string;
  /** The fork's branch, or null on main. */
  branch: string | null;
  /** Who acts; an agent's MCP session (short id) when it has one, for history and read {by}. */
  actor: Author & { session?: string };
  canEdit: boolean;
  state(): ModelState;
  index(): ModelIndex;
  config(): FConfig;
  /** One step, in the actor's name: one undo, one history line; join: part of the step before; undo: false: not in the actor's undo (notes). (A page on a design that follows git sends it to a fork, so it may be async.) */
  commit(ops: Op[], label: string, opts?: CommitOpts): void | Promise<void>;
  /** Views that follow rules pick up what changed. */
  applyRules?(): void;
  /** The actor's own last step undone (dry: only named): what it was, or null when there's nothing of theirs to undo. */
  undo?(dry?: boolean): string | null;
  recent?(n: number): LogEntry[];
  /** The repos index start brought in for this design (by name), so a path's repo can be checked. */
  repos?(): string[];
  /** A fork's main where the fork started (for read {diff}: what the fork changed); absent on main. */
  base?(): Promise<ModelState | null>;
  /** A stacked fork's parent fork (what base() is), or null when base() is main. */
  baseName?(): string | null;
  /** A link that opens a view (and a box on it) for a person. */
  url(diagramId?: string, objectId?: string): string;
  /** When the actor last read notes here, for unread. */
  seen?: { get(): string | undefined; set(at: string): void };
  stats?: (p: Package) => LibStats | null;
  canvas?: Canvas;
  designs?: Designs;
  indexer?: Indexer;
  /** A view as a picture (server). */
  render?(
    diagramId: string,
    o: { flow?: string; step?: number },
  ): Promise<{ png: string; url: string }>;
  /** Said after a write that went somewhere else than this design (the page: "it went to your fork"). */
  wrote?(): string;
}

/** A list parameter given as one value or a list. */
export const arr = <T>(v: T | T[] | undefined | null): T[] =>
  v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];

export const ok = (text: string, data?: Record<string, unknown>): Out => ({
  text,
  ...(data ? { data } : {}),
});
export const fail = (text: string): Out => ({ text, isError: true });

/** "N more, showing M": the tail every capped list ends with, and the call that gets the rest. */
export function more(total: number, shown: number, next: string): string {
  return total > shown ? `… ${total - shown} more, showing ${shown}: ${next}` : "";
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const clip = (s: string, n = 90): string => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/** The first sentence of a box's context: its purpose, in a line. */
export function purpose(text?: string, n = 100): string {
  if (!text) return "";
  const first = text
    .trim()
    .split(/\n\s*\n/)[0]!
    .replace(/\s+/g, " ");
  const m = /^(.+?[.!?])(\s|$)/.exec(first);
  return clip(m ? m[1]! : first, n);
}
