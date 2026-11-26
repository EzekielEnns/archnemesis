// The script Archnemesis serves at /archnm-index.cjs, for an agent to run with one command:
//   curl -fsS <archnm>/archnm-index.cjs | node - <repo folder> --to <archnm>/upload/<ticket>
// It reads the repo (never writes, never builds), surveys it, indexes its code with the best
// indexer on the machine (a SCIP indexer, Universal Ctags, or Archnemesis's own reader), and posts
// both to the link. Nothing else is sent: no file contents, only names, lines and what calls what.
import "../server/env-compat.ts";
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { indexRepo, NOT_PRODUCT, scipHint } from "../server/importer.ts";
import { surveyRepo } from "../server/survey.ts";
import { BUILTIN_LANGUAGES } from "../server/tags.ts";

const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const root = resolve(
  args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--")) ?? ".",
);
const to = flag("to");
const repo = flag("repo") ?? basename(root);
const all = args.includes("--all");
const log = (s: string) => process.stderr.write(`archnm: ${s}\n`);

const SKIP = new Set([
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
  ".terraform",
]);
function listFiles(): string[] {
  try {
    return execFileSync("git", ["ls-files", "-z"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 1 << 28,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\0")
      .filter(Boolean);
  } catch {
    // Not a git repo: walk it, leaving out what's never the product.
    const out: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        if (out.length > 50_000) return;
        const p = join(d, n);
        const st = statSync(p, { throwIfNoEntry: false });
        if (st?.isDirectory()) {
          if (!SKIP.has(n) && !n.startsWith(".")) walk(p);
        } else if (st?.isFile()) out.push(relative(root, p));
      }
    };
    walk(root);
    return out;
  }
}

async function main() {
  if (!to) {
    console.error(
      "usage: node archnm-index.cjs <repo folder> --to <the upload link the agent got from index start> [--scip index.scip] [--repo name] [--all]",
    );
    process.exit(2);
  }
  const t0 = Date.now();
  const files = listFiles().filter((f) => all || !NOT_PRODUCT.test(f));
  let sha: string | undefined;
  try {
    sha =
      execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || undefined;
  } catch {
    // not git: no commit to name
  }
  log(`surveying ${repo} (${files.length} files)…`);
  const survey = surveyRepo(root, repo, files, sha);
  const scip = flag("scip");
  const { index, adapter } = indexRepo(root, {
    repo,
    all,
    log,
    ...(scip ? { scip: resolve(scip) } : {}),
  });
  const exact = adapter.startsWith("SCIP");
  const top = survey.languages[0]?.language;
  const hint = !exact && top ? scipHint(top) : undefined;
  // Languages Archnemesis's own reader can't find functions in: Universal Ctags can (100+).
  const unread = adapter.includes("built-in reader")
    ? survey.languages.map((l) => l.language).filter((l) => !BUILTIN_LANGUAGES.includes(l))
    : [];
  const functions = unread.length
    ? `No functions found in ${unread.join(", ")} files: install Universal Ctags (brew install universal-ctags, apt install universal-ctags, or your package manager's), then run the same command again.`
    : undefined;
  survey.indexer = {
    adapter,
    exact,
    ...(top ? { language: top } : {}),
    ...(hint ? { hint } : {}),
    ...(functions ? { functions } : {}),
  };
  log(
    `${adapter}: ${index.functions.length} functions, ${index.calls.length} calls, ${index.packages.length} libraries; sending…`,
  );
  const r = await fetch(to, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ survey, index }),
  });
  const j = (await r.json().catch(() => ({}))) as { error?: string; ticket?: string };
  if (!r.ok) {
    console.error(`archnm: not sent: ${j.error ?? r.status}`);
    process.exit(1);
  }
  console.log(
    `Sent ${repo} to Archnemesis in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${survey.runnables.length} things that run, ${survey.stores.length} stores, ${index.functions.length} functions (${exact ? "exact calls" : "calls guessed by name"}). Ticket ${j.ticket}: call scan with it.`,
  );
}
void main();
