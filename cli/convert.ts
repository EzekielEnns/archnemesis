// One-off: a version 1 folder rewritten as version 2 (docs/grammar-v2.md). `archnm convert [dir]`.
// It reshapes the v1 files into the v2 grammar (objects by id, entities into their box's file
// by name, uses/carries, guess, named layout fields), reads that back the way Archnemesis reads any
// folder, and writes it out canonically. Delete this once the designs that follow git have moved.
import YAML from "yaml";
import * as Y from "yjs";
import { isGeneratedAgents } from "../shared/agentsmd.ts";
import { applyOps, emptyState, mirror, type Actor } from "../shared/doc.ts";
import { check, readFiles, toOps, writeFiles, type Problem } from "../shared/files.ts";
import { mergedContext, typeName } from "../shared/model.ts";

type Rec = Record<string, unknown>;
const CLI: Actor = { id: "cli", name: "archnm convert", kind: "system" };

const isRec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** The v1 files as v2 files (loose: readFiles normalises them), before the canonical rewrite. */
function reshape(files: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  const parsed = new Map<string, Rec>();
  for (const [path, text] of files)
    if (/\.ya?ml$/.test(path))
      parsed.set(path, (YAML.parse(text, { merge: false }) as Rec | null) ?? {});

  // Where each object lives, and every entity's name by its v1 id.
  const modelFile = (p: string) =>
    /^model\/[^/]+\.ya?ml$/.test(p) || /^code\/.+\.ya?ml$/.test(p) || p === "libraries.yaml";
  const fileOf = new Map<string, string>();
  for (const [p, v] of parsed)
    if (modelFile(p))
      for (const o of list(v.objects))
        if (isRec(o) && typeof o.id === "string")
          fileOf.set(o.id, p === "model/landscape.yaml" ? "model/_top.yaml" : p);
  const entities = list(parsed.get("entities.yaml")?.entities).filter(isRec);
  // Entity names become type names ("Paid Order" → PaidOrder), as the live document reads them.
  const nameOf = new Map(entities.map((e) => [String(e.id), typeName(String(e.name))]));
  const ename = (id: unknown) => nameOf.get(String(id)) ?? typeName(String(id));

  /** v1 links and references: links become link references, entity references come out. */
  const refs = (x: Rec) => {
    const all: Rec[] = [
      ...list(x.links)
        .filter(isRec)
        .map((l) => ({ link: l.url, ...(l.title ? { title: l.title } : {}) })),
      ...list(x.references).filter(isRec),
    ];
    return {
      references: all.filter((r) => r.entity === undefined),
      entities: all.filter((r) => r.entity !== undefined).map((r) => ename(r.entity)),
    };
  };

  // Links a view pinned to a box (on:) go on the box.
  const pinned = new Map<string, Rec[]>();
  for (const [p, v] of parsed) {
    if (!p.startsWith("views/")) continue;
    const links = list(v.links).filter(isRec);
    for (const l of links.filter((l) => l.on))
      pinned.set(String(l.on), [
        ...(pinned.get(String(l.on)) ?? []),
        { link: l.url, ...(l.title ? { title: l.title } : {}) },
      ]);
    if (links.some((l) => l.on)) v.links = links.filter((l) => !l.on).map(({ on: _, ...l }) => l);
  }

  const v2 = new Map<string, Rec>();
  const fileRec = (p: string) => {
    let r = v2.get(p);
    if (!r) v2.set(p, (r = { objects: {}, entities: {}, connections: [] }));
    return r;
  };
  for (const [p, v] of parsed) {
    if (!modelFile(p)) continue;
    const target = fileRec(p === "model/landscape.yaml" ? "model/_top.yaml" : p);
    for (const raw of list(v.objects).filter(isRec)) {
      const { id, description, context, links: _l, references: _r, ...rest } = raw;
      const { references, entities: uses } = refs(raw);
      const more = pinned.get(String(id)) ?? [];
      const text = mergedContext(
        typeof description === "string" ? description : undefined,
        typeof context === "string" ? context : undefined,
      );
      (target.objects as Rec)[String(id)] = {
        ...rest,
        ...(text ? { context: text } : {}),
        ...(uses.length ? { uses } : {}),
        ...(references.length + more.length ? { references: [...references, ...more] } : {}),
      };
    }
    for (const raw of list(v.connections).filter(isRec)) {
      const { confidence, links: _l, references: _r, ...rest } = raw;
      const { references, entities: carries } = refs(raw);
      (target.connections as Rec[]).push({
        ...rest,
        ...(confidence === "name" ? { guess: true } : {}),
        ...(carries.length ? { carries } : {}),
        ...(references.length ? { references } : {}),
      });
    }
  }
  for (const e of entities) {
    const home = typeof e.source === "string" ? fileOf.get(e.source) : undefined;
    (fileRec(home ?? "model/_top.yaml").entities as Rec)[typeName(String(e.name))] = {
      ...(home ? { in: e.source } : {}),
      ...(list(e.extends).length ? { extends: list(e.extends).map(ename) } : {}),
      ...(e.context ? { context: e.context } : {}),
      ...(list(e.fields).length ? { fields: e.fields } : {}),
      ...(list(e.values).length ? { values: e.values } : {}),
    };
  }
  for (const [p, r] of v2) out.set(p, YAML.stringify(r, { lineWidth: 0 }));

  for (const [p, text] of files) {
    if (modelFile(p) || p === "entities.yaml" || p === "model/landscape.yaml") continue;
    if (p === "archnm.yaml")
      out.set(p, YAML.stringify({ ...parsed.get(p), version: 2 }, { lineWidth: 0 }));
    else if (p.startsWith("views/")) out.set(p, YAML.stringify(parsed.get(p), { lineWidth: 0 }));
    else if (/^layout\/[^/]+\.json$/.test(p)) {
      const v = JSON.parse(text) as Rec;
      out.set(
        p,
        JSON.stringify(
          Object.fromEntries(
            Object.entries(v).map(([k, b]) => [
              k,
              Array.isArray(b)
                ? {
                    x: b[0],
                    y: b[1],
                    w: b[2],
                    h: b[3],
                    ...(b.length === 6 ? { parts: [b[4], b[5]] } : {}),
                  }
                : b,
            ]),
          ),
        ),
      );
    } else out.set(p, text);
  }
  return out;
}

/** A v1 folder's files as v2's canonical files, or the problems that stop it. */
export function convert(files: Map<string, string>): {
  files: Map<string, string>;
  problems: Problem[];
} {
  const shaped = reshape(files);
  const { model, problems: read } = readFiles(shaped);
  const problems = [...read, ...check(model)];
  if (problems.some((p) => p.level === "error")) return { files: shaped, problems };
  const doc = new Y.Doc();
  const state = emptyState();
  mirror(doc, state, () => {});
  applyOps(doc, state, toOps(state, model), CLI, "convert", CLI, { pin: false });
  const written = writeFiles(state, model.config);
  // A person's own AGENTS.md stays theirs.
  if (files.has("AGENTS.md") && !isGeneratedAgents(files.get("AGENTS.md")))
    written.set("AGENTS.md", files.get("AGENTS.md")!);
  return { files: written, problems };
}
