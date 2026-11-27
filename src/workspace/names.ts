// What a new box is called, and whether a box is still as it was made.
import type { ModelIndex } from "../../shared/project.ts";
import type { ModelObject, ObjectKind } from "../../shared/model.ts";

/** The name a new box gets: "New app", "new_table", "new_function()". */
export function defaultName(kind: ObjectKind): string {
  if (kind === "store") return "New service";
  return kind === "function" ? "new_function()" : kind === "table" ? "new_table" : `New ${kind}`;
}
export const isDefaultName = (name: string): boolean =>
  /^New [a-z]+$/.test(name) ||
  name === "New group" ||
  name === "new_table" ||
  name === "new_function()";

/** Nothing on it yet: its name is still the one it was made with, no description, no lines. */
export function isBlank(idx: ModelIndex, o: ModelObject): boolean {
  if (!isDefaultName(o.name) && o.name.trim() !== "") return false;
  if (o.description.trim() || o.columns?.length) return false;
  for (const c of idx.connections.values()) if (c.fromId === o.id || c.toId === o.id) return false;
  return true;
}
