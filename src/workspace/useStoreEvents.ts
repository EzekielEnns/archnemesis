// What the store tells us on its own: a toast carried over a page change, what other people
// do, and git moving us to or off a fork.
import { useEffect } from "react";
import type { LogEntry } from "../../shared/doc.ts";
import type { Store } from "../store";

import { carryToast, goDoc, takeCarried } from "../route";
import type { ToastFn } from "./toasts";

export function useStoreEvents(store: Store, toast: ToastFn) {
  useEffect(() => {
    const c = takeCarried();
    if (c) toast(c.text, c.tone);
  }, [toast]);

  useEffect(() => {
    store.onRemote = (e: LogEntry) => toast(`${e.actor.name} · ${e.label}`);
    // Git: an edit on main opened a fork; a fork closed (merged, discarded).
    store.onForked = (doc, created, errors) => {
      const name = doc.split("@")[1];
      carryToast(
        errors.length
          ? `Not all of it applied on ${name}: ${errors[0]}`
          : created
            ? `Started fork ${name}`
            : `Moved to fork ${name}`,
        errors.length ? "error" : "info",
      );
      goDoc(doc);
    };
    store.onMoved = (to, why) => {
      if (to === store.design) return location.reload();
      carryToast(why ? `${why}. Back on main.` : "Back on main");
      goDoc(to);
    };
    return () => {
      store.onRemote = null;
    };
  }, [store, toast]);
}
