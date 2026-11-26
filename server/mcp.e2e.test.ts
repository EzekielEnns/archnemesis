// The MCP end to end: a scratch Archnemesis on its own port (a free one the OS picks, so it never
// meets an Archnemesis someone is running), folder and database, driven through the MCP client SDK
// as an agent would, then stopped.
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Archnm, type Result, startArchnm, text } from "./e2e.ts";

let archnm: Archnm;
let BASE = "";
let dir: string;
let client: Client;

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await archnm.call(name, args);
  // The text is the answer: clients that get structuredContent show it instead (Claude Code does).
  expect(r.structuredContent, `${name} sent structuredContent`).toBeUndefined();
  return r;
};

beforeAll(async () => {
  archnm = await startArchnm({ ARCHNM_NEW_IN_GIT: "0" });
  ({ base: BASE, dir, client } = archnm);
  // A fresh server starts with one empty design; these tests read the example shop, asked for.
  const made = await archnm.call("design", {
    action: "create",
    name: "Example",
    key: "example",
    from: "example",
  });
  expect(made.isError, text(made)).toBeFalsy();
}, 70_000);

afterAll(async () => {
  await archnm?.stop();
});

describe("the MCP, end to end", () => {
  it("offers eight tools, four prompts, the guide, and short instructions", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "read",
      "write",
      "note",
      "show",
      "guide",
      "design",
      "index",
      "feedback",
    ]);
    const ro = Object.fromEntries(tools.map((t) => [t.name, t.annotations?.readOnlyHint ?? false]));
    expect(ro).toMatchObject({ read: true, guide: true, write: false });
    expect(tools.find((t) => t.name === "write")!.annotations?.destructiveHint).toBe(true);
    expect(client.getInstructions()!.length).toBeLessThanOrEqual(2500);
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(["design", "map", "mentor", "tour"]);
    const map = await client.getPrompt({ name: "map", arguments: { focus: "the shop" } });
    expect((map.messages[0]!.content as { text: string }).text).toContain("This time: the shop");
    const guide = await client.readResource({ uri: "archnm://guide" });
    expect((guide.contents[0] as { text: string }).text).toContain("Rules agents get wrong");
  });

  it("reads: the design, a search, one box, a scope", async () => {
    expect(text(await call("design"))).toMatch(/^example {2}Example/m);
    expect(text(await call("read"))).toContain("shop  Shop (system)");
    const hit = await call("read", { q: "checkout" });
    expect(text(hit)).toMatch(/^checkout {2}Checkout/);
    expect(text(await call("read", { ref: "checkout" }))).toContain(
      "→ payments  charges cards (HTTPS)",
    );
    expect(text(await call("read", { scope: "shop-api" }))).toContain("# neighbours");
  });

  it("writes a fragment, says every error at once, and undoes", async () => {
    const bad = await call("write", { yaml: "objects:\n  billing: {kind: ap, in: shopp}\n" });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain("did you mean app?");
    const ok = await call("write", {
      yaml: "objects:\n  billing: {kind: app, in: shop, context: Charges orders.}\nconnections:\n  - {from: checkout, to: billing, label: bills the order}\n",
    });
    expect(text(ok)).toContain("+ billing (app) in shop");
    expect(text(await call("read", { ref: "billing" }))).toContain("← checkout  bills the order");
    expect(text(await call("read", { history: true }))).toContain("wrote 1 box, 1 connection");
    expect(text(await call("write", { undo: true, dry_run: true }))).toContain(
      "Undo would take back: wrote 1 box, 1 connection",
    );
    expect(text(await call("read", { ref: "billing" }))).toContain("billing (app)");
    expect(text(await call("write", { undo: true }))).toMatch(
      /^Undone: wrote 1 box, 1 connection\./,
    );
    expect((await call("read", { ref: "billing" })).isError).toBe(true);
  });

  it("leaves notes, shows, renders, guides", async () => {
    const n = await call("note", { about: "orders-db", text: "Is the worker the only reader?" });
    expect(text(n)).toMatch(/^Left a note n_/);
    expect(text(await call("note", { action: "list" }))).toContain("note on orders-db");
    // About a connection: pinned on its arrow, and listed and read with it.
    const on = text(
      await call("note", { about: "checkout>orders-db", text: "Why not through the API?" }),
    );
    expect(on).toMatch(/^Left a note n_\S+ on checkout>orders-db/);
    expect(text(await call("note", { action: "list", about: "checkout>orders-db" }))).toContain(
      "Why not through the API?",
    );
    expect(text(await call("read", { ref: "checkout>orders-db" }))).toContain("open notes (1)");
    const r = await call("show", { render: "shop" });
    expect(r.content.some((c) => c.type === "image")).toBe(true);
    expect(text(await call("show", { open: "checkout" }))).toMatch(/^Showing shop-api/);
    expect(text(await call("guide", { topic: "grammar" }))).toContain("objects:");
  });

  it("starts an index, and knows a design that isn't there", async () => {
    const start = text(await call("index", { action: "start", path: "." }));
    expect(start).toMatch(/curl -fsS .*archnm-index\.cjs/);
    expect(start).toContain("Mapping a repo by reading it");
    // The command it hands out works: the script is served (built on demand when dist/ lacks it).
    const js = await fetch(`${BASE}/archnm-index.cjs`);
    expect(js.status).toBe(200);
    expect((await js.text()).length).toBeGreaterThan(1000);
    const r = await call("read", { design: "nope" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('no design "nope"');
    // This one keeps designs out of git (ARCHNM_NEW_IN_GIT=0): fork says so, and how to get one.
    const f = await call("design", { action: "fork", design: "example" });
    expect(f.isError).toBe(true);
    expect(text(f)).toMatch(/ARCHNM_NEW_IN_GIT=0.*Connect a git repo.*write to it directly/);
  });

  it("remembers the design this session made, and says what it starts with", async () => {
    const made = text(
      await call("design", { action: "create", name: "Delivery", key: "delivery" }),
    );
    expect(made).toContain("The tools use delivery from here on");
    expect(made).toContain("one view: landscape (follows rules");
    // Two designs now; no design named: the session's.
    const w = await call("write", {
      yaml: 'objects:\n  customer: {kind: actor, context: "Hungry, and in a hurry."}',
    });
    expect(text(w)).toContain("+ customer (actor)");
    expect(text(w)).toContain("(on delivery: the design this session last used");
    // A new client session has no default.
    const other = new Client({ name: "e2e-2", version: "1" });
    await other.connect(
      new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
        requestInit: { headers: { origin: BASE } },
      }),
    );
    const r = (await other.callTool({ name: "read", arguments: {} })) as Result;
    expect(text(r)).toContain("which design?");
    await other.close();
  });

  it("says once per line when prose in {…} needs quotes, and switches a view to hand-picked", async () => {
    const comma = await call("write", {
      design: "delivery",
      yaml: "objects:\n  courier: {kind: actor, context: Rides, picks up, drops off.}\n  shop: {kind: system, context: The platform: takes orders.}",
    });
    expect(comma.isError).toBe(true);
    expect(text(comma)).toContain("yaml:2: context: the text has a comma inside {…}");
    expect(text(comma)).toContain("yaml:3: context: the text has a colon inside {…}");
    expect(text(comma)).not.toContain("unknown field");
    expect(text(comma)).not.toContain("Block collections");
    const v = await call("write", {
      design: "delivery",
      yaml: "views:\n  landscape: {boxes: [customer]}",
    });
    expect(v.isError).toBeFalsy();
    expect(text(await call("read", { design: "delivery", view: "landscape" }))).toContain(
      "hand-picked",
    );
  });

  it("logs every call, keeps feedback with them, and reports it (API and CLI)", async () => {
    const r = await call("feedback", {
      kind: "confusing",
      text: "e2e: the colon error was the library's.",
      tool: "write",
    });
    const id = Number(/#(\d+)/.exec(text(r))?.[1]);
    expect(id).toBeGreaterThan(0);
    const res = await fetch(`${BASE}/api/telemetry`, { headers: { origin: BASE } });
    expect(res.status).toBe(200);
    const s = (await res.json()) as {
      calls: number;
      tools: { tool: string }[];
      feedback: { id: number; calls: number[] }[];
      writes: { streaks: number[] };
    };
    expect(s.calls).toBeGreaterThan(10);
    expect(s.tools.map((t) => t.tool)).toContain("write");
    expect(s.feedback.find((f) => f.id === id)!.calls.length).toBe(20);
    expect(s.writes.streaks.length).toBeGreaterThan(0);
    const out = await new Promise<string>((resolve) => {
      const p = spawn(
        process.execPath,
        ["cli/archnm.ts", "telemetry", "--db", join(dir, "telemetry.sqlite")],
        { stdio: ["ignore", "pipe", "inherit"] },
      );
      let o = "";
      p.stdout!.on("data", (b: Buffer) => (o += b.toString()));
      p.on("exit", () => resolve(o));
    });
    expect(out).toMatch(/^\d+ calls/);
    expect(out).toContain("writes to valid:");
    expect(out).toContain(`#${id} `);
  });
});
