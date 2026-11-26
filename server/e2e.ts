// A scratch Archnemesis for end-to-end tests: its own free port (the OS picks it, so it never meets an
// Archnemesis someone is running), folder and database, and an MCP client connected to it.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export type Result = {
  content: { type: string; text?: string }[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};
export const text = (r: Result) =>
  r.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");

export interface Archnm {
  base: string;
  dir: string;
  client: Client;
  call: (name: string, args?: Record<string, unknown>) => Promise<Result>;
  stop: () => Promise<void>;
}

/** Start one; env adds to (or overrides) the scratch settings. */
export async function startArchnm(env: Record<string, string> = {}): Promise<Archnm> {
  const port = Number(process.env.ARCHNM_E2E_PORT) || (await freePort());
  const base = `http://127.0.0.1:${port}`;
  const dir = mkdtempSync(join(tmpdir(), "archnm-e2e-"));
  const server: ChildProcess = spawn(process.execPath, ["server/main.ts"], {
    env: {
      ...process.env,
      ARCHNM_PORT: String(port),
      ARCHNM_HOST: "127.0.0.1",
      ARCHNM_BACKUP_DIR: "off",
      ARCHNM_DB: join(dir, "archnm.sqlite"),
      ARCHNM_ROOT: join(dir, "designs"),
      ARCHNM_LIBSTATS: "off",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`archnm didn't start in 60 s:\n${log}`)), 60_000);
    const seen = (b: Buffer) => {
      log += b.toString();
      if (log.includes(`archnm on ${base}`)) {
        clearTimeout(t);
        resolve();
      }
    };
    server.stdout!.on("data", seen);
    server.stderr!.on("data", seen);
    server.on("exit", (code) => reject(new Error(`archnm exited (${code}):\n${log}`)));
  });
  const client = new Client({ name: "e2e", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { origin: base } },
    }),
  );
  return {
    base,
    dir,
    client,
    call: async (name, args = {}) => (await client.callTool({ name, arguments: args })) as Result,
    stop: async () => {
      await client.close().catch(() => {});
      if (server.exitCode === null) {
        server.kill("SIGTERM");
        await new Promise((r) => server.once("exit", r));
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}
