// The small HTTP helpers the routes share: reading a request body, answering JSON, and serving
// the built app's files.
import { readFile } from "node:fs/promises";
import type http from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { ModelError } from "../shared/doc.ts";

/** Read a request's body as JSON ({} when empty), refusing one over `limit` bytes. */
export async function body(req: http.IncomingMessage, limit = 5 * 1024 * 1024): Promise<unknown> {
  const t = await text(req, limit);
  return t ? JSON.parse(t) : {};
}

export async function text(req: http.IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new ModelError("request too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function json(res: http.ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

/** X-Archnm-<what>, or X-Atlas-<what>, the name it had before the rename. */
export const archnmHeader = (req: http.IncomingMessage, what: "name" | "token") =>
  req.headers[`x-archnm-${what}`] ?? req.headers[`x-atlas-${what}`];

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

/** The built app (dist/): the file asked for, or index.html for any path that isn't one. */
export async function serveBuilt(
  res: http.ServerResponse,
  root: string,
  path: string,
): Promise<void> {
  const dist = join(root, "dist");
  const file = normalize(join(dist, path === "/" ? "index.html" : path));
  const target = file.startsWith(dist + sep) ? file : join(dist, "index.html");
  try {
    const data = await readFile(target);
    res.writeHead(200, { "content-type": MIME[extname(target)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    const data = await readFile(join(dist, "index.html"));
    res.writeHead(200, { "content-type": MIME[".html"] });
    res.end(data);
  }
}

/** A share link's token, from X-Archnm-Share (never the URL: it stays out of logs and Referer). */
export function shareToken(req: http.IncomingMessage): string | null {
  const v = req.headers["x-archnm-share"];
  const one = (Array.isArray(v) ? v[0] : v)?.trim();
  return one && one.length <= 128 ? one : null;
}
