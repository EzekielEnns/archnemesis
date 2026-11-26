// What this browser remembers (localStorage, never the document): the token, the name you
// chose, the last design you had open. Reads and writes never throw (a private window just
// doesn't remember).
export const TOKEN_KEY = "archnm.token";
export const NAME_KEY = "archnm.name";
export const DESIGN_KEY = "archnm.design";

/** The key this browser used before the rename ("atlas.token" for "archnm.token"), still read. */
const oldKey = (key: string) => (key.startsWith("archnm.") ? `atlas.${key.slice(7)}` : key);

export function stored(key: string): string | null {
  try {
    return localStorage.getItem(key) ?? localStorage.getItem(oldKey(key));
  } catch {
    return null;
  }
}

export function setStored(key: string, value: string | null): void {
  try {
    if (value === null) {
      localStorage.removeItem(key);
      localStorage.removeItem(oldKey(key));
    } else localStorage.setItem(key, value);
  } catch {
    /* private window: fine, just not remembered */
  }
}
