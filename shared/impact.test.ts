import { expect, it } from "vitest";
import { makeConnection, makeObject } from "./model.ts";
import { buildIndex } from "./project.ts";
import { impact } from "./impact.ts";

it("follows dependencies however many hops, through what's inside, without looping", () => {
  const web = makeObject({ kind: "app", name: "web" });
  const api = makeObject({ kind: "system", name: "api" });
  const svc = makeObject({ kind: "component", name: "svc", parentId: api.id });
  const db = makeObject({ kind: "store", name: "db" });
  const cron = makeObject({ kind: "app", name: "cron" });
  const idx = buildIndex({
    objects: [web, api, svc, db, cron],
    connections: [
      makeConnection({ fromId: web.id, toId: api.id }),
      makeConnection({ fromId: svc.id, toId: db.id }),
      makeConnection({ fromId: cron.id, toId: web.id }),
      makeConnection({ fromId: db.id, toId: cron.id }), // a loop back round
    ],
    diagrams: [],
    placements: [],
  });
  const up = new Map(
    impact(idx, db.id, "upstream").map((r) => [idx.objects.get(r.id)!.name, r.hops]),
  );
  expect(up).toEqual(
    new Map([
      ["svc", 1],
      ["web", 2],
      ["cron", 3],
    ]),
  );
  const down = new Map(
    impact(idx, api.id, "downstream").map((r) => [idx.objects.get(r.id)!.name, r.hops]),
  );
  expect(down).toEqual(
    new Map([
      ["db", 1],
      ["cron", 2],
      ["web", 3],
    ]),
  );
});
