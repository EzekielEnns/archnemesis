// Read answers say what they share once (token use, after trial 16): search hits in one file
// under the file, review findings with one fix under the fix.
import { describe, expect, it } from "vitest";
import { seedOps } from "../seed.ts";
import { planChanges } from "../agent.ts";
import { importChanges, type CodeIndex } from "../codeindex.ts";
import { keyOps } from "../files.ts";
import { memHost } from "./memhost.ts";
import { runTool, tool } from "./tools.ts";

function imported() {
  const h = memHost({ ops: seedOps() });
  h.commit(keyOps(h.state()), "keys", { undo: false });
  const fns = ["syncA", "syncB", "syncC", "syncD"].map((name, i) => ({
    symbol: `s#${name}`,
    name,
    file: "server/sync.ts",
    line: i + 1,
    signature: `${name}(): void`,
  }));
  const index: CodeIndex = {
    repo: "web",
    files: [{ path: "server/sync.ts", language: "typescript" }],
    functions: fns,
    calls: [],
    uses: [],
    packages: [],
  };
  const plan = importChanges(h.index(), index, { under: "shop" });
  h.commit(planChanges(h.state(), h.index(), plan.changes).ops, "import");
  return h;
}

describe("compact reads", () => {
  it("search names a file once over three or more of its functions", async () => {
    const h = imported();
    const r = await runTool(tool("read"), { host: h }, { q: "sync", kind: "function" });
    expect(r.text).toContain("in web:server/sync.ts (each is web:server/sync.ts#<name>");
    expect(r.text).toMatch(/\n {2}#syncA /);
    expect(r.text.match(/web:server\/sync\.ts/g)!.length).toBeLessThanOrEqual(3);
  });
});
