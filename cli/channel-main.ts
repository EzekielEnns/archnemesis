// The channel on its own, bundled into one file (dist/archnm-channel.mjs) that Archnemesis serves
// at /archnm-channel.mjs, so anyone can run it with plain node, no checkout:
//   node archnm-channel.mjs --server <url> [--every 3]     (ARCHNM_TOKEN for a token)
import "../server/env-compat.ts";
import { loadClientConfig } from "../server/config.ts";
import { runChannel } from "./channel.ts";

const client = loadClientConfig();
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const server = flag("server") ?? client.server;
if (!server) {
  console.error("usage: node archnm-channel.mjs --server <archnm url> [--every seconds]");
  process.exit(2);
}
await runChannel({
  server,
  every: Math.max(1, Number(flag("every")) || 3),
  token: client.token,
});
