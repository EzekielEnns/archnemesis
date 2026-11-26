// The eight tools, described once: their schemas, what they teach, their annotations, and how
// each runs over a Host. The server's MCP (server/mcp.ts) and the page's WebMCP (src/webmcp.ts)
// both register these.
import { z } from "zod";
import { RefError } from "../agent.ts";
import { CALLS_CHOICES } from "../codeindex.ts";
import { ModelError } from "../doc.ts";
import type { FConfig } from "../files.ts";
import { LAYOUT_DIRECTIONS, OBJECT_KINDS } from "../model.ts";
import { design, DESIGN_ACTIONS } from "./design.ts";
import { diff, forkFocus } from "./diff.ts";
import { guide } from "./guide.ts";
import { ToolError, arr, fail, type Designs, type Host, type Out } from "./host.ts";
import { INDEX_ACTIONS, indexTool } from "./indexing.ts";
import { LENSES } from "./lens.ts";
import { NOTE_ACTIONS, note } from "./note.ts";
import { FOLLOW, read } from "./read.ts";
import { show } from "./show.ts";
import { write } from "./write.ts";

export type ToolName =
  "read" | "write" | "note" | "show" | "guide" | "design" | "index" | "feedback";

export const FEEDBACK_KINDS = ["bug", "confusing", "missing", "wrong-answer"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

/** What a call runs with: the design's host (for tools about a design), and the rest. */
export interface Call {
  host?: Host;
  designs?: Designs;
  config?: FConfig;
  signal?: AbortSignal;
  /** Say how a long call is going (MCP progress notifications, when the client asked for them). */
  progress?: (progress: number, total: number, message: string) => Promise<void>;
  /** Where each design lives (for guide). */
  where?: string;
  page?: boolean;
  /** Keep an agent's report about Archnemesis itself; returns its id. Absent: nowhere to keep it. */
  feedback?: (f: { kind: FeedbackKind; text: string; tool?: string }) => Promise<number>;
}

export interface ToolDef {
  name: ToolName;
  title: string;
  description: string;
  input: z.ZodRawShape;
  annotations: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  /** Needs a design's host. */
  onDesign: boolean;
  run(c: Call, args: Record<string, unknown>): Promise<Out>;
}

const design_ = z
  .string()
  .optional()
  .describe("The design's key (or a fork's, design@fork); leave out when there's only one");

const step = z
  .object({
    ref: z.string().optional(),
    refs: z.array(z.string()).optional(),
    view: z.string().optional(),
    flow: z.string().optional(),
    step: z.number().int().min(1).optional(),
    tag: z.string().optional(),
    say: z.string().max(800).optional().describe("What to look at, shown to them"),
    code: z
      .array(z.string())
      .max(8)
      .optional()
      .describe("Code or docs for this stop: repo@ref:path or URLs"),
  })
  .strict();

/** A list parameter that also takes one value (follow: "calls"). */
const list = <T extends z.ZodType>(t: T) => z.union([t, z.array(t)]);

const host = (c: Call): Host => {
  if (!c.host) throw new ToolError("which design? pass design");
  return c.host;
};

export const TOOLS: ToolDef[] = [
  {
    name: "read",
    title: "Read the architecture",
    description: `Look at the design. The three you'll use most:
- q: search (ids, names, tech, tags, paths, context, entities, views; fuzzy). {} gives the top level.
- ref: one thing in full (a box, an entity, a connection a>b, view:<key>, repo:path#fn): its edges, what's inside, notes, decisions.
- scope (+ budget): a brief for working inside one box: it in full, its neighbours as contracts.
Also: view, lens (problems, mismatches…), history, diff, impact, routes, walks, file, here: guide {topic: "read"} has them all. Answers are capped and end with the call that gets more; every line starts with a ref you can pass back.
Example: read {q: "checkout"} then read {ref: "checkout"}.`,
    input: {
      design: design_,
      q: z.string().optional().describe("Search words"),
      kind: z
        .enum(OBJECT_KINDS)
        .optional()
        .describe('only boxes of this kind; alone (or with q: "*") it lists every one'),
      in: z
        .string()
        .optional()
        .describe("Only inside this box (with depth: 1, only what's directly inside)"),
      ref: z.string().optional(),
      depth: z.number().int().min(1).max(4).optional(),
      follow: list(z.enum(FOLLOW)).optional(),
      impact: z.enum(["upstream", "downstream"]).optional(),
      from: z
        .union([z.string(), z.number().int().min(1)])
        .optional()
        .describe("A route's start (with to), or with file the line to start at"),
      to: z.string().optional(),
      scope: z.string().optional(),
      budget: z.number().int().min(200).max(50_000).optional(),
      guesses: z
        .boolean()
        .optional()
        .describe(
          "With ref or scope: include the calls the importer only guessed by name (left out by default, counted)",
        ),
      view: z.string().optional(),
      lens: z.enum(LENSES).optional(),
      history: z.boolean().optional(),
      diff: z
        .boolean()
        .optional()
        .describe(
          "On a fork: what it changed against its main, grouped (with in: one box's subtree; by: one session or worker)",
        ),
      by: z
        .string()
        .optional()
        .describe(
          "With history or diff: one agent session (its short id, s-1a2b) or worker name (as)",
        ),
      file: z.string().optional(),
      here: z.boolean().optional(),
      limit: z.number().int().min(1).max(500).optional(),
      detail: z.enum(["brief", "full"]).optional(),
      all: z
        .boolean()
        .optional()
        .describe(
          "With lens on a fork: the whole design (by default problems, review and drift show only what the fork added or changed)",
        ),
    },
    annotations: { readOnlyHint: true },
    onDesign: true,
    run: async (c, a) =>
      a.diff
        ? diff(host(c), {
            in: a.in as string | undefined,
            by: a.by as string | undefined,
            limit: a.limit as number | undefined,
          })
        : read(host(c), {
            ...a,
            ...(a.follow !== undefined ? { follow: arr(a.follow as never) } : {}),
            ...(a.lens && !a.all ? { focus: await forkFocus(host(c)) } : {}),
          }),
  },
  {
    name: "write",
    title: "Change the architecture",
    description: `Change the design with a YAML fragment in the file grammar (guide {topic: "grammar"}), merged by id: a box that exists gets the fields you write (null takes one off) and keeps the rest; a connection is matched by from, to and label (was: "a>b" on one moves that line to its new from and to); leaving something out never deletes it, remove does. One step: one undo, one history line. Every problem comes back at once (where, the nearest real id); nothing is half-applied. On a design that follows git it goes to your fork (the answer says which).
- dry_run: what it would change and every problem, changing nothing; a passing one gives an id: write {apply: id} writes it without sending it again.
- A refused write gives an id too: write {onto: id, yaml: <only the corrected entries>} merges them in by key and checks the whole again, so a big write is never sent twice; edits: [{old, new}] fixes its text where it isn't YAML yet (a colon to quote). onto takes a dry run's id the same way. Either way the answer is a dry run again, with its own apply id (dry_run: false writes it at once).
- scope: refuse changes outside that box (for agents working in parallel); tell a neighbour with a note claim instead.
- tags: tag groups (archnm.yaml's): tags: {lane: {values: [callers, doors, domain, vendors]}} declares one (null drops it); then a box takes tags: [lane:doors], and a view lanes: lane or color_by: lane.
- remove: box ids; a>b or a>b:label (the label when two share the ends); entity names; view:<key>, boundary:<id>, decision:<id>. In yaml, objects: {x: null} removes only the box x, views: {x: null} only the view.
- views: setting boxes makes a view hand-picked (its include/exclude go); setting include/exclude makes it follow rules (its boxes go); a view with a scope and no include shows its children and neighbours, less what exclude takes.
- tidy: true (the views this changed) or view keys: lay them out, in the same step. undo: true: your own last write back (dry_run: say which); notes aren't in it.
Text with a comma or colon goes in quotes (context: "…", label: "…"), or the box in block style.
Example: write {yaml: "objects:\\n  billing: {kind: app, in: shop, tech: [Go], context: \\"Charges orders, then emails the invoice.\\"}\\nconnections:\\n  - {from: checkout, to: billing, label: bills the order, tech: HTTPS, carries: [Invoice]}\\nentities:\\n  Invoice: {in: billing, fields: {id: uuid, total: Money}}", dry_run: true}`,
    input: {
      design: design_,
      yaml: z
        .string()
        .optional()
        .describe(
          "objects: (by id), entities: (by type name), connections: (a list), views: (by key), boundaries:, decisions:, tags: (tag groups)",
        ),
      files: z
        .record(z.string(), z.string())
        .optional()
        .describe(
          "Whole files, as read {file} shows them (each replaces the boxes it names, with their connections)",
        ),
      remove: list(z.string()).optional(),
      dry_run: z.boolean().optional(),
      scope: z.string().optional(),
      tidy: z.union([z.boolean(), z.string(), z.array(z.string())]).optional(),
      direction: z.enum(LAYOUT_DIRECTIONS).optional(),
      undo: z.boolean().optional(),
      apply: z
        .string()
        .optional()
        .describe(
          "A passing dry run's id (its answer gives it): writes exactly what it checked, without sending it again; refused if the design changed since",
        ),
      onto: z
        .string()
        .optional()
        .describe(
          "A refused write's or a dry run's id (its answer gives it): yaml is then only the corrections, merged into that write by key (an entry takes the fields sent and keeps the rest; null drops an entry or a field), and the whole is checked again",
        ),
      edits: z
        .array(z.object({ old: z.string(), new: z.string() }))
        .optional()
        .describe(
          "With onto: exact text changes to that write's fragment (old copied exactly, found once), for what isn't YAML yet: a colon to quote, a bad indent",
        ),
      label: z
        .string()
        .max(200)
        .optional()
        .describe("What this is, for everyone's history (default: what it changed)"),
      as: z
        .string()
        .max(40)
        .optional()
        .describe(
          "A worker's name for this call's changes in history, instead of the session's short id (\"ordering-mapper\"); per call: pass it on every call",
        ),
    },
    annotations: { destructiveHint: true },
    onDesign: true,
    run: (c, a) => write(host(c), a),
  },
  {
    name: "note",
    title: "Notes, flags and claims",
    description: `Threads on anything, for people and other agents; not part of the architecture.
- add: text, about (any ref) or view. flag: true marks something wrong or missing (the curator picks it up). claim: {field, value, evidence} is what you learned about a box you don't own, for its owner to settle.
- reply (note, text), resolve / reopen (note), list (about, view, flags, resolved, unread).
Answer a person's question in its thread, and resolve only what's settled.`,
    input: {
      design: design_,
      action: z.enum(NOTE_ACTIONS).optional(),
      text: z.string().optional(),
      about: z.string().optional(),
      view: z.string().optional(),
      note: z.string().optional().describe("A note's id"),
      flag: z.boolean().optional(),
      claim: z
        .object({
          field: z.string(),
          value: z.string(),
          evidence: z.string().optional().describe("repo:path:line, a doc, a command's output"),
        })
        .strict()
        .optional(),
      unread: z.boolean().optional(),
      resolved: z.boolean().optional(),
      flags: z.boolean().optional(),
      limit: z.number().int().min(1).max(200).optional(),
      as: z
        .string()
        .max(40)
        .optional()
        .describe(
          "A worker's name for this call's changes in history, instead of the session's short id (\"ordering-mapper\"); per call: pass it on every call",
        ),
    },
    annotations: {},
    onDesign: true,
    run: (c, a) => note(host(c), a),
  },
  {
    name: "show",
    title: "Show the person",
    description: `Move what the person sees in Archnemesis; changes nothing in the design.
- open: a ref (a box, a view, a>b); spotlight: several refs at once; say: a line shown to them.
- tour: [{ref | refs | view, flow, step, say, code}]: the call holds while they read and press Next; a question comes back to you (answer, then tour again with at). done: true ends it.
- render: a view as a picture (flow, step to light one), for checking your work.`,
    input: {
      design: design_,
      open: z.string().optional(),
      spotlight: list(z.string()).optional(),
      view: z.string().optional(),
      say: z.string().max(800).optional(),
      tour: z.array(step).max(30).optional(),
      at: z.number().int().min(0).optional(),
      render: z.string().optional(),
      flow: z.string().optional(),
      step: z.number().int().min(1).optional(),
      done: z.boolean().optional(),
      wait_s: z
        .number()
        .int()
        .min(10)
        .max(600)
        .optional()
        .describe(
          "How long a tour may hold the call (default 55; keep it under your client's timeout)",
        ),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    onDesign: true,
    run: (c, a) =>
      show(
        host(c),
        {
          ...a,
          ...(a.spotlight !== undefined
            ? { spotlight: arr(a.spotlight as string[]).slice(0, 40) }
            : {}),
        },
        c.signal,
      ),
  },
  {
    name: "guide",
    title: "How Archnemesis works",
    description:
      "The grammar (read topic grammar before your first write), the field reference a section at a time, views, code, the playbooks (map, design, tour, mentor), and the app itself for teaching a person. No topic: the list.",
    input: { topic: z.string().optional() },
    annotations: { readOnlyHint: true },
    onDesign: false,
    run: async (c, a) => guide(a, c.host?.config() ?? c.config ?? {}, c.where),
  },
  {
    name: "design",
    title: "Designs and forks",
    description: `list designs and their forks; create one (from: empty, example); fork (a named fork of a design that follows git; with design: a fork, stacked on that fork: its diff and pull request are against it, so a plan on an unmerged map proposes only the plan); propose (saves the fork and gives the pull-request link: hand it to the person, they merge); delete (call without confirm first, ask the person, then confirm: true); discard (your own fork).`,
    input: {
      action: z.enum(DESIGN_ACTIONS).optional(),
      design: design_,
      name: z.string().optional(),
      key: z.string().optional(),
      from: z.enum(["empty", "example", "code"]).optional(),
      confirm: z.boolean().optional(),
    },
    annotations: { destructiveHint: true },
    onDesign: false,
    run: (c, a) => design(c.designs, a, { page: c.page }),
  },
  {
    name: "index",
    title: "Map a repo",
    description: `Read a repo on the person's machine, never through you. start (path) gives one shell command: it surveys the repo (what runs, what holds state, specs, languages) and indexes its code, and sends it straight to Archnemesis. scan (ticket) gives what it found and a draft in the file grammar: edit it into the architecture and write it. import (ticket, under) brings in its files and functions, tagged generated, under the box they run in; calls says which calls come with them (exact: the default, only what a compiler resolved; all: guesses by name too; none: you add the ones you confirm). scan says how this repo was indexed and recommends one. progress (text, step, of, done) tells the people watching how a long job is going.`,
    input: {
      design: design_,
      action: z.enum(INDEX_ACTIONS),
      path: z.string().optional(),
      ticket: z.string().optional(),
      system: z.string().optional(),
      under: z.string().optional(),
      calls: z.enum(CALLS_CHOICES).optional(),
      dry_run: z.boolean().optional(),
      text: z.string().max(140).optional(),
      step: z.number().int().min(0).optional(),
      of: z.number().int().min(1).optional(),
      done: z.boolean().optional(),
    },
    annotations: { destructiveHint: false },
    onDesign: true,
    run: (c, a) => indexTool(host(c), a as never, c),
  },
  {
    name: "feedback",
    title: "Tell us Archnemesis got in your way",
    description: `When Archnemesis itself gets in your way, say so: bug (it broke), confusing (an answer or error you couldn't act on), missing (something you needed and it can't do), wrong-answer (it said something untrue). text: what you tried, what happened, what you expected. tool: the tool it was about. Your recent calls go with it, so no need to paste them. It's kept on this Archnemesis server only, for the people who fix the tools.`,
    input: {
      kind: z.enum(FEEDBACK_KINDS),
      text: z.string().min(1).max(8000),
      tool: z.string().optional(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    onDesign: false,
    run: async (c, a) => {
      if (!c.feedback)
        return fail(
          "This Archnemesis has nowhere to keep feedback (no server). Tell the person instead.",
        );
      const kind = a.kind as FeedbackKind;
      if (!FEEDBACK_KINDS.includes(kind)) return fail(`kind: one of ${FEEDBACK_KINDS.join(", ")}`);
      const text = String(a.text ?? "").trim();
      if (!text) return fail("text: what you tried, what happened, and what you expected");
      const id = await c.feedback({
        kind,
        text,
        tool: typeof a.tool === "string" && a.tool ? a.tool : undefined,
      });
      return {
        text: `Thanks: kept as feedback #${id}, with your recent calls. Carry on with the work.`,
        data: { id },
      };
    },
  },
];

/** Run a tool, turning the caller's mistakes into an answer they can act on. */
export async function runTool(def: ToolDef, c: Call, args: Record<string, unknown>): Promise<Out> {
  try {
    return await def.run(c, args);
  } catch (e) {
    if (e instanceof ToolError || e instanceof RefError || e instanceof ModelError)
      return fail(e.message);
    throw e;
  }
}

export const tool = (name: ToolName): ToolDef => TOOLS.find((t) => t.name === name)!;
