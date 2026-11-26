// Every node the same: one context, references (links, images, docs, code, dependencies) and
// notes inside it. They read, write back unchanged, reach agents, and older files still load.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { planChanges } from "./agent.ts";
import { contextText } from "./context.ts";
import { stateFromFiles } from "./diff.ts";
import { applyOps, emptyState, mirror, ModelError, type Actor } from "./doc.ts";
import { check, readFiles, toOps, writeFiles } from "./files.ts";
import { buildIndex } from "./project.ts";
import { referencedBy, referencesOf, sharingTech, designTechs } from "./references.ts";

const MODEL = `objects:
  api:
    kind: app
    name: API
    tech: Rust, Axum
    context: |
      Serves the app.

      Rate limited per key.
    references:
      - link: https://runbooks.example/api
        title: Runbook
      - image: assets/api.png
      - doc: docs/api.md
      - code: hub:crates/api/src/main.rs#L12
      - dependency: serde
    notes: |
      - [ ] Move to Cloud Run.
      - [x] Rate limits.
  worker:
    kind: app
    name: Worker
    tech: [Rust]
    context: Drains the queue.
    references:
      - dependency: serde
  serde:
    kind: library
    package:
      ecosystem: cargo
      name: serde
`;

const files = (model = MODEL) =>
  new Map([
    ["archnm.yaml", "name: t\n"],
    ["model/m.yaml", model],
  ]);
const index = (state: ReturnType<typeof stateFromFiles>) =>
  buildIndex({
    objects: state.objects.values(),
    connections: state.connections.values(),
    diagrams: state.diagrams.values(),
    placements: state.placements.values(),
    flows: state.flows.values(),
    boundaries: state.boundaries.values(),
  });
const me: Actor = { id: "t", name: "T", kind: "agent" };

describe("references, notes, one context", () => {
  it("read, check and write back unchanged", () => {
    const { model, problems } = readFiles(files());
    expect([...problems, ...check(model)]).toEqual([]);
    const state = stateFromFiles(files());
    const out = writeFiles(state);
    const top = out.get("model/_top.yaml")!;
    expect(top).toContain("    tech: [Rust, Axum]\n");
    expect(top).toContain(
      "references:\n      - link: https://runbooks.example/api\n        title: Runbook\n      - image: assets/api.png",
    );
    expect(top).toContain("- dependency: serde");
    expect(top).toContain("notes: |\n      - [ ] Move to Cloud Run.\n      - [x] Rate limits.\n");
    // serde's name is its id: not written twice.
    expect(out.get("libraries.yaml")).toContain("  serde:\n    kind: library\n    package:");
    expect(toOps(state, readFiles(out).model)).toEqual([]);
  });

  it("v1's description and links are gone: check says what to write instead", () => {
    const old = MODEL.replace(
      "    context: |\n",
      "    description: Serves the app.\n    links:\n      - url: https://dash.example\n    context: |\n",
    );
    const msgs = readFiles(files(old)).problems.map((p) => p.message);
    expect(msgs).toContainEqual(expect.stringContaining('api: unknown field "description"'));
    expect(msgs).toContainEqual(expect.stringContaining('api: unknown field "links"'));
  });

  it("older notes, a list of { text, by, at }, read in as the running doc's lines", () => {
    const old = MODEL.replace(
      "    notes: |\n      - [ ] Move to Cloud Run.\n      - [x] Rate limits.\n",
      "    notes:\n      - text: Move to Cloud Run.\n        by: zeek\n        at: 2026-11-23\n      - Rate limits\n",
    );
    const api = [...stateFromFiles(files(old)).objects.values()].find((o) => o.key === "api")!;
    expect(api.notes).toBe("- Move to Cloud Run. (zeek, 2026-11-23)\n- Rate limits");
  });

  it("check: one kind per reference, a dependency is a library, paths stay in the design", () => {
    const bad = MODEL.replace(
      "      - image: assets/api.png\n",
      "      - image: ../../etc/passwd\n      - doc: x.md\n        code: y\n",
    ).replace("      - dependency: serde\n    notes", "      - dependency: worker\n    notes");
    const { model, problems } = readFiles(files(bad));
    const msgs = [...problems, ...check(model)].map((p) => p.message);
    expect(msgs.some((m) => m.includes("must be a path inside the design"))).toBe(true);
    expect(msgs.some((m) => m.includes("needs exactly one of"))).toBe(true);
    expect(msgs.some((m) => m.includes('dependency "worker" is a app, not a library'))).toBe(true);
  });

  it("finds everything using a dependency or a tech: the spiderweb", () => {
    const state = stateFromFiles(files());
    const idx = index(state);
    const serde = [...state.objects.values()].find((o) => o.key === "serde")!;
    expect(
      referencedBy(idx, serde.id)
        .map((o) => o.name)
        .sort(),
    ).toEqual(["API", "Worker"]);
    expect(
      sharingTech(idx, "rust")
        .map((o) => o.name)
        .sort(),
    ).toEqual(["API", "Worker"]);
    expect(designTechs(idx)[0]).toEqual({ name: "Rust", count: 2 });
    const api = [...state.objects.values()].find((o) => o.key === "api")!;
    expect(referencesOf(idx, api).map((r) => `${r.kind}:${r.title}`)).toEqual([
      "link:Runbook",
      "image:api.png",
      "doc:api.md",
      "code:crates/api/src/main.rs#L12",
      "dependency:serde",
    ]);
  });

  it("agents read them and set them with apply", () => {
    const state0 = stateFromFiles(files());
    const doc = new Y.Doc();
    const state = emptyState();
    mirror(doc, state, () => {});
    applyOps(doc, state, toOps(state, readFiles(files()).model), me, "load");
    const api = [...state.objects.values()].find((o) => o.key === "api")!;
    const text = contextText(index(state), api.id, { design: "t" });
    expect(text).toContain("references:\n  image: assets/api.png");
    expect(text).toContain("dependency: serde [serde]");
    expect(text).toContain(
      "notes (its running doc):\n  - [ ] Move to Cloud Run.\n  - [x] Rate limits.",
    );
    const serde = [...state.objects.values()].find((o) => o.key === "serde")!;
    expect(contextText(index(state), serde.id, { design: "t" })).toContain(
      "listed as a dependency by (2):",
    );

    const { ops } = planChanges(state, index(state), [
      {
        update: "worker",
        set: {
          context: "Drains the queue.",
          references: [
            { link: "https://w.example", title: "Dash" },
            { code: "hub:worker.rs" },
            { dependency: "serde" },
          ],
          notes: "- [ ] Flaky on Mondays.",
        },
      },
    ]);
    applyOps(doc, state, ops, me, "set");
    const w = [...state.objects.values()].find((o) => o.key === "worker")!;
    expect(w.description).toBe("Drains the queue.");
    expect(w.links).toEqual([{ title: "Dash", url: "https://w.example/" }]);
    expect(w.references).toEqual([
      { kind: "code", to: "hub:worker.rs" },
      { kind: "dependency", to: serde.id },
    ]);
    expect(w.notes).toBe("- [ ] Flaky on Mondays.");
    expect(() =>
      planChanges(state, index(state), [
        { update: "worker", set: { references: [{ dependency: "api" }] } },
      ]),
    ).toThrow(/a dependency is a library/);
    expect(() =>
      applyOps(
        doc,
        state,
        [
          {
            op: "object.put",
            object: { ...w, references: [{ kind: "image", to: "javascript:alert(1)" }] },
          },
        ],
        me,
        "x",
      ),
    ).toThrow(ModelError);
    expect(state0.objects.size).toBe(3);
  });
});
