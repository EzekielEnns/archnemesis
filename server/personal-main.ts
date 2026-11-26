#!/usr/bin/env node
// The `archnemesis` command (the published package's bin; `archnm` is the same file): with no
// arguments, or `start`, Archnemesis in personal mode for the folder it is run in; with an
// `archnm` subcommand (check, fmt, ...), that command. See server/personal.ts.
import "./env-compat.ts";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { HELP, parseLaunch, personalSettings, startupText } from "./personal.ts";

const launch = parseLaunch(process.argv.slice(2));

if (launch.kind === "help") {
  console.log(HELP);
} else if (launch.kind === "version") {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  };
  console.log(pkg.version);
} else if (launch.kind === "error") {
  console.error(`archnemesis: ${launch.message}`);
  process.exit(2);
} else if (launch.kind === "cli") {
  // cli/archnm.ts reads process.argv itself.
  await import("../cli/archnm.ts");
} else {
  const p = personalSettings(launch, process.env, process.cwd(), homedir());
  Object.assign(process.env, p.env);
  await import("./main.ts");
  const mcpName = (process.env.ARCHNM_MCP_NAME ?? "archnm").replace(/[^a-zA-Z0-9_-]/g, "");
  console.log(startupText(p, mcpName || "archnm"));
}
