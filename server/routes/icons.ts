// Technology logos for the app: search them, and fetch one as SVG.
import type { Call, Ctx } from "../app.ts";
import { json } from "../http.ts";
import { iconSvg, searchIcons } from "../../shared/icons.ts";

export function iconRoutes(ctx: Ctx, { req, res, path }: Call): boolean {
  if (req.method !== "GET") return false;
  const query = () => new URL(req.url ?? "", ctx.config.listen.publicUrl).searchParams;
  if (path === "/api/icons") {
    json(res, 200, searchIcons((query().get("q") ?? "").slice(0, 40)));
    return true;
  }
  if (path === "/api/icon") {
    const q = query();
    const brand = q.get("color") === "brand";
    const svg = iconSvg((q.get("tech") ?? "").slice(0, 80), brand ? "brand" : undefined);
    if (!svg) {
      res.writeHead(404, { "cache-control": "max-age=3600" }).end();
      return true;
    }
    res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "max-age=86400" });
    res.end(svg);
    return true;
  }
  return false;
}
