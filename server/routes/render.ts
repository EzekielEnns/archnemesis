// A view as an image: /api/d/<key>/render/<view>.svg|.png?flow=<name>&step=<n from 1>
import type { Ctx } from "../app.ts";
import { json } from "../http.ts";
import { renderView, toPng } from "../render.ts";
import type { DesignCall } from "./design.ts";

export async function renderRoutes(_ctx: Ctx, d: DesignCall): Promise<boolean> {
  const { req, res, live, sub, arg } = d;
  if (req.method !== "GET" || sub !== "/render" || !arg) return false;
  const file = /^(.+)\.(svg|png)$/.exec(decodeURIComponent(arg));
  if (!file) return (json(res, 400, { error: "render/<view>.svg or .png" }), true);
  const q = new URL(req.url ?? "", "http://x").searchParams;
  const step = Number(q.get("step") ?? "") || 0;
  try {
    const { svg } = await renderView(
      live.index(),
      live.config(),
      file[1]!,
      q.get("flow"),
      step ? step - 1 : undefined,
    );
    if (file[2] === "svg") {
      res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "no-store" });
      res.end(svg);
    } else {
      const png = await toPng(svg);
      res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
      res.end(png);
    }
  } catch (e) {
    json(res, 404, { error: (e as Error).message });
  }
  return true;
}
