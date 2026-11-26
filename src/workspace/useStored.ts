// Per-browser choices kept in localStorage (layout flags, arrow style), quietly skipped when
// storage isn't there (a private window).
import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useState } from "react";

/** One of a few choices kept in localStorage, or null for "not chosen" (falls back quietly). */
export function useStoredChoice<T extends string>(
  key: string,
  allowed: readonly T[],
): [T | null, (v: T | null) => void] {
  const [v, setV] = useState<T | null>(() => {
    try {
      const got = localStorage.getItem(key);
      return got !== null && (allowed as readonly string[]).includes(got) ? (got as T) : null;
    } catch {
      return null;
    }
  });
  const set = useCallback(
    (next: T | null) => {
      setV(next);
      try {
        if (next === null) localStorage.removeItem(key);
        else localStorage.setItem(key, next);
      } catch {
        /* private window: just don't remember */
      }
    },
    [key],
  );
  return [v, set];
}

/** A boolean kept in localStorage (a per-browser preference; falls back quietly). */
export function useStoredFlag(
  key: string,
  initial: boolean,
): [boolean, Dispatch<SetStateAction<boolean>>] {
  const [v, setV] = useState(() => {
    try {
      const got = localStorage.getItem(key);
      return got === null ? initial : got === "1";
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, v ? "1" : "0");
    } catch {
      /* private window: just don't remember */
    }
  }, [key, v]);
  return [v, setV];
}
