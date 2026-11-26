// Telemetry: a row per tool call with how it went, the off switch, retention, feedback with
// the session's calls, the summary's writes-to-valid, and a log that never breaks a call.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Auth, type Principal } from "./auth.ts";
import { testConfig } from "./testing.ts";
import { Hub } from "./live.ts";
import { buildServer, type Session } from "./mcp.ts";
import { DocStore } from "./store.ts";
import { repro } from "../cli/telemetry.ts";
import {
  capArgs,
  normalise,
  openTelemetry,
  summaryText,
  Telemetry,
  type CallRow,
} from "./telemetry.ts";

const agent: Principal = {
  id: "agent:alice",
  name: "Agent",
  kind: "agent",
  roles: ["editor"],
  for: "ts:alice",
};

let dir: string;
let hub: Hub;
let tel: Telemetry;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "archnm-telemetry-"));
  hub = new Hub(
    new DocStore(join(dir, "archnm.sqlite")),
    new Auth(testConfig(dir).auth),
    testConfig(dir),
  );
  await hub.start();
  tel = new Telemetry(join(dir, "telemetry.sqlite"));
});
afterEach(async () => {
  tel.close();
  await hub.close();
  rmSync(dir, { recursive: true, force: true });
});

type Result = { content: { type: string; text?: string }[]; isError?: boolean };
async function connect(session: Session, telemetry: Telemetry | null = tel) {
  const server = buildServer(
    { hub, identify: () => agent, baseUrl: "http://archnm.test", telemetry },
    agent,
    session,
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(b);
  return async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as Result;
}

describe("the call log", () => {
  it("writes a row per call, with the session, client, mode, design and outcome", async () => {
    const session: Session = { id: "s1", client: "claude-code", version: "2.1", at: Date.now() };
    const call = await connect(session);
    await call("design", { action: "create", name: "Delivery", key: "delivery" });
    await call("read", { q: "nothing-here" });
    await call("write", { yaml: "objects:\n  courier: {kind: actor, context: Rides, picks up.}" });
    await call("write", { yaml: "objects:\n  courier: {kind: actr}" });
    await call("write", {
      yaml: 'objects:\n  courier: {kind: actor, context: "Rides, picks up."}',
    });
    await call("read", { design: "nope" });
    const rows = tel.session("s1");
    expect(rows.map((r) => [r.tool, r.mode, r.outcome])).toEqual([
      ["design", "create", "ok"],
      ["read", "search", "ok"],
      ["write", "yaml", "refused"],
      ["write", "yaml", "refused"],
      ["write", "yaml", "ok"],
      ["read", "overview", "invalid"],
    ]);
    expect(rows[0]).toMatchObject({
      client: "claude-code/2.1",
      actor: "agent:alice",
      actorKind: "agent",
      via: "mcp",
    });
    expect(rows[1]!.design).toBe("delivery");
    expect(rows[2]!.firstError).toContain("the text has a comma inside {…}");
    expect(rows[2]!.errors).toBe(1);
    expect(JSON.parse(rows[4]!.args).yaml).toContain("Rides, picks up.");
    expect(rows[4]!.outChars).toBeGreaterThan(0);
    expect(rows[5]!.firstError).toContain('no design "nope"');
  });

  it("is off with ARCHNM_TELEMETRY=off (feedback is still kept)", async () => {
    const off = openTelemetry(join(dir, "off.sqlite"), false)!;
    const call = await connect({ id: "s2", at: Date.now() }, off);
    await call("design", { action: "list" });
    expect(off.session("s2")).toEqual([]);
    expect(off.call({ tool: "read", outcome: "ok" })).toBeNull();
    expect(off.feedback({ session: "s2", kind: "bug", text: "x" })).toBeGreaterThan(0);
    off.close();
  });

  it("caps long args", () => {
    const s = capArgs({ yaml: "x".repeat(20_000) });
    expect(Buffer.byteLength(s)).toBeLessThanOrEqual(8 * 1024);
    expect(s).toMatch(/cut at 8192 bytes of \d+\]$/);
  });

  it("keeps 30 days and at most so many rows", () => {
    const t = new Telemetry(":memory:", { keepRows: 5 });
    const now = Date.parse("2026-11-24T12:00:00Z");
    t.call({ at: new Date(now - 31 * 86400_000).toISOString(), tool: "read", outcome: "ok" });
    t.call({ at: new Date(now - 29 * 86400_000).toISOString(), tool: "read", outcome: "ok" });
    t.prune(now);
    expect(t.summary().calls).toBe(1);
    for (let i = 0; i < 9; i++)
      t.call({ at: new Date(now).toISOString(), tool: "write", outcome: "ok" });
    t.prune(now);
    expect(t.summary().calls).toBe(5);
    t.close();
  });

  it("never fails a call because logging failed", async () => {
    const broken = new Telemetry(join(dir, "broken.sqlite"));
    broken.close();
    const call = await connect({ id: "s3", at: Date.now() }, broken);
    const r = await call("design", { action: "list" });
    expect(r.isError).toBeFalsy();
    // Nor when the logger itself throws.
    const throwing = new Telemetry(":memory:");
    throwing.call = () => {
      throw new Error("disk full");
    };
    const call2 = await connect({ id: "s4", at: Date.now() }, throwing);
    expect((await call2("design", { action: "list" })).isError).toBeFalsy();
  });
});

describe("feedback", () => {
  it("is kept with the session's last 20 calls, and answers with its id", async () => {
    const call = await connect({ id: "s5", client: "claude-code", at: Date.now() });
    for (let i = 0; i < 22; i++) await call("guide", {});
    const r = await call("feedback", {
      kind: "confusing",
      text: "The colon error didn't say which line.",
      tool: "write",
    });
    expect(r.content[0]!.text).toMatch(/^Thanks: kept as feedback #(\d+)/);
    const [f] = tel.feedbackList({ open: true });
    expect(f).toMatchObject({
      kind: "confusing",
      tool: "write",
      session: "s5",
      client: "claude-code",
      actor: "agent:alice",
    });
    expect(f!.calls).toHaveLength(20);
    expect(f!.calls).toEqual(
      tel
        .session("s5")
        .slice(2, 22)
        .map((c) => c.id),
    );
    expect(tel.resolveFeedback(f!.id, "fixed in mcp-v2-fixes")).toBe(true);
    expect(tel.feedbackList({ open: true })).toEqual([]);
  });

  it("is the eighth tool: not read-only, not destructive", async () => {
    const server = buildServer(
      {
        hub,
        identify: () => agent,

        baseUrl: "http://archnm.test",
        telemetry: tel,
      },
      agent,
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(b);
    const t = (await client.listTools()).tools.find((x) => x.name === "feedback")!;
    expect(t.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(client.getInstructions()).toContain(
      "tell us with feedback: it's how the tools get fixed",
    );
  });
});

describe("the summary", () => {
  it("counts failed writes before each success, per session", () => {
    const t = new Telemetry(":memory:");
    const w = (session: string, outcome: CallRow["outcome"], firstError?: string, mode = "yaml") =>
      t.call({ session, tool: "write", mode, outcome, firstError, ms: 10 });
    // a: 3 failures then ok, then ok at once; b: ok, then 1 failure then ok, then a failure it never fixed.
    w("a", "refused", "yaml:5: the text has a colon inside {…}");
    w("a", "refused", "yaml:12: the text has a colon inside {…}");
    w("a", "invalid", 'no design "delivry"');
    w("a", "ok");
    w("a", "ok", undefined, "yaml:dry");
    w("a", "ok");
    w("b", "ok");
    w("b", "refused", "yaml:2: the text has a comma inside {…}");
    w("b", "ok");
    w("b", "refused", "yaml:7: the text has a colon inside {…}");
    t.call({ session: "b", tool: "read", mode: "view", outcome: "ok", ms: 3, outChars: 120 });
    const s = t.summary();
    expect(s.writes).toMatchObject({
      sessions: 2,
      streaks: [3, 0, 0, 1],
      median: 1,
      worst: 3,
      worstSession: "a",
      unfinished: 1,
    });
    expect(s.errors[0]).toEqual({
      line: "yaml:N: the text has a colon inside {…}",
      count: 3,
      tool: "write",
    });
    const yaml = s.tools.find((x) => x.tool === "write" && x.mode === "yaml")!;
    expect(yaml.calls).toBe(9);
    expect(yaml.refused).toBeCloseTo(4 / 9);
    expect(summaryText(s)).toContain(
      "failed tries before each: median 1, worst 3 (session a); 1 sessions ended on a failed write",
    );
    t.close();
  });

  it("normalises error lines so the same mistake counts once", () => {
    expect(normalise('error: yaml:14: unknown field "fold" on box courier-person')).toBe(
      normalise('error: yaml:3: unknown field "tags" on box api-gateway'),
    );
  });
});

describe("repro", () => {
  it("gives the call, the session's writes before it on that design, and where its files are", async () => {
    const call = await connect({ id: "s6", at: Date.now() });
    await call("design", { action: "create", name: "Delivery", key: "delivery" });
    await call("write", { yaml: 'objects:\n  courier: {kind: actor, context: "Rides."}' });
    await call("write", { yaml: "objects:\n  courier: {kind: actr}" });
    const failed = tel.session("s6").at(-1)!;
    const r = repro(tel, failed.id, join(dir, "designs"))!;
    expect(r.call).toMatchObject({
      tool: "write",
      outcome: "refused",
      args: { yaml: "objects:\n  courier: {kind: actr}" },
    });
    expect(r.before).toEqual([
      { tool: "write", args: { yaml: 'objects:\n  courier: {kind: actor, context: "Rides."}' } },
    ]);
    expect(r.files).toBe(join(dir, "designs", "delivery"));
  });
});

describe("sessions as workers", () => {
  it("names each session in history (as a worker when it says so), filters by it, and keeps undo per session", async () => {
    await hub.create("Shared", "shared", "empty", agent);
    const a = await connect({ id: "aaaa1111-0000-0000-0000-000000000000", at: Date.now() });
    const b = await connect({ id: "bbbb2222-0000-0000-0000-000000000000", at: Date.now() });
    const w = await a("write", {
      design: "shared",
      yaml: 'objects:\n  ordering: {kind: app, context: "Takes orders."}',
      as: "ordering-mapper",
      label: "ordering",
    });
    expect(w.content[0]!.text).toMatch(
      /^Written by Agent · ordering-mapper \(s-aaaa\): "ordering"/,
    );
    await b("write", {
      design: "shared",
      yaml: 'objects:\n  dispatch: {kind: app, context: "Finds couriers."}',
      label: "dispatch",
    });
    const hist = (await a("read", { design: "shared", history: true })).content[0]!.text!;
    expect(hist).toContain("Agent · ordering-mapper (agent, s-aaaa): ordering");
    expect(hist).toContain("Agent · s-bbbb (agent): dispatch");
    expect(
      (await a("read", { design: "shared", history: true, by: "s-bbbb" })).content[0]!.text,
    ).not.toContain("ordering-mapper");
    // a's undo takes back a's write, not b's later one.
    expect((await a("write", { design: "shared", undo: true })).content[0]!.text).toContain(
      "Undone",
    );
    const keys = [...hub.get("shared")!.state.objects.values()].map((o) => o.key);
    expect(keys).toContain("dispatch");
    expect(keys).not.toContain("ordering");
  });

  it("takes as per call: subagents share a session, so a name never sticks to the next call", async () => {
    await hub.create("Shared", "shared", "empty", agent);
    const s = await connect({ id: "cccc3333-0000-0000-0000-000000000000", at: Date.now() });
    await s("write", {
      design: "shared",
      yaml: 'objects:\n  ordering: {kind: app, context: "Takes orders."}',
      as: "ordering-mapper",
      label: "worker",
    });
    const mine = await s("write", {
      design: "shared",
      yaml: 'objects:\n  dispatch: {kind: app, context: "Finds couriers."}',
      label: "manager",
    });
    expect(mine.content[0]!.text).toMatch(/^Written by Agent · s-cccc/);
    const hist = (await s("read", { design: "shared", history: true })).content[0]!.text!;
    expect(hist).toContain("Agent · ordering-mapper (agent, s-cccc): worker");
    expect(hist).toContain("Agent · s-cccc (agent): manager");
  });
});
