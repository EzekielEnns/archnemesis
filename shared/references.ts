// References: what a node points at outside the model (links, images, docs, code, the
// libraries it depends on), and the other way round, everything that points at the same
// thing, which is what the spiderweb lights up.
import type { ModelObject, Reference, ReferenceKind } from "./model.ts";
import type { ModelIndex } from "./project.ts";

/** One reference as the panel and agents see it: links come from `links`, the rest from `references`. */
export interface RefRow {
  kind: "link" | ReferenceKind;
  to: string;
  title: string;
  /** Its index in `links` or `references`, for editing. */
  at: number;
}

/** A node's references, links first. A dependency's title is its library's name. Entities
 * aren't among them: they have their own row and sub-nodes (shared/entities.ts). */
export function referencesOf(
  idx: ModelIndex,
  o: Pick<ModelObject, "links" | "references">,
): RefRow[] {
  return [
    ...(o.links ?? []).map((l, at) => ({ kind: "link" as const, to: l.url, title: l.title, at })),
    ...(o.references ?? []).flatMap((r, at) =>
      r.kind === "entity"
        ? []
        : [{ kind: r.kind, to: r.to, title: r.title || refTitle(idx, r), at }],
    ),
  ];
}

/** What to call a reference without a title: a library's name, a file's name, the code's place. */
function refTitle(idx: ModelIndex, r: Reference): string {
  if (r.kind === "dependency") return idx.objects.get(r.to)?.name ?? r.to;
  if (r.kind === "entity") return idx.entities.get(r.to)?.name ?? r.to;
  if (r.kind === "code") return r.to.replace(/^[^:]+:/, "");
  return r.to.split("/").pop() || r.to;
}

/** Lines for an agent: "references:" then one per reference, kind first. Empty when there are none. */
export function referenceLines(idx: ModelIndex, o: ModelObject): string[] {
  const rows = (o.references ?? []).map((r) => {
    const lib = r.kind === "dependency" ? idx.objects.get(r.to) : undefined;
    const ent = r.kind === "entity" ? idx.entities.get(r.to) : undefined;
    if (ent)
      return `  entity: ${ent.name} [${ent.key ?? ent.id}]${ent.fields.length || ent.values?.length ? "" : " (TBD)"}`;
    const to = lib
      ? `${lib.name} [${lib.key ?? lib.id}]${lib.package?.version ? ` ${lib.package.version}` : ""}`
      : r.to;
    return `  ${r.kind}: ${to}${r.title && !lib ? ` (${r.title})` : ""}`;
  });
  return rows.length ? ["references:", ...rows] : [];
}

/** Everything that lists this object as a dependency. */
export function referencedBy(idx: ModelIndex, id: string): ModelObject[] {
  return [...idx.objects.values()].filter(
    (o) =>
      o.status !== "removed" && o.references?.some((r) => r.kind === "dependency" && r.to === id),
  );
}

/** Everything sharing a tech with this one, by name (case aside): the tech's spiderweb. */
export function sharingTech(idx: ModelIndex, tech: string): ModelObject[] {
  const t = tech.trim().toLowerCase();
  return [...idx.objects.values()].filter(
    (o) => o.status !== "removed" && techsOf(o.technology).some((x) => x.toLowerCase() === t),
  );
}

/** A tech field's entries: "Go, Cloud Run" → ["Go", "Cloud Run"]. */
export function techsOf(technology: string): string[] {
  return technology
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Every tech the design uses, with how many nodes use it, most used first. */
export function designTechs(idx: ModelIndex): { name: string; count: number }[] {
  const by = new Map<string, { name: string; count: number }>();
  for (const o of idx.objects.values()) {
    if (o.status === "removed") continue;
    for (const t of techsOf(o.technology)) {
      const k = t.toLowerCase();
      const e = by.get(k) ?? { name: t, count: 0 };
      e.count++;
      by.set(k, e);
    }
  }
  return [...by.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/**
 * What makes two references the same thing, for "who else points here": a link by its address
 * (no trailing slash or #part), an image or doc by its path, code by its file (any line in it),
 * a dependency by its library.
 */
export function refKey(r: { kind: RefRow["kind"]; to: string }): string {
  if (r.kind === "link")
    return `link:${r.to.replace(/#.*$/, "").replace(/\/+$/, "").toLowerCase()}`;
  if (r.kind === "code") return `code:${r.to.replace(/#.*$/, "")}`;
  return `${r.kind}:${r.to}`;
}

/** Everything (not removed) with a reference to the same thing, this one included. */
export function sharingRef(idx: ModelIndex, key: string): ModelObject[] {
  return [...idx.objects.values()].filter(
    (o) =>
      o.status !== "removed" &&
      (referencesOf(idx, o).some((r) => refKey(r) === key) ||
        (o.kind === "library" && key === `dependency:${o.id}`)),
  );
}

/**
 * Where to read a library's docs: a link of its own that looks like docs, else the usual place
 * for its ecosystem (docs.rs, npm, PyPI, pkg.go.dev…), at its version.
 */
export function libraryDocs(lib: ModelObject): string | null {
  const own = lib.links?.find(
    (l) => /docs?\b/i.test(l.title) || /^https?:\/\/(docs|doc)\./.test(l.url),
  );
  if (own) return own.url;
  const p = lib.package;
  if (!p) return lib.links?.[0]?.url ?? null;
  const n = encodeURIComponent(p.name);
  const v = p.version ? encodeURIComponent(p.version) : "";
  switch (p.ecosystem) {
    case "cargo":
      return `https://docs.rs/${n}${v ? `/${v}` : ""}`;
    case "npm":
      return `https://www.npmjs.com/package/${p.name.split("/").map(encodeURIComponent).join("/")}${v ? `/v/${v}` : ""}`;
    case "pypi":
      return `https://pypi.org/project/${n}/${v ? `${v}/` : ""}`;
    case "go":
      return `https://pkg.go.dev/${p.name}${v ? `@${v}` : ""}`;
    case "nuget":
      return `https://www.nuget.org/packages/${n}${v ? `/${v}` : ""}`;
    case "rubygems":
      return `https://rubygems.org/gems/${n}${v ? `/versions/${v}` : ""}`;
    case "maven":
      return `https://central.sonatype.com/search?q=${n}`;
    default:
      return lib.links?.[0]?.url ?? null;
  }
}
