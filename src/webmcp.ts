// WebMCP: the same tools (shared/tools), offered to an agent in the browser, when the
// browser has WebMCP (Chrome's preview: document.modelContext; older builds and guides:
// navigator.modelContext). The agent works for the person, on the design they have open, with
// their rights (nothing new to sign in to) but in its own name: history shows it as the agent,
// archnm.yaml's protect applies to it, and its undo takes back only its own changes. show and
// read here are direct, since the agent is in the page the person is looking at. write on a
// design that follows git goes to their fork (as their own edits do), and design offers list,
// fork and propose only: no delete, no discard.
// https://developer.chrome.com/docs/ai/webmcp/imperative-api
import { z } from "zod";
import type { Actor } from "../shared/doc.ts";
import type { Canvas, Designs, Host } from "../shared/tools/host.ts";
import { judge } from "../shared/tools/judge.ts";
import { TOOLS, runTool, type FeedbackKind, type ToolDef } from "../shared/tools/tools.ts";
import { backend } from "./backend";
import { hashFor } from "./route.ts";
import type { Store } from "./store.ts";

interface ModelContext {
  registerTool(
    tool: {
      name: string;
      title?: string;
      description: string;
      inputSchema: object;
      annotations?: object;
      execute: (input: Record<string, unknown>) => Promise<unknown>;
    },
    options?: { signal?: AbortSignal },
  ): unknown;
  unregisterTool?(name: string): void;
}

/** The browser's WebMCP, if it has one. */
export function modelContext(): ModelContext | null {
  const mc =
    (document as unknown as { modelContext?: ModelContext }).modelContext ??
    (navigator as unknown as { modelContext?: ModelContext }).modelContext;
  return mc && typeof mc.registerTool === "function" ? mc : null;
}

/** What the page offers: not index (the server takes repos), and design without delete or discard. */
const IN_PAGE = new Set(["read", "write", "note", "show", "guide", "design", "feedback"]);
/** What `design` does in the page: fork and propose need git, which not every backend has. */
const PAGE_DESIGN: [string, ...string[]] = !backend.git
  ? ["list"]
  : backend.git.inBrowser
    ? ["list", "fork"]
    : ["list", "fork", "propose"];

/** A little longer than the backend waits before applying view rules (src/backend/rules.ts). */
const RULES_SETTLE_MS = 700;

/** The agent in the page: its own name, working for the person. */
const pageAgent = (store: Store): Actor => ({
  id: `agent:page:${store.me.id}`,
  name: `Agent (for ${store.me.name})`,
  kind: "agent",
});

function pageHost(
  store: Store,
  canvas: Canvas | undefined,
  hand = store.helper(pageAgent(store)),
): Host {
  let seen: string | undefined;
  const url = (diagramId?: string, objectId?: string) =>
    `${location.origin}${location.pathname}#${hashFor({ design: store.design, diagramId: diagramId ?? null, objectId: objectId ?? null, noteId: null })}`;
  return {
    key: store.design,
    branch: store.branch,
    actor: pageAgent(store),
    canEdit: store.canEdit,
    // The live design, both from the same moment (never the past the person may be looking at).
    state: () => store.model(),
    index: () => store.liveIndex(),
    config: () => store.config,
    commit: (ops, label, opts) => hand.send(ops, label, opts),
    undo: (dry) => hand.undo(dry),
    recent: (n) => store.log(n),
    // Views that follow rules are brought up to date a moment after an edit (the backend does
    // it, here or on the server): wait for that, so what's said next is about the view as drawn.
    settled: () => new Promise((r) => setTimeout(r, RULES_SETTLE_MS)),
    url,
    seen: { get: () => seen, set: (at) => void (seen = at) },
    canvas,
    wrote: () =>
      store.mode === "mirror"
        ? 'This design follows git, so it went to your fork, which opens now: propose it when it\'s ready (design {action: "propose"}).'
        : "",
  };
}

function pageDesigns(store: Store): Designs {
  return {
    list: async () => {
      const all = await backend.designs.list().catch((e: unknown) => {
        throw new Error(`couldn't list designs: ${e instanceof Error ? e.message : String(e)}`);
      });
      const base = `${location.origin}${location.pathname}#/`;
      return all.map((d) => ({
        key: d.key,
        name: d.name,
        objects: d.objects,
        views: d.diagrams,
        git: d.git,
        private: d.private,
        present: d.present,
        url: `${base}${d.key}`,
      }));
    },
    fork: async (_design, name) => {
      const r = await store.gitAction.fork(name);
      return { key: r.doc, url: `${location.origin}${location.pathname}#/${r.doc}` };
    },
    propose: async () => {
      if (!store.branch)
        return "This is main: write first (it goes to your fork), then propose the fork.";
      const r = await store.gitAction.propose();
      return r.url
        ? `Saved to ${r.branch}. Open the pull request here (it's prefilled): ${r.url}`
        : `Saved to ${r.branch}. Merge it from the branch menu.`;
    },
  };
}

const warn = (name: string) => (e: unknown) =>
  console.warn(
    `[archnm] WebMCP: couldn't register ${name}: ${e instanceof Error ? e.message : String(e)}`,
  );

/** Register the tools for the design this page has open; the returned function takes them away. */
export function registerWebMcp(store: Store, canvas: () => Canvas | undefined): () => void {
  const mc = modelContext();
  if (!mc) return () => {};
  const controller = new AbortController();
  const designs = pageDesigns(store);
  // One agent, one undo stack, for as long as the design is open.
  const hand = store.helper(pageAgent(store));
  // The page's session, for the server's call log: from registering to the design closing.
  const session = `page-${crypto.randomUUID()}`;
  const feedback = async (f: { kind: FeedbackKind; text: string; tool?: string }) => {
    const id = await backend.telemetry?.feedback({
      session,
      client: "webmcp",
      design: store.design,
      ...f,
    });
    if (typeof id !== "number") throw new Error("couldn't keep it: the server didn't take it");
    return id;
  };
  const run = (def: ToolDef) => async (input: Record<string, unknown>) => {
    const t0 = performance.now();
    const args = { ...(input ?? {}) };
    try {
      const r = await inner(def, args);
      const text = r.content.map((c) => ("text" in c ? (c.text ?? "") : "")).join("\n");
      backend.telemetry?.call({
        session,
        client: "webmcp",
        tool: def.name,
        design: store.design,
        args: input ?? {},
        ms: performance.now() - t0,
        outChars: text.length,
        ...judge(text, !!r.isError),
      });
      // The agent laid a view out: bring it into sight, once the canvas has drawn it.
      if (def.name === "write" && !r.isError && /^tidied /m.test(text))
        setTimeout(() => canvas()?.fit?.(), 250);
      // WebMCP hands the agent whatever this resolves to, so give it the words themselves (a
      // refusal included: it says what to do next). A picture goes as it is.
      return r.content.every((c) => c.type === "text") ? text : r;
    } catch (e) {
      backend.telemetry?.call({
        session,
        client: "webmcp",
        tool: def.name,
        design: store.design,
        args: input ?? {},
        ms: performance.now() - t0,
        outcome: "exception",
        errors: 1,
        firstError: (e as Error)?.message ?? String(e),
        stack: (e as Error)?.stack,
      });
      throw e;
    }
  };
  const inner = async (
    def: ToolDef,
    args: Record<string, unknown>,
  ): Promise<{
    content: { type: string; text?: string; data?: string; mimeType?: string }[];
    isError?: boolean;
  }> => {
    if (def.name === "design" && args.action && !PAGE_DESIGN.includes(String(args.action)))
      return {
        content: [
          {
            type: "text",
            text: `In this page design does ${PAGE_DESIGN.join(", ")}; ${String(args.action)} is done by the person in Archnemesis.`,
          },
        ],
        isError: true,
      };
    if (
      def.onDesign &&
      typeof args.design === "string" &&
      args.design &&
      args.design !== store.design &&
      args.design !== store.designKey
    )
      return {
        content: [
          {
            type: "text",
            text: `This page has ${store.design} open, not ${args.design}: open that design to work on it.`,
          },
        ],
        isError: true,
      };
    delete args.design;
    const out = await runTool(
      def,
      {
        host: pageHost(store, canvas(), hand),
        designs,
        config: store.config,
        page: true,
        signal: controller.signal,
        ...(backend.telemetry ? { feedback } : {}),
      },
      args,
    );
    return {
      content: [
        { type: "text", text: out.text },
        ...(out.images ?? []).map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType })),
      ],
      ...(out.isError ? { isError: true } : {}),
    };
  };
  const names: string[] = [];
  for (const def of TOOLS) {
    if (!IN_PAGE.has(def.name)) continue;
    const { design: _d, ...rest } = def.input;
    // Tools about the open design don't take design (it's this page's); design itself keeps it but offers only what the page does.
    const input =
      def.name === "design"
        ? { ...def.input, action: z.enum(PAGE_DESIGN).optional() }
        : def.onDesign
          ? rest
          : def.input;
    try {
      // Chrome's registerTool answers with a promise (a name already taken rejects it).
      const done: unknown = mc.registerTool(
        {
          name: def.name,
          title: def.title,
          description:
            def.name === "design"
              ? `${def.description} In this page: ${PAGE_DESIGN.slice(0, -1).join(", ")}${PAGE_DESIGN.length > 1 ? " and " : ""}${PAGE_DESIGN.at(-1)}.`
              : def.description,
          inputSchema: z.toJSONSchema(z.object(input)),
          annotations: def.annotations,
          execute: run(def),
        },
        { signal: controller.signal },
      );
      if (done instanceof Promise) done.catch(warn(def.name));
      names.push(def.name);
    } catch (e) {
      warn(def.name)(e);
    }
  }
  return () => {
    controller.abort();
    for (const n of names) {
      try {
        mc.unregisterTool?.(n);
      } catch {
        /* already gone with the signal */
      }
    }
  };
}
