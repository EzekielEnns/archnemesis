// Where a request really comes from, for the per-address limit on wrong share links.
//
// Directly connected, that is the socket's address. Behind reverse proxies (ARCHNM_PROXIES of
// them) every visitor shares the proxy's address, so the visitor is read from X-Forwarded-For:
// each proxy appends the address it saw, so with n trusted proxies the visitor is the nth
// entry from the right. Anything further left was sent by the client and is never believed.
import type { IncomingHttpHeaders } from "node:http";

/** The part of a request this reads. */
interface From {
  socket: { remoteAddress?: string };
  headers: IncomingHttpHeaders;
}

export function clientAddr(req: From, proxies: number): string {
  const socket = req.socket.remoteAddress ?? "";
  if (proxies <= 0) return socket;
  const raw = req.headers["x-forwarded-for"];
  const hops = (Array.isArray(raw) ? raw.join(",") : (raw ?? ""))
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  // Fewer entries than proxies: the header isn't what was promised, so fall back to the socket.
  return hops.at(-proxies) ?? socket;
}
