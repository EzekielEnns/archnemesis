// Who's touched a box, from a local clone: authors grouped, agent-assisted commits counted.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { touched, touchedText } from "./touched.ts";

it("groups a path's commits by author and counts the ones an agent helped with", async () => {
  const root = mkdtempSync(join(tmpdir(), "archnm-touched-"));
  const dir = join(root, "svc");
  mkdirSync(join(dir, "api"), { recursive: true });
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" });
  git("init", "-q");
  const commit = (who: string, file: string, msg: string) => {
    writeFileSync(join(dir, file), `${Math.random()}`);
    git("add", "-A");
    git(
      "-c",
      `user.name=${who}`,
      "-c",
      `user.email=${who.toLowerCase()}@example.com`,
      "commit",
      "-q",
      "-m",
      msg,
    );
  };
  commit("Ada", "api/a.ts", "first");
  commit("Ada", "api/a.ts", "second\n\nCo-Authored-By: Claude <noreply@anthropic.com>");
  commit("Bob", "api/a.ts", "third");
  commit("Cy", "other.ts", "not this path");
  const t = await touched(["svc@main:api", "svc@main:api/a.ts:3", "ghost@main:x"], {
    localRoot: root,
  });
  expect(t.people.map((p) => [p.name, p.commits, p.withAgent])).toEqual([
    ["Ada", 2, 1],
    ["Bob", 1, 0],
  ]);
  expect(t.missed.map((m) => m.source)).toEqual(["ghost@main:x"]);
  expect(touchedText(t)).toContain("Ada: 2 commit(s), 1 with an agent");
});

it("counts one person once, whatever name or address they signed with", async () => {
  const root = mkdtempSync(join(tmpdir(), "archnm-touched-"));
  const dir = join(root, "svc");
  mkdirSync(dir, { recursive: true });
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" });
  git("init", "-q");
  const commit = (name: string, email: string) => {
    writeFileSync(join(dir, "a.ts"), `${Math.random()}`);
    git("add", "-A");
    git("-c", `user.name=${name}`, "-c", `user.email=${email}`, "commit", "-q", "-m", "x");
  };
  commit("Zee", "z@example.com");
  commit("Zee Smith", "z@example.com"); // same address, new name
  commit("Zee Smith", "zee@work.example"); // same name, new address
  commit("Other", "o@example.com");
  const t = await touched(["svc@main:a.ts"], { localRoot: root });
  expect(t.people.map((p) => [p.name, p.commits])).toEqual([
    ["Zee Smith", 3],
    ["Other", 1],
  ]);
});
