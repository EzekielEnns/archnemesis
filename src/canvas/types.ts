// What the canvas draws: the projection of one diagram (shared/project.ts), so the canvas
// never knows about the model, only about boxes, arrows and boundaries.
export type { CanvasEdge, CanvasGraph, CanvasGroup, CanvasNode } from "../../shared/project.ts";
export type { ObjectKind as NodeKind } from "../../shared/model.ts";
export { CARD_H as NODE_H, CARD_W as NODE_W } from "../../shared/model.ts";
