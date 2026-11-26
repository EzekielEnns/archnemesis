// `npx archnemesis`: the arguments and the settings for personal mode, as pure functions (the
// entry, server/personal-main.ts, reads the process and calls these). Personal mode is one
// person on their own machine: loopback only, no sign-in, designs saved as YAML in the folder
// the command was run in, the database and the git data kept in a per-user folder.
import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";

/** What the launcher does with its command line. */
export type Launch =
  | { kind: "start"; port: number | undefined; dir: string | undefined; data: string | undefined }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "cli" }
  | { kind: "error"; message: string };

/** The subcommands of the `archnm` command, which this one also is. */
const CLI_COMMANDS = new Set([
  "check",
  "fmt",
  "explain",
  "outline",
  "init",
  "schema",
  "convert",
  "render",
  "curate",
  "index",
  "import",
  "write",
  "channel",
  "config",
  "telemetry",
]);

export const HELP = `archnemesis: an architecture diagram tool for people and AI agents (Node 24+)

  archnemesis [start] [--port 5190] [--dir ./architecture] [--data <folder>]
      Start Archnemesis for this folder: open on this machine only (127.0.0.1), no sign-in.
      Designs are saved as YAML under --dir (default ./architecture), so you commit them with
      your repo. The database and the git data for forks go in --data (default: a folder of
      your own, outside the project; see the line printed at start).
  archnemesis check|fmt|explain|outline|init|... [dir]
      The archnm command (run \`archnemesis config\` for every setting it reads).

Settings people already set (ARCHNM_PORT, ARCHNM_ROOT, ARCHNM_DB, ARCHNM_AUTH, ...) still apply;
a flag beats the matching one.`;

const MISSING = (flag: string) => `${flag} needs a value`;

/** Read the arguments after the program name. */
export function parseLaunch(argv: readonly string[]): Launch {
  const [first] = argv;
  if (first !== undefined && CLI_COMMANDS.has(first)) return { kind: "cli" };
  const rest = first === "start" ? argv.slice(1) : argv;
  let port: number | undefined;
  let dir: string | undefined;
  let data: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const [name, inline] = (rest[i] ?? "").split(/=(.*)/s, 2) as [string, string | undefined];
    const value = () => inline ?? rest[++i];
    if (name === "--help" || name === "-h") return { kind: "help" };
    if (name === "--version" || name === "-v") return { kind: "version" };
    if (name === "--port" || name === "-p") {
      const v = value();
      if (v === undefined) return { kind: "error", message: MISSING(name) };
      const n = Number(v);
      if (!/^\d+$/.test(v) || n < 1 || n > 65535)
        return { kind: "error", message: `--port must be a number from 1 to 65535, not "${v}"` };
      port = n;
    } else if (name === "--dir" || name === "-d") {
      dir = value();
      if (!dir) return { kind: "error", message: MISSING(name) };
    } else if (name === "--data") {
      data = value();
      if (!data) return { kind: "error", message: MISSING(name) };
    } else {
      return {
        kind: "error",
        message: `unknown ${name.startsWith("-") ? "option" : "command"} "${rest[i]}" (archnemesis --help lists them)`,
      };
    }
  }
  return { kind: "start", port, dir, data };
}

/**
 * A per-user folder for this project's database, backups and git data, outside the project (so
 * nothing needs to go in .gitignore): <data home>/archnemesis/<folder name>-<hash of its path>.
 * The hash keeps two folders called "app" apart.
 */
export function dataFolder(cwd: string, env: Record<string, string | undefined>, home: string) {
  const base =
    env.ARCHNM_HOME ||
    join(env.XDG_DATA_HOME || (env.LOCALAPPDATA ?? join(home, ".local", "share")), "archnemesis");
  const id = createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 8);
  const name = basename(resolve(cwd)).replace(/[^a-zA-Z0-9._-]/g, "-") || "project";
  return join(base, `${name}-${id}`);
}

export interface Personal {
  /** The settings to put in the environment: only the ones the person has not set. */
  env: Record<string, string>;
  /** Where each thing ends up, for the start-up text. */
  port: number;
  designs: string;
  data: string;
  url: string;
}

/**
 * The settings for personal mode. A flag beats the variable that is already set, and a variable
 * beats the default. ARCHNM_AUTH is local unless set (loopback is the default listen address, so
 * no sign-in is safe); NODE_ENV is production, so the built app is served, not Vite.
 */
export function personalSettings(
  launch: Extract<Launch, { kind: "start" }>,
  env: Record<string, string | undefined>,
  cwd: string,
  home: string,
): Personal {
  const designs = resolve(cwd, launch.dir ?? env.ARCHNM_ROOT ?? "architecture");
  const db = launch.data
    ? join(resolve(cwd, launch.data), "archnm.sqlite")
    : (env.ARCHNM_DB ?? join(dataFolder(cwd, env, home), "archnm.sqlite"));
  const port = launch.port ?? (env.ARCHNM_PORT ? Number(env.ARCHNM_PORT) : 5190);
  const out: Record<string, string> = {
    ARCHNM_ROOT: designs,
    ARCHNM_DB: db,
    ARCHNM_PORT: String(port),
    NODE_ENV: "production",
  };
  if (!env.ARCHNM_AUTH && !env.ARCHNM_PERSONAL) out.ARCHNM_AUTH = "local";
  const url = env.ARCHNM_PUBLIC_URL ?? `http://127.0.0.1:${port}`;
  return { env: out, port, designs, data: db === ":memory:" ? db : resolve(db, ".."), url };
}

/** What to tell the person once it is running. */
export function startupText(p: Personal, mcpName: string): string {
  return [
    "",
    `  Open ${p.url}`,
    "",
    `  Connect an agent (Claude Code):`,
    `    claude mcp add -s user --transport http ${mcpName} ${p.url}/mcp`,
    "",
    `  Designs are saved as YAML in ${p.designs} (commit them with your repo).`,
    `  History and forks are kept in ${p.data}, outside the project.`,
    "  Ctrl-C stops it.",
    "",
  ].join("\n");
}
