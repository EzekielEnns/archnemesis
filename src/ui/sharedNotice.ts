// One line shown above a design for a moment after a shared link opened a copy that was already
// here: which design it is, and the link, so "Make another copy" can run it again.
import { useSyncExternalStore } from "react";

interface Notice {
  key: string;
  fragment: string;
}

let current: Notice | null = null;
const listeners = new Set<() => void>();

export function setSharedNotice(n: Notice | null): void {
  current = n;
  for (const l of listeners) l();
}

export function useSharedNotice(): Notice | null {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => void listeners.delete(l)),
    () => current,
  );
}
