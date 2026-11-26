// A design that travels inside a link. The design's files (exactly what writeFiles gives,
// layout included) become one JSON object, compressed with deflate-raw, written as base64url
// and given a version prefix ("a1.") so the format can change later. It goes in the
// fragment of a URL (`#~d=...`), which a browser never sends anywhere.
// Everything that comes back out of a link is untrusted: it is capped, checked to be a map of
// strings, and still goes through readFiles before anything is shown.
import { deflateRaw, inflateRaw } from "./deflate.ts";
import { isOurs } from "./ours.ts";

export const LINK_VERSION = "a1.";
/** The most a link may unpack to. */
export const MAX_DECODED = 5 * 1024 * 1024;
/** The most files one link may hold. */
const MAX_FILES = 2000;
const MAX_PATH = 300;

export class ShareLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShareLinkError";
  }
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The design's files as link text (without the `#~d=`). */
export async function encodeDesign(files: Map<string, string>): Promise<string> {
  // AGENTS.md is generated text about the design, most of the size of a small one; it's left
  // out (a copy writes its own).
  const json = JSON.stringify(Object.fromEntries([...files].filter(([p]) => p !== "AGENTS.md")));
  const raw = new TextEncoder().encode(json);
  if (raw.length > MAX_DECODED) throw new ShareLinkError("This design is too big for a link.");
  return LINK_VERSION + toBase64Url(await deflateRaw(raw));
}

const BAD = "That link doesn't hold a design (it may have been cut short when it was copied).";

/** The files in link text; throws ShareLinkError with a plain sentence when it isn't one. */
export async function decodeDesign(text: string): Promise<Map<string, string>> {
  const t = text.trim();
  if (!t.startsWith(LINK_VERSION)) {
    throw new ShareLinkError(
      /^a\d+\./.test(t)
        ? "That link was made by a newer version of Archnemesis. Update, or ask for the files."
        : BAD,
    );
  }
  const body = t.slice(LINK_VERSION.length);
  if (!body || !BASE64URL.test(body)) throw new ShareLinkError(BAD);
  let json: string;
  try {
    const bytes = await inflateRaw(fromBase64Url(body), MAX_DECODED, "big");
    json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (e) {
    throw new ShareLinkError(
      e instanceof Error && e.message === "big"
        ? "That design is too big to open from a link (over 5 MB)."
        : BAD,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new ShareLinkError(BAD);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new ShareLinkError(BAD);
  const out = new Map<string, string>();
  for (const [path, body] of Object.entries(parsed)) {
    if (typeof body !== "string") throw new ShareLinkError(BAD);
    // Only a design's own files (and none with a strange path) are kept.
    if (path.length <= MAX_PATH && isOurs(path)) out.set(path, body);
    if (out.size > MAX_FILES) throw new ShareLinkError("That link holds too many files.");
  }
  if (!out.size) throw new ShareLinkError("That link holds no design files.");
  return out;
}

/** A short fingerprint of link text, to tell a link already opened from a new one. */
export function fingerprint(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
