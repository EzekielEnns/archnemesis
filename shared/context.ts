// What an agent needs to know about one thing, in one call: what it is, where it runs, the
// file it's in, what it calls and what calls it (with the hops between processes), the
// libraries it uses, and the notes and decisions about it. The MCP `context` tool returns it;
// "Copy link" (a link to the box) points an agent at it: MCP open and context read the link.
import {
  mergedContext,
  type Connection,
  type ModelObject,
  type Note,
  type Package,
} from "./model.ts";
import { statsLine, type LibStats } from "./libstats.ts";
import { ancestors, descendants, processOf, type ModelIndex } from "./project.ts";
import { boundaryChain, boundaryOf, crossesRegions } from "./boundaries.ts";
import { columnsText, targetColumn } from "./tables.ts";
import { referenceLines, referencedBy } from "./references.ts";

/** A function's name as code writes it: no parentheses, no arguments. */
const bare = (name: string) => name.replace(/\(.*$/, "").trim();

/**
 * The module it's in (or is), when that module has a path. A module without one (a file
 * planned by name only) has no code ref: its functions aren't in the folder above it, so they
 * fall back to their keys rather than borrow the folder's path (server/signin#dropDoc).
 */
export function codeHome(idx: ModelIndex, id: string): ModelObject | null {
  for (const cur of [id, ...ancestors(idx, id)]) {
    const o = idx.objects.get(cur);
    if (o?.kind === "module") return o.path ? o : null;
  }
  return null;
}

/**
 * How to point at it: repo:path for a module, repo:path#name for a function, the
 * key for anything else. resolveRef reads every one of these back.
 */
export function codeRef(idx: ModelIndex, id: string): string {
  const o = idx.objects.get(id);
  if (!o) return id;
  // A module by its path, unless the path doesn't name it alone: a pattern (server/{auth,signin/*}.ts)
  // or a path another box answers to. Then the name it was given ("core" read as archnm-src:shared).
  if (o.kind === "module" && o.path) {
    const own = !/[*{?]/.test(o.path) && resolveRef(idx, o.path)?.id === o.id;
    // A folder someone named (core over archnm-src:shared) is called by that name; a file, or a
    // folder the import made, by its path ("core" came back as archnm-src:shared).
    const file = /\.[a-z0-9]{1,8}$/i.test(o.path);
    if (!o.key || (own && (file || o.tags.includes("generated")))) return o.path;
  }
  if (o.kind === "function") {
    const home = codeHome(idx, id);
    if (home) return `${home.path}#${bare(o.name)}`;
  }
  return o.key ?? o.id;
}

/** Each path's box, a module before anything else with it, first found first; made once per index
 * (every ref named looked through 20,000 boxes). */
const paths = new WeakMap<ModelIndex, Map<string, ModelObject>>();
function byPath(idx: ModelIndex): Map<string, ModelObject> {
  let m = paths.get(idx);
  if (m) return m;
  m = new Map();
  for (const o of idx.objects.values())
    if (o.kind === "module" && o.path) {
      const p = o.path.replace(/\/+$/, "");
      if (!m.has(p)) m.set(p, o);
    }
  for (const o of idx.objects.values())
    if (o.path) {
      const p = o.path.replace(/\/+$/, "");
      if (!m.has(p)) m.set(p, o);
    }
  paths.set(idx, m);
  return m;
}

/** The object a code reference names, or null (then look it up by key or name). */
export function resolveRef(idx: ModelIndex, ref: string): ModelObject | null {
  const [raw, fn] = ref.trim().split("#", 2) as [string, string | undefined];
  const path = raw.replace(/\/+$/, "");
  if (!path.includes(":")) return null;
  // A module by its path first; then an app or component that holds that path.
  const mod = byPath(idx).get(path);
  if (!mod) return null;
  if (fn === undefined) return mod;
  const want = bare(fn);
  const inside = [mod.id, ...descendants(idx, mod.id)]
    .map((x) => idx.objects.get(x)!)
    .filter(Boolean);
  const fns = inside.filter((o) => o.kind === "function");
  // A method by its class and name (Store.save), or by its name alone when only one has it.
  const exact = fns.find((o) => bare(o.name) === want);
  if (exact) return exact;
  const last = (n: string) => bare(n).split(/\.|::/).pop();
  const loose = fns.filter((o) => last(o.name) === last(want));
  return loose.length === 1 ? loose[0]! : null;
}

/**
 * Where to read about a package: its registry, deps.dev, and its docs where there's a usual
 * place. Unversioned unless asked: these become a library's links, which outlive a version.
 */
export function packageLinks(
  p: Package,
  opts: { versioned?: boolean } = {},
): { title: string; url: string }[] {
  const n = encodeURIComponent(p.name);
  const v = opts.versioned && p.version ? encodeURIComponent(p.version) : "";
  const registry: Partial<Record<Package["ecosystem"], string>> = {
    cargo: `https://crates.io/crates/${n}`,
    npm: `https://www.npmjs.com/package/${p.name.split("/").map(encodeURIComponent).join("/")}`,
    pypi: `https://pypi.org/project/${n}/`,
    go: `https://pkg.go.dev/${p.name}`,
    maven: `https://central.sonatype.com/search?q=${n}`,
    nuget: `https://www.nuget.org/packages/${n}`,
    rubygems: `https://rubygems.org/gems/${n}`,
  };
  const system: Partial<Record<Package["ecosystem"], string>> = {
    cargo: "cargo",
    npm: "npm",
    pypi: "pypi",
    go: "go",
    maven: "maven",
    nuget: "nuget",
  };
  const out: { title: string; url: string }[] = [];
  const where: Partial<Record<Package["ecosystem"], string>> = {
    cargo: "crates.io",
    npm: "npm",
    pypi: "PyPI",
    go: "pkg.go.dev",
    maven: "Maven Central",
    nuget: "NuGet",
    rubygems: "RubyGems",
  };
  if (registry[p.ecosystem])
    out.push({ title: `${p.name} on ${where[p.ecosystem]}`, url: registry[p.ecosystem]! });
  if (system[p.ecosystem])
    out.push({
      title: `${p.name} on deps.dev`,
      url: `https://deps.dev/${system[p.ecosystem]}/${n}${v ? `/${v}` : ""}`,
    });
  if (p.ecosystem === "cargo")
    out.push({ title: `${p.name} docs`, url: `https://docs.rs/${n}${v ? `/${v}` : ""}` });
  return out;
}

export interface Call {
  conn: Connection;
  /** The thing at the other end. */
  other: ModelObject;
  /** It crosses from one process to another. */
  hop: boolean;
  /** Its ends are in different regions: "us-central1 → europe-west2". */
  across: string | null;
}

/** Its calls each way, its insides' included when asked, libraries kept apart. */
export function callsOf(
  idx: ModelIndex,
  id: string,
  withInside = false,
): { calls: Call[]; calledBy: Call[]; libraries: Call[]; usedBy: Call[] } {
  const mine = new Set([id, ...(withInside ? descendants(idx, id) : [])]);
  const out = {
    calls: [] as Call[],
    calledBy: [] as Call[],
    libraries: [] as Call[],
    usedBy: [] as Call[],
  };
  for (const c of idx.connections.values()) {
    const from = mine.has(c.fromId);
    const to = mine.has(c.toId);
    if (from === to) continue;
    const other = idx.objects.get(from ? c.toId : c.fromId);
    if (!other) continue;
    const pa = processOf(idx, c.fromId);
    const pb = processOf(idx, c.toId);
    const call: Call = {
      conn: c,
      other,
      hop: !!pa && !!pb && pa !== pb,
      across: crossesRegions(idx, c.fromId, c.toId),
    };
    if (from) (other.kind === "library" ? out.libraries : out.calls).push(call);
    else (idx.objects.get(id)?.kind === "library" ? out.usedBy : out.calledBy).push(call);
  }
  const byName = (a: Call, b: Call) => a.other.name.localeCompare(b.other.name);
  for (const l of Object.values(out)) l.sort(byName);
  return out;
}

/** Open notes about it or anything inside it, flags for agents first. */
export function notesAbout(
  idx: ModelIndex,
  id: string,
  opts: { forAgent?: boolean; resolved?: boolean } = {},
): Note[] {
  const mine = new Set([id, ...descendants(idx, id)]);
  return [...idx.notes.values()]
    .filter(
      (n) =>
        n.kind === "note" &&
        (opts.resolved || !n.resolved) &&
        (!opts.forAgent || n.forAgent) &&
        (mine.has(n.about ?? "") || (!n.about && mine.has(n.objectId ?? ""))),
    )
    .sort(
      (a, b) =>
        Number(!!b.forAgent) - Number(!!a.forAgent) || a.createdAt.localeCompare(b.createdAt),
    );
}

/** Where it runs: the boundaries it's drawn in, innermost first. */
export function runsIn(idx: ModelIndex, id: string): string[] {
  return boundaryChain(idx, boundaryOf(idx, id)).map((b) => {
    const x = idx.boundaries.get(b)!;
    return `${x.name} (${x.kind})`;
  });
}

/** The bundle, as text an agent reads. */
export function contextText(
  idx: ModelIndex,
  id: string,
  opts: {
    design: string;
    url?: (objectId: string) => string;
    stats?: (p: Package) => LibStats | null;
    limit?: number;
    guesses?: boolean;
  } = { design: "" },
): string {
  const o = idx.objects.get(id);
  if (!o) return `nothing with id ${id}`;
  const limit = opts.limit ?? 30;
  // Its ref, and its id when that's different (what a write's keys, ends and in: can also take).
  const name = (x: ModelObject) => {
    const r = codeRef(idx, x.id);
    const own = x.key ?? x.id;
    // A function's name is its ref's end ("Auth.authorize()" for …#Auth.authorize): said once.
    const said = r.endsWith(`#${x.name.replace(/\(\)$/, "")}`) || r.endsWith(`/${x.name}`);
    return `${said ? "" : `${x.name} `}[${r}${r !== own ? ` · id ${own}` : ""}]`;
  };
  /** The same line many times once, with how many (now ×38); then the first `limit`, and how many more. */
  const tally = (head: string, xs: string[]): string[] => {
    const n = new Map<string, number>();
    for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1);
    const rows = [...n].sort((a, b) => b[1] - a[1]).map(([x, k]) => (k > 1 ? `${x} ×${k}` : x));
    const shown = rows.slice(0, limit);
    return [
      "",
      `${head}${rows.length > limit || rows.length !== xs.length ? ` (${xs.length}${rows.length !== xs.length ? `, ${rows.length} different` : ""})` : ""}:`,
      ...shown,
      ...(rows.length > limit
        ? [
            `  … ${rows.length - limit} more: read {ref: "${codeRef(idx, o.id)}", limit: ${rows.length}}`,
          ]
        : []),
    ];
  };
  const out: string[] = [];
  out.push(
    `${o.name}: ${o.kind}${o.technology ? `, ${o.technology}` : ""}${o.status !== "live" ? `, ${o.status}` : ""}${o.external ? ", external" : ""}`,
  );
  out.push(
    `ref: ${codeRef(idx, o.id)}${codeRef(idx, o.id) !== (o.key ?? o.id) ? ` · id ${o.key ?? o.id}` : ""}${opts.url ? `  ${opts.url(o.id)}` : ""}`,
  );
  const trail = ancestors(idx, o.id)
    .reverse()
    .map((a) => idx.objects.get(a)?.name ?? a);
  if (trail.length) out.push(`inside: ${trail.join(" › ")}`);
  const home = codeHome(idx, o.id);
  if (home && home.id !== o.id) out.push(`file: ${home.path}`);
  // What a planner checks a worker's function by (only types that used it showed it).
  if (o.signature) out.push(`signature: ${o.signature}`);
  if (o.package)
    out.push(
      `package: ${o.package.ecosystem} ${o.package.name}${o.package.version ? ` ${o.package.version}` : ""}`,
    );
  const st = o.package && opts.stats?.(o.package);
  if (st) out.push(`stats: ${statsLine(st)}`);
  const where = runsIn(idx, o.id);
  if (where.length) out.push(`runs in: ${where.join(" › ")}`);
  for (const s of o.sources ?? []) out.push(`source: ${s}`);
  // All of it, never cut: an agent adding to it writes it back whole.
  const text = mergedContext(o.description, o.context);
  if (text) out.push("", text);

  const inside = o.kind === "module" || (idx.children.get(o.id)?.length ?? 0) > 0;
  const all = callsOf(idx, o.id, inside);
  const { libraries, usedBy } = all;
  // Calls only guessed by name are left out unless asked for (mostly noise), and counted.
  const calls = opts.guesses ? all.calls : all.calls.filter((c) => !c.conn.guess);
  const calledBy = opts.guesses ? all.calledBy : all.calledBy.filter((c) => !c.conn.guess);
  const hiddenGuesses = all.calls.length - calls.length + all.calledBy.length - calledBy.length;
  const line = (c: Call, dir: "→" | "←") => {
    const how = [c.conn.name, c.conn.technology].filter(Boolean).join(", ");
    // A key between tables says which column holds it and which it points at.
    const key = c.conn.column
      ? ` by ${c.conn.column} → ${dir === "→" ? c.other.name : o.name}.${targetColumn(dir === "→" ? c.other : o, c.conn.toColumn)}`
      : "";
    return `  ${dir} ${name(c.other)}${key}${c.hop ? " (another process)" : ""}${c.across ? ` (across regions: ${c.across})` : ""}${c.conn.guess ? " (guess)" : ""}${how ? `: ${how}` : ""}`;
  };
  if (inside) {
    const kids = (idx.children.get(o.id) ?? [])
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
    if (kids.length)
      out.push(
        "",
        `inside it (${kids.length}):`,
        ...kids
          .slice(0, limit)
          .map((k) => `  ${k.kind} ${name(k)}${k.technology ? `: ${k.technology}` : ""}`),
        ...(kids.length > limit
          ? [
              `  … ${kids.length - limit} more: read {q: "", in: "${o.key ?? o.id}", limit: ${kids.length}}`,
            ]
          : []),
      );
  }
  if (o.kind === "table") out.push("", ...columnsText(idx, o));
  const data = o.kind === "table";
  if (calls.length)
    out.push(
      ...tally(
        data ? "points to" : "calls",
        calls.map((c) => line(c, "→")),
      ),
    );
  if (calledBy.length)
    out.push(
      ...tally(
        data ? "pointed at or used by" : "called by",
        calledBy.map((c) => line(c, "←")),
      ),
    );
  if (hiddenGuesses)
    out.push(
      "",
      `(${hiddenGuesses} guessed call${hiddenGuesses === 1 ? "" : "s"} left out: matched by name only. read {ref: "${codeRef(idx, o.id)}", guesses: true} shows them)`,
    );
  // Its libraries: dependency references (on it, or inside it when it's a file), and older
  // designs' lines to a library.
  const libs = new Map(libraries.map((c) => [c.other.id, c.other]));
  for (const x of [o.id, ...(inside ? descendants(idx, o.id) : [])])
    for (const r of idx.objects.get(x)?.references ?? []) {
      const lib = r.kind === "dependency" ? idx.objects.get(r.to) : undefined;
      if (lib) libs.set(lib.id, lib);
    }
  if (libs.size)
    out.push(
      "",
      "libraries:",
      ...[...libs.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((l) => {
          const w = l.package && opts.stats?.(l.package)?.warnings;
          return `  ${l.name}${l.package?.version ? ` ${l.package.version}` : ""}${l.description ? `: ${l.description}` : ""}${w?.length ? ` (look twice: ${w.join("; ")})` : ""}`;
        }),
    );
  if (usedBy.length)
    out.push(
      ...tally(
        "used by",
        usedBy.map((c) => `  ${name(c.other)}`),
      ),
    );
  // A library's links start as its package's; one with none yet still says where to read.
  const links = o.links?.length
    ? o.links
    : o.package
      ? packageLinks(o.package, { versioned: true })
      : [];
  if (links.length) out.push("", "links:", ...links.map((l) => `  ${l.title}: ${l.url}`));
  if (o.kind === "library" && !(o.links ?? []).some((l) => !isPackageLink(o.package, l.url)))
    out.push(
      "  (no repository or project docs yet: if you know them, write them as link references)",
    );
  out.push(...referenceLines(idx, o).map((l, i) => (i === 0 ? `\n${l}` : l)));
  if (o.kind === "library") {
    const users = referencedBy(idx, o.id);
    if (users.length)
      out.push(
        "",
        `listed as a dependency by (${users.length}):`,
        ...users.map((u) => `  ${name(u)}`),
      );
  }
  if (o.notes?.trim())
    out.push(
      "",
      "notes (its running doc):",
      ...o.notes
        .trim()
        .split("\n")
        .map((l) => `  ${l}`),
    );

  const decisions = [...idx.decisions.values()].filter((d) => d.affects.includes(o.id));
  if (decisions.length)
    out.push("", "decisions:", ...decisions.map((d) => `  ${d.id}: ${d.title} (${d.status})`));
  const notes = notesAbout(idx, o.id);
  if (notes.length) {
    out.push("", "open notes:");
    for (const n of notes) {
      const about =
        n.about && n.about !== o.id
          ? ` on ${idx.objects.get(n.about)?.name ?? "?"}`
          : n.objectId && n.objectId !== o.id
            ? ` on ${idx.objects.get(n.objectId)?.name ?? "?"}`
            : "";
      out.push(
        `  ${n.forAgent ? "flag" : "note"} ${n.id}${about} · ${n.author.name}: ${n.text.split("\n").join(" ")}`,
      );
      for (const r of idx.replies.get(n.id) ?? [])
        out.push(`    ↳ ${r.author.name}: ${r.text.split("\n").join(" ")}`);
    }
  }
  return out.join("\n");
}

/** Is this one of the links Archnemesis fills in from a library's package (not one a person or agent added)? */
function isPackageLink(p: Package | undefined, url: string): boolean {
  return !!p && packageLinks(p).some((l) => l.url === url);
}
