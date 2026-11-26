// Git everywhere: on a server that puts new designs in git (the default, with a lasting disk),
// every design made follows git too, so forks, read {diff} and propose work
// on it like on any design made later.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Archnm, startArchnm, text } from "./e2e.ts";

let archnm: Archnm;

beforeAll(async () => {
  archnm = await startArchnm();
  // A fresh server starts with one empty design; these tests work on the example shop, asked for.
  const made = await archnm.call("design", {
    action: "create",
    name: "Example",
    key: "example",
    from: "example",
  });
  expect(made.isError, text(made)).toBeFalsy();
}, 70_000);

afterAll(async () => {
  await archnm?.stop();
});

describe("the example made on request follows git", () => {
  it("lists it as following git, forks it, and diffs changed fields on an existing box", async () => {
    expect(text(await archnm.call("design"))).toMatch(/^example {2}Example .*follows git/m);
    const f = await archnm.call("design", { action: "fork", design: "example", name: "plan" });
    expect(f.isError, text(f)).toBeFalsy();
    const key = text(f).match(/^Started (\S+):/)![1]!;
    expect(key).toMatch(/^example@/);
    const w = await archnm.call("write", { design: key, yaml: "objects:\n  checkout: {tech: Go}" });
    expect(w.isError, text(w)).toBeFalsy();
    const d = text(await archnm.call("read", { design: key, diff: true }));
    expect(d).toMatch(/boxes ~1/);
    expect(d).toMatch(/~ checkout: .*tech/);
  });

  // Trial 17: a dry run naming main, after writes went to the agent's fork, ran on main and
  // answered "no object" for what the agent had written.
  it("runs a dry run that names main on the agent's open fork, and says so", async () => {
    const w = await archnm.call("write", {
      design: "example",
      yaml: "objects:\n  ledger: {kind: app, in: shop, context: Keeps the books.}",
    });
    expect(w.isError, text(w)).toBeFalsy();
    const fork = text(w).match(/Pass design: "([^"]+)"/)![1]!;
    const d = await archnm.call("write", {
      design: "example",
      dry_run: true,
      yaml: "objects:\n  ledger: {tech: Go}",
    });
    expect(d.isError, text(d)).toBeFalsy();
    expect(text(d)).toContain(`on your fork ${fork}`);
    const r = await archnm.call("read", { design: "example", ref: "ledger" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain(`your writes are on your fork: pass design: "${fork}"`);
  });
});
