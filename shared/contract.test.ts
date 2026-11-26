// The files are the contract: an agent with only the folder can keep the architecture up to
// date. These pin what that promise rests on.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { readFolder } from "../server/files.ts";
import { seedOps } from "./seed.ts";
import { AGENTS_MARK, isGeneratedAgents } from "./agentsmd.ts";
import { applyOps, emptyState, mirror, type Actor } from "./doc.ts";
import { check, keyOps, readFiles, toOps, writeFiles } from "./files.ts";
import { buildIndex } from "./project.ts";
import { SCHEMAS } from "./spec.ts";
import { viewOps } from "./views.ts";

const me: Actor = { id: "t", name: "T", kind: "agent" };

function shop() {
  const doc = new Y.Doc();
  const state = emptyState();
  mirror(doc, state, () => {});
  applyOps(doc, state, seedOps(), me, "seed");
  applyOps(doc, state, keyOps(state), me, "keys");
  return { doc, state };
}

/** Load files the way Archnemesis does: apply them, then let rule views pick up what's new. */
function load(files: Map<string, string>) {
  const { model, problems } = readFiles(files);
  const doc = new Y.Doc();
  const state = emptyState();
  mirror(doc, state, () => {});
  applyOps(doc, state, toOps(state, model), me, "load");
  const idx = () =>
    buildIndex({
      objects: state.objects.values(),
      connections: state.connections.values(),
      diagrams: state.diagrams.values(),
      placements: state.placements.values(),
      flows: state.flows.values(),
      boundaries: state.boundaries.values(),
    });
  const follow = [...state.diagrams.values()]
    .filter((d) => d.rules)
    .flatMap((d) => viewOps(idx(), d.id));
  if (follow.length) applyOps(doc, state, follow, me, "rules");
  return { state, idx: idx(), problems: [...problems, ...check(model)] };
}

describe("the file contract", () => {
  it("schema/ is exactly what the format's one definition says (run `archnm schema` after changing it)", () => {
    for (const [name, s] of Object.entries(SCHEMAS)) {
      const onDisk = JSON.parse(
        readFileSync(join(import.meta.dirname, "..", "schema", name), "utf8"),
      );
      expect(onDisk, name).toEqual(s);
    }
  });

  it("a new object added by editing YAML alone lands on the diagrams whose rules pick it, placed", () => {
    // The example folder, whose Shop diagram follows rules (children + neighbours of shop).
    const files = readFolder(join(import.meta.dirname, "..", "examples", "shop"));
    // What an agent writes: an object and a connection. No layout, no ids beyond the key.
    files.set(
      "model/shop.yaml",
      files
        .get("model/shop.yaml")!
        .replace(
          "objects:\n",
          "objects:\n  refunds:\n    kind: app\n    in: shop\n    tech: Go\n    context: Pays people back.\n",
        )
        .replace(
          "connections:\n",
          "connections:\n  - { from: refunds, to: payments, label: refunds cards }\n",
        ),
    );
    const { idx, problems } = load(files);
    expect(problems.filter((p) => p.level === "error")).toEqual([]);
    const refunds = [...idx.objects.values()].find((o) => o.key === "refunds")!;
    const inside = [...idx.diagrams.values()].find((d) => d.scopeId === refunds.parentId)!;
    expect(inside.rules).toBeTruthy();
    const spot = idx.placements.get(inside.id)?.get(refunds.id);
    expect(spot, "placed on the Shop diagram").toBeTruthy();
    expect(Number.isFinite(spot!.x)).toBe(true);
  });

  it("names every problem with its file and line, so an agent can go straight to it", () => {
    const { state } = shop();
    const files = writeFiles(state);
    files.set(
      "model/shop.yaml",
      files.get("model/shop.yaml")!.replace("kind: app", "kind: service"),
    );
    const p = readFiles(files).problems.find((x) =>
      x.message.includes('kind "service" isn\'t one of'),
    )!;
    const line = Number(p.file.split(":")[1]);
    expect(p.file).toMatch(/^model\/shop\.yaml:\d+$/);
    // The line is the field's own line: its kind.
    expect(files.get("model/shop.yaml")!.split("\n")[line - 1]).toBe("    kind: service");
  });

  it("writes an AGENTS.md with the format and this design's own rules; a person's AGENTS.md is theirs", () => {
    const { state } = shop();
    const files = writeFiles(state, { name: "Shop", forbid: ["\\bacme\\b"] });
    const guide = files.get("AGENTS.md")!;
    expect(guide.startsWith(AGENTS_MARK)).toBe(true);
    expect(guide).toContain("`\\bacme\\b`");
    expect(guide).toContain("| `kind` * |");
    expect(guide).toContain("archnm check");
    // Reading it changes nothing; writing it again gives the same bytes.
    const { model, problems } = readFiles(files);
    expect(problems).toEqual([]);
    expect(writeFiles(state, model.config)).toEqual(files);
    expect(isGeneratedAgents(guide)).toBe(true);
    expect(isGeneratedAgents("# Our agent rules\n")).toBe(false);
  });

  it("the design's rules hold for text anywhere, and say where", () => {
    const { state } = shop();
    const files = writeFiles(state, { forbid: ["\\bacme\\b"] });
    files.set(
      "model/shop.yaml",
      files.get("model/shop.yaml")!.replace("name: Worker", "name: Acme worker"),
    );
    const p = check(readFiles(files).model).find((x) => x.message.includes("forbids"))!;
    expect(p.file).toMatch(/^model\/shop\.yaml:\d+$/);
  });
});
