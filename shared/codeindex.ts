// The neutral code index, the same for every language, and the one step that turns it into
// changes to a design. Language knowledge lives only in the adapters that fill the index
// (server/scip.ts for any SCIP indexer, server/tags.ts for the name-matching fallback,
// server/manifests.ts for libraries).
//
// The step never overwrites what a person wrote: it adds what's new (tagged generated),
// refreshes sources (repo@sha:path:line), and marks generated things that have gone from
// the code as deprecated. Which process runs what isn't in code, so it's never touched.
import type { Change } from "./agent.ts";
import type { ModelObject, Package } from "./model.ts";
import { descendants, type ModelIndex } from "./project.ts";

export interface IndexedFunction {
  /** Unique in the index (a SCIP symbol, or file#name:line). */
  symbol: string;
  name: string;
  /** Repo-relative path. */
  file: string;
  /** 1-based. */
  line: number;
  /** The type it's a method of, if any. */
  owner?: string;
  /** Its signature as the indexer gives it (SCIP's hover text): newId(prefix: string): string. */
  signature?: string;
  /** Its doc comment's first paragraph, if it has one. */
  doc?: string;
}

export interface CodeIndex {
  repo: string;
  sha?: string;
  /** doc: its leading comment (headerComment), what the file is for. */
  files: { path: string; language?: string; doc?: string }[];
  functions: IndexedFunction[];
  /** exact: resolved by a compiler or indexer; name: matched by name only, a guess. */
  /** top: the call is in a file's top-level code, outside any function; from is the file's path. */
  calls: { from: string; to: string; confidence: "exact" | "name"; top?: true }[];
  /** A function using a library (any reference to the package's symbols). */
  uses: { from: string; package: Package }[];
  /** The libraries the manifests declare. */
  packages: (Package & { manifest?: string })[];
}

export const GENERATED = "generated";

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
/** A short stable hash, so long paths make short keys that still differ. */
function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36).slice(0, 5);
}
/** A readable key: the last two parts of the path (and the function), plus a short hash of the whole. */
const keyFor = (readable: string, whole: string) =>
  `${slug(readable).slice(0, 48).replace(/-+$/, "")}-${hash(whole)}`;
const lastTwo = (path: string) => path.split("/").slice(-2).join("-");
const bare = (name: string) => name.replace(/\(.*$/, "").trim();
const dirsOf = (path: string) => {
  const parts = path.split("/");
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
};

export interface ImportOptions {
  /** The object the repo's top folders sit in (a component, an app); by key or name. Folders and files under a box whose path covers them go in that box instead. */
  under: string;
  /** Leave out files matching these (tests, generated code, vendored deps). */
  skip?: (path: string) => boolean;
  /** Which calls come in: exact (resolved by a compiler; the default), all (guesses by name too,
   * marked guess), or none (files and functions only; agents add the calls they confirm). */
  calls?: CallsChoice;
}

/** A path with a pattern in it: *, ** or {a,b}. */
export const isGlob = (path: string) => /[*{]/.test(path);
/** A path pattern as a regex: * within a folder, ** across folders, {a,b} either. */
export function globRe(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (c === "*") re += "[^/]*";
    else if (c === "{") re += "(?:";
    else if (c === "}") re += ")";
    else if (c === ",") re += "|";
    else re += c.replace(/[.+?^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export const CALLS_CHOICES = ["exact", "all", "none"] as const;
export type CallsChoice = (typeof CALLS_CHOICES)[number];

/**
 * How the calls were found, the ways to import them, and which one to pick, for scan. A
 * compiler's calls come in as they are; guesses by name are a choice the agent makes (or asks
 * the person about, when the better way means installing something).
 */
export function callsAdvice(
  index: Pick<CodeIndex, "calls">,
  indexer: { adapter: string; exact: boolean; language?: string; hint?: string } | undefined,
): string {
  const guessed = index.calls.filter((c) => c.confidence === "name").length;
  const exact = index.calls.length - guessed;
  if (!index.calls.length) return "Calls: none found.";
  if (!guessed)
    return `Calls: ${exact}, exact (resolved by ${indexer?.adapter ?? "a compiler"}): import brings them all in.`;
  const by = indexer?.adapter ?? "the index";
  const install = indexer?.hint
    ? `install the SCIP indexer for ${indexer.language}: ${indexer.hint}. Installing is the person's call: ask them first.`
    : `there's no SCIP indexer for ${indexer?.language ?? "this language"}, so this way isn't open.`;
  const rec = indexer?.hint
    ? "Recommended: 1 if the person agrees to install it; otherwise 2."
    : "Recommended: 2.";
  return `Calls: ${guessed} guessed by name${exact ? ` (and ${exact} exact)` : ""}: ${by} can't tell which of two functions with one name a call means, so many are wrong. Three ways, pick one:
  1. Exact calls: ${install}
  2. import with calls: "none": files and functions only; add the calls you confirm by reading the code, as you trace flows. Everything on the map is true, and it's sparser.
  3. import with calls: "all": every guess comes in marked guess (hidden from reads unless guesses: true), for impact and reach across the whole repo; noisy, so curate later.
${rec} Leaving calls out imports only the exact ones${exact ? "" : " (none here)"}.`;
}

export interface ImportPlan {
  changes: Change[];
  added: { modules: number; functions: number; libraries: number; calls: number };
  updated: number;
  deprecated: number;
  /** Where the new modules and functions go: per box (its id), the top folders and files put in it, and how many land inside it in all. */
  placed: Map<string, { top: string[]; modules: number; functions: number; byPath: boolean }>;
  /** Guessed calls left out (calls: exact) or calls left out (calls: none). */
  left: number;
}

/** The changes that bring the design in line with the index. */
export function importChanges(idx: ModelIndex, index: CodeIndex, opts: ImportOptions): ImportPlan {
  const { repo } = index;
  const at = (path: string, line?: number) =>
    `${repo}${index.sha ? `@${index.sha}` : ""}:${path}${line ? `:${line}` : ""}`;
  const plan: ImportPlan = {
    changes: [],
    added: { modules: 0, functions: 0, libraries: 0, calls: 0 },
    updated: 0,
    deprecated: 0,
    placed: new Map(),
    left: 0,
  };
  const files = index.files.filter((f) => !opts.skip?.(f.path));
  const keep = new Set(files.map((f) => f.path));
  const fns = index.functions.filter((f) => keep.has(f.file));

  // What's already modelled: modules by path, functions by file + name, libraries by package.
  const all = [...idx.objects.values()];
  const modByPath = new Map(
    all.filter((o) => o.kind === "module" && o.path).map((o) => [o.path!, o]),
  );
  const libByPkg = new Map(
    all
      .filter((o) => o.kind === "library" && o.package)
      .map((o) => [`${o.package!.ecosystem}/${o.package!.name}`, o]),
  );
  const ref = (o: ModelObject) => o.key ?? o.id;
  const byRef = new Map(all.map((o) => [ref(o), o]));
  const gen = (o: ModelObject) => o.tags.includes(GENERATED);

  // Folders, then files: each in its folder. A folder or file whose path a box already has (an
  // app, a component with path repo:server) is that box; so what's below it goes in it, the
  // deepest such box first. The rest of the top ones go in `under`.
  const unslash = (p: string) => p.replace(/\/+$/, "");
  const holders = new Map(
    all
      .filter(
        (o) =>
          o.kind !== "module" &&
          o.kind !== "function" &&
          o.path &&
          o.path.startsWith(`${repo}:`) &&
          !isGlob(o.path),
      )
      .map((o) => [unslash(o.path!), o]),
  );
  // A box whose path is a pattern (repo:server/git*.ts, repo:server/{live,hub}.ts) claims the
  // files it matches, in a flat folder where no one folder is the box's; the longest pattern wins.
  const globHolders = all
    // A module too: one with a pattern for a path is a grouping of files, not a file.
    .filter(
      (o) => o.kind !== "function" && o.path && o.path.startsWith(`${repo}:`) && isGlob(o.path),
    )
    .map((o) => ({ o, re: globRe(o.path!.slice(repo.length + 1)), len: o.path!.length }))
    .sort((a, b) => b.len - a.len);
  const modKey = new Map<string, string>();
  /** Per path: the box (not a module made here) it lands in, for the dry run. */
  const boxOf = new Map<string, string>();
  const tally = (
    box: string,
    top: string | null,
    what: "modules" | "functions",
    byPath = false,
  ) => {
    const p = plan.placed.get(box) ?? { top: [], modules: 0, functions: 0, byPath };
    if (top) p.top.push(top);
    p[what]++;
    plan.placed.set(box, p);
  };
  const dirs = [...new Set(files.flatMap((f) => dirsOf(f.path)))].sort(
    (a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b),
  );
  const ensureModule = (path: string, isFile: boolean, language?: string, doc?: string) => {
    const full = `${repo}:${path}`;
    const parentDir = dirsOf(path).at(-1);
    const parent = parentDir ? modKey.get(parentDir)! : opts.under;
    // A planned file named but given no path (shares.ts inside server/signin): the same file.
    const named = modByPath.get(full)
      ? undefined
      : (idx.children.get((idx.objects.get(parent) ?? byRef.get(parent))?.id ?? "") ?? []).find(
          (o) => o.kind === "module" && !o.path && o.name === path.split("/").at(-1),
        );
    const had = modByPath.get(full) ?? named;
    const holder = had
      ? undefined
      : (holders.get(full) ?? (isFile ? globHolders.find((g) => g.re.test(path))?.o : undefined));
    // A box whose path is a file (a component that's one file): the file is a module inside it,
    // as every file is, so its functions sit in a file and not in the component.
    if (holder && isFile) {
      const key = keyFor(lastTwo(path), full);
      modKey.set(path, key);
      boxOf.set(path, ref(holder));
      newMods.add(path);
      // Named in the dry run: a pattern that takes a file it shouldn't (git* takes github.ts) shows.
      tally(ref(holder), path, "modules", true);
      plan.changes.push({
        add: {
          id: key,
          name: path.split("/").at(-1)!,
          kind: "module",
          in: ref(holder),
          path: full,
          tags: [GENERATED],
          sources: [at(path)],
          ...(language ? { tech: language } : {}),
          ...(doc ? { context: doc } : {}),
        },
      });
      plan.added.modules++;
      return;
    }
    if (holder) {
      modKey.set(path, ref(holder));
      boxOf.set(path, ref(holder));
      plan.placed.set(
        ref(holder),
        plan.placed.get(ref(holder)) ?? { top: [], modules: 0, functions: 0, byPath: true },
      );
      plan.placed.get(ref(holder))!.byPath = true;
      return;
    }
    if (had) {
      boxOf.set(path, ref(had));
      modKey.set(path, ref(had));
      if (named) modByPath.set(full, had);
      // Planned (status future), and now the code is here: live, with its path if it had none.
      if (had.status === "future" || named) {
        plan.changes.push({
          update: ref(had),
          set: {
            ...(had.status === "future" ? { status: "live" } : {}),
            ...(named ? { path: full } : {}),
            ...(isFile ? { sources: [at(path)] } : {}),
          },
        });
        plan.updated++;
        return;
      }
      if (isFile && gen(had)) {
        const src = [at(path)];
        // A box that claims this file by its path (one given after the import): the file moves in.
        const claim = holders.get(full) ?? globHolders.find((g) => g.re.test(path))?.o;
        const move = claim && claim.id !== had.id && had.parentId !== claim.id;
        if (move) {
          boxOf.set(path, ref(claim));
          tally(ref(claim), null, "modules", true);
        }
        // Its header comment as its context, only where nobody has written one.
        const ctx = !!doc && !had.description?.trim();
        if (
          JSON.stringify(had.sources ?? []) !== JSON.stringify(src) ||
          had.status === "deprecated" ||
          move ||
          ctx
        ) {
          plan.changes.push({
            update: ref(had),
            set: {
              sources: src,
              ...(had.status === "deprecated" ? { status: "live" } : {}),
              ...(move ? { in: ref(claim) } : {}),
              ...(ctx ? { context: doc } : {}),
            },
          });
          plan.updated++;
        }
      }
      return;
    }
    const key = keyFor(lastTwo(path), full);
    modKey.set(path, key);
    // Its box: the parent, unless that's a module made here too (then the parent's box).
    const box = !parentDir ? opts.under : newMods.has(parentDir) ? boxOf.get(parentDir)! : parent;
    boxOf.set(path, box);
    newMods.add(path);
    tally(
      box,
      parentDir && newMods.has(parentDir) ? null : `${path}${isFile ? "" : "/"}`,
      "modules",
    );
    plan.changes.push({
      add: {
        id: key,
        name: path.split("/").at(-1)!,
        kind: "module",
        in: parent,
        path: full,
        tags: [GENERATED],
        ...(isFile ? { sources: [at(path)] } : {}),
        ...(isFile && language ? { tech: language } : {}),
        ...(isFile && doc ? { context: doc } : {}),
      },
    });
    plan.added.modules++;
  };
  const newMods = new Set<string>();
  // A folder whose every file a box claims (by the file, a pattern, or a folder below it) would
  // be an empty box of its own: it isn't made (cli/ and server/signin/ left empty).
  const claimed = (file: string, below: string) =>
    holders.has(`${repo}:${file}`) ||
    globHolders.some((g) => g.re.test(file)) ||
    dirsOf(file).some(
      (x) => x.length > below.length && x.startsWith(`${below}/`) && holders.has(`${repo}:${x}`),
    );
  const empty = (d: string) =>
    !modByPath.has(`${repo}:${d}`) &&
    !holders.has(`${repo}:${d}`) &&
    files.every((f) => !f.path.startsWith(`${d}/`) || claimed(f.path, d));
  for (const d of dirs) if (!empty(d)) ensureModule(d, false);
  for (const f of files) ensureModule(f.path, true, f.language, f.doc);

  // Functions, matched inside their file by name (and owner, for two methods of one name).
  const fnKey = new Map<string, string>();
  const seenFns = new Set<string>();
  // Imported functions moved out of their file (by hand, or by an older import that put them
  // in a box), found by the file their sources name: matched, and moved back, never doubled.
  const srcFile = (o: ModelObject) => {
    const s = o.sources?.[0];
    const m = s ? /^([^:@]+)(?:@[^:]+)?:(.+?)(?::\d+)?$/.exec(s) : null;
    return m && m[1] === repo ? m[2]! : null;
  };
  const strays = new Map<string, ModelObject[]>();
  for (const o of all)
    if (o.kind === "function" && gen(o)) {
      const p = srcFile(o);
      if (p) strays.set(p, [...(strays.get(p) ?? []), o]);
    }
  for (const f of fns) {
    const fileKey = modKey.get(f.file)!;
    const file = modByPath.get(`${repo}:${f.file}`);
    const fileObj = idx.objects.get(fileKey) ?? byRef.get(fileKey);
    const within = file ? new Set(descendants(idx, file.id)) : new Set<string>();
    const inside = [
      ...(file
        ? [file.id, ...within].map((x) => idx.objects.get(x)!).filter((o) => o?.kind === "function")
        : []),
      ...(strays.get(f.file) ?? []).filter((o) => !within.has(o.id)),
    ];
    const tech = f.owner ? `method of ${f.owner}` : undefined;
    // A method is named by its class too (GitSync.propose), as repo:path#GitSync.propose finds it.
    const named =
      f.owner && !f.name.startsWith(`${f.owner}.`) && !f.name.startsWith(`${f.owner}::`)
        ? `${f.owner}.${f.name}`
        : f.name;
    const had =
      inside.find((o) => bare(o.name) === named && !seenFns.has(o.id)) ??
      inside.find(
        (o) =>
          bare(o.name) === f.name &&
          !seenFns.has(o.id) &&
          (!f.owner || !o.technology?.startsWith("method of ") || o.technology === tech),
      );
    const src = [at(f.file, f.line)];
    if (had) {
      seenFns.add(had.id);
      fnKey.set(f.symbol, ref(had));
      // (A method found by its bare name keeps it: a name is a person's to change.)
      // A planned function (status future) goes live when its code lands.
      const goesLive = had.status === "future" || (gen(had) && had.status === "deprecated");
      // One found outside its file goes back in it (a function inside another function stays).
      const home =
        gen(had) &&
        fileObj &&
        !within.has(had.id) &&
        had.parentId !== fileObj.id &&
        idx.objects.get(had.parentId ?? "")?.kind !== "function";
      // The signature is the code's: refreshed on an imported function, as the code changes. One
      // a person wrote where the indexer gives none stays.
      const sig = gen(had) && f.signature && f.signature !== had.signature;
      if (JSON.stringify(had.sources ?? []) !== JSON.stringify(src) || goesLive || home || sig) {
        plan.changes.push({
          update: ref(had),
          set: {
            sources: src,
            ...(goesLive ? { status: "live" } : {}),
            ...(home ? { in: fileKey } : {}),
            ...(sig ? { signature: f.signature } : {}),
          },
        });
        plan.updated++;
      }
      continue;
    }
    const key = keyFor(
      `${f.file.split("/").at(-1)}-${f.owner ? `${f.owner}-` : ""}${f.name}`,
      `${repo}:${f.file}#${f.symbol}`,
    );
    fnKey.set(f.symbol, key);
    // Its signature and doc comment come with it: the comment is the author's own word on what it does.
    plan.changes.push({
      add: {
        id: key,
        name: `${named}()`,
        kind: "function",
        in: fileKey,
        tags: [GENERATED],
        sources: src,
        ...(tech ? { tech } : {}),
        ...(f.signature ? { signature: f.signature } : {}),
        ...(f.doc ? { context: f.doc } : {}),
      },
    });
    plan.added.functions++;
    tally(boxOf.get(f.file) ?? fileKey, null, "functions");
  }

  // Libraries: what the manifests declare, plus anything the code uses that they don't.
  const libKey = new Map<string, string>();
  const pkgs = new Map<string, Package>();
  // What the code uses first, then the manifests, whose versions win. Where an ecosystem has
  // manifests, a package they don't declare is reached through another (a re-export, a
  // macro crate): it isn't a dependency of this repo, so it isn't drawn.
  const declared = new Set(index.packages.map((p) => p.ecosystem));
  const named = new Set(index.packages.map((p) => `${p.ecosystem}/${p.name}`));
  const counts = (p: Package) =>
    !declared.has(p.ecosystem) || named.has(`${p.ecosystem}/${p.name}`);
  for (const p of [...index.uses.map((u) => u.package).filter(counts), ...index.packages]) {
    const k = `${p.ecosystem}/${p.name}`;
    const version = p.version ?? pkgs.get(k)?.version;
    pkgs.set(k, { ecosystem: p.ecosystem, name: p.name, ...(version ? { version } : {}) });
  }
  for (const [k, p] of pkgs) {
    const had = libByPkg.get(k);
    if (had) {
      libKey.set(k, ref(had));
      // A library another repo shares keeps its version: only an unversioned one gets this one's.
      if (p.version && !had.package?.version) {
        plan.changes.push({
          update: ref(had),
          set: { package: { ...had.package!, version: p.version } },
        });
        plan.updated++;
      }
      continue;
    }
    const key = keyFor(`lib-${p.name}`, k);
    libKey.set(k, key);
    plan.changes.push({
      add: { id: key, name: p.name, kind: "library", package: p, tags: [GENERATED] },
    });
    plan.added.libraries++;
  }

  // Calls and uses, where there's no line between the two yet.
  const objIdOf = (key: string) =>
    idx.objects.get(key)?.id ?? [...idx.objects.values()].find((o) => o.key === key)?.id ?? key;
  const linked = new Set([...idx.connections.values()].map((c) => `${c.fromId}>${c.toId}`));
  const connect = (from: string, to: string, confidence: "exact" | "name") => {
    const k = `${objIdOf(from)}>${objIdOf(to)}`;
    if (from === to || linked.has(k)) return;
    linked.add(k);
    plan.changes.push({ connect: { from, to, ...(confidence === "name" ? { guess: true } : {}) } });
    plan.added.calls++;
  };
  const choice = opts.calls ?? "exact";
  for (const c of index.calls) {
    if (choice === "none" || (choice === "exact" && c.confidence === "name")) {
      plan.left++;
      continue;
    }
    const a = c.top ? modKey.get(c.from) : fnKey.get(c.from);
    const b = fnKey.get(c.to);
    if (a && b) connect(a, b, c.confidence);
  }
  // A library a function uses is a dependency reference on it, not a line: the References
  // layer draws it beside the function, and it lights everything else that uses it.
  const usesOf = new Map<string, Set<string>>();
  for (const u of index.uses) {
    const a = fnKey.get(u.from);
    const b = libKey.get(`${u.package.ecosystem}/${u.package.name}`);
    if (a && b) usesOf.set(a, (usesOf.get(a) ?? new Set()).add(b));
  }
  for (const [fn, libs] of usesOf) {
    // Added in this plan: set after the libraries are (they come later in it).
    if (plan.changes.some((c) => "add" in c && c.add.id === fn)) {
      plan.changes.push({
        update: fn,
        set: { references: [...libs].map((l) => ({ dependency: l })) },
      });
      continue;
    }
    // Already modelled: keep what it points at, and add the libraries it doesn't yet.
    const o = idx.objects.get(objIdOf(fn));
    if (!o) continue;
    const has = new Set(
      (o.references ?? []).filter((r) => r.kind === "dependency").map((r) => r.to),
    );
    const fresh = [...libs].filter((l) => !has.has(objIdOf(l)));
    if (!fresh.length) continue;
    plan.changes.push({
      update: fn,
      set: {
        references: [
          ...(o.links ?? []).map((l) => ({ link: l.url, ...(l.title ? { title: l.title } : {}) })),
          ...(o.references ?? []).map((r) => ({
            [r.kind]: r.to,
            ...(r.title ? { title: r.title } : {}),
          })),
          ...fresh.map((l) => ({ dependency: l })),
        ],
      },
    });
    plan.updated++;
  }

  // Generated things in this repo that the code no longer has.
  const live = new Set([...modKey.values(), ...fnKey.values()]);
  for (const o of all) {
    if (!gen(o) || o.status === "deprecated" || live.has(ref(o))) continue;
    const home =
      o.kind === "module" ? o.path : o.kind === "function" ? homePath(idx, o) : undefined;
    if (!home?.startsWith(`${repo}:`)) continue;
    plan.changes.push({ update: ref(o), set: { status: "deprecated" } });
    plan.deprecated++;
  }
  return plan;
}

function homePath(idx: ModelIndex, o: ModelObject): string | undefined {
  let cur = o.parentId ? idx.objects.get(o.parentId) : undefined;
  while (cur && !(cur.kind === "module" && cur.path))
    cur = cur.parentId ? idx.objects.get(cur.parentId) : undefined;
  return cur?.path;
}

/** In plain words, for the person running the import: the totals, then where things go. */
export function importSummary(
  p: ImportPlan,
  opts: { under?: string; calls?: CallsChoice } = {},
): string {
  const a = p.added;
  const left = p.left
    ? ` (${p.left} calls the index ${opts.calls === "none" ? "has" : "only guessed by name"} left out: calls: ${opts.calls === "none" ? '"exact" or "all"' : '"all"'} brings them in)`
    : "";
  const totals = `${a.modules} files and folders, ${a.functions} functions, ${a.libraries} libraries and ${a.calls} calls added${left}; ${p.updated} refreshed; ${p.deprecated} marked deprecated (gone from the code)`;
  const rows = [...p.placed].filter(([, x]) => x.modules || x.functions || x.byPath);
  if (!rows.length) return totals;
  const list = (xs: string[]) =>
    xs.length > 8 ? `${xs.slice(0, 8).join(", ")}, … ${xs.length - 8} more` : xs.join(", ");
  const lines = rows
    .sort((x, y) => y[1].modules + y[1].functions - (x[1].modules + x[1].functions))
    .map(
      ([box, x]) =>
        `  ${box}${x.byPath ? " (by its path)" : box === opts.under ? " (under)" : ""}: ${x.top.length ? `${list(x.top)}; ` : ""}${x.modules} file${x.modules === 1 ? "" : "s"} and folders, ${x.functions} function${x.functions === 1 ? "" : "s"}`,
    );
  return `${totals}
where they go (a folder or file whose path a box has goes in that box; the rest in under):
${lines.join("\n")}`;
}

/**
 * A file's leading comment, as what the file is for (its first paragraph): line comments (//, #,
 * --, ;, %), a block comment (slash-star, (* *), {- -}) or a docstring (""" or '''), after a shebang
 * or an encoding line, skipping a licence header. By the shape of comments, not by language,
 * so it reads any language that writes one at the top; null when there's none.
 */
export function headerComment(text: string, cap = 400): string | null {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  let i = 0;
  const blank = () => {
    // Also the imports some files put first (a one-line import, use, package or include).
    while (
      i < lines.length &&
      (!lines[i]!.trim() ||
        /^#!/.test(lines[i]!) ||
        /^#.*coding[:=]/.test(lines[i]!) ||
        /^\s*(["']use strict["'];?|<\?php)\s*$/.test(lines[i]!) ||
        /^\s*(import|from|use|using|package|require|extern crate|#include|@file:)\b.*([;)'"]|\w)\s*$/.test(
          lines[i]!,
        ))
    )
      i++;
  };
  const LINE =
    /^\s*(\/\/[/!]?|#(?![!\[{]|include|define|if|ifdef|ifndef|endif|else|elif|pragma|import|undef|error|region|endregion)|--(?!\[)|;+|%+)\s?(.*)$/;
  const BLOCKS: [RegExp, RegExp][] = [
    [/^\s*\/\*+!?/, /\*+\//],
    [/^\s*\(\*+/, /\*+\)/],
    [/^\s*\{-\|?/, /-\}/],
    [/^\s*"""/, /"""/],
    [/^\s*'''/, /'''/],
    [/^\s*--\[\[/, /\]\]/],
  ];
  const one = (): string[] | null => {
    blank();
    if (i >= lines.length) return null;
    const first = lines[i]!;
    for (const [open, close] of BLOCKS) {
      const m = open.exec(first);
      if (!m) continue;
      const out: string[] = [];
      let rest = first.slice(m[0].length);
      for (;;) {
        const end = close.exec(rest);
        if (end) {
          out.push(rest.slice(0, end.index));
          i++;
          return out.map((l) => l.replace(/^\s*\*?\s?/, ""));
        }
        out.push(rest);
        if (++i >= lines.length) return out.map((l) => l.replace(/^\s*\*?\s?/, ""));
        rest = lines[i]!;
      }
    }
    const out: string[] = [];
    for (let m = LINE.exec(lines[i] ?? ""); i < lines.length && m; m = LINE.exec(lines[++i] ?? ""))
      out.push(m[2] ?? "");
    return out.length ? out : null;
  };
  for (let tries = 0; tries < 3; tries++) {
    const block = one();
    if (!block) return null;
    // Tool directives are lines of their own (// @ts-nocheck, # type: ignore); a licence is the whole block.
    const body = block
      .filter(
        (l) =>
          !/^\s*(@ts-|eslint-|prettier-ignore|type:\s*ignore|pylint:|noqa|-\*-|jshint|global\s|#region|#endregion)/i.test(
            l,
          ),
      )
      .join("\n")
      .trim();
    if (!body || /copyright|spdx-license|licensed under|all rights reserved|@license/i.test(body))
      continue;
    const para = body
      .split(/\n\s*\n/)[0]!
      .replace(/\s+/g, " ")
      .trim();
    if (!/[a-z]{3}/i.test(para)) continue;
    return para.length > cap ? `${para.slice(0, cap - 1).replace(/\s+\S*$/, "")}…` : para;
  }
  return null;
}
