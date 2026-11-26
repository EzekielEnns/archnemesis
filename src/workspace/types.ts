// Small shared types for the workspace's hooks.
import type { MutableRefObject } from "react";
import type { How } from "../../shared/trail";
import type { Scene } from "../canvas/Scene";

/** The canvas, once it exists (null before it's made and after it's torn down). */
export type SceneRef = MutableRefObject<Scene | null>;

/** Go to a diagram (and a box on it), saying how, for the navigation trail. */
export type Navigate = (id: string, objectId?: string | null, how?: How, created?: boolean) => void;
