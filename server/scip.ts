// The SCIP adapter: reads an index.scip (written by rust-analyzer, scip-typescript,
// scip-python, scip-java, scip-go, scip-clang, scip-ruby, scip-dotnet...) into Archnemesis's neutral
// code index. Every SCIP indexer writes the same format, so this one reader covers them all.
//
// SCIP is protobuf. Only the handful of fields used here are decoded, by hand, so Archnemesis
// needs no protobuf library: Index.documents; Document.relative_path, occurrences, symbols;
// Occurrence.range, symbol, symbol_roles, enclosing_range; SymbolInformation.symbol, kind,
// display_name, documentation, signature_documentation.text. (github.com/sourcegraph/scip, scip.proto.)
import type { CodeIndex, IndexedFunction } from "../shared/codeindex.ts";
import type { Ecosystem } from "../shared/model.ts";

// --- protobuf, just enough ------------------------------------------------------------------

class Reader {
  pos = 0;
  readonly buf: Uint8Array;
  readonly end: number;
  constructor(buf: Uint8Array) {
    this.buf = buf;
    this.end = buf.length;
  }
  varint(): number {
    let out = 0;
    let shift = 0;
    for (;;) {
      if (this.pos >= this.end) throw new Error("scip: truncated varint");
      const b = this.buf[this.pos++]!;
      out += (b & 0x7f) * 2 ** shift;
      if (b < 0x80) return out;
      shift += 7;
      if (shift > 63) throw new Error("scip: varint too long");
    }
  }
  bytes(): Uint8Array {
    const n = this.varint();
    if (this.pos + n > this.end) throw new Error("scip: truncated field");
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  skip(wire: number): void {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) this.bytes();
    else if (wire === 5) this.pos += 4;
    else throw new Error(`scip: unsupported wire type ${wire}`);
  }
  /** Each field as [number, wire type]; the caller reads or skips its value. */
  *fields(): Generator<[number, number]> {
    while (this.pos < this.end) {
      const tag = this.varint();
      yield [Math.floor(tag / 8), tag & 7];
    }
  }
}

const utf8 = new TextDecoder();
const str = (r: Reader) => utf8.decode(r.bytes());
/** A repeated int32, packed or not. */
function ints(r: Reader, wire: number, into: number[]): void {
  if (wire === 0) into.push(r.varint() | 0);
  else {
    const b = r.bytes();
    const p = new Reader(b);
    while (p.pos < p.end) into.push(p.varint() | 0);
  }
}

interface Occurrence {
  range: number[];
  symbol: string;
  roles: number;
  enclosing: number[];
}
interface Doc {
  path: string;
  language: string;
  occurrences: Occurrence[];
  symbols: Map<string, { kind: number; display: string; docs: string[]; signature: string }>;
}

function readOccurrence(b: Uint8Array): Occurrence {
  const r = new Reader(b);
  const o: Occurrence = { range: [], symbol: "", roles: 0, enclosing: [] };
  for (const [f, w] of r.fields()) {
    if (f === 1) ints(r, w, o.range);
    else if (f === 2 && w === 2) o.symbol = str(r);
    else if (f === 3 && w === 0) o.roles = r.varint();
    else if (f === 7) ints(r, w, o.enclosing);
    else r.skip(w);
  }
  return o;
}

function readSymbol(b: Uint8Array): {
  symbol: string;
  kind: number;
  display: string;
  docs: string[];
  signature: string;
} {
  const r = new Reader(b);
  const s = { symbol: "", kind: 0, display: "", docs: [] as string[], signature: "" };
  for (const [f, w] of r.fields()) {
    if (f === 1 && w === 2) s.symbol = str(r);
    else if (f === 3 && w === 2) s.docs.push(str(r));
    else if (f === 5 && w === 0) s.kind = r.varint();
    else if (f === 6 && w === 2) s.display = str(r);
    else if (f === 7 && w === 2) {
      // signature_documentation: a Document, whose text (5) is the signature.
      const d = new Reader(r.bytes());
      for (const [g, v] of d.fields()) {
        if (g === 5 && v === 2) s.signature = str(d);
        else d.skip(v);
      }
    } else r.skip(w);
  }
  return s;
}

/**
 * A symbol's signature and doc comment from its documentation: indexers write the signature as
 * a code block (```ts\nfunction newId(prefix: string): string\n```) and the comment as text.
 * The declaring words go (function, fn, def, func, pub, async, (method)…): what's left reads
 * as the function's own line.
 */
function signatureOf(docs: string[], given = ""): { signature?: string; doc?: string } {
  const fence = /^\s*```[\w+-]*\n([\s\S]*?)\n?```\s*$/;
  const code = given.trim() || docs.map((d) => fence.exec(d)?.[1]).find((x) => !!x?.trim()) || "";
  const tidy = code
    .replace(/\s+/g, " ")
    .replace(
      /^(?:\((?:method|function|property|constructor)\)\s*|(?:export|default|declare|public|private|protected|static|readonly|abstract|override|async|function|fn|def|func|const|let|var|pub(?:\([^)]*\))?|unsafe|extern|inline|virtual)\s+)+/g,
      "",
    )
    .trim();
  const text = docs
    .filter((d) => !fence.test(d))
    .join("\n\n")
    .trim();
  const para =
    text
      .split(/\n\s*\n/)[0]
      ?.replace(/\s+/g, " ")
      .trim() ?? "";
  return {
    ...(tidy && tidy.length <= 300
      ? { signature: tidy }
      : tidy
        ? { signature: `${tidy.slice(0, 297)}…` }
        : {}),
    ...(para ? { doc: para.length <= 400 ? para : `${para.slice(0, 397)}…` } : {}),
  };
}

function readDocument(b: Uint8Array): Doc {
  const r = new Reader(b);
  const d: Doc = { path: "", language: "", occurrences: [], symbols: new Map() };
  for (const [f, w] of r.fields()) {
    if (f === 1 && w === 2) d.path = str(r);
    else if (f === 2 && w === 2) d.occurrences.push(readOccurrence(r.bytes()));
    else if (f === 3 && w === 2) {
      const s = readSymbol(r.bytes());
      d.symbols.set(s.symbol, s);
    } else if (f === 4 && w === 2) d.language = str(r);
    else r.skip(w);
  }
  return d;
}

function readScipDocuments(buf: Uint8Array): Doc[] {
  const r = new Reader(buf);
  const docs: Doc[] = [];
  for (const [f, w] of r.fields()) {
    if (f === 2 && w === 2) docs.push(readDocument(r.bytes()));
    else r.skip(w);
  }
  return docs;
}

// --- symbols --------------------------------------------------------------------------------

/**
 * A SCIP symbol: "<scheme> <manager> <package> <version> <descriptors>", a space inside a
 * field written as two. "local N" symbols are a file's own locals.
 */
export function parseSymbol(
  sym: string,
): { manager: string; pkg: string; version: string; descriptors: string } | null {
  if (sym.startsWith("local ")) return null;
  const parts: string[] = [];
  let cur = "";
  let i = 0;
  while (i < sym.length && parts.length < 4) {
    if (sym[i] === " ") {
      if (sym[i + 1] === " ") {
        cur += " ";
        i += 2;
        continue;
      }
      parts.push(cur);
      cur = "";
      i++;
      continue;
    }
    cur += sym[i++];
  }
  if (parts.length < 4) return null;
  return { manager: parts[1]!, pkg: parts[2]!, version: parts[3]!, descriptors: sym.slice(i) };
}

/**
 * The last descriptor, when it's a method or function ("name()." or "name(+1)."), and the
 * type it belongs to: "Hub#post()." (most indexers) or "impl#[Hub]post()." (rust-analyzer).
 */
export function functionName(descriptors: string): { name: string; owner?: string } | null {
  const m = /(`[^`]+`|[^/#.`()[\]]+)\((?:\+\d+)?\)\.$/.exec(descriptors);
  if (!m) return null;
  const name = m[1]!.replace(/^`|`$/g, "");
  const before = descriptors.slice(0, m.index);
  const owner = (
    /\[([^\]]+)\]$/.exec(before)?.[1] ?? /(`[^`]+`|[^/#.`[\]]+)#$/.exec(before)?.[1]
  )?.replace(/^`|`$/g, "");
  return { name, ...(owner && owner !== "impl" ? { owner } : {}) };
}

/** The last descriptor when it's a term ("Card." or "Hub#onClick."), with its type if it has one. */
function assignedName(descriptors: string): { name: string; owner?: string } | null {
  const m = /([A-Za-z_$][\w$]*)\.$/.exec(descriptors);
  if (!m || /\)\.$/.test(descriptors)) return null;
  const before = descriptors.slice(0, m.index);
  const owner = /([A-Za-z_$][\w$]*)#$/.exec(before)?.[1];
  return { name: m[1]!, ...(owner ? { owner } : {}) };
}

/** What follows a name where it's defined assigns it a function: "= (a) =>", "= async x =>",
 * "= function", ": FC<P> = …", "= memo(", "= forwardRef(" (the next line when it breaks after =). */
function assignsFunction(after: string, next = ""): boolean {
  const m = /^\s*(?::[^=]*?)?=(?!=)\s*(.*)$/.exec(after);
  if (!m) return false;
  const rhs = m[1]!.trim() || next.trim();
  return /^(?:async\s+)?(?:function\b|\([^)]*\)?\s*(?::[^=]*)?=>|\(\s*$|\(\s*\{|\(\s*[\w$]+\s*[:,]|lambda\b|func\s*\(|[A-Za-z_$][\w$]*\s*=>|<[^>]+>\s*\()|^(?:React\.)?(?:memo|forwardRef|lazy)\s*(?:<[^>]*>)?\(/.test(
    rhs,
  );
}

// SymbolInformation.Kind values that are functions, for indexers that set kind but write
// an unusual descriptor: Constructor 9, Function 17, Method 26, AbstractMethod 66,
// ProtocolMethod 68, PureVirtualMethod 69, TraitMethod 70, TypeClassMethod 71,
// SingletonMethod 76, StaticMethod 80.
const FUNCTION_KINDS = new Set([9, 17, 26, 66, 68, 69, 70, 71, 76, 80]);

const MANAGERS: Record<string, Ecosystem> = {
  cargo: "cargo",
  npm: "npm",
  pip: "pypi",
  pypi: "pypi",
  maven: "maven",
  gomod: "go",
  go: "go",
  nuget: "nuget",
  gem: "rubygems",
  rubygems: "rubygems",
};

/**
 * The language itself, as the indexers name it: its standard library and built-in types, not a
 * library anyone chose (typescript, for lib.d.ts's string and Promise, was a "use" of
 * every function). Per ecosystem, so each language keeps its own.
 */
const LANGUAGE: Record<string, readonly string[]> = {
  cargo: ["std", "core", "alloc", "proc_macro"],
  npm: ["typescript", "@types/node"],
  pip: ["python-stdlib", "builtins"],
  pypi: ["python-stdlib", "builtins"],
  maven: ["jdk"],
  gomod: ["std", "builtin"],
  go: ["std", "builtin"],
  nuget: ["System.Runtime", "netstandard", "mscorlib"],
  gem: ["ruby", "core"],
  rubygems: ["ruby", "core"],
};
const isLanguage = (manager: string, pkg: string) => LANGUAGE[manager]?.includes(pkg) ?? false;

const lineOf = (range: number[]) => range[0] ?? 0;
const endOf = (range: number[]) => (range.length === 4 ? range[2]! : range[0]!);

/**
 * SCIP to the neutral index: functions are the definitions whose symbol is a method or
 * function; a call is a reference to one inside another's body (exact: the indexer resolved
 * it); a reference to another package's symbol is a use of that library.
 */
export function scipToIndex(
  buf: Uint8Array,
  opts: { repo: string; sha?: string; read?: (path: string) => string | null },
): CodeIndex {
  const docs = readScipDocuments(buf);
  const index: CodeIndex = {
    repo: opts.repo,
    sha: opts.sha,
    files: [],
    functions: [],
    calls: [],
    uses: [],
    packages: [],
  };
  const ours = new Set<string>();
  const bySymbol = new Map<string, IndexedFunction>();
  // The bodies, per file, to find which function a reference sits in.
  const bodies = new Map<string, { sym: string; from: number; to: number }[]>();

  for (const d of docs) {
    index.files.push({ path: d.path, language: d.language || undefined });
    const defs = d.occurrences
      .filter((o) => o.roles & 1)
      .sort((a, b) => lineOf(a.range) - lineOf(b.range));
    const fns: { sym: string; from: number; to: number }[] = [];
    let src: string[] | null | undefined;
    for (const o of defs) {
      const p = parseSymbol(o.symbol);
      if (!p) continue;
      ours.add(`${p.manager} ${p.pkg}`);
      const info = d.symbols.get(o.symbol);
      let fn =
        functionName(p.descriptors) ??
        (info && FUNCTION_KINDS.has(info.kind) ? { name: info.display || p.descriptors } : null);
      // A name assigned a function (const Card = (props) => …, = function, = memo(…)): a
      // function too. Indexers call it a variable (React components weren't
      // functions, so the frontend's flows stepped through files).
      if (!fn && opts.read) {
        const term = assignedName(p.descriptors);
        if (term) {
          src ??= opts.read(d.path)?.split("\n") ?? null;
          const line = src?.[lineOf(o.range)] ?? "";
          const after = line.slice(o.range.length === 4 ? o.range[3]! : o.range[2]!);
          if (assignsFunction(after, src?.[lineOf(o.range) + 1])) fn = term;
        }
      }
      if (!fn || bySymbol.has(o.symbol)) continue;
      const f: IndexedFunction = {
        symbol: o.symbol,
        name: fn.name,
        file: d.path,
        line: lineOf(o.range) + 1,
        ...(fn.owner ? { owner: fn.owner } : {}),
        ...(info ? signatureOf(info.docs, info.signature) : {}),
      };
      bySymbol.set(o.symbol, f);
      index.functions.push(f);
      fns.push({
        sym: o.symbol,
        from: lineOf(o.enclosing.length ? o.enclosing : o.range),
        to: o.enclosing.length ? endOf(o.enclosing) : -1,
      });
    }
    // Without an enclosing range, a body runs to the next definition in the file.
    fns.forEach((f, i) => {
      if (f.to < 0) f.to = (fns[i + 1]?.from ?? Number.MAX_SAFE_INTEGER) - 1;
    });
    bodies.set(d.path, fns);
  }

  const calls = new Set<string>();
  const uses = new Set<string>();
  for (const d of docs) {
    const fns = bodies.get(d.path) ?? [];
    let lines: string[] | null | undefined;
    for (const o of d.occurrences) {
      if (o.roles & 1) continue;
      const line = lineOf(o.range);
      // The innermost body around it.
      let inside: { sym: string; from: number; to: number } | undefined;
      for (const f of fns)
        if (f.from <= line && line <= f.to && (!inside || f.from >= inside.from)) inside = f;
      if (!inside) {
        // Top-level code (a script's body, a route table, a CLI's switch): a call from the file
        // itself. Only a call, a name followed by "(", in any language; an import names
        // functions too, and isn't one.
        if (!bySymbol.has(o.symbol) || !opts.read) continue;
        lines ??= opts.read(d.path)?.split("\n") ?? null;
        const after = lines?.[line]?.slice(o.range.length === 4 ? o.range[3]! : o.range[2]!) ?? "";
        if (!/^\s*(?:<[^<>()]*>\s*)?(?:!\s*)?\(/.test(after)) continue;
        const k = `${d.path}\n${o.symbol}`;
        if (!calls.has(k)) {
          calls.add(k);
          index.calls.push({ from: d.path, to: o.symbol, confidence: "exact", top: true });
        }
        continue;
      }
      if (inside.sym === o.symbol) continue;
      const p = parseSymbol(o.symbol);
      if (!p) continue;
      if (bySymbol.has(o.symbol)) {
        const k = `${inside.sym}\n${o.symbol}`;
        if (!calls.has(k)) {
          calls.add(k);
          index.calls.push({ from: inside.sym, to: o.symbol, confidence: "exact" });
        }
      } else if (
        !ours.has(`${p.manager} ${p.pkg}`) &&
        MANAGERS[p.manager] &&
        !isLanguage(p.manager, p.pkg)
      ) {
        const k = `${inside.sym}\n${p.manager} ${p.pkg}`;
        if (!uses.has(k)) {
          uses.add(k);
          index.uses.push({
            from: inside.sym,
            package: {
              ecosystem: MANAGERS[p.manager]!,
              name: p.pkg,
              ...(p.version && p.version !== "." ? { version: p.version } : {}),
            },
          });
        }
      }
    }
  }
  return index;
}
