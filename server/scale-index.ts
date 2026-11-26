// A made-up repo index of any size, for timing imports and big designs (server/scale.test.ts).
import type { CodeIndex } from "../shared/codeindex.ts";

/** ~2,000 functions in ~200 files (10 folders), ~4,000 calls. */
export function bigIndex(files = 200, perFile = 10, callsPer = 2): CodeIndex {
  const fl: CodeIndex["files"] = [];
  const fns: CodeIndex["functions"] = [];
  for (let f = 0; f < files; f++) {
    const path = `src/area${f % 10}/file${f}.ts`;
    fl.push({ path, language: "typescript" });
    for (let i = 0; i < perFile; i++)
      fns.push({
        symbol: `${path}#fn${f}_${i}`,
        name: `fn${f}_${i}`,
        file: path,
        line: i * 10 + 1,
      });
  }
  const calls: CodeIndex["calls"] = [];
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (const fn of fns)
    for (let k = 0; k < callsPer; k++)
      calls.push({
        from: fn.symbol,
        to: fns[Math.floor(rnd() * fns.length)]!.symbol,
        confidence: "exact",
      });
  return {
    repo: "big",
    sha: "abc",
    files: fl,
    functions: fns,
    calls: calls.filter((c) => c.from !== c.to),
    uses: [],
    packages: [],
  };
}
