// Tables: one box per table, its columns a field on it. A foreign key, or a pointer to a row
// in another store or region, is a connection between tables that names its column
// (`column`, and `toColumn` on the other side, its primary key when left out; in the files and in write, `column` and `to_column`). These read
// the columns and keys back the same way for the side panel, agents' context and check.
import type { Column, Connection, ModelObject } from "./model.ts";
import type { ModelIndex } from "./project.ts";
import { crossesRegions, crossesRegionsShort } from "./boundaries.ts";

/** One key: a column of one table pointing at a column of another. */
export interface Key {
  conn: Connection;
  /** The table holding the key, and its column. */
  from: ModelObject;
  column: string;
  /** The table it points at, and the column there. */
  to: ModelObject;
  toColumn: string;
  /** "us-central1 → europe-west2" when the two tables are in different regions… */
  across: string | null;
  /** …and short, for a badge: "US → UK". */
  acrossShort: string | null;
}

/** The column a key points at: the one named, else the table's primary key, else "id". */
export function targetColumn(to: ModelObject | undefined, toColumn?: string): string {
  return toColumn || to?.columns?.find((c) => c.pk)?.name || "id";
}

/** A table's keys: the ones its columns hold (out) and the ones pointing at it (in). */
export function keysOf(idx: ModelIndex, tableId: string): { out: Key[]; in: Key[] } {
  const out: Key[] = [];
  const inn: Key[] = [];
  for (const c of idx.connections.values()) {
    if (!c.column || c.status === "removed" || (c.fromId !== tableId && c.toId !== tableId))
      continue;
    const from = idx.objects.get(c.fromId);
    const to = idx.objects.get(c.toId);
    if (!from || !to) continue;
    const k: Key = {
      conn: c,
      from,
      column: c.column,
      to,
      toColumn: targetColumn(to, c.toColumn),
      across: crossesRegions(idx, c.fromId, c.toId),
      acrossShort: crossesRegionsShort(idx, c.fromId, c.toId),
    };
    if (c.fromId === tableId) out.push(k);
    if (c.toId === tableId) inn.push(k);
  }
  return { out, in: inn };
}

/** "UK Postgres › faces.id": a table's column, with the store it's in (two tables can share a name). */
export function columnRef(idx: ModelIndex, table: ModelObject, column: string): string {
  const store = table.parentId ? idx.objects.get(table.parentId) : undefined;
  return `${store ? `${store.name} › ` : ""}${table.name}.${column}`;
}

/** "uuid · pk · nullable": a column's type and what it is, in one line. */
function columnLine(c: Column): string {
  return [
    c.type,
    c.pk && "pk",
    c.unique && "unique",
    c.nullable && "nullable",
    c.personal && "personal data",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** A table's columns as lines an agent reads: each with its key, where it points and across what. */
export function columnsText(idx: ModelIndex, table: ModelObject): string[] {
  const cols = table.columns ?? [];
  if (!cols.length) return [];
  const { out } = keysOf(idx, table.id);
  return [
    `columns (${cols.length}):`,
    ...cols.map((c) => {
      const keys = out.filter((k) => k.column === c.name);
      const to = keys
        .map(
          (k) =>
            ` → ${k.to.name}.${k.toColumn} [${k.to.key ?? k.to.id}]${k.across ? ` (across regions: ${k.across})` : ""}`,
        )
        .join(",");
      return `  ${c.name}: ${columnLine(c)}${to}${c.description ? ` (${c.description})` : ""}`;
    }),
  ];
}
