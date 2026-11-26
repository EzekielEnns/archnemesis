// Names typed in place: over a box, and over an arrow.
import { updateConnection, updateObject } from "../../shared/actions.ts";

import type { WorkspaceBag } from "./useInteraction";

/** The name being typed over a box. */
export function RenameInput({
  renaming,
  setRenaming,
  idx,
  run,
}: Pick<WorkspaceBag, "renaming" | "setRenaming" | "idx" | "run">) {
  return (
    <>
      {renaming && idx.objects.get(renaming.id) && (
        <input
          className="rename"
          autoFocus
          defaultValue={idx.objects.get(renaming.id)!.name}
          style={{
            left: renaming.x + 26 * renaming.scale,
            top: renaming.y + 9 * renaming.scale,
            width: Math.max(120, renaming.w - 34 * renaming.scale),
            fontSize: Math.max(12, 15 * renaming.scale),
          }}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => {
            const o = idx.objects.get(renaming.id);
            const name = e.currentTarget.value.trim();
            setRenaming(null);
            if (o && name && name !== o.name) void run(updateObject(o, { name }), "rename");
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              e.currentTarget.value = idx.objects.get(renaming.id)?.name ?? "";
              e.currentTarget.blur();
            }
          }}
        />
      )}
    </>
  );
}

/** The name being typed over an arrow. */
export function EdgeRenameInput({
  edgeEdit,
  setEdgeEdit,
  idx,
  run,
}: Pick<WorkspaceBag, "edgeEdit" | "setEdgeEdit" | "idx" | "run">) {
  return (
    <>
      {edgeEdit && idx.connections.get(edgeEdit.connectionId) && (
        <input
          className="rename edge-rename"
          autoFocus
          placeholder="What it does"
          defaultValue={idx.connections.get(edgeEdit.connectionId)!.name}
          style={{ left: edgeEdit.x - 110, top: edgeEdit.y - 14 }}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => {
            const c = idx.connections.get(edgeEdit.connectionId);
            const name = e.currentTarget.value.trim();
            setEdgeEdit(null);
            if (c && name !== c.name) void run(updateConnection(c, { name }), "name connection");
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              e.currentTarget.value = idx.connections.get(edgeEdit.connectionId)?.name ?? "";
              e.currentTarget.blur();
            }
          }}
        />
      )}
    </>
  );
}
