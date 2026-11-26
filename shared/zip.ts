// A minimal zip, both ways, with no dependency. Writing stores every file uncompressed (the
// files are small text, and a git client or `unzip` reads them all the same). Reading takes
// stored and deflated entries, the two kinds every zip tool makes, and is cautious: it only
// unpacks a design's own files, caps what it reads, and ignores any path that goes upward.
import { inflateRaw } from "./deflate.ts";
import { designFolders, filesUnder, isOurs } from "./ours.ts";

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: false });

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A fixed date (1980-01-01): a zip of the same files is the same bytes every time. */
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;

/** The files as a .zip (uncompressed, names in UTF-8). */
export function zipFiles(files: Map<string, string>): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of files) {
    const n = enc.encode(name);
    const data = enc.encode(text);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);
    local.setUint16(8, 0, true);
    local.setUint16(10, DOS_TIME, true);
    local.setUint16(12, DOS_DATE, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, n.length, true);
    parts.push(new Uint8Array(local.buffer), n, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint16(12, DOS_TIME, true);
    c.setUint16(14, DOS_DATE, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, data.length, true);
    c.setUint32(24, data.length, true);
    c.setUint16(28, n.length, true);
    c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), n);
    offset += 30 + n.length + data.length;
  }
  const size = central.reduce((s, p) => s + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.size, true);
  end.setUint16(10, files.size, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

const NOT_ZIP = "That isn't a zip file Archnemesis can read.";
/** What a zip may unpack to (all of a design's files together). */
const MAX_TOTAL = 5 * 1024 * 1024;
const MAX_ENTRIES = 20000;

interface Entry {
  name: string;
  method: number;
  packed: number;
  size: number;
  at: number;
}

function entriesOf(bytes: Uint8Array): Entry[] {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--)
    if (v.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0) throw new ZipError(NOT_ZIP);
  const count = v.getUint16(end + 10, true);
  let p = v.getUint32(end + 16, true);
  if (count > MAX_ENTRIES) throw new ZipError("That zip holds too many files.");
  const out: Entry[] = [];
  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length || v.getUint32(p, true) !== 0x02014b50) throw new ZipError(NOT_ZIP);
    const nameLen = v.getUint16(p + 28, true);
    const extra = v.getUint16(p + 30, true);
    const comment = v.getUint16(p + 32, true);
    if (p + 46 + nameLen > bytes.length) throw new ZipError(NOT_ZIP);
    out.push({
      name: dec.decode(bytes.subarray(p + 46, p + 46 + nameLen)),
      method: v.getUint16(p + 10, true),
      packed: v.getUint32(p + 20, true),
      size: v.getUint32(p + 24, true),
      at: v.getUint32(p + 42, true),
    });
    p += 46 + nameLen + extra + comment;
  }
  return out;
}

async function extract(bytes: Uint8Array, e: Entry, budget: number): Promise<string> {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (e.at + 30 > bytes.length || v.getUint32(e.at, true) !== 0x04034b50)
    throw new ZipError(NOT_ZIP);
  const start = e.at + 30 + v.getUint16(e.at + 26, true) + v.getUint16(e.at + 28, true);
  const packed = bytes.subarray(start, start + e.packed);
  if (packed.length !== e.packed) throw new ZipError(NOT_ZIP);
  const tooBig = "That zip unpacks to too much to be a design.";
  if (e.size > budget) throw new ZipError(tooBig);
  if (e.method === 0) return dec.decode(packed);
  if (e.method === 8) {
    const data = await inflateRaw(packed, Math.min(e.size, budget), tooBig).catch((err) => {
      throw err instanceof Error && err.message === tooBig
        ? new ZipError(tooBig)
        : new ZipError(NOT_ZIP);
    });
    return dec.decode(data);
  }
  throw new ZipError("That zip uses a compression Archnemesis can't read.");
}

/** A path as a plain relative one (backslashes to slashes), or null when it goes upward or is absolute. */
export function cleanPath(name: string): string | null {
  const p = name.replace(/\\/g, "/");
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return null;
  const parts = p.split("/").filter((s) => s !== "" && s !== ".");
  return parts.some((s) => s === "..") || !parts.length ? null : parts.join("/");
}

/**
 * The design inside a zip: the files of the first folder (the top first) that holds an
 * archnm.yaml, with that folder taken off their paths. GitHub's "Download ZIP" puts
 * everything under one folder, so that works too.
 */
export async function unzipDesign(bytes: Uint8Array): Promise<Map<string, string>> {
  const entries = entriesOf(bytes);
  const byPath = new Map<string, Entry>();
  for (const e of entries) {
    const p = cleanPath(e.name);
    if (p && !e.name.endsWith("/")) byPath.set(p, e);
  }
  const folder = designFolders(byPath.keys())[0];
  if (folder === undefined) throw new ZipError("That zip has no design in it (no archnm.yaml).");
  const wanted = filesUnder(byPath, folder);
  const out = new Map<string, string>();
  let left = MAX_TOTAL;
  for (const [rel, e] of wanted) {
    if (!isOurs(rel)) continue;
    const text = await extract(bytes, e, left);
    left -= enc.encode(text).length;
    out.set(rel, text);
  }
  return out;
}
