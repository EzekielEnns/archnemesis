// The canvas's host element, the Scene made for it, the cameras kept per diagram, and whether it's
// ready. useScene (below) is what makes and drives the Scene; these are shared before it exists.
import { useRef, useState } from "react";
import type { Camera } from "../canvas/camera";
import { Scene } from "../canvas/Scene";

export function useSceneRefs() {
  const [ready, setReady] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<Scene | null>(null);
  const cameras = useRef(new Map<string, Camera>());
  const shown = useRef<string | null>(null);
  return { host, scene, cameras, shown, ready, setReady };
}
