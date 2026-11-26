// The canvas and what happens on it: moving between diagrams, notes, edits, the tour, the Scene
// itself, who else is on the diagram, what's lit by hovering, and jumps. Builds on
// useDiagramState.

import { useNavigation } from "./useNavigation";
import { useNotes } from "./useNotes";
import { useEditActions } from "./useEditActions";
import { useDiagramActions } from "./useDiagramActions";
import { useDragDrop } from "./useDragDrop";
import { useTour } from "./useTour";
import { useWebMcp } from "./useWebMcp";
import { useStoreEvents } from "./useStoreEvents";
import { useScene } from "./useScene";
import { usePeerSync } from "./usePeerSync";
import { useHighlights } from "./useHighlights";
import { useJump } from "./useJump";
import { useTrail } from "./useTrail";
import type { DiagramState } from "./useDiagramState";

export function useCanvasSession(s: DiagramState) {
  const nav = useNavigation(s);
  const notes = useNotes({ ...s, ...nav });
  const edits = useEditActions(s);
  const actions = useDiagramActions({ ...s, ...nav });
  const onDrop = useDragDrop(s);
  const tour = useTour(s);
  useWebMcp({ ...s, ...tour });
  useStoreEvents(s.store, s.toast);
  const canvas = useScene({ ...s, ...nav, refs: s, deps: { ...s, ...notes, ...edits } });
  usePeerSync(s);
  const highlights = useHighlights(s);
  const jump = useJump({ ...s, ...nav });
  const trail = useTrail({ ...s, ...nav, ...jump });
  return {
    ...nav,
    ...notes,
    ...edits,
    ...actions,
    onDrop,
    ...tour,
    ...canvas,
    ...highlights,
    ...jump,
    ...trail,
  };
}

export type CanvasSession = ReturnType<typeof useCanvasSession>;
