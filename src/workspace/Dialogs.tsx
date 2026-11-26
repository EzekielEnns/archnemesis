// The right-click menu, the "what were you trying to do" dialog, and the command palette.
import { ContextMenu } from "../ui/ContextMenu";
import { Palette } from "../ui/Palette";

import { mark, recording } from "../trail";
import { Dialog } from "../ui/Dialog";
import { menuItems } from "./contextMenu";
import type { WorkspaceBag } from "./useInteraction";

/** The right-click menu. */
export function ContextMenuHost({
  menuCtx,
  menu,
  setMenu,
}: Pick<WorkspaceBag, "menuCtx" | "menu" | "setMenu">) {
  return (
    <>
      {menu && (
        <ContextMenu
          x={menu.clientX}
          y={menu.clientY}
          items={menuItems(menu, menuCtx)}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}

/** "What were you trying to do?", kept in the trail. */
export function MarkingDialog({
  marking,
  setMarking,
  toast,
}: Pick<WorkspaceBag, "marking" | "setMarking" | "toast">) {
  return (
    <>
      {marking !== null && (
        <Dialog
          title="What were you trying to do?"
          confirm="Mark it"
          disabled={!marking.trim()}
          onCancel={() => setMarking(null)}
          onConfirm={() => {
            mark(marking.trim());
            setMarking(null);
            toast(
              recording()
                ? "Marked. It's in your trail with everything around it."
                : "Marked. Turn on ⌘K → Record my navigation to keep what led up to it too.",
            );
          }}
        >
          <input
            className="dialog-input"
            value={marking}
            placeholder="e.g. find where invites are sent; add a store under app-service"
            onChange={(e) => setMarking(e.target.value)}
          />
          <p className="muted small">
            Kept with where you are and what you did just before, for an agent to read (trail).
          </p>
        </Dialog>
      )}
    </>
  );
}

/** ⌘K: commands, diagrams and boxes. */
export function PaletteHost({
  commands,
  navigate,
  palette,
  setPalette,
  toast,
  idx,
  diagramId,
}: Pick<
  WorkspaceBag,
  "commands" | "navigate" | "palette" | "setPalette" | "toast" | "idx" | "diagramId"
>) {
  return (
    <>
      {palette && (
        <Palette
          idx={idx}
          commands={commands}
          onClose={() => setPalette(false)}
          onPick={(item) => {
            setPalette(false);
            if (item.command) item.command.run();
            else if (item.kind === "diagram") navigate(item.id, null, "search");
            else {
              const on =
                diagramId && idx.placements.get(diagramId)?.has(item.id)
                  ? diagramId
                  : [...(idx.placedOn.get(item.id) ?? [])][0];
              if (on) navigate(on, item.id, "search");
              else toast(`${item.label} isn't on any diagram yet: drag it in from the sidebar`);
            }
          }}
        />
      )}
    </>
  );
}
