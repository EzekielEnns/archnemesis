// Libraries from manifests and lockfiles, one small reader per format: Cargo (with
// Cargo.lock for resolved versions), package.json, pyproject.toml / requirements.txt,
// go.mod, Gemfile, Maven pom.xml, .NET csproj. Each turns a file into {ecosystem, name, version}.
// Path and workspace-local dependencies are the repo's own code, not libraries, and are left out.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Package } from "../shared/model.ts";

type Found = Package & { manifest: string };

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "target",
  "vendor",
  "dist",
  "build",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  "out",
]);
/** A version range down to the version it names ("^1.2.3" → "1.2.3"); none for "*" or a git ref. */
const plain = (v: string | undefined) => {
  const m = v?.trim().match(/\d+(?:\.\d+){0,3}(?:[-+][\w.]+)?/);
  return m ? m[0] : undefined;
};
const pkg = (
  ecosystem: Package["ecosystem"],
  name: string,
  version: string | undefined,
  manifest: string,
): Found => ({ ecosystem, name, ...(version ? { version } : {}), manifest });

/** Cargo.lock: name → the version resolved (the first, when two versions are in the tree). */
export function readCargoLock(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const block of text.split(/^\[\[package\]\]$/m).slice(1)) {
    const name = /^name = "([^"]+)"/m.exec(block)?.[1];
    const version = /^version = "([^"]+)"/m.exec(block)?.[1];
    const local = !/^source = /m.test(block);
    if (name && version && !local && !out.has(name)) out.set(name, version);
  }
  return out;
}

export function readCargoToml(
  text: string,
  manifest: string,
  lock: Map<string, string> = new Map(),
): Found[] {
  const out: Found[] = [];
  let section = "";
  let table: { name: string; version?: string; local: boolean } | null = null;
  const flush = () => {
    if (table && !table.local)
      out.push(pkg("cargo", table.name, lock.get(table.name) ?? plain(table.version), manifest));
    table = null;
  };
  const deps = (s: string) =>
    /^(workspace\.)?(dev-|build-)?dependencies$/.test(s) ||
    /^target\..+\.(dev-|build-)?dependencies$/.test(s);
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    const head = /^\[([^\]]+)\]$/.exec(line);
    if (head) {
      flush();
      section = head[1]!.trim();
      const one = /^(?:(?:workspace|target\..+)\.)?(?:dev-|build-)?dependencies\.([\w-]+)$/.exec(
        section,
      );
      if (one) table = { name: one[1]!, local: false };
      continue;
    }
    if (table) {
      const v = /^version\s*=\s*"([^"]+)"/.exec(line);
      if (v) table.version = v[1];
      if (/^path\s*=/.test(line)) table.local = true;
      continue;
    }
    if (!deps(section)) continue;
    const m = /^([\w-]+)(\.workspace)?\s*=\s*(.+)$/.exec(line);
    if (!m) continue;
    const [, name, ws, rest] = m as unknown as [string, string, string | undefined, string];
    if (/\bpath\s*=/.test(rest)) continue;
    const version = rest.startsWith('"')
      ? /^"([^"]+)"/.exec(rest)?.[1]
      : /\bversion\s*=\s*"([^"]+)"/.exec(rest)?.[1];
    // name.workspace = true, or { workspace = true }: the version is in the workspace's lock.
    if (ws || /\bworkspace\s*=\s*true/.test(rest))
      out.push(pkg("cargo", name, lock.get(name), manifest));
    else out.push(pkg("cargo", name, lock.get(name) ?? plain(version), manifest));
  }
  flush();
  return out;
}

export function readPackageJson(text: string, manifest: string): Found[] {
  let j: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    workspaces?: unknown;
  };
  try {
    j = JSON.parse(text);
  } catch {
    return [];
  }
  return Object.entries({ ...j.devDependencies, ...j.dependencies })
    .filter(([, v]) => !/^(workspace:|file:|link:|portal:)/.test(v))
    .map(([name, v]) => pkg("npm", name, plain(v), manifest));
}

const PY_NAME =
  /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*(?:(==|>=|~=|<=|>|<|!=)\s*([^;,\s]+))?/;
export function readRequirements(text: string, manifest: string): Found[] {
  const out: Found[] = [];
  for (const line of text.split("\n")) {
    const l = line.replace(/#.*$/, "").trim();
    if (!l || l.startsWith("-") || l.includes("://")) continue;
    const m = PY_NAME.exec(l);
    if (m)
      out.push(
        pkg(
          "pypi",
          m[1]!.toLowerCase(),
          m[2] === "==" || m[2] === "~=" || m[2] === ">=" ? plain(m[3]) : undefined,
          manifest,
        ),
      );
  }
  return out;
}

export function readPyproject(text: string, manifest: string): Found[] {
  const out: Found[] = [];
  // PEP 621: dependencies = ["x>=1", ...], also optional-dependencies and dependency groups.
  for (const block of text.matchAll(/^\s*(?:dependencies|[\w-]+)\s*=\s*\[([\s\S]*?)\]/gm)) {
    for (const s of block[1]!.matchAll(/"([^"]+)"|'([^']+)'/g)) {
      const spec = s[1] ?? s[2]!;
      if (/^[A-Za-z0-9]/.test(spec) && !spec.includes("://"))
        out.push(...readRequirements(spec, manifest));
    }
  }
  // Poetry: [tool.poetry.dependencies] name = "^1.2"
  const poetry = /^\[tool\.poetry\.(?:group\.\w+\.)?dependencies\]$([\s\S]*?)(?=^\[|$(?![\s\S]))/gm;
  for (const sec of text.matchAll(poetry))
    for (const m of sec[1]!.matchAll(
      /^([\w.-]+)\s*=\s*(?:"([^"]+)"|\{[^}]*version\s*=\s*"([^"]+)")/gm,
    ))
      if (m[1] !== "python")
        out.push(pkg("pypi", m[1]!.toLowerCase(), plain(m[2] ?? m[3]), manifest));
  const seen = new Set<string>();
  return out.filter((p) => !seen.has(p.name) && seen.add(p.name));
}

export function readGoMod(text: string, manifest: string): Found[] {
  const out: Found[] = [];
  const add = (l: string) => {
    const m = /^\s*([\w.\-/~]+)\s+(v[\w.\-+]+)/.exec(l);
    if (m) out.push(pkg("go", m[1]!, m[2]!.replace(/^v/, ""), manifest));
  };
  // Only what the module requires itself: "// indirect" ones come in through those.
  for (const b of text.matchAll(/^require\s*\(([\s\S]*?)\)/gm))
    for (const l of b[1]!.split("\n"))
      if (!/\/\/\s*indirect\b/.test(l)) add(l.replace(/\/\/.*$/, ""));
  for (const m of text.matchAll(/^require\s+([^(\n].*)$/gm)) add(m[1]!);
  return out;
}

function readGemfile(text: string, manifest: string): Found[] {
  return [...text.matchAll(/^\s*gem\s+["']([^"']+)["'](?:\s*,\s*["']([^"']+)["'])?/gm)].map((m) =>
    pkg("rubygems", m[1]!, plain(m[2]), manifest),
  );
}

export function readPom(text: string, manifest: string): Found[] {
  const out: Found[] = [];
  for (const d of text.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const g = /<groupId>([^<]+)<\/groupId>/.exec(d[1]!)?.[1]?.trim();
    const a = /<artifactId>([^<]+)<\/artifactId>/.exec(d[1]!)?.[1]?.trim();
    const v = /<version>([^<]+)<\/version>/.exec(d[1]!)?.[1]?.trim();
    if (g && a)
      out.push(pkg("maven", `${g}:${a}`, v && !v.includes("${") ? v : undefined, manifest));
  }
  return out;
}

function readCsproj(text: string, manifest: string): Found[] {
  return [...text.matchAll(/<PackageReference\s+Include="([^"]+)"(?:\s+Version="([^"]+)")?/g)].map(
    (m) => pkg("nuget", m[1]!, plain(m[2]), manifest),
  );
}

/** Every manifest under root, read; a library declared twice is listed once (first version wins). */
export function readManifests(root: string, opts: { maxFiles?: number } = {}): Found[] {
  const max = opts.maxFiles ?? 20_000;
  const out: Found[] = [];
  const own = new Set<string>();
  let seen = 0;
  // Lockfiles per folder, read once.
  const cargoLock = (dir: string): Map<string, string> => {
    for (let d = dir; d.startsWith(root); d = join(d, "..")) {
      const p = join(d, "Cargo.lock");
      if (existsSync(p)) return readCargoLock(readFileSync(p, "utf8"));
      if (d === root) break;
    }
    return new Map();
  };
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (++seen > max) return;
      const p = join(dir, n);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(n) && !n.startsWith(".")) walk(p);
        continue;
      }
      if (st.size > 2_000_000) continue;
      const rel = relative(root, p);
      const read = () => readFileSync(p, "utf8");
      if (n === "Cargo.toml") {
        const t = read();
        const name = /^\[package\][^[]*?^name\s*=\s*"([^"]+)"/m.exec(t)?.[1];
        if (name) own.add(`cargo/${name}`);
        out.push(...readCargoToml(t, rel, cargoLock(dir)));
      } else if (n === "package.json") {
        const t = read();
        try {
          const name = (JSON.parse(t) as { name?: string }).name;
          if (name) own.add(`npm/${name}`);
        } catch {
          // read as no dependencies below
        }
        out.push(...readPackageJson(t, rel));
      } else if (n === "pyproject.toml") out.push(...readPyproject(read(), rel));
      else if (/^requirements.*\.txt$/.test(n)) out.push(...readRequirements(read(), rel));
      else if (n === "go.mod") out.push(...readGoMod(read(), rel));
      else if (n === "Gemfile") out.push(...readGemfile(read(), rel));
      else if (n === "pom.xml") out.push(...readPom(read(), rel));
      else if (n.endsWith(".csproj")) out.push(...readCsproj(read(), rel));
    }
  };
  walk(root);
  const by = new Map<string, Found>();
  // The repo's own crates and packages, named by one manifest and depended on by another.
  for (const p of out)
    if (!by.has(`${p.ecosystem}/${p.name}`) && !own.has(`${p.ecosystem}/${p.name}`))
      by.set(`${p.ecosystem}/${p.name}`, p);
  return [...by.values()];
}
