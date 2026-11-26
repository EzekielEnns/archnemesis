// Folding externals on a landscape: by group: tag by default, or all into one box.
import { expect, it } from "vitest";
import * as Y from "yjs";
import { applyOps, emptyState, mirror, type Actor } from "./doc.ts";
import { makeDiagram, makeObject } from "./model.ts";
import { buildIndex, foldMode, groupLabel, projectDiagram } from "./project.ts";
import { viewOps } from "./views.ts";

const me: Actor = { id: "t", name: "T", kind: "agent" };
const ext = (id: string, g?: string) =>
  makeObject({
    id,
    key: id,
    kind: "system",
    name: id.toUpperCase(),
    external: true,
    tags: g ? [`group:${g}`] : [],
  });

function names(
  fold?: "groups" | "externals" | "none",
  extra: ReturnType<typeof makeObject>[] = [],
  include?: { tag: string }[],
  loose?: Set<string>,
) {
  const doc = new Y.Doc();
  const st = emptyState();
  mirror(doc, st, () => {});
  const objs = [
    makeObject({ id: "us", key: "us", kind: "system", name: "Us" }),
    ext("ses", "aws"),
    ext("rek", "aws"),
    ext("stripe", "third-party-services"),
    ext("clerk", "third-party-services"),
    ext("lone", "public-lookup-services-no-contract"),
    ext("x"),
    ext("y"),
    ...extra,
  ];
  applyOps(
    doc,
    st,
    [
      ...objs.map((object) => ({ op: "object.put" as const, object })),
      {
        op: "diagram.put",
        diagram: makeDiagram({
          id: "d",
          name: "L",
          key: "l",
          ...(fold ? { fold } : {}),
          rules: { include: [{ ids: objs.map((o) => o.id) }, ...(include ?? [])], exclude: [] },
        }),
      },
    ],
    me,
    "t",
  );
  const idx = () =>
    buildIndex({
      objects: st.objects.values(),
      connections: st.connections.values(),
      diagrams: st.diagrams.values(),
      placements: st.placements.values(),
      flows: st.flows.values(),
    });
  applyOps(doc, st, viewOps(idx(), "d"), me, "rules");
  return projectDiagram(idx(), "d", { loose })
    .nodes.map((n) => n.name)
    .sort();
}

it("groups by default: one box per group, a lone group member stays, the ungrouped together", () => {
  expect(names()).toEqual([
    "2 other externals",
    "AWS · 2",
    "LONE",
    "Third party services · 2",
    "Us",
  ]);
});
it("externals: all in one box", () => expect(names("externals")).toEqual(["7 externals", "Us"]));
it("none: each drawn", () => expect(names("none")).toHaveLength(8));
it("never folds a box just made (loose): it stays where it was put", () => {
  expect(names("externals", [], undefined, new Set(["stripe"]))).toEqual([
    "6 externals",
    "STRIPE",
    "Us",
  ]);
});
it("labels", () => {
  expect(groupLabel("aws")).toBe("AWS");
  expect(groupLabel("third-party-services")).toBe("Third party services");
  expect(groupLabel("runs-on-the-subject-s-device")).toBe("Runs on the subject's device");
});

const ours = (id: string, g: string) =>
  makeObject({ id, key: id, kind: "app", name: id.toUpperCase(), tags: [`group:${g}`] });
it("by default our own grouped boxes stay; fold: groups folds them too", () => {
  const hs = [ours("probe", "human-signals"), ours("collector", "human-signals")];
  expect(names(undefined, hs)).toContain("PROBE");
  expect(names("groups", hs)).toContain("Human signals · 2");
  expect(names("groups", hs)).not.toContain("PROBE");
});
it("never folds the group the view is about", () => {
  expect(names("groups", [], [{ tag: "group:aws" }])).toEqual(
    expect.arrayContaining(["SES", "REK"]),
  );
});

it("doesn't fold by default where boundaries are drawn", () => {
  expect(foldMode({ scopeId: null })).toBe("groups");
  expect(foldMode({ scopeId: null, boundaries: true })).toBe("none");
  expect(foldMode({ scopeId: null, boundaries: true, fold: "externals" })).toBe("externals");
});
