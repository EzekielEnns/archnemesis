// Create Archnemesis's GitHub App once, ahead of time, for a deployment that gets it from its
// environment (ARCHNM_GITHUB_*) instead of storing it in its database. The App's secrets go
// straight into Google Secret Manager; nothing secret is printed or written to disk.
//
//   node scripts/github-app.ts --name arch-archnm --url https://archnm.example.run.app \
//     --project my-project [--secrets archnm-github] [--org SomeOrg]
//
// It opens GitHub's filled-in "create app" page; you click Create. It then adds versions to
// <secrets>-client-secret and <secrets>-private-key (which must already exist) and prints
// what isn't secret: the App's id, slug and client id, for the deployment's settings.
import { spawnSync, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { loadConfig } from "../server/config.ts";
import { appManifest } from "../server/github.ts";

const { values: a } = parseArgs({
  options: {
    name: { type: "string" },
    url: { type: "string" },
    project: { type: "string" },
    secrets: { type: "string", default: "archnm-github" },
    org: { type: "string" },
  },
});
if (!a.name || !a.url || !a.project) {
  console.error(
    "usage: node scripts/github-app.ts --name NAME --url ARCHNM_URL --project GCP_PROJECT [--secrets PREFIX] [--org ORG]",
  );
  process.exit(2);
}
const base = a.url.replace(/\/+$/, "");
const secret = (s: string) => `${a.secrets}-${s}`;
for (const s of [secret("client-secret"), secret("private-key")]) {
  const r = spawnSync(
    "gcloud",
    ["secrets", "describe", s, "--project", a.project, "--format=value(name)"],
    { encoding: "utf8" },
  );
  if (r.status !== 0) {
    console.error(`Secret ${s} doesn't exist in ${a.project}: create it first (terraform).`);
    process.exit(1);
  }
}

const state = randomBytes(16).toString("hex");
const server = createServer(async (req, res) => {
  const u = new URL(req.url ?? "/", "http://127.0.0.1");
  const port = (server.address() as { port: number }).port;
  if (u.pathname === "/") {
    const manifest = appManifest({
      name: a.name!,
      baseUrl: base,
      redirect: `http://127.0.0.1:${port}/done`,
      public: loadConfig().github.appPublic,
    });
    const where = a.org
      ? `https://github.com/organizations/${encodeURIComponent(a.org)}/settings/apps/new`
      : "https://github.com/settings/apps/new";
    const esc = (t: string) =>
      t.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(
      `<form method="post" action="${where}?state=${state}"><input type="hidden" name="manifest" value="${esc(JSON.stringify(manifest))}"></form><script>document.forms[0].submit()</script>`,
    );
  }
  if (u.pathname !== "/done") return res.writeHead(404).end();
  if (u.searchParams.get("state") !== state) return res.writeHead(400).end("state doesn't match");
  const r = await fetch(
    `https://api.github.com/app-manifests/${encodeURIComponent(u.searchParams.get("code") ?? "")}/conversions`,
    { method: "POST", headers: { accept: "application/vnd.github+json" } },
  );
  if (!r.ok) {
    res.writeHead(502).end("GitHub didn't accept it; see the terminal.");
    console.error(`GitHub refused (${r.status}): ${(await r.text()).slice(0, 300)}`);
    process.exit(1);
  }
  const app = (await r.json()) as {
    id: number;
    slug: string;
    client_id: string;
    client_secret: string;
    pem: string;
    owner?: { login: string };
    html_url: string;
  };
  for (const [s, v] of [
    [secret("client-secret"), app.client_secret],
    [secret("private-key"), app.pem],
  ] as const)
    execFileSync(
      "gcloud",
      ["secrets", "versions", "add", s, "--project", a.project!, "--data-file=-"],
      { input: v, stdio: ["pipe", "ignore", "inherit"] },
    );
  res.writeHead(200, { "content-type": "text/html" });
  res.end(
    `<p>Created <a href="${app.html_url}">${app.slug}</a>. Its secrets are in Secret Manager; you can close this tab.</p>`,
  );
  console.log(`created ${app.html_url} (owner ${app.owner?.login})`);
  console.log(`  github_app_id        = ${app.id}`);
  console.log(`  github_app_slug      = "${app.slug}"`);
  console.log(`  github_app_client_id = "${app.client_id}"`);
  console.log(
    `  secrets: ${secret("client-secret")}, ${secret("private-key")} (new versions added)`,
  );
  server.close();
});
server.listen(0, "127.0.0.1", () =>
  console.log(
    `open http://127.0.0.1:${(server.address() as { port: number }).port}/ and click Create on GitHub`,
  ),
);
