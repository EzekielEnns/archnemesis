// The latest model, diagram and tool, held in a ref for the canvas callbacks that are bound
// once (they'd otherwise see the values from the render they were made in).
import { useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { Exploded } from "../../shared/explode.ts";
import type { Flow, ObjectKind } from "../../shared/model.ts";
import type { CanvasGraph, ModelIndex } from "../../shared/project.ts";
import type { Removed } from "../../shared/whatsnew.ts";
import type { Spread } from "../canvas/spread";
import type { usePresence } from "../presence";
import type { ToolId } from "../ui/Chrome";
import type { Selection } from "../canvas/Scene";
import type { Run, ToastFn } from "./toasts";

interface Latest {
  gone: ReadonlyMap<string, Removed>;
  diffIdx: ModelIndex | null;
  idx: ModelIndex;
  diagramId: string | null;
  run: Run;
  graph: CanvasGraph | null;
  flow: Flow | undefined;
  connectFrom: string | null;
  toast: ToastFn;
  tool: ToolId;
  setPresence: ReturnType<typeof usePresence>["set"];
  simple: boolean;
  openFresh: (id: string) => void;
  lastKind: ObjectKind | null;
  sel: Selection;
  setTool: Dispatch<SetStateAction<ToolId>>;
  spread: Spread;
  exploded: Exploded | null;
}
export type LatestRef = MutableRefObject<Latest>;

/** The ref itself; Workspace fills it in on every render, once everything it holds exists. */
export function useLatestRef(): LatestRef {
  return useRef({} as Latest);
}
