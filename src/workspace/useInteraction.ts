// How you work on the diagram: what's lit for a flow or the diff, going up, the card following
// its box, copy and paste, the keyboard, and the lists built for the right-click menu, the
// palette, the diff and settings. Builds on useDiagramState and useCanvasSession, and hands
// everything on, flat, to the components.

import { useSpotlight } from "./useSpotlight";
import { useFlowEffects } from "./useFlow";
import { useUp } from "./useUp";
import { useCardFollow } from "./useCard";
import { useClipboard } from "./useClipboard";
import { useKeyboard } from "./useKeyboard";

import type { MenuCtx } from "./contextMenu";
import { buildCommands } from "./commands";
import { diffChangesOf } from "./diffChanges";
import { viewSettingsOf } from "./viewSettings";
import type { DiagramState } from "./useDiagramState";
import type { CanvasSession } from "./useCanvasSession";

export function useInteraction(s: DiagramState, c: CanvasSession) {
  const all = { ...s, ...c };
  useSpotlight(all);
  useFlowEffects(all);
  const up = useUp({ ...all });
  const floatRef = useCardFollow(all);
  useClipboard(all);
  useKeyboard({ ...all, up: up.up });
  const menuCtx: MenuCtx = { ...all, ...up };
  const diffChanges = diffChangesOf(all);
  const commands = buildCommands({ ...all, ...up });
  const viewSettings = viewSettingsOf(all);
  return { ...all, ...up, floatRef, menuCtx, diffChanges, commands, viewSettings };
}

export type WorkspaceBag = ReturnType<typeof useInteraction>;
