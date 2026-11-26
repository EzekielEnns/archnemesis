// While diffing: the fork's changes as a list, each one a way to go and look.
import { type ModelIndex } from "../../shared/project.ts";
import type { WhatsNew } from "../../shared/whatsnew.ts";
import { type Change } from "../ui/Branches";

import type { ToastFn } from "./toasts";
import type { Navigate, SceneRef } from "./types";
import type { useJump } from "./useJump";

export function diffChangesOf({
  whatsNew,
  idx,
  diagramId,
  scene,
  jumpFrom,
  navigate,
  toast,
  goToObject,
}: {
  whatsNew: WhatsNew | null;
  idx: ModelIndex;
  diagramId: string | null;
  scene: SceneRef;
  jumpFrom: ReturnType<typeof useJump>["jumpFrom"];
  navigate: Navigate;
  toast: ToastFn;
  goToObject: ReturnType<typeof useJump>["goToObject"];
}): Change[] {
  return !whatsNew
    ? []
    : [
        ...(whatsNew.added ?? []).map((id) => ({
          key: id,
          sign: "+" as const,
          name: idx.objects.get(id)?.name ?? id,
          go: () => goToObject(id),
        })),
        ...Object.entries(whatsNew.lines ?? {}).map(([id, ls]) => ({
          key: id,
          sign: "~" as const,
          name: idx.objects.get(id)?.name ?? id,
          plus: ls.filter((l) => l[0] === "+").length,
          minus: ls.filter((l) => l[0] === "-").length,
          go: () => goToObject(id),
        })),
        ...(whatsNew.removed ?? []).map((r) => ({
          key: `gone-${r.key}`,
          sign: "−" as const,
          name: r.name,
          go: () => {
            // Where it sat on main: here if it was, else the first diagram it was on.
            const here = diagramId ? r.at[diagramId] : undefined;
            if (here)
              return void scene.current?.centerAt({
                x: here.x + here.w / 2,
                y: here.y + here.h / 2,
              });
            const d = Object.keys(r.at).find((x) => idx.diagrams.has(x));
            if (d) (jumpFrom(), navigate(d, null, "sidebar"));
            else toast(`${r.name} wasn't on a diagram on main`);
          },
        })),
      ];
}
