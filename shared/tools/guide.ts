// guide: how Archnemesis works, for an agent and for the person it's helping. The grammar (short, and
// the field reference a section at a time), views, code, the playbooks, and the app itself.
import { agentsGuide } from "../agentsmd.ts";
import { GUIDE_TOPICS, guideText } from "../guide.ts";
import type { FConfig } from "../files.ts";
import { ToolError, ok, type Out } from "./host.ts";
import { CONNECTION, OBJECT, type Schema } from "../spec.ts";
import {
  GRAMMAR_TIPS,
  PLAYBOOKS,
  TOPIC_CODE,
  TOPIC_MANAGE,
  TOPIC_READ,
  MANUAL_MAP,
  TOPIC_VIEWS,
} from "./teach.ts";

/** Tables and their columns, from the format's one definition (spec.ts), so it can't drift. */
function topicTables(): string {
  const props = (s: Schema | undefined) => (s?.properties ?? {}) as Record<string, Schema>;
  const cols = props(props(OBJECT).columns?.items as Schema);
  const conn = props(CONNECTION);
  return [
    "Tables: a table (kind: table) is a box inside its store, one per table, with its columns listed on it; the columns are never boxes.",
    "",
    "objects:",
    "  orders-db: {kind: store, tech: [Postgres], in: shop}",
    "  orders:",
    "    kind: table",
    "    in: orders-db",
    "    columns:",
    "      - {name: id, type: uuid, pk: true}",
    "      - {name: customer_id, type: uuid}",
    "      - {name: email, type: text, personal: true, nullable: true, description: Where receipts go.}",
    "connections:",
    "  - {from: orders, to: customers, column: customer_id}   # a key between tables (to_column: leave out for its primary key)",
    "",
    "A column's fields:",
    ...Object.entries(cols).map(
      ([k, s]) => `- ${k}${k === "name" ? " (required)" : ""}: ${String(s.description ?? "")}`,
    ),
    "",
    "On a connection between tables:",
    `- column: ${String(conn.column?.description ?? "")}`,
    `- to_column: ${String(conn.to_column?.description ?? "")}`,
  ].join("\n");
}

export interface GuideArgs {
  topic?: string;
}

/** The AGENTS.md Archnemesis writes, split at its headings (outside code blocks). */
function sections(config: FConfig): { head: string; level: number; body: string[] }[] {
  const full = agentsGuide(config).split("\n").slice(1).join("\n");
  const parts: { head: string; level: number; body: string[] }[] = [
    { head: "", level: 1, body: [] },
  ];
  let code = false;
  for (const line of full.split("\n")) {
    if (line.startsWith("```")) code = !code;
    const m = !code && /^(#{2,3}) (.*)$/.exec(line);
    if (m) parts.push({ head: m[2]!, level: m[1]!.length, body: [line] });
    else parts[parts.length - 1]!.body.push(line);
  }
  return parts;
}

const fieldName = (head: string) => head.replace(/ \(.*$/, "").toLowerCase();

export function guide(a: GuideArgs, config: FConfig = {}, where = ""): Out {
  const topic = a.topic?.trim().toLowerCase() ?? "";
  const parts = sections(config);
  const refAt = parts.findIndex((p) => /^field reference/i.test(p.head));
  const fields = refAt < 0 ? [] : parts.slice(refAt + 1).filter((p) => p.level === 3);
  if (!topic) {
    return ok(
      [
        "Archnemesis guide. guide {topic}:",
        "- grammar: one full scope file and the rules agents get wrong (read this before your first write)",
        `- the field reference, a section each: ${fields.map((p) => fieldName(p.head)).join(", ")}`,
        "- read: every option of read (search, ref, scope, views, lenses, history, diff, walks, impact, routes, files, here)",
        "- views: rules, flows, keeping a view readable",
        "- code: modules, functions, libraries, refs, importing a repo",
        "- tables: a store's tables and their columns, keys between tables",
        "- manage: running agents that write in parallel to one fork (brief, watch with read {diff, by}, correct, propose)",
        `- playbooks: ${Object.entries(PLAYBOOKS)
          .map(([k, p]) => `${k} (${p.title.toLowerCase()})`)
          .join(", ")}`,
        `- the app, for teaching a person: ${GUIDE_TOPICS.join(", ")} (app:<topic> where a field has the same name)`,
        "- all: the whole file format guide (AGENTS.md)",
        "When Archnemesis itself gets in your way (a wrong answer, a confusing error, something missing): feedback {kind, text, tool}. It's how the tools get fixed.",
        where,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  if (topic === "all") return ok(parts.flatMap((p) => p.body).join("\n"));
  if (topic === "grammar" || topic === "format") {
    const top = (refAt < 0 ? parts : parts.slice(0, refAt)).filter((p) =>
      /scope's file|get these right/i.test(p.head),
    );
    return ok(
      [
        ...top.flatMap((p) => p.body),
        "",
        GRAMMAR_TIPS,
        "",
        `Writing it: write {yaml: "<a fragment like the file above>"}. Field reference: guide {topic: "${fields.map((p) => fieldName(p.head))[1] ?? "objects"}"}.`,
      ]
        .join("\n")
        .trim(),
    );
  }
  if (topic === "views") return ok(TOPIC_VIEWS);
  if (topic === "read") return ok(TOPIC_READ);
  if (topic === "map-by-reading" || topic === "manual") return ok(MANUAL_MAP);
  if (topic === "code") return ok(TOPIC_CODE);
  if (topic === "tables" || topic === "table" || topic === "columns") return ok(topicTables());
  if (topic === "manage") return ok(TOPIC_MANAGE);
  if (topic in PLAYBOOKS) {
    const p = PLAYBOOKS[topic as keyof typeof PLAYBOOKS];
    return ok(`${p.title}\n\n${p.text}`);
  }
  // A name that's both the app's topic and a field (flows): the field, for an agent writing it,
  // and the app's under app:<topic> (asking for flows gave the app's click-through).
  const appTopic = topic.replace(/^app:/, "");
  const field = fields.find((p) => fieldName(p.head) === topic);
  if (field && !topic.startsWith("app:"))
    return ok(
      `${field.body.join("\n").trim()}${(GUIDE_TOPICS as readonly string[]).includes(topic) ? `\n\n(Using ${topic} in the app, for teaching a person: guide {topic: "app:${topic}"}.)` : ""}`,
    );
  if ((GUIDE_TOPICS as readonly string[]).includes(appTopic))
    return ok(`${guideText(appTopic)}${where ? `\n${where}` : ""}`);
  const hit =
    fields.find(
      (p) => fieldName(p.head) === topic || fieldName(p.head) === topic.replace(/-/g, "_"),
    ) ??
    fields.find((p) => fieldName(p.head).startsWith(topic)) ??
    parts.find((p) => p.head.toLowerCase().startsWith(topic));
  if (hit) return ok(hit.body.join("\n").trim());
  // Not a topic: where the guide mentions it (hide_lines, lanes, fold), so asking by a field's name still answers.
  const texts: [string, string][] = [
    ["views", TOPIC_VIEWS],
    ["grammar", GRAMMAR_TIPS],
    ["read", TOPIC_READ],
    ["map-by-reading", MANUAL_MAP],
    ["code", TOPIC_CODE],
    ["tables", topicTables()],
    ["manage", TOPIC_MANAGE],
    ...Object.entries(PLAYBOOKS).map(([k, p]): [string, string] => [k, p.text]),
    ...GUIDE_TOPICS.map((t): [string, string] => [t, guideText(t)]),
  ];
  const word = topic.replace(/[_-]/g, "[_ -]?");
  const re = new RegExp(word, "i");
  const found = texts.flatMap(([t, text]) =>
    text
      .split("\n")
      .filter((l) => re.test(l))
      .slice(0, 3)
      .map((l) => `  ${t}: ${l.trim()}`),
  );
  if (found.length)
    return ok(
      `No topic "${a.topic}"; the guide mentions it here:\n${[...new Set(found)].slice(0, 8).join("\n")}`,
    );
  throw new ToolError(`no topic "${a.topic}"; guide {} lists them`);
}
