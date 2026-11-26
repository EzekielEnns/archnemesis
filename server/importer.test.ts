// The importer: SCIP and ctags into the neutral index, manifests into libraries, and the one
// step that turns an index into changes (adds, refreshes, deprecates, never overwrites).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { planChanges } from "../shared/agent.ts";
import { callsAdvice, importChanges, importSummary, type CodeIndex } from "../shared/codeindex.ts";
import { fillFrom, scipHint } from "./importer.ts";
import { applyOps, emptyState, mirror, type Actor } from "../shared/doc.ts";
import { keyOps, readFiles, toOps, writeFiles } from "../shared/files.ts";
import { buildIndex } from "../shared/project.ts";
import {
  readCargoLock,
  readCargoToml,
  readGoMod,
  readPackageJson,
  readPom,
  readPyproject,
  readRequirements,
} from "./manifests.ts";
import { functionName, parseSymbol, scipToIndex } from "./scip.ts";
import { seedOps } from "../shared/seed.ts";
import { builtinTags, readFrom, tagsToIndex } from "./tags.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const me: Actor = { id: "t", name: "T", kind: "agent" };
const toy = () =>
  scipToIndex(readFileSync(new URL("./testdata/toy.scip", import.meta.url)), {
    repo: "toy",
    sha: "abc123",
  });

function shop() {
  const doc = new Y.Doc();
  const state = emptyState();
  mirror(doc, state, () => {});
  applyOps(doc, state, seedOps(), me, "seed");
  applyOps(doc, state, keyOps(state), me, "keys");
  const idx = () =>
    buildIndex({
      objects: state.objects.values(),
      connections: state.connections.values(),
      diagrams: state.diagrams.values(),
      placements: state.placements.values(),
      flows: state.flows.values(),
    });
  const run = (index: CodeIndex) => {
    const plan = importChanges(idx(), index, { under: "cart", calls: "all" });
    if (plan.changes.length)
      applyOps(doc, state, planChanges(state, idx(), plan.changes).ops, me, "import");
    return plan;
  };
  return { doc, state, idx, run };
}
const fnNamed = (s: ReturnType<typeof shop>, name: string) =>
  [...s.state.objects.values()].find((o) => o.name === name)!;

describe("SCIP", () => {
  it("reads symbols the way every indexer writes them", () => {
    expect(parseSymbol("rust-analyzer cargo toy 0.1.0 hub/serve().")).toEqual({
      manager: "cargo",
      pkg: "toy",
      version: "0.1.0",
      descriptors: "hub/serve().",
    });
    expect(parseSymbol("local 3")).toBeNull();
    expect(functionName("hub/impl#[Hub]post().")).toEqual({ name: "post", owner: "Hub" });
    expect(functionName("src/`cart.ts`/Cart#add(+1).")).toEqual({ name: "add", owner: "Cart" });
    expect(functionName("hub/Hub#")).toBeNull();
  });

  it("turns rust-analyzer's index into functions and exact calls", () => {
    const ix = toy();
    expect(ix.files.map((f) => f.path).sort()).toEqual([
      "src/hub/mod.rs",
      "src/hub/store.rs",
      "src/main.rs",
    ]);
    expect(
      ix.functions
        .map((f) => `${f.owner ? `${f.owner}.` : ""}${f.name}@${f.file}:${f.line}`)
        .sort(),
    ).toEqual([
      "Hub.new@src/hub/mod.rs:4",
      "Hub.post@src/hub/mod.rs:5",
      "append@src/hub/store.rs:1",
      "main@src/main.rs:2",
      "serve@src/hub/mod.rs:7",
    ]);
    const name = (sym: string) => ix.functions.find((f) => f.symbol === sym)!.name;
    expect(ix.calls.map((c) => `${name(c.from)}→${name(c.to)}:${c.confidence}`).sort()).toEqual([
      "main→new:exact",
      "main→serve:exact",
      "post→append:exact",
      "serve→post:exact",
    ]);
  });
});

describe("ctags fallback", () => {
  it("guesses calls by name, only where the name is one function", () => {
    const tags = [
      { _type: "tag", name: "load", path: "a.py", line: 1, kind: "function", language: "Python" },
      { _type: "tag", name: "save", path: "a.py", line: 4, kind: "function", language: "Python" },
      { _type: "tag", name: "run", path: "b.py", line: 1, kind: "function", language: "Python" },
      {
        _type: "tag",
        name: "save",
        path: "b.py",
        line: 5,
        kind: "method",
        scope: "Store",
        scopeKind: "class",
        language: "Python",
      },
      { _type: "tag", name: "other", path: "c.py", line: 1, kind: "function", language: "Python" },
    ]
      .map((t) => JSON.stringify(t))
      .join("\n");
    const src: Record<string, string> = {
      "a.py": "def load():\n  save()\n\ndef save():\n  pass\n",
      "b.py": "def run():\n  load()\n  save()\n\n  def save(self):\n    pass\nfrom a import load\n",
      "c.py": "def other():\n  load()\n",
    };
    const ix = tagsToIndex(tags, { repo: "r", read: (p) => src[p] ?? null });
    const name = (sym: string) => ix.functions.find((f) => f.symbol === sym)!;
    const calls = ix.calls
      .map(
        (c) =>
          `${name(c.from).file}:${name(c.from).name}→${name(c.to).file}:${name(c.to).name}:${c.confidence}`,
      )
      .sort();
    // load → save: two saves, but one in a.py itself. run → load: the only load. run → save:
    // b.py's own save (a method; still the one in this file). c.py calls a load() it never
    // imported: not a call.
    expect(calls).toEqual([
      "a.py:load→a.py:save:name",
      "b.py:run→a.py:load:name",
      "b.py:run→b.py:save:name",
    ]);
    expect(ix.functions.find((f) => f.owner)?.owner).toBe("Store");
  });

  it("the built-in reader finds methods, arrow functions in consts, and files with no functions", () => {
    const dir = mkdtempSync(join(tmpdir(), "archnm-tags-"));
    try {
      const files: Record<string, string> = {
        "sync.ts": [
          "export class GitSync {",
          "  private timer = 0;",
          "  async forkFor(by: Principal): Promise<{ live: Live; created: boolean }> {",
          "    const x = (await this.find(by)).map((y) => y.id);",
          "    return x;",
          "  }",
          "  async propose(",
          "    doc: string,",
          "    link: string,",
          "  ): Promise<{ url: string | null }> {",
          "    return { url: null };",
          "  }",
          "  onTick = async (n: number) => {",
          "    return n;",
          "  };",
          "}",
        ].join("\n"),
        "main.ts": [
          "const json = (res: Res, code: number, body: unknown) => {",
          "  res.end(JSON.stringify(body));",
          "};",
          "const withChannel = <T extends object>(x: T, token: string | null = null) => ({ ...x });",
          "const kinds = (KINDS as readonly string[]).find((k) => k === 'a');",
          "export const handler = async (",
          "  req: Req,",
          ") => {};",
        ].join("\n"),
        "types.ts": "export interface A { b: string }\nexport const LIMIT = 3;\n",
      };
      for (const [p, t] of Object.entries(files)) writeFileSync(join(dir, p), t);
      const ix = tagsToIndex(builtinTags(dir, Object.keys(files)), {
        repo: "r",
        read: readFrom(dir),
        files: Object.keys(files),
      });
      expect(ix.functions.map((f) => (f.owner ? `${f.owner}.${f.name}` : f.name)).sort()).toEqual([
        "GitSync.forkFor",
        "GitSync.onTick",
        "GitSync.propose",
        "handler",
        "json",
        "withChannel",
      ]);
      expect(ix.files.map((f) => f.path).sort()).toEqual(["main.ts", "sync.ts", "types.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Trial 8: guesses only link to what the calling file can see.
describe("guessed calls follow imports", () => {
  const index = (files: Record<string, string>, dirs: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), "archnm-guess-"));
    try {
      for (const d of dirs) mkdirSync(join(dir, d));
      for (const [p, t] of Object.entries(files)) writeFileSync(join(dir, p), t);
      const ix = tagsToIndex(builtinTags(dir, Object.keys(files)), {
        repo: "r",
        read: readFrom(dir),
        files: Object.keys(files),
      });
      const name = new Map(ix.functions.map((f) => [f.symbol, `${f.file}#${f.name}`]));
      return ix.calls.map((c) => `${name.get(c.from)}→${name.get(c.to)}`).sort();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("links a name only to its own file or a file it imports, and not res.end() to some end()", () => {
    const calls = index(
      {
        "main.ts": [
          'import { load } from "./lib/store.ts";',
          "import * as live from './live.ts';",
          "export function json(res: Res) {",
          "  res.end('x');",
          "  load();",
          "  live.commit();",
          "  render();",
          "}",
        ].join("\n"),
        "lib/store.ts": ["export function load() {", "  return 1;", "}"].join("\n"),
        "live.ts": ["export function commit() {", "  return 2;", "}"].join("\n"),
        "whatsnew.ts": [
          "export function end() {",
          "  return 3;",
          "}",
          "export function render() {",
          "  return 4;",
          "}",
        ].join("\n"),
      },
      ["lib"],
    );
    // load (imported), live.commit (a namespace import); not end (a method on res), not render (never imported).
    expect(calls).toEqual(["main.ts#json→lib/store.ts#load", "main.ts#json→live.ts#commit"]);
  });

  it("reads Python imports", () => {
    const calls = index(
      {
        "app.py": [
          "from pkg.util import tidy",
          "def main():",
          "    tidy()",
          "    stray()",
          "",
        ].join("\n"),
        "pkg/util.py": ["def tidy():", "    pass", ""].join("\n"),
        "other/misc.py": ["def stray():", "    pass", ""].join("\n"),
      },
      ["pkg", "other"],
    );
    expect(calls).toEqual(["app.py#main→pkg/util.py#tidy"]);
  });
});

describe("import", () => {
  it("adds folders, files, functions and calls under the object it's given, tagged generated", () => {
    const s = shop();
    const plan = s.run(toy());
    expect(plan.added).toEqual({ modules: 5, functions: 5, libraries: 0, calls: 4 });
    const store = [...s.state.objects.values()].find((o) => o.path === "toy:src/hub/store.rs")!;
    expect(store.tags).toContain("generated");
    expect(s.state.objects.get(s.state.objects.get(store.parentId!)!.parentId!)?.path).toBe(
      "toy:src",
    );
    // A method is named with its class.
    const post = fnNamed(s, "Hub.post()");
    expect(post.technology).toBe("method of Hub");
    expect(post.sources).toEqual(["toy@abc123:src/hub/mod.rs:5"]);
    expect(
      [...s.state.connections.values()].some(
        (c) => c.fromId === post.id && c.toId === fnNamed(s, "append()").id,
      ),
    ).toBe(true);
  });

  it("changes nothing the second time, and round-trips through the files", () => {
    const s = shop();
    s.run(toy());
    expect(s.run(toy()).changes).toEqual([]);
    const files = writeFiles(s.state);
    expect(files.get("code/toy/src/hub/mod.rs.yaml")).toContain("name: Hub.post()");
    expect(toOps(s.state, readFiles(files).model)).toEqual([]);
  });

  it("never overwrites what a person wrote, refreshes sources, deprecates what's gone", () => {
    const s = shop();
    s.run(toy());
    const post = fnNamed(s, "Hub.post()");
    applyOps(
      s.doc,
      s.state,
      planChanges(s.state, s.idx(), [
        { update: post.key ?? post.id, set: { description: "Adds a message.", name: "post()" } },
      ]).ops,
      me,
      "person",
    );
    const next = toy();
    next.sha = "def456";
    next.functions = next.functions.filter((f) => f.name !== "append");
    next.calls = next.calls.filter((c) => !c.to.includes("append"));
    const plan = s.run(next);
    expect(plan.deprecated).toBe(1);
    expect(fnNamed(s, "append()").status).toBe("deprecated");
    expect(fnNamed(s, "post()").description).toBe("Adds a message.");
    expect(fnNamed(s, "post()").sources).toEqual(["toy@def456:src/hub/mod.rs:5"]);
    // Back again: live again.
    s.run(toy());
    expect(fnNamed(s, "append()").status).toBe("live");
  });

  it("joins functions and libraries, a manifest's version winning", () => {
    const s = shop();
    const ix = toy();
    const post = ix.functions.find((f) => f.name === "post")!.symbol;
    ix.uses = [{ from: post, package: { ecosystem: "cargo", name: "serde", version: "1.0.0" } }];
    ix.packages = [
      { ecosystem: "cargo", name: "serde", version: "1.0.229", manifest: "Cargo.toml" },
    ];
    s.run(ix);
    const serde = [...s.state.objects.values()].find(
      (o) => o.kind === "library" && o.package?.name === "serde",
    )!;
    expect(serde.package?.version).toBe("1.0.229");
    // Used, it's a dependency reference on the function, not a line.
    expect(fnNamed(s, "Hub.post()").references).toEqual([{ kind: "dependency", to: serde.id }]);
    expect([...s.state.connections.values()].some((c) => c.toId === serde.id)).toBe(false);
    // Again: nothing new to add.
    s.run(ix);
    expect(fnNamed(s, "Hub.post()").references).toHaveLength(1);
  });

  it("marks a guessed call so it's drawn fainter", () => {
    const s = shop();
    const ix = toy();
    ix.calls = ix.calls.map((c) => ({ ...c, confidence: "name" as const }));
    s.run(ix);
    const c = [...s.state.connections.values()].find((c) => c.fromId === fnNamed(s, "serve()").id)!;
    expect(c.guess).toBe(true);
    expect(writeFiles(s.state).get("code/toy/src/hub/mod.rs.yaml")).toContain("guess: true");
  });

  it("brings in the calls asked for: exact by default, all, or none", () => {
    const ix = toy();
    const guessed = {
      ...ix,
      calls: ix.calls.map((c, i) => ({
        ...c,
        confidence: i % 2 ? ("name" as const) : ("exact" as const),
      })),
    };
    const exact = guessed.calls.filter((c) => c.confidence === "exact").length;
    const s = shop();
    const by = (calls?: "exact" | "all" | "none") =>
      importChanges(s.idx(), guessed, { under: "cart", calls });
    expect(by().added.calls).toBeLessThanOrEqual(exact);
    expect(by().left).toBe(guessed.calls.length - exact);
    expect(by("all").left).toBe(0);
    expect(by("all").added.calls).toBeGreaterThan(by().added.calls);
    expect(by("none").added.calls).toBe(0);
    expect(by("none").added.functions).toBe(by("all").added.functions);
    expect(importSummary(by(), { under: "cart" })).toContain(
      'guessed by name left out: calls: "all" brings them in',
    );
  });

  it("draws a call from a file's top-level code from the file itself", () => {
    const s = shop();
    const ix = toy();
    const target = ix.functions[0]!;
    const file = ix.files.find((f) => f.path !== target.file)?.path ?? target.file;
    ix.calls = [{ from: file, to: target.symbol, confidence: "exact", top: true }];
    expect(s.run(ix).added.calls).toBe(1);
    const mod = [...s.state.objects.values()].find(
      (o) => o.kind === "module" && o.path === `toy:${file}`,
    )!;
    expect([...s.state.connections.values()].filter((c) => c.fromId === mod.id)).toHaveLength(1);
  });

  it("fills in the files a SCIP index left out, from the fallback reader, as guesses", () => {
    const scip: CodeIndex = {
      repo: "r",
      files: [{ path: "src/a.ts" }],
      functions: [{ symbol: "scip a", name: "run", file: "src/a.ts", line: 1 }],
      calls: [],
      uses: [],
      packages: [],
    };
    const fb: CodeIndex = {
      repo: "r",
      files: [{ path: "src/a.ts" }, { path: "cli/main.ts" }],
      functions: [
        { symbol: "src/a.ts#run:1", name: "run", file: "src/a.ts", line: 1 },
        { symbol: "cli/main.ts#main:3", name: "main", file: "cli/main.ts", line: 3 },
      ],
      calls: [
        { from: "cli/main.ts#main:3", to: "src/a.ts#run:1", confidence: "name" },
        { from: "src/a.ts#run:1", to: "cli/main.ts#main:3", confidence: "name" },
      ],
      uses: [],
      packages: [],
    };
    fillFrom(scip, fb, new Set(["cli/main.ts"]));
    expect(scip.functions.map((f) => f.symbol)).toEqual(["scip a", "cli/main.ts#main:3"]);
    // The other end is named as the SCIP index names it.
    expect(scip.calls).toEqual([
      { from: "cli/main.ts#main:3", to: "scip a", confidence: "name" },
      { from: "scip a", to: "cli/main.ts#main:3", confidence: "name" },
    ]);
    expect(scip.files.map((f) => f.path)).toEqual(["src/a.ts", "cli/main.ts"]);
  });

  it("tells the agent how its calls were found and which way to import them", () => {
    const named = { calls: [{ from: "a", to: "b", confidence: "name" as const }] };
    const ts = callsAdvice(named, {
      adapter: "Archnemesis's built-in reader",
      exact: false,
      language: "typescript",
      hint: scipHint("typescript"),
    });
    expect(ts).toContain("1 guessed by name");
    expect(ts).toContain("@sourcegraph/scip-typescript");
    expect(ts).toContain("Recommended: 1 if the person agrees");
    const elixir = callsAdvice(named, { adapter: "Universal Ctags", exact: false, language: "ex" });
    expect(elixir).toContain("no SCIP indexer for ex");
    expect(elixir).toContain("Recommended: 2.");
    expect(
      callsAdvice(
        { calls: [{ from: "a", to: "b", confidence: "exact" }] },
        { adapter: "SCIP (scip-typescript)", exact: true },
      ),
    ).toBe("Calls: 1, exact (resolved by SCIP (scip-typescript)): import brings them all in.");
    // Every language with a SCIP indexer gets a way to it; one Archnemesis doesn't run itself says to pass --scip.
    expect(scipHint("ruby")).toContain("--scip index.scip");
    expect(scipHint("lua")).toBeUndefined();
  });
});

describe("manifests", () => {
  it("reads Cargo with its lock, leaving path and workspace-local crates out", () => {
    const lock = readCargoLock(
      '[[package]]\nname = "axum"\nversion = "0.8.9"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n\n[[package]]\nname = "board"\nversion = "0.1.0"\n',
    );
    const toml =
      '[package]\nname = "board"\n\n[dependencies]\naxum = "0.8"\nserde = { version = "1.0.200", features = ["derive"] }\nlocal = { path = "../local" }\ntokio.workspace = true\n\n[dependencies.clap]\nversion = "4.5"\n\n[dev-dependencies]\ntempfile = "3"\n';
    expect(
      readCargoToml(toml, "Cargo.toml", lock).map((p) => `${p.name}@${p.version ?? ""}`),
    ).toEqual(["axum@0.8.9", "serde@1.0.200", "tokio@", "clap@4.5", "tempfile@3"]);
  });
  it("reads npm, Python, Go and Maven", () => {
    expect(
      readPackageJson(
        '{"dependencies":{"yjs":"^13.6.0","local":"workspace:*"},"devDependencies":{"vitest":"~3.1.2"}}',
        "package.json",
      ).map((p) => `${p.name}@${p.version}`),
    ).toEqual(["vitest@3.1.2", "yjs@13.6.0"]);
    expect(
      readRequirements(
        "fastapi==0.115.0\npydantic>=2\n# no\n-r other.txt\nuvicorn[standard]\n",
        "r.txt",
      ).map((p) => `${p.name}@${p.version ?? ""}`),
    ).toEqual(["fastapi@0.115.0", "pydantic@2", "uvicorn@"]);
    expect(
      readPyproject(
        '[project]\ndependencies = [\n  "httpx>=0.27",\n  "rich",\n]\n',
        "pyproject.toml",
      ).map((p) => p.name),
    ).toEqual(["httpx", "rich"]);
    expect(
      readGoMod(
        "module x\n\nrequire (\n\tgithub.com/a/b v1.2.3\n\tgolang.org/x/net v0.30.0 // indirect\n)\nrequire github.com/c/d v0.1.0\n",
        "go.mod",
      ).map((p) => `${p.name}@${p.version}`),
    ).toEqual(["github.com/a/b@1.2.3", "github.com/c/d@0.1.0"]);
    expect(
      readPom(
        "<dependency><groupId>org.x</groupId><artifactId>y</artifactId><version>1.0</version></dependency>",
        "pom.xml",
      )[0],
    ).toMatchObject({ ecosystem: "maven", name: "org.x:y", version: "1.0" });
  });
});
