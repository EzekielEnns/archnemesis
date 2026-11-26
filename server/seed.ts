// A code example for tests and demos: the agent board mapped down to its functions. (The shop
// example, shared with the browser, is shared/seed.ts.)
import {
  boxSize,
  makeBoundary,
  makeConnection,
  makeFlow,
  makeStep,
  type Package,
  makeDiagram,
  makeObject,
  type ModelObject,
  type Op,
} from "../shared/model.ts";

/**
 * A code example: the agent board (a Rust CLI that runs as three processes) mapped down to
 * its functions and libraries, with ordinary objects, boundaries and views only.
 */
export function codeSeedOps(): Op[] {
  const ops: Op[] = [];
  const obj = (fields: Parameters<typeof makeObject>[0]): ModelObject => {
    const o = makeObject(fields);
    ops.push({ op: "object.put", object: o });
    return o;
  };
  const call = (from: ModelObject, to: ModelObject, technology = "") =>
    ops.push({
      op: "connection.put",
      connection: makeConnection({ fromId: from.id, toId: to.id, technology }),
    });

  const board = obj({
    kind: "system",
    name: "Agent board",
    description: "Agents post to a shared board and get woken when something is for them.",
  });
  const harness = obj({
    kind: "system",
    name: "Claude Code",
    external: true,
    description: "The agent harness: runs hooks and talks MCP.",
  });
  const app = obj({
    kind: "app",
    name: "board",
    parentId: board.id,
    technology: "Rust",
    description: "One binary: the CLI, the per-machine node, and the hub.",
  });
  const db = obj({
    kind: "store",
    name: "Board database",
    parentId: board.id,
    technology: "SQLite",
    description: "The event log and its derived tables (WAL).",
  });

  const mod = (name: string, path: string, parent: ModelObject, description = "") =>
    obj({ kind: "module", name, path: `s-chan:${path}`, parentId: parent.id, description });
  const crate = mod("board", "crates/board", app, "The binary crate.");
  const core = mod("board-core", "crates/board-core", app, "Shared rules and types.");
  const mainRs = mod("main.rs", "crates/board/src/main.rs", crate);
  const cliRs = mod("cli/mod.rs", "crates/board/src/cli/mod.rs", crate);
  const nodeRs = mod("node/mod.rs", "crates/board/src/node/mod.rs", crate);
  const hubRs = mod("hub/mod.rs", "crates/board/src/hub/mod.rs", crate);
  const routesRs = mod("hub/routes.rs", "crates/board/src/hub/routes.rs", crate);
  const storeRs = mod("hub/store.rs", "crates/board/src/hub/store.rs", crate);
  const guardsRs = mod("guards.rs", "crates/board-core/src/guards.rs", core);
  const envelopeRs = mod("envelope.rs", "crates/board-core/src/envelope.rs", core);
  const hook = mod("session-start.sh", "hooks/claude/session-start.sh", app);

  const fn = (name: string, file: ModelObject, technology: string, description: string) =>
    obj({ kind: "function", name, parentId: file.id, technology, description });
  const main = fn(
    "main()",
    mainRs,
    "entry point",
    "Parses the verb and starts the right part: post, hello, hub or node.",
  );
  const runPost = fn("run_post()", cliRs, "", "Sends a post to the local node.");
  const runHello = fn("run_hello()", cliRs, "", "Registers the agent with its node.");
  const forward = fn("forward()", nodeRs, "", "Passes a local request on to the hub.");
  const subscribe = fn(
    "subscribe_loop()",
    nodeRs,
    "task",
    "Holds the hub's event stream open and wakes agents.",
  );
  const serve = fn("serve()", hubRs, "", "Builds the router and listens.");
  const postMessage = fn(
    "post_message()",
    routesRs,
    "axum handler",
    "Takes a post: checks guards, stores it, fans it out.",
  );
  const events = fn("events()", routesRs, "axum handler", "Server-sent events to nodes.");
  const append = fn("append()", storeRs, "", "Appends the event and updates the derived tables.");
  const check = fn("check()", guardsRs, "", "Refuses loops between two agents.");
  const envelope = fn("Envelope::new()", envelopeRs, "", "Wraps a post with its address and id.");
  const sessionStart = fn(
    "session-start",
    hook,
    "shell hook",
    "Claude Code runs it when a session starts: board hello.",
  );

  const lib = (
    name: string,
    version: string,
    ecosystem: Package["ecosystem"],
    description: string,
  ) => obj({ kind: "library", name, description, package: { ecosystem, name, version } });
  const clap = lib("clap", "4.6.9", "cargo", "Command-line argument parsing.");
  const reqwest = lib("reqwest", "0.13.5", "cargo", "HTTP client.");
  const sse = lib("eventsource-stream", "0.2.3", "cargo", "Server-sent events from a byte stream.");
  const axum = lib("axum", "0.8.9", "cargo", "HTTP routing and request handling.");
  const tokio = lib("tokio", "1.54.1", "cargo", "Async runtime.");
  const rusqlite = lib("rusqlite", "0.43.0", "cargo", "SQLite bindings.");
  const serde = lib("serde", "1.0.229", "cargo", "Serialising and deserialising.");

  call(sessionStart, main, "exec");
  call(main, runPost);
  call(main, runHello);
  call(main, serve, "starts the hub");
  call(main, subscribe, "starts the node");
  call(runPost, forward, "local socket");
  call(runHello, forward, "local socket");
  call(forward, postMessage, "HTTP");
  call(subscribe, events, "SSE");
  call(serve, postMessage);
  call(serve, events);
  call(postMessage, check);
  call(postMessage, envelope);
  call(postMessage, append);
  call(append, db, "SQLite");
  for (const [f, l] of [
    [main, clap],
    [runPost, reqwest],
    [runHello, reqwest],
    [forward, reqwest],
    [subscribe, reqwest],
    [subscribe, sse],
    [serve, axum],
    [serve, tokio],
    [postMessage, axum],
    [events, axum],
    [envelope, serde],
    [append, rusqlite],
  ] as const) {
    // A library is a dependency reference on what uses it, not a line (the object's put op
    // holds this same object, so it goes in with it).
    (f as ModelObject).references = [...(f.references ?? []), { kind: "dependency", to: l.id }];
  }

  // Where each part runs: the same binary, three processes.
  const proc = (name: string, members: ModelObject[]) =>
    ops.push({
      op: "boundary.put",
      boundary: makeBoundary({
        name,
        kind: "process",
        rules: { include: [{ ids: members.map((m) => m.id) }], exclude: [] },
      }),
    });
  proc("board CLI", [mainRs, cliRs]);
  proc("Board node", [nodeRs]);
  proc("Board hub", [hubRs, routesRs, storeRs, core]);
  proc("Claude Code session", [hook]);

  const diagram = (
    name: string,
    scope: ModelObject | null,
    at: [ModelObject, number, number][],
    extra: Partial<Parameters<typeof makeDiagram>[0]> = {},
  ) => {
    const d = makeDiagram({ name, scopeId: scope?.id ?? null, ...extra });
    ops.push({ op: "diagram.put", diagram: d });
    for (const [o, x, y] of at)
      ops.push({
        op: "placement.put",
        placement: {
          diagramId: d.id,
          objectId: o.id,
          x,
          y,
          ...(o.kind === "function" ? { ...boxSize("function"), w: 168 } : boxSize(o.kind)),
        },
      });
    return d;
  };
  diagram("Landscape", null, [
    [harness, 0, 80],
    [board, 360, 80],
  ]);
  diagram("Agent board", board, [
    [harness, 0, 60],
    [app, 340, 60],
    [db, 680, 60],
  ]);
  const code = diagram(
    "board (code)",
    app,
    [
      [sessionStart, 0, 480],
      [main, 0, 60],
      [runPost, 0, 190],
      [runHello, 0, 240],
      [forward, 300, 190],
      [subscribe, 300, 240],
      [serve, 600, 60],
      [postMessage, 600, 190],
      [events, 600, 240],
      [check, 900, 60],
      [envelope, 900, 190],
      [append, 600, 360],
      [db, 900, 470],
      // The files: drawn as frames around their functions, so where they sit doesn't matter.
      ...[mainRs, cliRs, nodeRs, hubRs, routesRs, storeRs, guardsRs, envelopeRs, hook].map(
        (m): [ModelObject, number, number] => [m, 0, 0],
      ),
    ],
    { boundaries: true },
  );

  ops.push({
    op: "flow.put",
    flow: makeFlow({
      diagramId: code.id,
      name: "board post",
      kind: "path",
      steps: [
        [main, runPost],
        [runPost, forward],
        [forward, postMessage],
        [postMessage, check],
        [postMessage, append],
        [append, db],
      ].map(([a, b]) => makeStep({ fromId: a!.id, toId: b!.id })),
    }),
  });
  return ops;
}
