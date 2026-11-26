// Toasts: the short messages at the bottom of the page, and `run`, which sends edits to the
// store and toasts it when one is refused.
import { useCallback, useState } from "react";
import type { Op } from "../../shared/model.ts";
import type { Store } from "../store";

interface Toast {
  id: number;
  text: string;
  tone: "info" | "error";
  action?: { label: string; run: () => void };
}

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toast = useCallback(
    (text: string, toneOrAction: Toast["tone"] | Toast["action"] = "info") => {
      const id = Date.now() + Math.random();
      const tone = typeof toneOrAction === "string" ? toneOrAction : "info";
      const action = typeof toneOrAction === "object" ? toneOrAction : undefined;
      setToasts((t) => [...t.slice(-3), { id, text, tone, action }]);
      // One with a button stays long enough to reach it.
      setTimeout(
        () => setToasts((t) => t.filter((x) => x.id !== id)),
        tone === "error" || action ? 6000 : 3500,
      );
    },
    [],
  );
  return { toasts, setToasts, toast };
}

export type ToastFn = ReturnType<typeof useToasts>["toast"];

export function useRun(store: Store, toast: ToastFn) {
  const run = useCallback(
    (ops: Op[], label: string) =>
      store
        .send(ops, label)
        .catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), "error")),
    [store, toast],
  );
  return run;
}

export type Run = ReturnType<typeof useRun>;
