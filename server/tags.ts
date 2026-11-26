// The fallback adapter, for a language with no SCIP indexer to hand: definitions from
// Universal Ctags (ctags --output-format=json, 100+ languages), and calls guessed by name:
// inside a function's lines, a name followed by "(" that is exactly one function in the repo
// (or one in the same file). Those calls carry confidence "name" and are drawn fainter,
// so nobody mistakes a guess for a fact.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CodeIndex, IndexedFunction } from "../shared/codeindex.ts";

interface Tag {
  _type?: string;
  name: string;
  path: string;
  line?: number;
  end?: number;
  kind?: string;
  language?: string;
  scope?: string;
  scopeKind?: string;
  /** Defined inside another function (a helper const): only its own file calls it. */
  nested?: boolean;
}

const FUNCTION_KINDS = new Set([
  "function",
  "method",
  "func",
  "subroutine",
  "procedure",
  "member",
  "singletonMethod",
  "constructor",
]);
const OWNER_KINDS = new Set([
  "class",
  "struct",
  "implementation",
  "interface",
  "trait",
  "module",
  "namespace",
  "type",
]);

/** Is Universal Ctags on the path (not the old BSD ctags macOS ships)? */
export function hasUniversalCtags(): boolean {
  try {
    return execFileSync("ctags", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).includes("Universal Ctags");
  } catch {
    return false;
  }
}

/** Run ctags over a repo: one JSON tag per line. */
export function runCtags(root: string, files: string[]): string {
  return execFileSync(
    "ctags",
    ["--output-format=json", "--fields=+nKSe-P", "--extras=-F", "-f", "-", "-L", "-"],
    {
      cwd: root,
      input: files.join("\n"),
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
    },
  );
}

/** The language of a source file, by its extension (undefined for anything that isn't code). */
export function languageOf(path: string): string | undefined {
  const ext = /\.[^./]+$/.exec(path)?.[0]?.toLowerCase();
  if (!ext) return undefined;
  if (ext === ".py") return "python";
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"].includes(ext))
    return "typescript";
  if (ext === ".go") return "go";
  if (ext === ".rs") return "rust";
  if ([".java", ".kt", ".cs", ".scala"].includes(ext)) return "java";
  if (ext === ".rb") return "ruby";
  if (ext === ".php") return "php";
  if (
    [
      ".c",
      ".h",
      ".cc",
      ".cpp",
      ".hpp",
      ".swift",
      ".m",
      ".ex",
      ".exs",
      ".erl",
      ".hs",
      ".lua",
      ".dart",
      ".vue",
      ".svelte",
    ].includes(ext)
  )
    return ext.slice(1);
  return undefined;
}

/** ctags JSON lines plus the source text to the neutral index, calls guessed by name. `files`: every file read, so a file with no functions is a module too. */
export function tagsToIndex(
  json: string,
  opts: { repo: string; sha?: string; read: (path: string) => string | null; files?: string[] },
): CodeIndex {
  const tags: Tag[] = [];
  for (const line of json.split("\n")) {
    if (!line.trim()) continue;
    try {
      const t = JSON.parse(line) as Tag;
      if (t._type === undefined || t._type === "tag") tags.push(t);
    } catch {
      // a line ctags couldn't write as JSON: skip it
    }
  }
  const index: CodeIndex = {
    repo: opts.repo,
    sha: opts.sha,
    files: [],
    functions: [],
    calls: [],
    uses: [],
    packages: [],
  };
  const langs = new Map<string, string>();
  for (const t of tags)
    if (t.language && !langs.has(t.path)) langs.set(t.path, t.language.toLowerCase());
  for (const [path, language] of langs) index.files.push({ path, language });
  for (const path of opts.files ?? []) {
    const language = languageOf(path);
    if (language && !langs.has(path)) index.files.push({ path, language });
  }

  const byFile = new Map<string, (IndexedFunction & { end: number })[]>();
  const nested = new Set<string>();
  for (const t of tags) {
    if (!t.kind || !FUNCTION_KINDS.has(t.kind) || !t.line) continue;
    const owner =
      t.scope && (!t.scopeKind || OWNER_KINDS.has(t.scopeKind))
        ? t.scope.split(/[.:]+/).at(-1)
        : undefined;
    const f = {
      symbol: `${t.path}#${owner ? `${owner}.` : ""}${t.name}:${t.line}`,
      name: t.name,
      file: t.path,
      line: t.line,
      ...(owner ? { owner } : {}),
      end: t.end ?? 0,
    };
    index.functions.push({
      symbol: f.symbol,
      name: f.name,
      file: f.file,
      line: f.line,
      ...(owner ? { owner } : {}),
    });
    if (t.nested || t.scopeKind === "function" || (t.scopeKind === "method" && !owner))
      nested.add(f.symbol);
    (byFile.get(t.path) ?? byFile.set(t.path, []).get(t.path)!).push(f);
  }
  const byName = new Map<string, IndexedFunction[]>();
  for (const f of index.functions)
    (byName.get(f.name) ?? byName.set(f.name, []).get(f.name)!).push(f);

  const seen = new Set<string>();
  const allFiles = new Set([
    ...byFile.keys(),
    ...(opts.files ?? []),
    ...index.files.map((f) => f.path),
  ]);
  for (const [path, fns] of byFile) {
    const text = opts.read(path);
    if (text === null) continue;
    const sees = importsOf(path, text, allFiles);
    const ts = languageOf(path) === "typescript";
    const ns = ts ? namespacesOf(path, text, allFiles) : new Map<string, string>();
    const lines = text.split("\n");
    fns.sort((a, b) => a.line - b.line);
    fns.forEach((f, i) => {
      const last = f.end || (fns[i + 1]?.line ?? lines.length + 1) - 1;
      const body = lines.slice(f.line, last).join("\n");
      for (const m of body.matchAll(/(?<![\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
        let cands = byName.get(m[1]!);
        if (!cands) continue;
        // x.name(…) in TS/JS is a method on x (res.end() isn't some end() function), unless x
        // is a namespace import (live.commit() is live.ts's commit).
        const receiver = ts
          ? /([A-Za-z_$][\w$]*)\s*(?:\?\.|\.)\s*$/.exec(
              body.slice(Math.max(0, m.index! - 80), m.index),
            )?.[1]
          : undefined;
        if (receiver)
          cands = cands.filter(
            (c) =>
              (c.owner && !nested.has(c.symbol) && (receiver !== "this" || c.file === path)) ||
              ns.get(receiver) === c.file,
          );
        const here = cands.filter((c) => c.file === path);
        // Where its imports are read: only a function this file can see (itself, or what it
        // imports, and not a helper nested inside a function over there).
        const visible = sees
          ? cands.filter((c) => c.file === path || (sees.has(c.file) && !nested.has(c.symbol)))
          : cands;
        const to = here.length === 1 ? here[0] : visible.length === 1 ? visible[0] : undefined;
        if (!to || to.symbol === f.symbol) continue;
        const k = `${f.symbol}\n${to.symbol}`;
        if (seen.has(k)) continue;
        seen.add(k);
        index.calls.push({ from: f.symbol, to: to.symbol, confidence: "name" });
      }
    });
  }
  return index;
}

/** The repo file a relative TS/JS import names ("./x.js" → x.ts, "./dir" → dir/index.ts). */
function tsTarget(path: string, spec: string, files: Set<string>): string | undefined {
  const st: string[] = [];
  for (const p of [...path.split("/").slice(0, -1), ...spec.split("/")]) {
    if (p === "..") st.pop();
    else if (p && p !== ".") st.push(p);
  }
  const base = st.join("/");
  const bare = base.replace(/\.(m|c)?jsx?$/, "");
  return [
    base,
    ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts"].map((e) => bare + e),
    ...["ts", "tsx", "js", "jsx"].map((e) => `${base}/index.${e}`),
  ].find((c) => files.has(c));
}

/** TS/JS namespace imports (import * as live from "./live.ts"): the name, and the file it stands for. */
function namespacesOf(path: string, text: string, files: Set<string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of text.matchAll(
    /import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+["'](\.{1,2}\/[^"']+)["']/g,
  )) {
    const hit = tsTarget(path, m[2]!, files);
    if (hit) out.set(m[1]!, hit);
  }
  return out;
}

/**
 * The repo files a file can see by its imports (TypeScript/JavaScript, Python, Go), or null for
 * a language whose imports aren't read here. A call guessed by name only links to a function
 * in the file itself or in one of these.
 */
function importsOf(path: string, text: string, files: Set<string>): Set<string> | null {
  const lang = languageOf(path);
  const out = new Set<string>();
  const dir = path.split("/").slice(0, -1);
  const norm = (parts: string[]) => {
    const st: string[] = [];
    for (const p of parts) {
      if (p === "..") st.pop();
      else if (p && p !== ".") st.push(p);
    }
    return st.join("/");
  };
  if (lang === "typescript") {
    for (const m of text.matchAll(
      /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g,
    )) {
      const hit = tsTarget(path, m[1]!, files);
      if (hit) out.add(hit);
    }
    return out;
  }
  if (lang === "python") {
    for (const m of text.matchAll(
      /^\s*(?:from\s+(\.*)([\w.]*)\s+import\s+([\w, ()*]+)|import\s+([\w.]+))/gm,
    )) {
      const dots = m[1] ?? "";
      const mod = (m[2] ?? m[4] ?? "").split(".").filter(Boolean);
      const start = dots ? dir.slice(0, dir.length - (dots.length - 1)) : [];
      const tries = (parts: string[]) => [`${norm(parts)}.py`, `${norm(parts)}/__init__.py`];
      const names = (m[3] ?? "")
        .replace(/[()]/g, "")
        .split(",")
        .map((x) => x.trim().split(/\s+/)[0]!)
        .filter((x) => x && x !== "*");
      const found = [
        ...tries([...start, ...mod]),
        ...names.flatMap((n) => tries([...start, ...mod, n])),
      ];
      // Absolute imports: the module anywhere in the repo (src/ layouts, packages under a folder).
      if (!dots && mod.length)
        for (const f of files)
          if (f.endsWith(`/${mod.join("/")}.py`) || f.endsWith(`/${mod.join("/")}/__init__.py`))
            found.push(f);
      for (const f of found) if (files.has(f)) out.add(f);
    }
    return out;
  }
  if (lang === "go") {
    // A package is its folder: the same folder, and folders whose path ends an import path.
    const dirs = new Map<string, string[]>();
    for (const f of files)
      if (f.endsWith(".go")) {
        const d = f.split("/").slice(0, -1).join("/");
        dirs.set(d, [...(dirs.get(d) ?? []), f]);
      }
    for (const f of dirs.get(dir.join("/")) ?? []) out.add(f);
    const block = /import\s*\(([^)]*)\)/g.exec(text)?.[1] ?? "";
    const paths = [
      ...block.matchAll(/"([^"]+)"/g),
      ...text.matchAll(/^import\s+(?:\w+\s+)?"([^"]+)"/gm),
    ].map((m) => m[1]!);
    for (const p of paths)
      for (const [d, fs] of dirs)
        if (d && (p === d || p.endsWith(`/${d}`))) for (const f of fs) out.add(f);
    return out;
  }
  return null;
}

export const readFrom = (root: string) => (path: string) => {
  try {
    return readFileSync(join(root, path), "utf8");
  } catch {
    return null;
  }
};

/**
 * The last resort, when neither a SCIP indexer nor Universal Ctags is installed: function
 * definitions found by pattern, in the same shape ctags writes (JSON lines), so the same
 * name-guessing finds the calls. Python, JavaScript and TypeScript, Go, Rust, Java, Kotlin,
 * C#, Ruby, PHP. Rough by design: good enough to see a repo's functions and guess what calls
 * what; a SCIP indexer makes it exact.
 */
export const BUILTIN_LANGUAGES = ["python", "typescript", "go", "rust", "java", "ruby", "php"];

export function builtinTags(root: string, files: string[]): string {
  const out: string[] = [];
  const read = readFrom(root);
  const emit = (
    path: string,
    name: string,
    line: number,
    language: string,
    scope?: string,
    nested = false,
  ) =>
    out.push(
      JSON.stringify({
        _type: "tag",
        name,
        path,
        line,
        kind: "function",
        language,
        ...(scope ? { scope, scopeKind: "class" } : {}),
        ...(nested ? { nested: true } : {}),
      }),
    );
  const KEYWORDS = new Set([
    "if",
    "for",
    "while",
    "switch",
    "catch",
    "return",
    "function",
    "else",
    "do",
    "try",
    "new",
    "typeof",
    "await",
    "with",
    "elif",
    "sizeof",
    "foreach",
    "using",
    "lock",
    "fixed",
    "synchronized",
  ]);
  for (const path of files) {
    const lang = languageOf(path);
    if (!lang || !BUILTIN_LANGUAGES.includes(lang)) continue;
    const text = read(path);
    if (text === null || text.length > 1_000_000) continue;
    const lines = text.split("\n");
    // Owners: the class (or impl) a line sits in, by indentation (Python, Ruby) or braces (the rest, roughly).
    const owners: { name: string; indent: number; depth: number }[] = [];
    let depth = 0;
    lines.forEach((raw, i) => {
      const line = raw.replace(/\t/g, "    ");
      const indent = line.length - line.trimStart().length;
      const t = line.trim();
      if (!t || t.startsWith("//") || t.startsWith("#") || t.startsWith("*")) return;
      if (lang === "python" || lang === "ruby")
        while (owners.length && indent <= owners.at(-1)!.indent) owners.pop();
      else while (owners.length && depth < owners.at(-1)!.depth) owners.pop();
      const owner = owners.at(-1)?.name;
      let m: RegExpExecArray | null;
      if (lang === "python") {
        if ((m = /^class\s+([A-Za-z_]\w*)/.exec(t))) owners.push({ name: m[1]!, indent, depth });
        else if ((m = /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(t)))
          emit(path, m[1]!, i + 1, lang, owner);
      } else if (lang === "ruby") {
        if ((m = /^(?:class|module)\s+([A-Z]\w*)/.exec(t)))
          owners.push({ name: m[1]!, indent, depth });
        else if ((m = /^def\s+(?:self\.)?([a-z_]\w*[?!]?)/.exec(t)))
          emit(path, m[1]!, i + 1, lang, owner);
      } else if (lang === "go") {
        if ((m = /^func\s+\(\s*\w*\s*\*?\s*([A-Za-z_]\w*)[^)]*\)\s*([A-Za-z_]\w*)\s*[([]/.exec(t)))
          emit(path, m[2]!, i + 1, lang, m[1]);
        else if ((m = /^func\s+([A-Za-z_]\w*)\s*[([]/.exec(t))) emit(path, m[1]!, i + 1, lang);
      } else if (lang === "rust") {
        if ((m = /^impl(?:<[^>]*>)?\s+(?:[\w:]+(?:<[^>]*>)?\s+for\s+)?([A-Za-z_]\w*)/.exec(t)))
          owners.push({ name: m[1]!, indent, depth: depth + 1 });
        else if (
          (m =
            /^(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"\w+"\s+)?fn\s+([A-Za-z_]\w*)/.exec(
              t,
            ))
        )
          emit(path, m[1]!, i + 1, lang, owner);
      } else if (lang === "typescript") {
        // Straight in a class's body (not inside one of its methods).
        const inClass = !!owner && depth === owners.at(-1)!.depth;
        // An arrow function or function expression: = (…) =>, = async x =>, = <T>(…) =>, or = ( with its parameters on the next lines.
        const fnValue =
          /^=\s*(?:async\s+)?(?:function\b|(?:<[^>]*>\s*)?\((?:(?:[^()]|\([^()]*\))*\)\s*(?::[^=]+?)?=>|[^)]*$)|[A-Za-z_$][\w$]*\s*=>)/;
        if (
          (m = /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(t))
        )
          owners.push({ name: m[1]!, indent, depth: depth + 1 });
        else if (
          (m =
            /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*[(<]/.exec(
              t,
            ))
        )
          emit(path, m[1]!, i + 1, lang);
        else if (
          (m = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?(=.*)$/.exec(
            t,
          )) &&
          fnValue.test(m[2]!)
        )
          emit(path, m[1]!, i + 1, lang, undefined, depth > 0);
        // A method (its signature on one line ending in {, or its parameters going on to the next lines), or a field holding an arrow function.
        else if (
          inClass &&
          (m =
            /^(?:(?:public|private|protected|static|async|readonly|override|get|set|abstract)\s+)*\*?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\((?:.*\)\s*(?::.+)?\{\s*$|[^)]*$)/.exec(
              t,
            )) &&
          !KEYWORDS.has(m[1]!)
        )
          emit(path, m[1]!, i + 1, lang, owner);
        else if (
          inClass &&
          (m =
            /^(?:(?:public|private|protected|static|readonly|override)\s+)*([A-Za-z_$][\w$]*)\s*(?::[^=]+)?(=.*)$/.exec(
              t,
            )) &&
          fnValue.test(m[2]!)
        )
          emit(path, m[1]!, i + 1, lang, owner);
      } else if (lang === "php") {
        if ((m = /^(?:abstract\s+|final\s+)?class\s+([A-Za-z_]\w*)/.exec(t)))
          owners.push({ name: m[1]!, indent, depth: depth + 1 });
        else if ((m = /function\s+&?\s*([A-Za-z_]\w*)\s*\(/.exec(t)))
          emit(path, m[1]!, i + 1, lang, owner);
      } else {
        // Java, Kotlin, C#, Scala: a class, then methods (a type and a name before "(", ending in "{" or "=").
        if (
          (m = /\b(?:class|interface|object|record|enum|struct)\s+([A-Z]\w*)/.exec(t)) &&
          /[{:]\s*$|\bextends\b|\bimplements\b|\(\s*$/.test(t)
        )
          owners.push({ name: m[1]!, indent, depth: depth + 1 });
        else if (
          (m =
            /^(?:fun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?([a-zA-Z_]\w*)\s*\(|def\s+([a-zA-Z_]\w*)\s*[([:]|(?:(?:public|private|protected|internal|static|final|abstract|override|virtual|async|synchronized|open|suspend)\s+)*[\w<>[\],.?]+\s+([a-zA-Z_]\w*)\s*\([^;]*$)/.exec(
              t,
            ))
        ) {
          const name = m[1] ?? m[2] ?? m[3];
          if (name && !KEYWORDS.has(name)) emit(path, name, i + 1, lang, owner);
        }
      }
      if (lang !== "python" && lang !== "ruby")
        for (const ch of t.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`/g, ""))
          depth += ch === "{" ? 1 : ch === "}" ? -1 : 0;
    });
  }
  return out.join("\n");
}
