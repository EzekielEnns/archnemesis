import { describe, expect, it } from "vitest";
import { trailFindings, trailText, type TrailRow } from "./trail";
import { buildIndex } from "./project";

const idx = buildIndex({
  objects: [],
  connections: [],
  diagrams: [],
  placements: [],
  flows: [],
} as never);
const at = (s: number) => new Date(Date.UTC(2026, 10, 22, 12, 0, s)).toISOString();
const move = (s: number, how: string, from: string, to: string, extra = {}): TrailRow => ({
  session: "s1",
  user: "Zeek",
  doc: "d",
  event: {
    at: at(s),
    kind: "move",
    how: how as never,
    from: { d: from, o: null },
    to: { d: to, o: null },
    ...extra,
  },
});

describe("trail", () => {
  it("spots bounces, climbs, dead ends, new views and searching after drilling", () => {
    const rows: TrailRow[] = [
      move(0, "open", "a", "b"),
      move(10, "open", "b", "c", { created: true }),
      move(12, "up", "c", "b"),
      move(30, "open", "b", "d"),
      {
        session: "s1",
        user: "Zeek",
        doc: "d",
        event: { at: at(40), kind: "dead-end", object: "x" },
      },
      move(50, "search", "d", "e"),
      move(60, "up", "e", "d"),
      move(70, "up", "d", "b"),
      move(80, "up", "b", "a"),
    ];
    const f = trailFindings(rows, idx).join("\n");
    expect(f).toMatch(/2 bounce/);
    expect(f).toMatch(/up 3\+ levels/);
    expect(f).toMatch(/1 double-click/);
    expect(f).toMatch(/1 open\(s\) made a brand-new view/);
    expect(f).toMatch(/1 search\(es\) after drilling/);
    expect(trailText(rows, idx)).toMatch(/open {4}\(deleted view a\) \[0\] → \(deleted view b\)/);
  });
  it("says how to turn it on when there's nothing", () => {
    expect(trailText([], idx)).toMatch(/Record my navigation/);
  });
});
