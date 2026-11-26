// Not the API, and not the app: the repo upload an agent's script makes, and the scripts the
// server hands out (one file each for node; npm run build makes them).
import type http from "node:http";
import type { Ctx } from "../app.ts";
import { body, json } from "../http.ts";
import type { Script } from "../scripts.ts";

/** A repo's survey and code index, from the script an agent ran: the ticket is the permission (minted by index start inside a signed-in MCP call), so no sign-in here. */
async function upload(
  ctx: Ctx,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ticket: string,
): Promise<void> {
  const b = (await body(req, 200 * 1024 * 1024)) as { survey?: unknown; index?: unknown };
  const ok = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object";
  if (
    !ok(b.survey) ||
    !ok(b.index) ||
    !Array.isArray(b.index.functions) ||
    !Array.isArray(b.index.files)
  )
    return json(res, 400, { error: "send { survey, index } (the archnm-index script makes it)" });
  const r = ctx.uploads.put(ticket, b as never);
  if (r.ok) json(res, 200, { ticket, repo: r.repo });
  else json(res, 410, { error: r.error });
}

export async function uploadRoutes(
  ctx: Ctx,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  path: string,
): Promise<boolean> {
  const up = /^\/upload\/([\w-]{16,64})$/.exec(path);
  if (up && req.method === "POST") {
    await upload(ctx, req, res, up[1]!);
    return true;
  }
  // The channel (see routes/signin.ts) and the repo reader (see index start). Built on demand
  // when dist/ doesn't have them (a server started from the source).
  if (path === "/archnm-index.cjs" || path === "/archnm-channel.mjs") {
    const r = await ctx.scripts.read(path.slice(1) as Script);
    if (!r.ok) json(res, 404, { error: r.error });
    else {
      res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-cache" });
      res.end(r.data);
    }
    return true;
  }
  return false;
}
