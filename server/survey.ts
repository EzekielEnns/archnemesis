// A repo's survey: the evidence an agent needs to decide what the architecture is, without
// reading the whole repo. What runs (Dockerfiles, compose services, Procfiles, Kubernetes,
// Terraform Cloud Run / Lambda / functions, package bins, entry points), what holds state
// (datastore images, database URLs), what it serves (OpenAPI specs), and what it's written
// in. It decides nothing: what's a service and what talks to what is the agent's call; what
// the survey can't tell, it says (gaps), rather than guessing.
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

interface Runnable {
  /** How it was found. */
  kind:
    | "dockerfile"
    | "compose"
    | "procfile"
    | "kubernetes"
    | "terraform"
    | "bin"
    | "entry"
    | "serverless";
  name: string;
  /** Where (repo-relative), with a line when it's a part of a file. */
  at: string;
  /** What it says about itself: a base image, a command, a port, the folder it builds. */
  detail?: string;
}

interface StoreHint {
  /** postgres, redis, mysql, mongo, … */
  kind: string;
  name: string;
  at: string;
}

interface ApiSpec {
  at: string;
  title?: string;
  paths?: number;
}

export interface Survey {
  repo: string;
  sha?: string;
  files: number;
  /** Files per language, most first. */
  languages: { language: string; files: number }[];
  runnables: Runnable[];
  stores: StoreHint[];
  apis: ApiSpec[];
  /** The language most of a folder's code is in, for its first two levels (app-service, human-signals/cmd). */
  folderLanguages?: Record<string, string>;
  /** Folders that look like their own project (a manifest of their own): a monorepo's parts. */
  projects: { at: string; manifest: string; name?: string }[];
  /** How the code was indexed, and how to make it exact if it isn't. */
  indexer?: {
    adapter: string;
    exact: boolean;
    language?: string;
    hint?: string;
    functions?: string;
  };
  /** What the survey couldn't tell. */
  gaps: string[];
}

const LANG: Record<string, string> = {
  ".py": "python",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".rb": "ruby",
  ".cs": "csharp",
  ".php": "php",
  ".swift": "swift",
  ".scala": "scala",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".ex": "elixir",
  ".exs": "elixir",
  ".dart": "dart",
  ".lua": "lua",
  ".sh": "shell",
  ".tf": "terraform",
  ".sql": "sql",
  ".vue": "vue",
  ".svelte": "svelte",
};
const languageOf = (path: string): string | undefined => {
  const m = /\.[^./]+$/.exec(path);
  return m ? LANG[m[0].toLowerCase()] : undefined;
};

/** Datastores by what their image or URL says. */
const STORE_IMAGES: [RegExp, string][] = [
  [/postgres|postgis|timescale|supabase\/postgres/i, "postgres"],
  [/\bredis|valkey|keydb|dragonfly/i, "redis"],
  [/mysql|mariadb/i, "mysql"],
  [/mongo/i, "mongo"],
  [/elasticsearch|opensearch/i, "search"],
  [/rabbitmq/i, "rabbitmq"],
  [/kafka|redpanda/i, "kafka"],
  [/nats\b/i, "nats"],
  [/minio|fake-gcs|localstack|azurite/i, "object storage"],
  [/firestore|firebase|datastore-emulator/i, "firestore"],
  [/bigquery/i, "bigquery"],
  [/spanner/i, "spanner"],
  [/memcached/i, "memcached"],
  [/clickhouse/i, "clickhouse"],
  [/cassandra|scylla/i, "cassandra"],
  [/dynamodb/i, "dynamodb"],
  [/sqlite/i, "sqlite"],
];
const storeKind = (s: string) => STORE_IMAGES.find(([re]) => re.test(s))?.[1];

const MAX_READ = 512 * 1024;
const read = (root: string, path: string): string | null => {
  try {
    const p = join(root, path);
    if (statSync(p).size > MAX_READ) return null;
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
};
const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length;

/** Compose services (indentation-based, enough for compose's shape; no YAML library needed in the script). */
function composeServices(text: string): {
  name: string;
  line: number;
  image?: string;
  build?: string;
  command?: string;
  ports?: string;
}[] {
  const lines = text.split("\n");
  const out: {
    name: string;
    line: number;
    image?: string;
    build?: string;
    command?: string;
    ports?: string;
  }[] = [];
  let inServices = false;
  let indent = -1;
  let cur: (typeof out)[number] | null = null;
  lines.forEach((raw, i) => {
    const line = raw.replace(/\s+#.*$/, "");
    if (!line.trim()) return;
    const lead = line.length - line.trimStart().length;
    if (lead === 0) {
      inServices = /^services:\s*$/.test(line);
      cur = null;
      return;
    }
    if (!inServices) return;
    if (indent < 0) indent = lead;
    if (lead === indent) {
      const m = /^\s*([\w.-]+):\s*$/.exec(line);
      cur = m ? { name: m[1]!, line: i + 1 } : null;
      if (cur) out.push(cur);
      return;
    }
    if (!cur || lead !== indent * 2) return;
    const kv = /^\s*(image|build|command|ports|entrypoint):\s*(.*)$/.exec(line);
    if (!kv) return;
    const v = kv[2]!.trim().replace(/^["']|["']$/g, "");
    const c = cur as (typeof out)[number];
    if (kv[1] === "image") c.image = v;
    else if (kv[1] === "build") c.build = v || "(build section)";
    else if (kv[1] === "command" || kv[1] === "entrypoint") c.command ??= v.slice(0, 120);
    else if (kv[1] === "ports")
      c.ports = v || lines[i + 1]?.trim().replace(/^-\s*/, "").replace(/["']/g, "");
  });
  return out;
}

/** The survey of a repo's files (repo-relative paths, already filtered to the product). */
export function surveyRepo(root: string, repo: string, files: string[], sha?: string): Survey {
  const s: Survey = {
    repo,
    sha,
    files: files.length,
    languages: [],
    runnables: [],
    stores: [],
    apis: [],
    projects: [],
    gaps: [],
  };
  const langs = new Map<string, number>();
  for (const f of files) {
    const l = languageOf(f);
    if (l) langs.set(l, (langs.get(l) ?? 0) + 1);
  }
  s.languages = [...langs]
    .map(([language, n]) => ({ language, files: n }))
    .sort((a, b) => b.files - a.files);
  {
    const per = new Map<string, Map<string, number>>();
    for (const f of files) {
      const l = languageOf(f);
      if (!l || l === "shell" || l === "terraform" || l === "sql") continue;
      const parts = f.split("/").slice(0, -1);
      for (let d = 1; d <= Math.min(2, parts.length); d++) {
        const dir = parts.slice(0, d).join("/");
        const m = per.get(dir) ?? per.set(dir, new Map()).get(dir)!;
        m.set(l, (m.get(l) ?? 0) + 1);
      }
    }
    s.folderLanguages = Object.fromEntries(
      [...per].map(([d, m]) => [d, [...m].sort((a, b) => b[1] - a[1])[0]![0]]),
    );
  }
  const seenStore = new Set<string>();
  const store = (kind: string, name: string, at: string) => {
    const k = `${kind}:${name}`;
    if (seenStore.has(k)) return;
    seenStore.add(k);
    s.stores.push({ kind, name, at });
  };

  for (const f of files) {
    const name = basename(f);
    const dir = dirname(f) === "." ? "" : dirname(f);
    // Dockerfiles: one runnable each, named by their folder (or their suffix: Dockerfile.worker).
    if (/^(Dockerfile|Containerfile)(\..+)?$|\.Dockerfile$/i.test(name) && !/ignore$/i.test(name)) {
      const t = read(root, f) ?? "";
      const from = [...t.matchAll(/^FROM\s+(\S+)/gim)].map((m) => m[1]).at(-1);
      const cmd = /^(?:CMD|ENTRYPOINT)\s+(.+)$/gim.exec(t)?.[1]?.slice(0, 120);
      const port = /^EXPOSE\s+(.+)$/im.exec(t)?.[1];
      const suffix =
        /^(?:Dockerfile|Containerfile)\.(.+)$/i.exec(name)?.[1] ??
        /^(.+)\.Dockerfile$/i.exec(name)?.[1];
      s.runnables.push({
        kind: "dockerfile",
        name: suffix ?? (basename(dir) || repo),
        at: f,
        detail: [from && `FROM ${from}`, cmd && `runs ${cmd}`, port && `port ${port}`]
          .filter(Boolean)
          .join(" · "),
      });
      continue;
    }
    if (/^(docker-)?compose[\w.-]*\.ya?ml$/i.test(name)) {
      const t = read(root, f) ?? "";
      for (const c of composeServices(t)) {
        const kind = storeKind(c.image ?? "") ?? (c.build ? undefined : storeKind(c.name));
        if (kind && !c.build) store(kind, c.name, `${f}:${c.line}`);
        else
          s.runnables.push({
            kind: "compose",
            name: c.name,
            at: `${f}:${c.line}`,
            detail: [
              c.build ? `builds ${c.build}` : c.image ? `image ${c.image}` : "",
              c.command && `runs ${c.command}`,
              c.ports && `port ${c.ports}`,
            ]
              .filter(Boolean)
              .join(" · "),
          });
      }
      continue;
    }
    if (name === "Procfile") {
      const t = read(root, f) ?? "";
      for (const m of t.matchAll(/^([\w-]+):\s*(.+)$/gm))
        s.runnables.push({
          kind: "procfile",
          name: m[1]!,
          at: `${f}:${lineOf(t, m.index!)}`,
          detail: `runs ${m[2]!.slice(0, 120)}`,
        });
      continue;
    }
    if (/\.ya?ml$/i.test(name) && !/^\.github\//.test(f)) {
      const t = read(root, f);
      if (!t) continue;
      // Kubernetes: a Deployment, StatefulSet, CronJob or Knative Service.
      if (
        /^kind:\s*(Deployment|StatefulSet|DaemonSet|CronJob|Job)\s*$/m.test(t) ||
        (/^apiVersion:\s*serving\.knative\.dev/m.test(t) && /^kind:\s*Service/m.test(t))
      ) {
        const kind = /^kind:\s*(\w+)/m.exec(t)![1];
        const nm =
          /^metadata:\s*\n(?:\s+.*\n)*?\s+name:\s*([\w.-]+)/m.exec(t)?.[1] ??
          basename(f).replace(/\.ya?ml$/, "");
        const image = /image:\s*["']?([^\s"']+)/.exec(t)?.[1];
        s.runnables.push({
          kind: "kubernetes",
          name: nm,
          at: f,
          detail: [kind, image && `image ${image}`].filter(Boolean).join(" · "),
        });
        if (/^kind:\s*StatefulSet/m.test(t) && image && storeKind(image))
          store(storeKind(image)!, nm, f);
        continue;
      }
      // OpenAPI.
      if (/^(openapi|swagger):\s*["']?\d/m.test(t))
        s.apis.push({
          at: f,
          title: /^\s+title:\s*["']?(.+?)["']?\s*$/m.exec(t)?.[1],
          paths: (t.match(/^ {2}\/[^:]*:\s*$/gm) ?? []).length || undefined,
        });
      // Serverless framework.
      if (/^service:\s*\S+/m.test(t) && /^functions:\s*$/m.test(t))
        for (const m of t.matchAll(/^ {2}([\w-]+):\s*$/gm))
          s.runnables.push({ kind: "serverless", name: m[1]!, at: `${f}:${lineOf(t, m.index!)}` });
      continue;
    }
    if (/\.json$/i.test(name) && /openapi|swagger/i.test(name)) {
      const t = read(root, f);
      if (!t) continue;
      try {
        const j = JSON.parse(t) as {
          openapi?: string;
          swagger?: string;
          info?: { title?: string };
          paths?: object;
        };
        if (j.openapi || j.swagger)
          s.apis.push({
            at: f,
            title: j.info?.title,
            paths: j.paths ? Object.keys(j.paths).length : undefined,
          });
      } catch {
        // not JSON after all
      }
      continue;
    }
    // Terraform: what it deploys (Cloud Run, functions, Lambda, ECS, App Engine) and the databases it makes.
    if (name.endsWith(".tf")) {
      const t = read(root, f);
      if (!t) continue;
      // A module whose source is a deploy (a shared cloud_run_service module, a lambda module…).
      for (const m of t.matchAll(/^module\s+"([\w-]+)"\s*\{([\s\S]*?)^\}/gm)) {
        const src = /^\s*source\s*=\s*"([^"]+)"/m.exec(m[2]!)?.[1] ?? "";
        const what =
          /cloud[_-]?run[\w-]*|cloud[_-]?function[\w-]*|lambda[\w-]*|ecs[_-]service[\w-]*|app[_-]engine[\w-]*|container[_-]app[\w-]*|function[_-]app[\w-]*/i.exec(
            src.split(/[/?]/).filter(Boolean).slice(-2).join("/"),
          )?.[0];
        // A module called "service" or "migrate" is named for the project it's in (app-service's came through as apps called service and migrate).
        const top = f.includes("/") ? f.split("/")[0]! : "";
        const label = /^\s*(?:name|service_name)\s*=\s*"([^"$]+)"/m.exec(m[2]!)?.[1] ?? m[1]!;
        const generic =
          /^(service|app|api|main|job|migrate|migrations?|worker|server|web|this)(_\w+)?$/i.test(
            label,
          );
        const nm =
          generic && top
            ? /^(service|app|main|this|server|web)$/i.test(label)
              ? top
              : `${top}-${label.replace(/_/g, "-")}`
            : label;
        if (what && !/build|trigger|iam|domain/i.test(what))
          s.runnables.push({
            kind: "terraform",
            name: nm,
            at: `${f}:${lineOf(t, m.index!)}`,
            detail: `module ${what}`,
          });
      }
      for (const m of t.matchAll(/^resource\s+"([\w]+)"\s+"([\w-]+)"/gm)) {
        // A module's own resource is often called "this" or "main": it's named by its module's folder.
        // In a shared modules/ folder, it's a template others deploy, not a thing of its own.
        const generic = /^(this|main|default|primary|self)$/.test(m[2]!);
        if (generic && /(^|\/)modules\//.test(f)) continue;
        const [type, nm] = [
          m[1]!,
          generic ? (basename(dirname(f)) === "." ? m[2]! : basename(dirname(f))) : m[2]!,
        ];
        const at = `${f}:${lineOf(t, m.index!)}`;
        // The thing itself, not its IAM bindings, subscriptions or settings.
        if (
          /_(iam_\w+|subscription|policy|binding|member|version_\w+|notification)$/.test(type) &&
          !/app_engine_\w+_version$/.test(type)
        )
          continue;
        if (
          /(cloud_run_(v2_)?(service|job)|cloudfunctions2?_function|lambda_function|ecs_service|app_engine_\w+_version|container_app|linux_web_app|function_app)$/.test(
            type,
          )
        )
          s.runnables.push({ kind: "terraform", name: nm, at, detail: type });
        else if (
          /(sql_database_instance|db_instance|rds_cluster|redis_instance|elasticache_cluster|elasticache_replication_group|spanner_instance|spanner_database|bigquery_dataset|firestore_database|dynamodb_table|cosmosdb_account|storage_bucket|s3_bucket|pubsub_topic|sqs_queue|sns_topic|memorystore_instance)$/.test(
            type,
          )
        )
          store(type.replace(/^(google|aws|azurerm)_/, "").replace(/_/g, " "), nm, at);
      }
      continue;
    }
    // Package bins and entry points.
    if (name === "package.json") {
      const t = read(root, f);
      try {
        const j = JSON.parse(t ?? "{}") as {
          name?: string;
          bin?: string | Record<string, string>;
          scripts?: Record<string, string>;
          main?: string;
        };
        s.projects.push({ at: dir || ".", manifest: f, name: j.name });
        if (j.bin)
          for (const [b, p] of Object.entries(
            typeof j.bin === "string" ? { [j.name ?? "bin"]: j.bin } : j.bin,
          ))
            s.runnables.push({ kind: "bin", name: b, at: f, detail: `runs ${p}` });
        const start = j.scripts?.start ?? j.scripts?.serve ?? j.scripts?.dev;
        if (start)
          s.runnables.push({
            kind: "entry",
            name: j.name ?? (basename(dir) || repo),
            at: f,
            detail: `npm start: ${start.slice(0, 120)}`,
          });
      } catch {
        // a package.json that isn't JSON: skip it
      }
      continue;
    }
    if (
      name === "Cargo.toml" ||
      name === "pyproject.toml" ||
      name === "go.mod" ||
      name === "pom.xml" ||
      name === "build.gradle" ||
      name === "build.gradle.kts" ||
      name === "Gemfile" ||
      name.endsWith(".csproj") ||
      name === "setup.py"
    ) {
      const t = read(root, f) ?? "";
      const nm =
        /^\[package\][^[]*?^name\s*=\s*"([^"]+)"/m.exec(t)?.[1] ??
        /^\[project\][^[]*?^name\s*=\s*"([^"]+)"/m.exec(t)?.[1] ??
        /^module\s+(\S+)/m.exec(t)?.[1] ??
        /<artifactId>([^<]+)<\/artifactId>/.exec(t)?.[1];
      s.projects.push({ at: dir || ".", manifest: f, ...(nm ? { name: nm } : {}) });
      if (name === "Cargo.toml")
        for (const m of t.matchAll(/^\[\[bin\]\][^[]*?^name\s*=\s*"([^"]+)"/gm))
          s.runnables.push({ kind: "bin", name: m[1]!, at: f });
      if (name === "pyproject.toml") {
        // The section's own lines: up to the next [header] (a blank line isn't the end of it).
        const sec = /^\[(?:project|tool\.poetry)\.scripts\]\s*\n([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(
          t,
        )?.[1];
        for (const m of (sec ?? "").matchAll(/^([\w-]+)\s*=\s*"([^"]+)"/gm))
          s.runnables.push({ kind: "bin", name: m[1]!, at: f, detail: `runs ${m[2]}` });
      }
      continue;
    }
    // Entry points in code: a Rust or Go main, a Python app server, a Java main class.
    if (/(^|\/)main\.(rs|go)$/.test(f) || (name.endsWith(".rs") && /(^|\/)src\/bin\//.test(f))) {
      const t = read(root, f) ?? "";
      if (/^\s*(pub\s+)?(async\s+)?fn\s+main\s*\(|^func\s+main\s*\(/m.test(t))
        s.runnables.push({
          kind: "entry",
          name:
            f.endsWith("main.rs") || f.endsWith("main.go")
              ? basename(dirname(dirname(f)) === "." ? dir || repo : dir) || repo
              : basename(f, ".rs"),
          at: f,
          detail: "main()",
        });
      continue;
    }
    if (name.endsWith(".py") && /(^|\/)(main|app|server|asgi|wsgi|manage|__main__)\.py$/.test(f)) {
      const t = read(root, f) ?? "";
      const app =
        /\b(FastAPI|Flask|Starlette|Quart|Sanic|Litestar)\s*\(/.exec(t)?.[1] ??
        (/django/.test(t) && name === "manage.py" ? "Django" : undefined);
      if (app || /if\s+__name__\s*==\s*["']__main__["']/.test(t))
        s.runnables.push({
          kind: "entry",
          name: basename(dir) || repo,
          at: f,
          detail: app ? `${app} app` : "__main__",
        });
      continue;
    }
  }

  // Database URLs in env examples and config: a store even with no compose service for it.
  for (const f of files
    .filter((x) =>
      /(^|\/)\.env(\.[\w-]+)?$|\.env\.example$|settings\.py$|config\.(ts|js|py|ya?ml)$/i.test(x),
    )
    .slice(0, 40)) {
    const t = read(root, f) ?? "";
    for (const m of t.matchAll(
      /\b(postgres(?:ql)?|redis|mysql|mongodb(?:\+srv)?|amqp|nats|kafka):\/\//gi,
    ))
      store(
        storeKind(m[1]!) ?? m[1]!.toLowerCase(),
        `${m[1]!.toLowerCase()} (from ${basename(f)})`,
        `${f}:${lineOf(t, m.index!)}`,
      );
  }

  // An embedded database opened from the code (a SQLite file, DuckDB): no service or URL
  // names it (archnm.sqlite, through node:sqlite, wasn't found). By the import or
  // driver line in each language; a store per file that opens one, named by its folder.
  const EMBEDDED: [RegExp, string][] = [
    [
      /from\s+["'](?:node:sqlite|bun:sqlite|better-sqlite3|sqlite3|sqlite)["']|require\(["'](?:better-sqlite3|sqlite3)["']\)|^\s*import\s+sqlite3\b|^\s*use\s+rusqlite\b|"(?:github\.com\/mattn\/go-sqlite3|modernc\.org\/sqlite)"|jdbc:sqlite:|Microsoft\.Data\.Sqlite|\bSQLite3::Database\b/m,
      "SQLite",
    ],
    [
      /from\s+["'](?:duckdb|@duckdb\/node-api)["']|^\s*import\s+duckdb\b|^\s*use\s+duckdb\b|jdbc:duckdb:/m,
      "DuckDB",
    ],
    [
      /from\s+["'](?:level|classic-level|lmdb)["']|^\s*use\s+(?:sled|rocksdb|redb)\b|^\s*import\s+(?:lmdb|plyvel|rocksdict)\b/m,
      "embedded key-value store",
    ],
  ];
  let embedded = 0;
  for (const f of files.filter((x) => languageOf(x)).slice(0, 4000)) {
    if (
      embedded >= 6 ||
      /(^|\/)(test|tests|__tests__|spec|examples?|docs?)\//.test(f) ||
      /\.(test|spec)\.\w+$/.test(f)
    )
      continue;
    const t = read(root, f) ?? "";
    for (const [re, kind] of EMBEDDED) {
      const m = re.exec(t);
      if (!m) continue;
      embedded++;
      store(kind, `${kind} (opened in ${f})`, `${f}:${lineOf(t, m.index)}`);
    }
  }

  // The same thing in several places (dev and prod Terraform, two compose files): once, with where else.
  const once = <T extends { kind: string; name: string; at: string; detail?: string }>(
    xs: T[],
  ): T[] => {
    const by = new Map<string, T & { more: string[] }>();
    for (const x of xs) {
      const k = `${x.kind}:${x.name}`;
      const had = by.get(k);
      if (had) had.more.push(x.at);
      else by.set(k, { ...x, more: [] });
    }
    return [...by.values()].map(
      ({ more, ...x }) =>
        (more.length
          ? {
              ...x,
              at: `${x.at} (+ ${more
                .map((m) => m.split(":")[0])
                .filter((m, i, a) => a.indexOf(m) === i)
                .join(", ")})`,
            }
          : x) as unknown as T,
    );
  };
  s.runnables = once(s.runnables);
  s.stores = once(s.stores);

  if (!s.runnables.length)
    s.gaps.push(
      "nothing runnable found (no Dockerfile, compose service, Procfile, Kubernetes or Terraform deploy, bin or main): a library, or it's deployed from another repo",
    );
  const multi = s.projects.filter((p) => p.at !== ".");
  if (multi.length > 1)
    s.gaps.push(
      `${multi.length} projects inside (a monorepo or workspace): decide which are their own apps and which are shared code`,
    );
  if (!s.languages.length) s.gaps.push("no source files in a language Archnemesis knows");
  return s;
}

/** The survey as a few lines for an agent, with the detail an agent asks for when it needs it. */
export function surveyText(s: Survey): string {
  const out = [
    `${s.repo}${s.sha ? `@${s.sha}` : ""}: ${s.files} files · ${
      s.languages
        .slice(0, 5)
        .map((l) => `${l.language} ${l.files}`)
        .join(", ") || "no known languages"
    }`,
  ];
  if (s.indexer)
    out.push(
      `code index: ${s.indexer.adapter}${s.indexer.exact ? " (exact calls)" : " (calls guessed by name)"}${s.indexer.functions ? `. ${s.indexer.functions}` : ""}`,
    );
  if (s.runnables.length)
    out.push(
      "",
      `What runs (${s.runnables.length}):`,
      ...s.runnables
        .slice(0, 40)
        .map((r) => `  ${r.kind} ${r.name}: ${r.at}${r.detail ? ` · ${r.detail}` : ""}`),
      ...(s.runnables.length > 40 ? [`  … and ${s.runnables.length - 40} more`] : []),
    );
  if (s.stores.length)
    out.push(
      "",
      `What holds state (${s.stores.length}):`,
      ...s.stores.slice(0, 30).map((x) => `  ${x.kind} ${x.name}: ${x.at}`),
    );
  if (s.apis.length)
    out.push(
      "",
      `API specs (${s.apis.length}):`,
      ...s.apis.map(
        (a) => `  ${a.at}${a.title ? ` · ${a.title}` : ""}${a.paths ? ` · ${a.paths} paths` : ""}`,
      ),
    );
  if (s.projects.length > 1)
    out.push(
      "",
      `Projects inside (${s.projects.length}):`,
      ...s.projects
        .slice(0, 30)
        .map((p) => `  ${p.at}${p.name ? ` (${p.name})` : ""}: ${p.manifest}`),
    );
  if (s.gaps.length) out.push("", "Couldn't tell:", ...s.gaps.map((g) => `  ${g}`));
  return out.join("\n");
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "x";

/**
 * A first draft of the repo as Archnemesis YAML, for write: a system for the repo, an app for each
 * thing that's deployed (a container, a compose service, a cloud deploy; else each entry
 * point), and a store for each datastore. A draft: the agent renames, merges and drops.
 */
export function draftYaml(s: Survey, opts: { system?: string } = {}): string {
  const sys = opts.system ?? slug(s.repo);
  // What's deployed, and every command the repo ships (a CLI, a local server, a script): each
  // runs on its own (with a Dockerfile, the CLI, the channel and the indexer were
  // left out). Entry points (npm start, main()) only when nothing else says what runs.
  // Not what a lab, test or example folder runs (a compose lab's curl seeders were apps).
  const side = (r: Runnable) =>
    /(^|\/)(labs?|examples?|demos?|tests?|e2e|fixtures|testdata|sandbox)\//i.test(r.at);
  const real = s.runnables.filter((r) => !side(r));
  const deployed = real.filter((r) => r.kind !== "entry" && r.kind !== "bin");
  const bins = real.filter((r) => r.kind === "bin");
  const apps =
    deployed.length || bins.length ? [...deployed, ...bins] : real.length ? real : s.runnables;
  const seen = new Set<string>();
  const id = (base0: string) => {
    // Named after the repo (a Dockerfile at its root): "app", not the repo's name twice
    // (archnm-src-archnm-src).
    // Its own name, prefixed only when it would clash (every id began trailoftears-).
    const base = slug(base0) === sys || !slug(base0) ? "app" : slug(base0);
    let k = (base === "app" ? `${sys}-${base}` : base).slice(0, 60);
    for (let n = 2; seen.has(k) || k === sys; n++) k = `${base}-${n}`;
    seen.add(k);
    return k;
  };
  const q = (v: string) => JSON.stringify(v);
  // Objects by id (format 2); name only when it isn't the id.
  const named = (id: string, name: string) => (name === id ? [] : [`    name: ${q(name)}`]);
  const lines = [
    `# Draft from the survey of ${s.repo}: rename, merge and drop what isn't really its own app,`,
    `# then add the components inside and the connections (who calls whom, who reads which store).`,
    "objects:",
    `  ${sys}:`,
    "    kind: system",
    ...named(sys, s.repo),
  ];
  const lang = s.languages[0]?.language;
  // One app per name: a service deployed by Terraform and run in a compose lab is one thing.
  const byName = new Map<string, Runnable[]>();
  for (const r of apps) {
    const k = slug(
      r.name.replace(new RegExp(`^${s.repo.replace(/[^\w]/g, ".")}[-_]?`, "i"), "") || r.name,
    );
    (byName.get(k) ?? byName.set(k, []).get(k)!).push(r);
  }
  for (const rs of [...byName.values()].slice(0, 30)) {
    const r = rs.find((x) => x.kind === "terraform" || x.kind === "kubernetes") ?? rs[0]!;
    const where = rs
      .map((x) => `${x.kind} at ${x.at}${x.detail ? ` (${x.detail})` : ""}`)
      .join("; ");
    const k = id(r.name);
    // The language of its own folder, not the repo's most common one (every app was typescript).
    const dirs = rs.map((x) => x.at.split(":")[0]!.split("/").slice(0, -1));
    // Its own folder (two levels) first, then the image it runs on, then its top folder.
    const lang2 = (ds: string[]) =>
      ds
        .filter(Boolean)
        .map((d) => s.folderLanguages?.[d])
        .find(Boolean);
    const deep = lang2(dirs.filter((d) => d.length >= 2).map((d) => d.slice(0, 2).join("/")));
    const top = lang2([...dirs.map((d) => d.slice(0, 1).join("/")), r.name, slug(r.name)]);
    const runs = /FROM (python|node|golang|rust|ruby|openjdk|eclipse-temurin)/i
      .exec(where)?.[1]
      ?.toLowerCase();
    const image = runs
      ? ((
          {
            node: "javascript",
            golang: "go",
            openjdk: "java",
            "eclipse-temurin": "java",
          } as Record<string, string>
        )[runs] ?? runs)
      : undefined;
    const tech =
      deep ??
      image ??
      top ??
      (s.languages.length === 1 ||
      (s.languages.length &&
        s.languages[0]!.files >= 0.7 * s.languages.reduce((n, l) => n + l.files, 0))
        ? lang
        : undefined);
    lines.push(
      `  ${k}:`,
      "    kind: app",
      ...named(k, r.name),
      `    in: ${sys}`,
      `    context: ${q(where.slice(0, 400))}`,
      ...(tech ? [`    tech: [${q(tech)}]`] : []),
    );
  }
  for (const st of s.stores.slice(0, 30)) {
    const k = id(st.name);
    lines.push(
      `  ${k}:`,
      "    kind: store",
      ...named(k, st.name),
      `    in: ${sys}`,
      `    context: ${q(`from ${st.at}`)}`,
      `    tech: [${q(st.kind)}]`,
    );
  }
  return lines.join("\n") + "\n";
}
