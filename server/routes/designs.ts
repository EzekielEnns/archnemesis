// The list of designs, and making one.
import { canCreate } from "../access.ts";
import type { Seed } from "../live.ts";
import type { Call, Ctx } from "../app.ts";
import { body, json } from "../http.ts";

export async function designsRoutes(ctx: Ctx, { req, res, path, who }: Call): Promise<boolean> {
  if (path !== "/api/designs") return false;
  const { hub } = ctx;
  if (req.method === "GET") {
    json(res, 200, hub.list(who));
    return true;
  }
  if (req.method !== "POST") return false;
  if (!canCreate(who)) return (json(res, 403, { error: "you can read but not edit" }), true);
  const { name, key, from } = (await body(req)) as { name?: string; key?: string; from?: Seed };
  if (!name?.trim()) return (json(res, 400, { error: "a design needs a name" }), true);
  const d = await hub.create(
    name.trim(),
    key,
    from === "example" || from === "code" ? from : "empty",
    who,
  );
  await ctx.startInGit(d);
  json(res, 201, { key: d.key, name: d.name(), doc: d.docId() });
  return true;
}
