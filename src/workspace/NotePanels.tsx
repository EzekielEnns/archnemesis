// The panel for the selected note or link, or the draft being written.
import { DRAFT, DraftPanel, LinkPanel, NotePanel } from "../ui/Notes";

import type { WorkspaceBag } from "./useInteraction";

/** The note, link or draft panel. */
export function NotePanels({
  noteSel,
  draft,
  mentionable,
  closeNote,
  selectNote,
  store,
  idx,
  run,
  diagramId,
}: Pick<
  WorkspaceBag,
  | "noteSel"
  | "draft"
  | "mentionable"
  | "closeNote"
  | "selectNote"
  | "store"
  | "idx"
  | "run"
  | "diagramId"
>) {
  return (
    <>
      {diagramId &&
        noteSel &&
        (() => {
          const common = {
            idx,
            me: store.me,
            people: mentionable,
            canEdit: store.canEdit,
            run,
            onClose: closeNote,
          };
          if (noteSel === DRAFT)
            return (
              draft && (
                <DraftPanel
                  key={`${draft.kind}${draft.x},${draft.y}`}
                  {...common}
                  draft={draft}
                  onPosted={selectNote}
                />
              )
            );
          const n = idx.notes.get(noteSel);
          if (!n) return null;
          return n.kind === "link" ? (
            <LinkPanel key={n.id} {...common} note={n} diagramId={diagramId} />
          ) : (
            <NotePanel key={n.id} {...common} note={n} />
          );
        })()}
    </>
  );
}
