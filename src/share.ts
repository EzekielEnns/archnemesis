// Share links in this browser. A link is an address with the token after the #:
//   https://archnm.example/#/<design>~share=<token>
// The part after the # is never sent to a server by the browser (so it stays out of logs and
// Referer), and this takes it out of the address bar at once. The token is kept for that one design
// in session storage (this tab only, gone when it closes, never local storage) and sent to the
// server in a header (and on the sync connection) only for that design.
const PREFIX = "archnm.share.";
const LINK =
  /^#\/([a-z0-9][a-z0-9-]*(?:@[a-z0-9][a-z0-9-]*)?)~share=([A-Za-z0-9_-]{20,128})(\/.*)?$/i;

function session(): Storage | null {
  try {
    return sessionStorage;
  } catch {
    return null;
  }
}

/** If the address is a share link: keep its token for that design, and leave the address without it. */
export function takeShareFromHash(): void {
  const m = LINK.exec(location.hash);
  if (!m) return;
  const doc = m[1]!.toLowerCase();
  try {
    session()?.setItem(PREFIX + doc, m[2]!);
  } catch {
    /* storage refused: the link works for this load only */
  }
  history.replaceState(null, "", `${location.pathname}${location.search}#/${doc}${m[3] ?? ""}`);
}

/** The token held for this document (or, for a design, for one of its forks: a fork's link also reads its base). */
export function shareTokenFor(doc: string): string | null {
  const s = session();
  if (!s) return null;
  try {
    const own = s.getItem(PREFIX + doc);
    if (own) return own;
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k?.startsWith(`${PREFIX}${doc}@`)) return s.getItem(k);
    }
  } catch {
    /* nothing held */
  }
  return null;
}

/** Let go of the token held for this document (the link was revoked, or it stopped working). */
export function forgetShare(doc: string): void {
  try {
    session()?.removeItem(PREFIX + doc);
  } catch {
    /* already gone */
  }
}
