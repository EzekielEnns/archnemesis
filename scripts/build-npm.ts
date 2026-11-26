// Make the publishable package in dist-npm/: `pnpm build:npm` (it runs `pnpm build` first).
//
// The repo runs TypeScript directly with Node's type stripping, which Node refuses under
// node_modules, so the package carries compiled JavaScript: tsc (tsconfig.npm.json) writes
// server/, shared/ and cli/ into dist-npm/ with the same layout as the checkout, which is what
// the server expects (it finds dist/, schema/ and examples/auth/ one folder above server/). The
// built app (dist/) is copied beside them. Dependencies are not bundled: they are declared in
// the package's package.json, taken from the ones the compiled code imports, at the versions
// this repo pins, so `npx` installs them.
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const out = join(root, "dist-npm");
const run = (cmd: string, args: string[]) =>
  execFileSync(cmd, args, { cwd: root, stdio: "inherit" });

/** Read at run time by path, not imported, so scanning the code does not find them. */
const BY_PATH = ["@resvg/resvg-wasm", "@expo-google-fonts/inter"];

function jsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? jsFiles(join(dir, e.name))
      : e.name.endsWith(".js")
        ? [join(dir, e.name)]
        : [],
  );
}

/** The packages the compiled code imports (by name, not path). */
function imported(): Set<string> {
  const found = new Set<string>();
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"'.][^"']*)["']/g;
  for (const dir of ["server", "shared", "cli"])
    for (const file of jsFiles(join(out, dir)))
      for (const m of readFileSync(file, "utf8").matchAll(re)) {
        const spec = m[1]!.replace(/^node:/, "");
        if (builtinModules.includes(spec.split("/")[0]!) || m[1]!.startsWith("node:")) continue;
        const parts = spec.split("/");
        found.add(spec.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]!);
      }
  return found;
}

const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  version: string;
  license: string;
  homepage: string;
  bugs: string;
  keywords: string[];
  description: string;
  dependencies: Record<string, string>;
  engines: Record<string, string>;
};

rmSync(out, { recursive: true, force: true });
run("pnpm", ["exec", "tsc", "-p", "tsconfig.npm.json"]);
if (!existsSync(join(root, "dist", "index.html"))) throw new Error("dist/ is missing: pnpm build");

const dependencies: Record<string, string> = {};
// The dev-only imports (vite, when the server runs from source) are not dependencies of the package.
for (const name of [...imported(), ...BY_PATH].sort()) {
  const version = rootPkg.dependencies[name];
  if (version) dependencies[name] = version;
}

cpSync(join(root, "dist"), join(out, "dist"), { recursive: true });
cpSync(join(root, "schema"), join(out, "schema"), { recursive: true });
cpSync(join(root, "examples", "auth"), join(out, "examples", "auth"), { recursive: true });
cpSync(join(root, "LICENSE"), join(out, "LICENSE"));

const bin = "server/personal-main.js";
writeFileSync(
  join(out, "package.json"),
  JSON.stringify(
    {
      name: "archnemesis",
      version: rootPkg.version,
      description: rootPkg.description,
      keywords: rootPkg.keywords,
      license: rootPkg.license,
      repository: { type: "git", url: "git+https://github.com/EzekielEnns/archnemesis.git" },
      homepage: rootPkg.homepage,
      bugs: rootPkg.bugs,
      type: "module",
      bin: { archnemesis: bin, archnm: bin },
      files: ["server", "shared", "cli", "dist", "schema", "examples", "README.md", "LICENSE"],
      engines: rootPkg.engines,
      dependencies,
    },
    null,
    2,
  ) + "\n",
);
writeFileSync(
  join(out, "README.md"),
  `# Archnemesis

An architecture diagram tool for people and AI agents: one model of your system, many views,
saved as YAML in your repo, edited live on a canvas or by an agent over MCP.

\`\`\`sh
cd your-project
npx archnemesis
\`\`\`

Needs Node 24 or newer. It opens on http://127.0.0.1:5190 (this machine only, no sign-in),
saves each design as YAML under \`./architecture\` (commit it with your code), and prints the one
command that connects an agent. History and forks are kept in a per-user folder, not in your
project. Flags: \`--port\`, \`--dir\`, \`--data\`, \`--help\`. The \`archnm\` commands work too:
\`npx archnemesis check\`, \`fmt\`, \`outline\`, \`init\`.

Full documentation: ${rootPkg.homepage} and https://github.com/EzekielEnns/archnemesis
`,
);

const size = (p: string): number =>
  statSync(p).isDirectory()
    ? readdirSync(p).reduce((n, f) => n + size(join(p, f)), 0)
    : statSync(p).size;
mkdirSync(out, { recursive: true });
console.log(
  `dist-npm/: ${(size(out) / 1e6).toFixed(1)} MB, ${Object.keys(dependencies).length} dependencies`,
);
