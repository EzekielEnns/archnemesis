// The MCP: how agents read and change the architecture while people watch.
//
// Seven tools (docs/mcp-v2.md), the same ones the web app offers over WebMCP: they live in
// shared/tools as functions over a Host, and this file makes the server's Host. Agents edit
// the same live document as everyone else, as a named participant: their changes show up at
// once in every open tab, land as one undo step of their own, and are written to the files
// like any other edit. On a design that follows git, writes go to the agent's own fork.
//
// Served stateless over streamable HTTP at /mcp.
import { randomUUID } from "node:crypto";
import type http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { findView, planChanges } from "../shared/agent.ts";
import { callsAdvice, importChanges, importSummary } from "../shared/codeindex.ts";
import { ModelError } from "../shared/doc.ts";
import type { LibStats } from "../shared/libstats.ts";
import type { Author, Package } from "../shared/model.ts";
import { newNotes } from "../shared/notes.ts";
import type { TrailEvent } from "../shared/trail.ts";
import { guide } from "../shared/tools/guide.ts";
import type { Canvas, Designs, Host, Indexer, Out } from "../shared/tools/host.ts";
import { INSTRUCTIONS, MANUAL_MAP, PLAYBOOKS } from "../shared/tools/teach.ts";
import { liftParams, type WriteArgs } from "../shared/tools/write.ts";
import { TOOLS, runTool, type Call, type ToolDef } from "../shared/tools/tools.ts";
import { canCreate } from "./access.ts";
import type { Principal } from "./auth.ts";
import { GitError } from "./git.ts";
import { dropLocalRepo } from "./gitsync.ts";
import type { Hub, Live } from "./live.ts";
import { renderView, toPng } from "./render.ts";
import { draftYaml, surveyText } from "./survey.ts";
import { judge, modeOf, type CallRow, type Telemetry } from "./telemetry.ts";
import type { Scripts } from "./scripts.ts";
import type { Uploads } from "./uploads.ts";

/** What the SDK hands a tool besides its arguments (the parts used here). */
interface Extra {
  signal?: AbortSignal;
  _meta?: { progressToken?: string | number };
  sendNotification?: (n: {
    method: "notifications/progress";
    params: { progressToken: string | number; progress: number; total?: number; message?: string };
  }) => Promise<void>;
}

interface Deps {
  hub: Hub;
  /** Who the request is from; null when they aren't signed in. */
  identify: (req: http.IncomingMessage) => Principal | null;
  baseUrl: string;
  /** WWW-Authenticate on a 401: where an MCP client starts signing in (OAuth), if it can. */
  challenge?: string;
  /** Cached library stats, when the stats job is on. */
  libstats?: (p: Package) => LibStats | null;
  /** Repos sent from people's machines (index start). */
  uploads?: Uploads;
  /** The repo reader index start hands out: checked (built if missing) before it's handed out. */
  scripts?: Scripts;
  /** After a design is made: start it in its own git repo. */
  created?: (d: Awaited<ReturnType<Hub["create"]>>) => Promise<void>;
  /** The call log and feedback (server/telemetry.ts); absent: neither is kept. */
  telemetry?: Telemetry | null;
}

/**
 * An MCP session: one agent's connection, from initialize on. The transport is stateless (a
 * server per request), so Archnemesis keeps what a session needs itself: who the client is, and the
 * design it last used (so a call without design goes on there). The id goes back in the
 * Mcp-Session-Id header on initialize and comes in on every request after.
 */
export interface Session {
  id: string;
  client?: string;
  version?: string;
  /** The design (or fork) this session last worked on. */
  design?: string;
  /** The worker name the session goes by (write/note as), instead of its short id. */
  as?: string;
  at: number;
}

/** A session's short id, for history lines: "s-1a2b". */
const shortId = (s: Session) => `s-${s.id.replace(/-/g, "").slice(0, 4)}`;
const sessions = new Map<string, Session>();
const clientName = (s?: Session) =>
  s?.client ? `${s.client}${s.version ? `/${s.version}` : ""}` : null;
const SESSION_TTL = 24 * 3600_000;

function sessionFor(req: http.IncomingMessage, body: unknown): Session | undefined {
  const now = Date.now();
  const msgs = Array.isArray(body) ? body : [body];
  const init = msgs.find((m) => (m as { method?: string })?.method === "initialize") as
    { params?: { clientInfo?: { name?: string; version?: string } } } | undefined;
  if (init) {
    for (const [k, s] of sessions) if (now - s.at > SESSION_TTL) sessions.delete(k);
    const s: Session = {
      id: randomUUID(),
      client: init.params?.clientInfo?.name,
      version: init.params?.clientInfo?.version,
      at: now,
    };
    sessions.set(s.id, s);
    return s;
  }
  const id = req.headers["mcp-session-id"];
  const s = typeof id === "string" ? sessions.get(id) : undefined;
  if (s) s.at = now;
  return s;
}

export function mcpHandler(
  deps: Deps,
): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" }).end();
      return;
    }
    const principal = deps.identify(req);
    if (!principal) {
      res
        .writeHead(401, {
          "content-type": "application/json",
          "www-authenticate": deps.challenge ?? "Bearer",
        })
        .end(JSON.stringify({ error: "not signed in" }));
      return;
    }
    // What GitHub says each design's repo lets this person do, before listing anything.
    await deps.hub.perms.warm(principal);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > 5_000_000) {
        res
          .writeHead(413, { "content-type": "application/json" })
          .end(JSON.stringify({ error: "request too large" }));
        return;
      }
      chunks.push(c as Buffer);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      res
        .writeHead(400, { "content-type": "application/json" })
        .end(JSON.stringify({ error: "not JSON" }));
      return;
    }
    const session = sessionFor(req, body);
    if (session) res.setHeader("mcp-session-id", session.id);
    const server = buildServer(deps, principal, session);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };
}

/** When each agent last read a design's notes ("<principal>|<design>" → ISO time). */
const notesSeen = new Map<string, string>();

/** What an agent is doing, by tool, for the list of who's on Archnemesis. */
const VERB: Record<string, string> = {
  read: "reading",
  write: "editing",
  note: "leaving a note",
  show: "showing someone around",
  index: "reading a repo",
  design: "looking around",
};

/** Calls that change the design: on a design that follows git they go to the agent's fork. */
const isDry = (name: string, args: Record<string, unknown>) =>
  (name === "write" && !!args.dry_run) ||
  (name === "index" && args.action === "import" && !!args.dry_run);
const forks = (name: string, args: Record<string, unknown>) =>
  (name === "write" && !args.dry_run && !args.undo) ||
  (name === "index" && args.action === "import" && !args.dry_run);

export function buildServer(
  { hub, baseUrl, libstats, uploads, scripts, created, telemetry }: Deps,
  principal: Principal,
  session?: Session,
): McpServer {
  const server = new McpServer(
    { name: "archnm", version: "2.0.0" },
    { instructions: INSTRUCTIONS },
  );
  const designUrl = (design: string) => `${baseUrl}/#/${design}`;
  /**
   * Who acts: the agent, named by the call's `as` ("Agent · ordering-mapper") or else its
   * session ("Agent · s-1a2b"), so a manager sees which worker did what; its undo is its own.
   * `as` is per call: subagents share their parent's session, so a name that stuck to the
   * session would credit one agent's writes to another.
   */
  const acting = (as?: string): Principal =>
    session
      ? {
          ...principal,
          session: shortId(session),
          name: `${principal.name} · ${as ?? shortId(session)}`,
        }
      : as
        ? { ...principal, name: `${principal.name} · ${as}` }
        : principal;
  const authorOf = (as?: string): Author => {
    const p = acting(as);
    return { id: p.id, name: p.name, kind: p.kind };
  };

  /** Set when a call went to the session's design without naming one, so the answer can say so. */
  let defaulted = "";
  /** The design a call is about: the one named (or linked), the only one there is, or the one this session last used. */
  const pick = (design: string | undefined): Live => {
    const all = hub.list(principal);
    const linked =
      design && /#\/([a-z0-9][a-z0-9-]*(?:@[a-z0-9][a-z0-9-]*)?)/i.exec(design)?.[1]?.toLowerCase();
    if (linked) design = linked;
    if (design) {
      const want = design.trim().toLowerCase();
      const d =
        hub.get(design) ?? hub.get(all.find((x) => x.name.toLowerCase() === want)?.key ?? "");
      if (d && hub.perms.can(principal, d.key, "view")) return d;
      throw new ModelError(`no design "${design}"; designs: ${all.map((x) => x.key).join(", ")}`);
    }
    if (all.length === 1) return hub.get(all[0]!.key)!;
    const last = session?.design ? hub.get(session.design) : undefined;
    if (last && hub.perms.can(principal, last.key, "view")) {
      defaulted = last.key;
      return last;
    }
    throw new ModelError(`which design? pass design: one of ${all.map((x) => x.key).join(", ")}`);
  };

  /** The person this agent works for, where they are: their view and selection, from their open tab. */
  const personHere = (live: Live): ReturnType<Canvas["here"]> => {
    const me = principal.for;
    if (!me) return { note: "this connection doesn't belong to a person" };
    const mine = (id: string, kind?: string) =>
      id === me || (me === "local:*" && id.startsWith("local:") && kind !== "agent");
    let found: ReturnType<Canvas["here"]> | null = null;
    for (const [doc, d] of hub.hocuspocus.documents) {
      for (const st of d.awareness.getStates().values()) {
        const s = st as {
          user?: { id: string; kind?: string };
          diagram?: string | null;
          selected?: string[];
        };
        if (!s.user?.id || !mine(s.user.id, s.user.kind)) continue;
        const here = {
          design: doc,
          diagram: typeof s.diagram === "string" ? s.diagram : null,
          selection: Array.isArray(s.selected) ? s.selected : [],
        };
        // Their tab on this design wins over one elsewhere.
        if (doc === live.key || !found) found = here;
      }
    }
    if (!found)
      return {
        note: "They don't have Archnemesis open in a browser right now: ask them what they're looking at, or send a link.",
      };
    const rows = hub.store.trail(live.design, { limit: 40 }) as {
      user: string;
      event: TrailEvent;
    }[];
    const idx = live.index();
    const name = (d?: string | null) =>
      d ? (idx.diagrams.get(d)?.key ?? idx.diagrams.get(d)?.name ?? d) : "?";
    const recent = rows
      .filter((r) => r.event.kind === "move" || r.event.kind === "mark")
      .slice(-12)
      .map(
        (r) =>
          `${r.event.at.slice(11, 16)} ${r.user}: ${r.event.kind === "mark" ? `marked “${r.event.text ?? ""}”` : `${r.event.how ?? "moved"} to ${name(r.event.to?.d)}${r.event.to?.o ? ` (${idx.objects.get(r.event.to.o)?.key ?? r.event.to.o})` : ""}`}`,
      );
    return { ...found, ...(recent.length ? { recent } : {}) };
  };

  const canvasOf = (live: Live): Canvas | undefined =>
    principal.kind === "agent" && principal.for
      ? {
          show: async (stop, wait) => {
            live.point(principal, { ...stop, ...(wait ? { waiting: true } : {}) });
            if (!wait) return null;
            const seq = live.guideSeq;
            if (seq === null) return null;
            return live.waitReply(seq, Math.max(1000, wait.ms));
          },
          end: () => live.endGuide(),
          here: () => personHere(live),
          watching: () => hub.present(live.key),
        }
      : undefined;

  const indexerOf = (live: Live): Indexer | undefined =>
    uploads
      ? {
          start: async (dir) => {
            // Never hand out a command that 404s: the script must be there (built now if it isn't).
            const ready = scripts
              ? await scripts.ensure("archnm-index.cjs")
              : { ok: true as const };
            if (!ready.ok)
              return `The repo reader can't be handed out: ${ready.error}. Whoever runs this Archnemesis can fix it with npm run build. Meanwhile, map it by reading:\n\n${MANUAL_MAP}`;
            const ticket = uploads.mint(principal.id, live.key, dir ?? ".");
            const folder = dir ? JSON.stringify(dir) : ".";
            return `Run this in a shell on the machine with the repo (it only reads it; about a second, longer with a SCIP indexer on a big repo):\n\ncurl -fsS ${baseUrl}/archnm-index.cjs | node - ${folder} --to ${baseUrl}/upload/${ticket}\n\nThen: index {action: "scan", ticket: "${ticket}"}. The link works once, for 15 minutes.\n\nNo node or curl, or the command fails? Map it by reading instead:\n${MANUAL_MAP}`;
          },
          scan: (ticket, system) => {
            const got = uploads.get(ticket, principal.id);
            if (!got || "error" in got) throw new ModelError(got?.error ?? "no such ticket");
            const { survey, index } = got.ticket.upload!;
            const repo = index.repo || survey.repo;
            return `${surveyText(survey)}\n\nrepo: ${repo}: write its paths as ${repo}:path/in/the/repo (on modules, and on apps and components for their code root).\ncode: ${index.files.length} files, ${index.functions.length} functions, ${index.calls.length} calls, ${index.packages.length} libraries\n${callsAdvice(index, survey.indexer)}\n\nA draft, as evidence turned into boxes (rename, merge and drop; add what's inside and the connections), then write {yaml}:\n${draftYaml(survey, { system })}\n\nThen index {action: "import", ticket: "${ticket}", under: "<the system or app>", dry_run: true} shows where its files and functions would go: a folder whose path an app or component has (path: ${repo}:server) goes in that box; under takes the rest. Then import for real.`;
          },
          importPlan: (ticket, under, calls) => {
            const got = uploads.get(ticket, principal.id);
            if (!got || "error" in got) throw new ModelError(got?.error ?? "no such ticket");
            const { index } = got.ticket.upload!;
            const plan = importChanges(live.index(), index, { under, calls });
            const ops = plan.changes.length
              ? planChanges(live.state, live.index(), plan.changes, { tags: live.config().tags })
                  .ops
              : [];
            return {
              ops,
              summary: importSummary(plan, { under, calls }),
              label: `import ${index.repo}${index.sha ? `@${index.sha}` : ""}`,
            };
          },
          progress: (p) => hub.presence.agentProgress(principal, live.key, p),
        }
      : undefined;

  const hostOf = (live: Live, as?: string): Host => ({
    key: live.key,
    branch: live.branch,
    actor: { ...authorOf(as), ...(session ? { session: shortId(session) } : {}) },
    canEdit: hub.perms.can(principal, live.key, "edit"),
    state: () => live.state,
    index: () => live.index(),
    config: () => live.config(),
    commit: (ops, label, opts) => void live.commit(acting(as), ops, label, opts),
    applyRules: () => live.applyRules(),
    undo: (dry) => live.undo(acting(as), dry),
    recent: (n) => live.recent(n),
    ...(uploads ? { repos: () => uploads.reposFor(live.key) } : {}),
    // A fork's main, for read {diff}.
    ...(live.branch && hub.git.get(live.design)
      ? {
          base: () => hub.git.get(live.design)!.baseState(live.key),
          baseName: () => hub.git.get(live.design)!.parentOf(live.key)?.doc ?? null,
        }
      : {}),
    url: (d, o) => (d ? `${designUrl(live.key)}/d/${d}${o ? `/o/${o}` : ""}` : designUrl(live.key)),
    seen: {
      get: () => notesSeen.get(`${principal.id}|${live.design}`),
      set: (at) => void notesSeen.set(`${principal.id}|${live.design}`, at),
    },
    stats: libstats,
    canvas: canvasOf(live),
    indexer: indexerOf(live),
    render: async (d, o) => {
      const idx = live.index();
      const { svg } = await renderView(idx, live.config(), d, o.flow, o.step);
      const png = Buffer.from(await toPng(svg, 1.5)).toString("base64");
      const view = idx.diagrams.get(d);
      const q = o.flow
        ? `?flow=${encodeURIComponent(o.flow)}${o.step !== undefined ? `&step=${o.step + 1}` : ""}`
        : "";
      return { png, url: `${baseUrl}/api/d/${live.key}/render/${view?.key ?? d}.png${q}` };
    },
  });

  const gitOf = (live: Live) => {
    const g = hub.git.get(live.design);
    if (!g)
      throw new GitError(
        `${live.design} doesn't follow a git repo, so it has no forks (new designs start in git unless the server runs with ARCHNM_NEW_IN_GIT=0 or has no lasting disk). To get forks, the person connects a repo from the canvas's branch menu ("Connect a git repo…"); until then write to it directly: every write is in read {history: true} and write {undo: true} takes it back, so say what you changed when you hand it over.`,
      );
    return g;
  };
  /** Making designs is for editors; forking, proposing and discarding need to edit the design. */
  const editor = (on?: Live) => {
    if (on ? !hub.perms.can(principal, on.key, "edit") : !canCreate(principal))
      throw new GitError(`${principal.name} can read but not edit`);
  };
  const designs: Designs = {
    list: () =>
      hub.list(principal).map((d) => ({
        key: d.key,
        name: d.name,
        objects: d.objects,
        views: d.diagrams,
        git: d.git,
        private: d.private,
        present: d.present,
        url: designUrl(d.key),
        forks: (hub.git.get(d.key)?.info().forks ?? []).map((f) => ({
          key: f.doc,
          by: f.by ?? "?",
          pending: f.pending,
          behind: f.behind,
          proposed: !!f.proposedAt,
          url: designUrl(f.doc),
        })),
      })),
    create: async ({ name, key, from }) => {
      editor();
      const d = await hub.create(name, key, from ?? "empty", principal);
      await created?.(d);
      const who = principal.kind === "agent" ? "the person you work for" : "you";
      const live = hub.get(d.key) ?? d;
      const views = [...live.index().diagrams.values()].map((v) => ({
        key: v.key ?? v.id,
        rules: !!v.rules,
      }));
      // A design that follows git isn't written on main: the agent's writes go to its fork, so make it now and say so up front.
      const git = hub.git.get(d.key);
      let writesTo: { key: string; url: string } | undefined;
      if (live.mode === "mirror" && git && hub.perms.can(principal, live.key, "edit")) {
        const f = (await git.forkFor(principal)).live;
        writesTo = { key: f.key, url: designUrl(f.key) };
      }
      if (session) session.design = writesTo?.key ?? d.key;
      return {
        key: d.key,
        name: d.name(),
        url: designUrl(d.key),
        views,
        ...(writesTo ? { writesTo } : {}),
        ...(hub.access(d.key).private
          ? { note: `It's private: only ${who} can see it until it's shared from the design menu.` }
          : {}),
      };
    },
    delete: async (design, confirm) => {
      const key = design.toLowerCase();
      if (key.includes("@"))
        throw new GitError('that\'s a fork: design {action: "discard"} removes it');
      const d = hub.list(principal).find((x) => x.key === key);
      if (!d) throw new GitError(`no design "${design}"`);
      if (d.git && !hub.git.get(key)?.info().local)
        throw new GitError(
          `${key} follows a git repo: it isn't deleted here. Reconnect it from the design menu instead.`,
        );
      if (!hub.perms.can(principal, key, "manage")) {
        const who = principal.kind === "agent" ? "the person you work for" : "you";
        throw new GitError(
          `${key} isn't owned by ${who}: ${hub.access(key).owner ? "only its owner" : "it's a team design, so an admin"} can delete it, from the design menu in the app.`,
        );
      }
      if (!confirm)
        return `Would delete ${key} "${d.name}": ${d.objects} boxes and ${d.diagrams} views. Ask the person; if they say yes, call design {action: "delete", key: "${key}", confirm: true}.`;
      await dropLocalRepo(hub, key);
      hub.remove(key, `${principal.name} deleted ${d.name}`);
      return `Deleted ${key} "${d.name}". Its files were moved aside on the server.`;
    },
    fork: async (design, name) => {
      // From a fork: stacked on it (its diff and pull request are against that fork).
      const on = pick(design);
      editor(on);
      const f = await gitOf(on).fork(principal, name, on.branch ? on.key : undefined);
      return { key: f.key, url: designUrl(f.key), ...(on.branch ? { stackedOn: on.key } : {}) };
    },
    propose: async (design) => {
      const live = pick(design);
      editor(live);
      if (!live.branch)
        throw new GitError(
          'that\'s main; pass a fork as design (design {action: "list"} shows them)',
        );
      const r = await gitOf(live).propose(live.key, designUrl(live.key));
      const stack = r.stacked
        ? `Stacked on ${r.stacked}: the pull request is against its branch ${r.base}, so it shows only this fork's changes; merge ${r.stacked} first (or retarget this one to main once it's merged).\n`
        : "";
      const SHOWN = 25;
      const list = [
        r.headline,
        ...r.changes.slice(0, SHOWN).map((c) => `- ${c}`),
        ...(r.changes.length > SHOWN
          ? [
              `- … ${r.changes.length - SHOWN} more (the pull request lists ${Math.min(r.changes.length, 60)}${r.changes.length > 60 ? " and counts the rest" : ""}; read {diff: true} has them all)`,
            ]
          : []),
      ]
        .filter(Boolean)
        .join("\n");
      return r.url
        ? `${stack}Saved to ${r.branch}. Open the pull request here (it's prefilled; the person submits it):\n${r.url}\n\nChanges:\n${list}`
        : `${stack}Saved to ${r.branch}. This repo isn't on a forge Archnemesis knows, so a person merges it from the branch menu in Archnemesis: ${designUrl(live.key)}${r.stacked ? ` (into ${r.stacked} first: Archnemesis merges into main only, so merge ${r.stacked}, then this)` : ""}\n\nChanges:\n${list}`;
    },
    discard: async (design) => {
      const live = pick(design);
      editor(live);
      if (!live.branch) throw new GitError("that's main; pass a fork as design");
      const g = gitOf(live);
      const f = g.info().forks.find((x) => x.doc === live.key);
      if (!f) throw new GitError(`no open fork ${live.key}`);
      const row = hub.store.forks(live.design).find((r) => r.doc === live.key);
      if (!f.agent || row?.byId !== principal.id)
        throw new GitError(
          `${live.key} was started by ${f.by}; only they discard it (from the branch menu)`,
        );
      await g.discard(live.key, principal);
      return `Discarded ${live.key}.`;
    },
  };

  /** Where each design lives, for guide: so "where is this saved?" has a real answer. */
  const where = () => {
    const lines = hub.list(principal).map((d) => {
      const w = hub.git.get(d.key)?.where();
      return w
        ? `  ${d.key} "${d.name}": ${w.repo}, branch ${w.branch}, folder ${w.folder}; forks save to ${w.forks}`
        : `  ${d.key} "${d.name}": not in git: Archnemesis keeps it itself`;
    });
    return `The app: ${baseUrl}/${lines.length ? `\nWhere each design lives:\n${lines.join("\n")}` : ""}`;
  };

  const answer = (out: Out) => ({
    content: [
      { type: "text" as const, text: out.text },
      ...(out.images ?? []).map((i) => ({
        type: "image" as const,
        data: i.data,
        mimeType: i.mimeType,
      })),
    ],
    // No structuredContent: clients that have it show it instead of the text (Claude Code does), and the text is the answer.
    ...(out.isError ? { isError: true } : {}),
  });

  const feedback = telemetry
    ? async (f: { kind: string; text: string; tool?: string }) =>
        telemetry.feedback({
          session: session?.id,
          client: clientName(session),
          actor: principal.id,
          design: session?.design,
          ...f,
        })
    : undefined;
  /** The design a call was on, for the log (set by the call when it picks one). */
  let loggedDesign: string | null = null;

  /** MCP progress notifications, when the client asked for them (a progressToken). */
  const progressOf = (extra: Extra): Call["progress"] => {
    const token = extra?._meta?.progressToken;
    if (token === undefined || !extra.sendNotification) return undefined;
    return async (progress, total, message) => {
      await extra.sendNotification!({
        method: "notifications/progress",
        params: { progressToken: token, progress, total, message },
      }).catch(() => {});
    };
  };

  /** Every call, timed and logged (never failing because the log did). */
  const logged =
    (
      def: ToolDef,
      run: (args: Record<string, unknown>, extra: Extra) => Promise<ReturnType<typeof answer>>,
    ) =>
    async (args: Record<string, unknown>, extra: Extra) => {
      const t0 = performance.now();
      loggedDesign = null;
      const log = (r: Partial<CallRow> & { outcome: CallRow["outcome"] }) => {
        if (!telemetry) return;
        try {
          telemetry.call({
            session: session?.id,
            client: clientName(session),
            actor: principal.id,
            actorKind: principal.kind,
            via: "mcp",
            tool: def.name,
            mode: modeOf(def.name, args),
            design:
              loggedDesign ??
              (typeof args.design === "string" ? args.design : (session?.design ?? null)),
            args,
            ms: performance.now() - t0,
            ...r,
          });
        } catch {
          /* the log never fails a call */
        }
      };
      try {
        const res = await run(args, extra);
        const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
        log({ ...judge(text, !!res.isError), outChars: text.length });
        return res;
      } catch (e) {
        log({
          outcome: "exception",
          errors: 1,
          firstError: (e as Error)?.message?.split("\n")[0] ?? String(e),
          stack: (e as Error)?.stack ?? null,
        });
        throw e;
      }
    };

  const register = (def: ToolDef) =>
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.input,
        annotations: { title: def.title, ...def.annotations },
      } as never,
      logged(def, async (args: Record<string, unknown>, extra: Extra) => {
        try {
          if (!def.onDesign) {
            const only = hub.list(principal).length === 1 ? hostOf(pick(undefined)) : undefined;
            return answer(
              await runTool(
                def,
                {
                  designs,
                  where: where(),
                  signal: extra?.signal,
                  feedback,
                  ...(only ? { host: only } : {}),
                },
                args,
              ),
            );
          }
          defaulted = "";
          // as: written in a write's yaml counts too (liftParams), like the other parameters.
          const as =
            def.name === "write"
              ? liftParams(args as WriteArgs & { as?: string }).args.as
              : args.as;
          const callAs = typeof as === "string" && as.trim() ? as.trim().slice(0, 40) : undefined;
          let live = pick(args.design as string | undefined);
          let forkHint = "";
          let tail = defaulted
            ? `\n\n(on ${defaulted}: the design this session last used; pass design for another)`
            : "";
          const git = hub.git.get(live.design);
          if (
            forks(def.name, args) &&
            live.mode === "mirror" &&
            git &&
            hub.perms.can(principal, live.key, "edit")
          ) {
            const r = await git.forkFor(principal);
            live = r.live;
            tail += `\n\n${live.design}'s main follows git, so this is on ${r.created ? "a new fork" : "your fork"}, ${live.branch}: ${designUrl(live.key)}. Pass design: "${live.key}" to keep working on it; design {action: "propose", design: "${live.key}"} when it's ready.`;
          } else if (live.mode === "mirror" && git && hub.perms.can(principal, live.key, "edit")) {
            // Main, named while this agent has a fork open: a dry run previews what the real call
            // does, which lands on the fork, so it runs there (an import dry run named
            // main and answered "no object archnm", which the agent had written on its fork). Other
            // calls stay on main, and say where its writes are when they fail.
            const mine = git.openFork(principal);
            if (mine && isDry(def.name, args)) {
              live = mine;
              tail += `\n\n(on your fork ${live.key}: ${live.design}'s main follows git, and your writes go there)`;
            } else if (mine)
              forkHint = `\n\nThis read ${live.design}'s main, which follows git; your writes are on your fork: pass design: "${mine.key}".`;
          }
          // Seen: it shows in everyone's list of who's on Archnemesis, on this design (and view).
          let viewId: string | null = null;
          const v = (args.view ?? args.render) as string | undefined;
          if (v && v !== "*") {
            try {
              viewId = findView(live.index(), v).id;
            } catch {
              /* not a view: the tool says so */
            }
          }
          if (session) session.design = live.key;
          loggedDesign = live.key;
          hub.presence.agentSeen(principal, live.key, viewId, VERB[def.name] ?? def.name);
          // Notes are how people answer agents: say when new ones arrive, on whatever call comes next.
          const seenKey = `${principal.id}|${live.design}`;
          const seenAt = notesSeen.get(seenKey);
          const out0 = await runTool(
            def,
            { host: hostOf(live, callAs), signal: extra?.signal, progress: progressOf(extra) },
            args,
          );
          const out = out0.isError && forkHint ? { ...out0, text: out0.text + forkHint } : out0;
          const listed = def.name === "note" && (args.action ?? "list") === "list";
          if (!listed && !out.isError) {
            const idx = live.index();
            if (seenAt === undefined) {
              notesSeen.set(seenKey, new Date().toISOString());
              const open = [...idx.notes.values()].filter(
                (n) => n.kind === "note" && !n.resolved && n.author.id !== principal.id,
              ).length;
              if (open)
                tail += `\n\n[${open} open note${open === 1 ? "" : "s"} from people on ${live.design}: note {action: "list"}; then note {action: "list", unread: true} shows only what's new.]`;
            } else {
              const fresh = newNotes(idx, seenAt, principal.id);
              if (fresh.notes || fresh.replies)
                tail += `\n\n[New since you last read notes: ${[fresh.notes ? `${fresh.notes} note${fresh.notes === 1 ? "" : "s"}` : "", fresh.replies ? `${fresh.replies} repl${fresh.replies === 1 ? "y" : "ies"}` : ""].filter(Boolean).join(" and ")}. note {action: "list", unread: true}.]`;
            }
          }
          return answer(tail ? { ...out, text: out.text + tail } : out);
        } catch (e) {
          if (e instanceof ModelError || e instanceof GitError)
            return answer({ text: e.message, isError: true });
          throw e;
        }
      }) as never,
    );
  for (const def of TOOLS) register(def);

  for (const [name, p] of Object.entries(PLAYBOOKS))
    server.registerPrompt(
      name,
      {
        title: p.title,
        description: `${p.title}: the playbook, for ${p.args}`,
        argsSchema: { focus: z.string().optional().describe(p.args) },
      },
      ({ focus }) => ({
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `${p.text}${focus ? `\n\nThis time: ${focus}` : ""}`,
            },
          },
        ],
      }),
    );

  server.registerResource(
    "guide",
    "archnm://guide",
    { title: "How to work with Archnemesis", mimeType: "text/markdown" },
    async (uri) => ({
      contents: [{ uri: uri.href, text: `${INSTRUCTIONS}\n\n${guide({ topic: "grammar" }).text}` }],
    }),
  );

  return server;
}
