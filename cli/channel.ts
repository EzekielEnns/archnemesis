// `archnm channel`: Archnemesis's MCP for Claude Code, run locally, that also hears @agent.
// Claude Code starts it over stdio. It passes every Archnemesis tool through to the server's
// hosted MCP (so it replaces the http one), and, as a Claude Code channel (a research
// preview), polls the server for flags waiting on this agent (someone wrote @agent, or
// answered a flag) and pushes each into the running session as a <channel source="archnm">
// event, so the session goes and answers it.
//
//   claude mcp add -s user archnm -- node <archnm>/cli/archnm.ts channel --server <url>
//   claude --dangerously-load-development-channels server:archnm
//
// Started without the flag it's just Archnemesis's tools: the events are dropped.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { WaitingFlag } from "../shared/flags.ts";

type Flag = WaitingFlag & { link: string };

const INSTRUCTIONS = `Events from Archnemesis arrive as <channel source="archnm" note="…" design="…">. Each is a note thread in Archnemesis (a shared architecture diagram) where the person you work for asked you something: they wrote @agent, or answered a thread you're in. Answer it without being asked again:
1. Read the thread with the Archnemesis tool read, ref: the link (it prints the thread; read ref on what it's about for more).
2. Do what it asks: answer from the model and the code, or make the change with write (on a design that follows git it goes to a fork) if it asks for one.
3. Reply in the thread with note {action: "reply", note: <its id>, text}, saying what you found or did. Resolve it (note {action: "resolve"}) only if it's settled.
4. Tell the person here in one line what you answered, with the link.
`;

/** Seen: note id → the time of the last message pushed, so each new word is pushed once. */
export async function runChannel(opts: {
  server: string;
  every: number;
  token?: string;
}): Promise<void> {
  const base = opts.server.replace(/\/$/, "");
  const log = (s: string) => process.stderr.write(`archnm channel: ${s}\n`);
  const headers: Record<string, string> = opts.token
    ? { authorization: `Bearer ${opts.token}` }
    : {};

  // The hosted MCP, connected again whenever a call finds it gone (the server restarted).
  let remote: Promise<Client> | null = null;
  const connect = () =>
    (remote ??= (async () => {
      const c = new Client({ name: "archnm-channel", version: "1.0.0" });
      await c.connect(
        new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }),
      );
      return c;
    })().catch((e) => {
      remote = null;
      throw e;
    }));
  const call = async <T>(fn: (c: Client) => Promise<T>): Promise<T> => {
    try {
      return await fn(await connect());
    } catch {
      remote = null;
      return fn(await connect());
    }
  };
  // Its instructions are the session's, so wait (a little) for them.
  let remoteInstructions = "";
  try {
    remoteInstructions =
      (
        await Promise.race([
          connect(),
          new Promise<never>((_, no) => setTimeout(() => no(new Error("timed out")), 8000)),
        ])
      ).getInstructions() ?? "";
  } catch (e) {
    log(`can't reach ${base}/mcp yet (${(e as Error).message}); tools connect on first use`);
  }

  const mcp = new Server(
    { name: "archnm", version: "1.0.0" },
    {
      capabilities: { tools: {}, experimental: { "claude/channel": {} } },
      instructions: [remoteInstructions, INSTRUCTIONS].filter(Boolean).join("\n\n"),
    },
  );
  mcp.setRequestHandler(ListToolsRequestSchema, async (req) =>
    call((c) => c.listTools(req.params)),
  );
  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      // Long enough for a point wait (it holds the call until the person presses something).
      return (await call((c) =>
        c.callTool(req.params, undefined, { timeout: 10 * 60_000 }),
      )) as never;
    } catch (e) {
      return {
        content: [
          { type: "text", text: `Archnemesis at ${base} didn't answer: ${(e as Error).message}` },
        ],
        isError: true,
      };
    }
  });
  await mcp.connect(new StdioServerTransport());
  const seen = new Map<string, string>();
  let failing = false;
  const poll = async () => {
    try {
      const r = await fetch(`${base}/api/flags`, { headers: { origin: base, ...headers } });
      if (r.status === 404)
        throw new Error("it has no /api/flags: update it to hear @agent (its tools still work)");
      if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
      const { flags } = (await r.json()) as { flags: Flag[] };
      if (failing) log("reconnected");
      failing = false;
      const open = new Set(flags.map((f) => f.id));
      for (const id of seen.keys()) if (!open.has(id)) seen.delete(id);
      for (const f of flags) {
        if (seen.get(f.id) === f.last.at) continue;
        seen.set(f.id, f.last.at);
        const thread =
          f.last.text === f.text
            ? `${f.last.by.name}: “${f.text}”`
            : `it starts “${f.text}”; the latest, from ${f.last.by.name}: “${f.last.text}”`;
        await mcp.notification({
          method: "notifications/claude/channel",
          params: {
            content: `An Archnemesis thread${f.on ? ` on ${f.on}` : ""} is waiting on you: ${thread}\n${f.link}`,
            meta: { note: f.id, design: f.doc },
          },
        });
      }
    } catch (e) {
      if (!failing) log(`can't reach ${base}: ${(e as Error).message}`);
      failing = true;
    }
  };
  await poll();
  setInterval(() => void poll(), opts.every * 1000);
}
