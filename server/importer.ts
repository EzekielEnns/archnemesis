// Index a repo on disk into the neutral code index, with the best adapter it has:
//   1. a SCIP index (given, or made by an indexer on the path: rust-analyzer, scip-typescript,
//      scip-python, scip-go): exact calls;
//   2. Universal Ctags: definitions, and calls guessed by name;
// and the manifests for libraries, always. `archnm index` and `archnm import` call this.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { headerComment, type CodeIndex } from "../shared/codeindex.ts";
import { readManifests } from "./manifests.ts";
import { scipToIndex } from "./scip.ts";
import {
  builtinTags,
  hasUniversalCtags,
  languageOf,
  readFrom,
  runCtags,
  tagsToIndex,
} from "./tags.ts";

/** Tests, fixtures, examples, vendored and generated code: left out unless asked for. */
export const NOT_PRODUCT =
  /(^|\/)(tests?|__tests__|spec|testdata|fixtures?|examples?|benches|vendor|third_party|node_modules|target|dist|build|generated)\/|(_test\.go|\.(test|spec)\.[jt]sx?|_test\.py|test_[^/]*\.py)$/;

const run = (cmd: string, args: string[], cwd: string) =>
  execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });
const has = (cmd: string) => {
  try {
    execFileSync("which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

function gitSha(root: string): string | undefined {
  try {
    return run("git", ["rev-parse", "--short=12", "HEAD"], root).trim() || undefined;
  } catch {
    return undefined;
  }
}

function gitFiles(root: string): string[] | null {
  try {
    return run("git", ["ls-files", "-z"], root).split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

/** The SCIP indexers Archnemesis knows how to run, by what marks a repo as theirs. */
const INDEXERS: { marker: string[]; cmd: string; args: (out: string) => string[] }[] = [
  { marker: ["Cargo.toml"], cmd: "rust-analyzer", args: (out) => ["scip", ".", "--output", out] },
  {
    marker: ["tsconfig.json", "package.json"],
    cmd: "scip-typescript",
    args: (out) => ["index", "--output", out],
  },
  {
    marker: ["pyproject.toml", "setup.py", "requirements.txt"],
    cmd: "scip-python",
    args: (out) => ["index", ".", "--output", out],
  },
  { marker: ["go.mod"], cmd: "scip-go", args: (out) => ["--output", out] },
];

/**
 * How to get exact calls for a language: the SCIP indexer to install. Archnemesis reads every SCIP
 * indexer's output the same way, so a language not run by INDEXERS still works: run its
 * indexer and pass the index.scip with --scip. undefined: no SCIP indexer exists for it.
 */
export function scipHint(language: string): string | undefined {
  const runs = (install: string) => `${install}, then run the same command again`;
  const own = (install: string, cmd: string) =>
    `${install}, run \`${cmd}\` in the repo, then run the same command again with --scip index.scip`;
  return (
    {
      typescript: runs("npm i -g @sourcegraph/scip-typescript"),
      python: runs("npm i -g @sourcegraph/scip-python"),
      go: runs("go install github.com/sourcegraph/scip-go/cmd/scip-go@latest"),
      rust: runs("rustup component add rust-analyzer"),
      java: own(
        "install scip-java (Java, Kotlin, Scala: sourcegraph.github.io/scip-java) or scip-dotnet (C#: dotnet tool install -g scip-dotnet)",
        "scip-java index` or `scip-dotnet index",
      ),
      ruby: own("install scip-ruby (github.com/sourcegraph/scip-ruby)", "scip-ruby"),
      php: own("composer require --dev davidrjenni/scip-php", "vendor/bin/scip-php"),
      c: own(
        "install scip-clang (github.com/sourcegraph/scip-clang)",
        "scip-clang --compdb-path=compile_commands.json",
      ),
      cc: own(
        "install scip-clang (github.com/sourcegraph/scip-clang)",
        "scip-clang --compdb-path=compile_commands.json",
      ),
      cpp: own(
        "install scip-clang (github.com/sourcegraph/scip-clang)",
        "scip-clang --compdb-path=compile_commands.json",
      ),
      h: own(
        "install scip-clang (github.com/sourcegraph/scip-clang)",
        "scip-clang --compdb-path=compile_commands.json",
      ),
      hpp: own(
        "install scip-clang (github.com/sourcegraph/scip-clang)",
        "scip-clang --compdb-path=compile_commands.json",
      ),
    } as Record<string, string>
  )[language];
}

/**
 * The functions of `missing` files from a fallback index, into a SCIP one: their own, and the
 * calls into and out of them (guesses), with the other end named as the SCIP index names it
 * (the same file and name).
 */
export function fillFrom(index: CodeIndex, fallback: CodeIndex, missing: Set<string>): void {
  const scipBy = new Map(
    index.functions.map((f) => [`${f.file}#${f.owner ? `${f.owner}.` : ""}${f.name}`, f.symbol]),
  );
  const fb = new Map(fallback.functions.map((f) => [f.symbol, f]));
  const inMissing = (sym: string) => missing.has(fb.get(sym)?.file ?? "");
  const name = (sym: string) => {
    const f = fb.get(sym);
    if (!f) return undefined;
    return missing.has(f.file)
      ? sym
      : scipBy.get(`${f.file}#${f.owner ? `${f.owner}.` : ""}${f.name}`);
  };
  for (const p of missing)
    if (!index.files.some((f) => f.path === p))
      index.files.push(
        fallback.files.find((f) => f.path === p) ?? { path: p, language: languageOf(p) },
      );
  index.functions.push(...fallback.functions.filter((f) => missing.has(f.file)));
  const seen = new Set(index.calls.map((c) => `${c.from}\n${c.to}`));
  for (const c of fallback.calls) {
    if (!(inMissing(c.from) || inMissing(c.to))) continue;
    const from = name(c.from);
    const to = name(c.to);
    if (!from || !to || seen.has(`${from}\n${to}`)) continue;
    seen.add(`${from}\n${to}`);
    index.calls.push({ from, to, confidence: "name" });
  }
  index.uses.push(...fallback.uses.filter((u) => inMissing(u.from)));
}

export interface IndexOptions {
  /** The repo's name in paths (repo:path); default the folder name. */
  repo?: string;
  /** An index.scip made already. */
  scip?: string;
  /** Keep tests, examples and vendored code. */
  all?: boolean;
  log?: (line: string) => void;
}

export function indexRepo(
  root: string,
  opts: IndexOptions = {},
): { index: CodeIndex; adapter: string } {
  const repo = opts.repo ?? basename(root);
  const sha = gitSha(root);
  const log = opts.log ?? (() => {});
  let index: CodeIndex | null = null;
  let adapter = "";

  let scip = opts.scip;
  let tmp: string | null = null;
  if (!scip) {
    for (const ix of INDEXERS) {
      if (!ix.marker.some((m) => existsSync(join(root, m))) || !has(ix.cmd)) continue;
      tmp = mkdtempSync(join(tmpdir(), "archnm-scip-"));
      const out = join(tmp, "index.scip");
      log(`indexing with ${ix.cmd}…`);
      try {
        run(ix.cmd, ix.args(out), root);
        if (existsSync(out)) {
          scip = out;
          adapter = `SCIP (${ix.cmd})`;
          break;
        }
      } catch (e) {
        log(`${ix.cmd} failed: ${(e as Error).message.split("\n")[0]}`);
      }
    }
  } else adapter = "SCIP";
  try {
    if (scip) index = scipToIndex(readFileSync(scip), { repo, sha, read: readFrom(root) });
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
  if (index) {
    // A SCIP indexer only reads what the project's config includes (a tsconfig's include, a
    // Cargo workspace): the source files it left out get their functions from the fallback
    // reader, their calls guessed by name, rather than staying empty.
    const covered = new Set(index.functions.map((f) => f.file));
    const indexed = new Set(index.files.map((f) => f.path));
    const files = (gitFiles(root) ?? []).filter((f) => opts.all || !NOT_PRODUCT.test(f));
    const missing = new Set(
      files.filter((f) => languageOf(f) && !indexed.has(f) && !covered.has(f)),
    );
    if (missing.size) {
      log(
        `${missing.size} files the SCIP index left out (outside the project's config): reading them as well, calls guessed by name…`,
      );
      const ctags = hasUniversalCtags();
      const t = tagsToIndex(ctags ? runCtags(root, files) : builtinTags(root, files), {
        repo,
        sha,
        read: readFrom(root),
        files,
      });
      fillFrom(index, t, missing);
      adapter += ` + ${ctags ? "Universal Ctags" : "Archnemesis's built-in reader"} for ${missing.size} file${missing.size === 1 ? "" : "s"} it left out`;
    }
  }
  if (!index) {
    const files = (gitFiles(root) ?? []).filter((f) => opts.all || !NOT_PRODUCT.test(f));
    if (hasUniversalCtags()) {
      log("indexing with Universal Ctags (calls are guessed by name)…");
      index = tagsToIndex(runCtags(root, files), { repo, sha, read: readFrom(root), files });
      adapter = "Universal Ctags";
    } else {
      // Nothing installed: Archnemesis's own reader, so mapping never stops for want of a tool.
      log("indexing with Archnemesis's built-in reader (calls are guessed by name)…");
      index = tagsToIndex(builtinTags(root, files), { repo, sha, read: readFrom(root), files });
      adapter = "Archnemesis's built-in reader";
    }
  }
  // Every source file is a module, functions or not (an entry point, a file of types or constants).
  {
    const have = new Set(index.files.map((f) => f.path));
    for (const p of (gitFiles(root) ?? []).filter((f) => opts.all || !NOT_PRODUCT.test(f))) {
      const language = languageOf(p);
      if (language && !have.has(p)) index.files.push({ path: p, language });
    }
  }
  // What each file is for: its leading comment (agents scripted these in by hand).
  {
    const read = readFrom(root);
    for (const f of index.files) {
      if (f.doc) continue;
      const text = read(f.path);
      const doc = text ? headerComment(text.slice(0, 20_000)) : null;
      if (doc) f.doc = doc;
    }
  }
  index.packages = readManifests(root);
  if (!opts.all) {
    const keep = new Set(index.files.map((f) => f.path).filter((p) => !NOT_PRODUCT.test(p)));
    index.files = index.files.filter((f) => keep.has(f.path));
    // And test modules inside product files (Rust's mod tests, a tests namespace).
    const inTests = (sym: string) => /(^|[/#])tests?[/#]/.test(sym.split(" ").slice(4).join(" "));
    index.functions = index.functions.filter((f) => keep.has(f.file) && !inTests(f.symbol));
    const fns = new Set(index.functions.map((f) => f.symbol));
    index.calls = index.calls.filter(
      (c) => (c.top ? keep.has(c.from) : fns.has(c.from)) && fns.has(c.to),
    );
    index.uses = index.uses.filter((u) => fns.has(u.from));
  }
  return { index, adapter };
}
