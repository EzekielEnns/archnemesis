#!/usr/bin/env node
// Archnemesis on the command line, for agents and CI: no server needed, just the folder.
//
//   archnm check [dir]          errors and warnings; exits 1 on any error
//   archnm fmt [dir]            rewrite every file in its one canonical form
//   archnm explain <view> [dir] each box on a view and the rule that put it there
//   archnm outline [dir]        the whole model as an indented outline
//   archnm init [dir]           start a folder from the example shop
//   archnm schema [dir]         write the JSON schemas (default ./schema)
//   archnm convert [dir]        one-off: rewrite a version 1 folder as version 2
//   archnm render [dir] [--view v] [--flow f] [--out d] [--svg]
//                              each view (or one) as a PNG (or SVG), for a pull request or a
//                              vision check: what the app would draw, from the files alone
//   archnm curate [dir]         what to fix to keep the code layer true: open flags, drift,
//                              things gone from the code, guessed calls, unplaced code
//   archnm index <repo> [--repo name] [--scip index.scip] [--all]
//                              a repo's code as Archnemesis's neutral index (JSON): files, functions,
//                              calls, libraries, from SCIP or Universal Ctags plus manifests
//   archnm import <repo> --under <object> [--repo name] [--scip f] [--all] [--dry-run] [dir]
//                              bring the design's code layer in line with the repo: adds what's
//                              new (tagged generated), refreshes sources, deprecates what's gone,
//                              never overwrites what a person wrote. Into the folder (run it on
//                              a branch), or with --server <url> --design <key> into a fork there
//
//   archnm write <file.yaml | -> | --apply <id> [--design <key>] [--scope id] [--as name] [--label l]
//               [--dry-run] [--onto id] [--tidy] [--server <url>]
//                              a big write from a file (or stdin), sent to the server's write
//                              tool as if passed to it: same checks, drafts, dry runs and fork
//
//   archnm channel --server <url> [--every 3]
//                              a Claude Code channel: pushes flags waiting on you (an @agent,
//                              an answer to a flag) into your running session; see cli/channel.ts
//   archnm config              every setting the server and the CLI read from the environment:
//                              what it is, its default, and which are set here (secrets hidden)
//   archnm telemetry [--since d] [--json] | session <id> | repro <call-id> | feedback [resolve <id>]
//                              the server's log of agents' tool calls and their feedback, kept on
//                              this machine only; see cli/telemetry.ts
//
// dir defaults to $ARCHNM_DIR, then ./architecture.
import "../server/env-compat.ts";
import { describeConfig, loadClientConfig } from "../server/config.ts";
import { viewProblems } from "../shared/score.ts";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import * as Y from "yjs";
import { applyOps, emptyState, mirror, type Actor, type ModelState } from "../shared/doc.ts";
import {
  check,
  DESIGN_FILE,
  normalizeDesignFile,
  readFiles,
  toOps,
  writeFiles,
  type Problem,
} from "../shared/files.ts";
import { buildIndex, type ModelIndex } from "../shared/project.ts";
import { adoptRules, describeSelector, resolve, viewOps } from "../shared/views.ts";
import { keyOps } from "../shared/files.ts";
import { seedOps } from "../shared/seed.ts";
import { hasDesignFolder, readFolder } from "../server/files.ts";
import { isGeneratedAgents } from "../shared/agentsmd.ts";
import { SCHEMAS } from "../shared/spec.ts";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { indexRepo } from "../server/importer.ts";
import {
  CALLS_CHOICES,
  importChanges,
  importSummary,
  type CallsChoice,
  type CodeIndex,
} from "../shared/codeindex.ts";
import { planChanges } from "../shared/agent.ts";
import { worklist, worklistText } from "../shared/curate.ts";
import { convert } from "./convert.ts";

const CLI: Actor = { id: "cli", name: "archnm cli", kind: "system" };
const [cmd, ...args] = process.argv.slice(2);
const client = loadClientConfig();
const dirArg = (i: number) => resolvePath(args[i] ?? client.dir);

const print = (p: Problem) =>
  console.log(`${p.level === "error" ? "error" : "warn "}  ${p.file}: ${p.message}`);

/** Read and check a folder; on errors print them and exit. */
function load(dir: string): {
  state: ModelState;
  idx: ModelIndex;
  problems: Problem[];
  files: Map<string, string>;
} {
  const files = readFolder(dir);
  if (!files.size) {
    console.error(`no Archnemesis files in ${dir}`);
    process.exit(2);
  }
  const { model, problems: read } = readFiles(files);
  const problems = [...read, ...check(model)];
  if (problems.some((p) => p.level === "error")) {
    problems.forEach(print);
    process.exit(1);
  }
  const doc = new Y.Doc();
  const state = emptyState();
  mirror(doc, state, () => {});
  applyOps(doc, state, toOps(state, model), CLI, "load", CLI, { pin: false });
  const index = () =>
    buildIndex({
      objects: state.objects.values(),
      connections: state.connections.values(),
      diagrams: state.diagrams.values(),
      placements: state.placements.values(),
      flows: state.flows.values(),
      boundaries: state.boundaries.values(),
      decisions: state.decisions.values(),
      entities: state.entities.values(),
    });
  // Views that follow rules get the boxes their rules add, as the server would.
  const follow = [...state.diagrams.values()]
    .filter((d) => d.rules)
    .flatMap((d) => viewOps(index(), d.id));
  if (follow.length) applyOps(doc, state, follow, CLI, "rules", CLI, { pin: false });
  return { state, idx: index(), problems, files };
}

/** --name value, or a bare --flag (true), from args; the rest positional. */
function parseArgs(bare: string[] = []): { flags: Record<string, string | true>; rest: string[] } {
  const flags: Record<string, string | true> = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("--")) rest.push(a);
    else if (bare.includes(a.slice(2))) flags[a.slice(2)] = true;
    else flags[a.slice(2)] = args[++i] ?? "";
  }
  return { flags, rest };
}

function indexFor(flags: Record<string, string | true>, repoDir: string): CodeIndex {
  const { index, adapter } = indexRepo(repoDir, {
    repo: typeof flags.repo === "string" ? flags.repo : undefined,
    scip: typeof flags.scip === "string" ? resolvePath(flags.scip) : undefined,
    all: flags.all === true,
    log: (l) => console.error(l),
  });
  console.error(
    `${adapter}: ${index.files.length} files, ${index.functions.length} functions, ${index.calls.length} calls, ${index.packages.length} libraries${index.sha ? ` at ${index.sha}` : ""}`,
  );
  return index;
}

/** One call of an MCP tool on the server: initialize, then tools/call (the server is stateless). */
async function callTool(
  server: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const base = server.replace(/\/$/, "");
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    origin: base,
    ...(client.token ? { authorization: `Bearer ${client.token}` } : {}),
  };
  const post = async (body: unknown) => {
    const r = await fetch(`${base}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
    if (!r.ok)
      throw new Error(
        r.status === 401
          ? "not signed in: set ARCHNM_TOKEN to a token from the app (Settings → Tokens)"
          : `the server answered ${r.status}`,
      );
    return r;
  };
  const init = await post({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "archnm-cli", version: "1" },
    },
  });
  const sid = init.headers.get("mcp-session-id");
  if (sid) headers["mcp-session-id"] = sid;
  const r = await post({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const j = (await r.json()) as {
    result?: { content?: { type: string; text?: string }[]; isError?: boolean };
    error?: { message: string };
  };
  if (j.error) return { text: j.error.message, isError: true };
  return {
    text: (j.result?.content ?? []).map((c) => c.text ?? "").join("\n"),
    isError: j.result?.isError === true,
  };
}

switch (cmd) {
  case "write": {
    const { flags, rest } = parseArgs(["dry-run", "tidy"]);
    const server = typeof flags.server === "string" ? flags.server : client.server;
    if ((!rest[0] && !flags.apply) || !server) {
      console.error(
        "usage: archnm write <file.yaml | -> | --apply <dry-id> [--design <key>] [--scope id] [--as name] [--label l] [--dry-run] [--onto id] [--tidy] [--server <url> | ARCHNM_SERVER]",
      );
      process.exit(2);
    }
    const str = (k: string) => (typeof flags[k] === "string" ? (flags[k] as string) : undefined);
    const call: Record<string, unknown> = rest[0]
      ? { yaml: readFileSync(rest[0] === "-" ? 0 : resolvePath(rest[0]), "utf8") }
      : {};
    for (const [flag, arg] of [
      ["design", "design"],
      ["scope", "scope"],
      ["as", "as"],
      ["label", "label"],
      ["onto", "onto"],
      ["apply", "apply"],
    ] as const)
      if (str(flag)) call[arg] = str(flag);
    if (flags["dry-run"] === true) call.dry_run = true;
    if (flags.tidy === true) call.tidy = true;
    try {
      const r = await callTool(server, "write", call);
      // Undo goes by session, and this one ended with the call.
      const text = r.text.replace(
        "(undo with write {undo: true})",
        "(sent from the CLI, so write {undo: true} won't reach it: take it back with remove)",
      );
      (r.isError ? console.error : console.log)(text);
      if (r.isError) process.exit(1);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
    break;
  }
  case "config": {
    console.log(describeConfig());
    break;
  }
  case "telemetry": {
    const { telemetryCli } = await import("./telemetry.ts");
    process.exitCode = telemetryCli(args);
    break;
  }
  case "channel": {
    const { flags } = parseArgs();
    const server = typeof flags.server === "string" ? flags.server : client.server;
    if (!server) {
      console.error("usage: archnm channel --server <url> [--every seconds]");
      process.exit(2);
    }
    const { runChannel } = await import("./channel.ts");
    await runChannel({
      server,
      every: Math.max(1, Number(flags.every) || 3),
      token: client.token,
    });
    break;
  }
  case "curate": {
    const { idx } = load(dirArg(0));
    console.log(worklistText(worklist(idx), dirArg(0)));
    break;
  }
  case "index": {
    const { flags, rest } = parseArgs(["all"]);
    if (!rest[0]) {
      console.error("usage: archnm index <repo> [--repo name] [--scip index.scip] [--all]");
      process.exit(2);
    }
    console.log(JSON.stringify(indexFor(flags, resolvePath(rest[0])), null, 1));
    break;
  }
  case "import": {
    const { flags, rest } = parseArgs(["all", "dry-run"]);
    const under = typeof flags.under === "string" ? flags.under : "";
    if (!rest[0] || !under) {
      console.error(
        "usage: archnm import <repo> --under <object> [--repo name] [--scip f] [--calls exact|all|none] [--all] [--dry-run] [dir | --server <url> --design <key>]",
      );
      process.exit(2);
    }
    const index = indexFor(flags, resolvePath(rest[0]));
    const calls = flags.calls === undefined ? undefined : (flags.calls as CallsChoice);
    if (calls !== undefined && !CALLS_CHOICES.includes(calls)) {
      console.error(`--calls is exact, all or none`);
      process.exit(2);
    }
    if (typeof flags.server === "string") {
      const design = typeof flags.design === "string" ? flags.design : "";
      const r = await fetch(
        `${flags.server.replace(/\/$/, "")}/api/d/${encodeURIComponent(design)}/import`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: flags.server.replace(/\/$/, ""),
            ...(client.token ? { authorization: `Bearer ${client.token}` } : {}),
          },
          body: JSON.stringify({ index, under, calls, dryRun: flags["dry-run"] === true }),
        },
      );
      const j = (await r.json()) as {
        error?: string;
        summary?: string;
        doc?: string;
        url?: string;
      };
      if (!r.ok) {
        console.error(j.error ?? `the server answered ${r.status}`);
        process.exit(1);
      }
      console.log(j.summary);
      if (j.url) console.log(j.url);
      break;
    }
    const dir = resolvePath(rest[1] ?? client.dir);
    const { state, idx, files } = load(dir);
    const plan = importChanges(idx, index, { under, calls });
    console.log(importSummary(plan, { under, calls }));
    if (flags["dry-run"] === true || !plan.changes.length) break;
    const config = readFiles(files).model.config;
    const { ops } = planChanges(state, idx, plan.changes, { tags: config.tags });
    const doc = new Y.Doc();
    const st = emptyState();
    mirror(doc, st, () => {});
    applyOps(doc, st, toOps(st, readFiles(files).model), CLI, "load", CLI, { pin: false });
    applyOps(doc, st, ops, CLI, "import");
    const out = writeFiles(st, config);
    let n = 0;
    for (const [path, text] of out) {
      if (files.get(path) === text || (path === "AGENTS.md" && !isGeneratedAgents(files.get(path))))
        continue;
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
      n++;
    }
    for (const path of files.keys()) {
      if (out.has(path) || path === "AGENTS.md") continue;
      rmSync(join(dir, path));
      n++;
    }
    console.log(`${n} file(s) written in ${dir}`);
    break;
  }
  case "render": {
    const flag = (name: string) => {
      const i = args.indexOf(`--${name}`);
      return i >= 0 ? args[i + 1] : undefined;
    };
    const positional: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--svg") continue;
      if (args[i]!.startsWith("--")) i++;
      else positional.push(args[i]!);
    }
    const dir = resolvePath(positional[0] ?? client.dir);
    const outDir = resolvePath(flag("out") ?? "render");
    const svgOnly = args.includes("--svg");
    const { idx, files } = load(dir);
    const config = readFiles(files).model.config;
    const { renderSvg, routePaths, toPng } = await import("../server/render.ts");
    const want = flag("view");
    const views = [...idx.diagrams.values()].filter(
      (d) =>
        !want || d.key === want || d.id === want || d.name.toLowerCase() === want.toLowerCase(),
    );
    if (!views.length) {
      console.error(`no view "${want}"`);
      process.exit(1);
    }
    mkdirSync(outDir, { recursive: true });
    for (const d of views) {
      const fname = flag("flow");
      const flow = fname
        ? ([...idx.flows.values()].find(
            (f) => f.diagramId === d.id && f.name.toLowerCase() === fname.toLowerCase(),
          ) ?? null)
        : null;
      const svg = renderSvg(idx, d.id, config, {
        title: config.name,
        flow,
        paths: await routePaths(idx, d.id),
      });
      const base = join(outDir, `${d.key ?? d.id}${flow ? `--${flow.id}` : ""}`);
      if (svgOnly) writeFileSync(`${base}.svg`, svg);
      else writeFileSync(`${base}.png`, await toPng(svg));
      console.log(`${base}.${svgOnly ? "svg" : "png"}`);
    }
    process.exit(0);
  }
  case "check": {
    const dir = dirArg(0);
    const files = readFolder(dir);
    const { model, problems: read } = readFiles(files);
    const problems = [...read, ...check(model)];
    // How readable the diagrams are, once the files are sound (needs them loaded and placed).
    if (!problems.some((p) => p.level === "error"))
      problems.push(...viewProblems(load(dir).idx, model.config.limits));
    problems.forEach(print);
    const errors = problems.filter((p) => p.level === "error").length;
    console.log(
      errors
        ? `${errors} error(s), ${problems.length - errors} warning(s)`
        : `ok: ${model.objects.length} objects, ${model.connections.length} connections, ${model.views.length} views${problems.length ? `, ${problems.length} warning(s)` : ""}`,
    );
    process.exit(errors ? 1 : 0);
  }
  case "fmt": {
    const dir = dirArg(0);
    const { state, files } = load(dir);
    const out = writeFiles(state, readFiles(files).model.config);
    let n = 0;
    for (const [path, text] of out) {
      if (files.get(path) === text) continue;
      if (path === "AGENTS.md" && !isGeneratedAgents(files.get(path))) continue;
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
      console.log(`wrote ${path}`);
      n++;
    }
    for (const path of files.keys()) {
      if (out.has(path) || path === "AGENTS.md") continue;
      rmSync(join(dir, path));
      console.log(`removed ${path}`);
      n++;
    }
    console.log(n ? `${n} file(s) changed` : "already formatted");
    break;
  }
  case "explain": {
    const view = args[0];
    if (!view) {
      console.error("usage: archnm explain <view> [dir]");
      process.exit(2);
    }
    const { idx } = load(dirArg(1));
    const d = [...idx.diagrams.values()].find(
      (x) => x.key === view || x.name.toLowerCase() === view.toLowerCase(),
    );
    if (!d) {
      console.error(
        `no view "${view}"; views: ${[...idx.diagrams.values()].map((x) => x.key).join(", ")}`,
      );
      process.exit(2);
    }
    const name = (id: string) => idx.objects.get(id)?.name ?? id;
    const key = (id: string) => idx.objects.get(id)?.key ?? id;
    console.log(
      `${d.name}${d.scopeId ? ` (inside ${name(d.scopeId)})` : ""}: ${d.rules ? "follows the model" : "hand-picked"}`,
    );
    if (!d.rules) {
      for (const id of idx.placements.get(d.id)?.keys() ?? [])
        console.log(`  ${key(id).padEnd(24)} listed in boxes`);
      break;
    }
    const r = resolve(idx, d);
    for (const [id, why] of [...r.why].sort(([a], [b]) => (key(a) < key(b) ? -1 : 1))) {
      console.log(
        `  ${key(id).padEnd(24)} ${why.map((s) => describeSelector(s, name)).join("; ")}`,
      );
    }
    for (const [id, s] of r.excluded)
      console.log(`  ${`-${key(id)}`.padEnd(24)} left off: ${describeSelector(s, name)}`);
    for (const s of r.empty) console.log(`  warning: ${JSON.stringify(s)} matches nothing`);
    break;
  }
  case "outline": {
    const { idx } = load(dirArg(0));
    const out = (id: string | null, depth: number) => {
      const list = id
        ? (idx.children.get(id) ?? [])
        : [...idx.objects.values()].filter((o) => !o.parentId);
      for (const o of list.sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const conns = [...idx.connections.values()].filter((c) => c.fromId === o.id);
        const arrows = conns
          .map((c) => `→ ${idx.objects.get(c.toId)?.name}${c.name ? ` "${c.name}"` : ""}`)
          .join(", ");
        const meta = [
          o.kind,
          o.technology,
          o.status !== "live" ? o.status : "",
          o.external ? "external" : "",
        ]
          .filter(Boolean)
          .join(" · ");
        console.log(
          `${"  ".repeat(depth)}${o.name} [${o.key ?? o.id}] (${meta})${arrows ? `  ${arrows}` : ""}`,
        );
        out(o.id, depth + 1);
      }
    };
    out(null, 0);
    break;
  }
  case "convert": {
    const dir = dirArg(0);
    const raw = readFolder(dir);
    const files = normalizeDesignFile(raw);
    const version = String(
      (parseYaml(files.get(DESIGN_FILE) ?? "") as { version?: unknown } | null)?.version ?? "1",
    );
    if (version !== "1") {
      console.error(`${dir} is version ${version} already`);
      process.exit(2);
    }
    const { files: out, problems } = convert(files);
    problems.forEach(print);
    if (problems.some((p) => p.level === "error")) process.exit(1);
    for (const [path, text] of out) {
      if (files.get(path) === text) continue;
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
      console.log(`wrote ${path}`);
    }
    for (const path of raw.keys()) {
      if (out.has(path)) continue;
      rmSync(join(dir, path));
      console.log(`removed ${path}`);
    }
    console.log("converted to version 2; check the diff, then commit it");
    break;
  }
  case "schema": {
    // The JSON schemas, from the one definition of the format (shared/spec.ts).
    const dir = resolvePath(args[0] ?? "schema");
    mkdirSync(dir, { recursive: true });
    for (const [name, s] of Object.entries(SCHEMAS))
      writeFileSync(join(dir, name), `${JSON.stringify(s, null, 2)}\n`);
    console.log(`wrote ${Object.keys(SCHEMAS).length} schemas to ${dir}`);
    break;
  }
  case "init": {
    const dir = dirArg(0);
    if (hasDesignFolder(dir)) {
      console.error(`${dir} already has an archnm.yaml`);
      process.exit(2);
    }
    const doc = new Y.Doc();
    const state = emptyState();
    mirror(doc, state, () => {});
    applyOps(doc, state, seedOps(), CLI, "example");
    const idx = () =>
      buildIndex({
        objects: state.objects.values(),
        connections: state.connections.values(),
        diagrams: state.diagrams.values(),
        placements: state.placements.values(),
        flows: state.flows.values(),
        boundaries: state.boundaries.values(),
        decisions: state.decisions.values(),
        entities: state.entities.values(),
      });
    // The insides follow the model; the landscape stays hand-picked.
    const follow = [...state.diagrams.values()]
      .filter((d) => d.scopeId)
      .map((d) => ({ op: "diagram.put" as const, diagram: adoptRules(idx(), d) }));
    applyOps(doc, state, follow, CLI, "rules", CLI, { pin: false });
    applyOps(doc, state, keyOps(state), CLI, "keys");
    for (const [path, text] of writeFiles(state, { name: "Example shop" })) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    console.log(
      `wrote the example shop to ${dir}; try: archnm explain shop ${args[0] ?? ""}`.trim(),
    );
    break;
  }
  default:
    console.log(
      `archnm check|fmt|explain <view>|outline|init [dir]   (dir: $ARCHNM_DIR or ./architecture)\narchnm config   every environment variable the server and this command read`,
    );
    process.exit(cmd ? 2 : 0);
}
