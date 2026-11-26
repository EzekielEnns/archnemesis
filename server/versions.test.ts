// Looking back: main's commits that changed the design, and the design as it was at one.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import * as Y from "yjs";
import { stateFromFiles } from "../shared/diff.ts";
import { applyOps, emptyState, mirror, type Actor } from "../shared/doc.ts";
import { keyOps, writeFiles } from "../shared/files.ts";
import { makeObject } from "../shared/model.ts";
import { Repo } from "./git.ts";
import { testConfig } from "./testing.ts";
import { isOurs } from "./files.ts";
import { seedOps } from "../shared/seed.ts";

const me: Actor = { id: "t", name: "T", kind: "agent" };

it("lists main's versions of a design and reads one back as it was", async () => {
  const root = mkdtempSync(join(tmpdir(), "archnm-versions-"));
  const origin = join(root, "origin");
  mkdirSync(origin);
  const git = (...a: string[]) =>
    execFileSync(
      "git",
      ["-C", origin, "-c", "user.name=T", "-c", "user.email=t@example.com", ...a],
      { stdio: "pipe" },
    );
  git("init", "-q", "-b", "main");
  const doc = new Y.Doc();
  const state = emptyState();
  mirror(doc, state, () => {});
  applyOps(doc, state, seedOps(), me, "seed");
  applyOps(doc, state, keyOps(state), me, "keys");
  const commit = (msg: string) => {
    for (const [p, t] of writeFiles(state)) {
      mkdirSync(dirname(join(origin, "arch", p)), { recursive: true });
      writeFileSync(join(origin, "arch", p), t);
    }
    writeFileSync(join(origin, "README.md"), msg); // outside the design: doesn't count
    git("add", "-A");
    git("commit", "-q", "-m", msg);
  };
  commit("first map");
  const before = state.objects.size;
  applyOps(
    doc,
    state,
    [{ op: "object.put", object: makeObject({ kind: "system", name: "Billing" }) }],
    me,
    "add",
  );
  applyOps(doc, state, keyOps(state), me, "keys");
  commit("add billing");

  const repo = new Repo(join(root, "clone"), origin, testConfig(root).git);
  await repo.ensure();
  await repo.fetch();
  const versions = await repo.log("refs/remotes/origin/main", "arch", 10);
  expect(versions.map((v) => v.subject)).toEqual(["add billing", "first map"]);
  const then = stateFromFiles(await repo.filesAt(versions[1]!.sha, "arch", isOurs));
  expect(then.objects.size).toBe(before);
  expect([...then.objects.values()].some((o) => o.name === "Billing")).toBe(false);
  const now = stateFromFiles(await repo.filesAt(versions[0]!.sha, "arch", isOurs));
  expect([...now.objects.values()].some((o) => o.name === "Billing")).toBe(true);
});
