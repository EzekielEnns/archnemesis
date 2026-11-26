// The GitHub loader, against a pretend GitHub: which URLs it asks, what it keeps, and what it says when it can't.
import { describe, expect, it } from "vitest";
import { filesFromOps, smallOps } from "../../shared/filesFromOps.ts";
import { parseGhSpec } from "../../shared/ghlink.ts";
import { fetchGhDesign, MAX_FILES } from "./github-public.ts";
import { BackendError } from "./types.ts";

interface Repo {
  /** ref → path → text (a path not ours is listed too, to be left out). */
  refs: Record<string, Map<string, string>>;
}

/** A fetch that answers like api.github.com and raw.githubusercontent.com for one repository. */
function github(repo: Repo, log: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    log.push(url);
    const tree =
      /^https:\/\/api\.github\.com\/repos\/acme\/designs\/git\/trees\/(.+)\?recursive=1$/.exec(url);
    if (tree) {
      const ref = decodeURIComponent(tree[1]!).replace(/%2F/g, "/");
      const files = repo.refs[ref === "HEAD" ? "main" : ref];
      if (!files) return new Response("{}", { status: 404 });
      return Response.json({
        tree: [...files].map(([path, text]) => ({ path, type: "blob", size: text.length })),
        truncated: false,
      });
    }
    const raw =
      /^https:\/\/raw\.githubusercontent\.com\/acme\/designs\/([^/]+(?:\/[^/]+)*?)\/(shop\/.*|[^/]+)$/.exec(
        url,
      );
    if (raw) {
      const refs = Object.keys(repo.refs).concat("HEAD");
      const ref = refs.find((r) => url.includes(`/designs/${r}/`))!;
      const text = repo.refs[ref === "HEAD" ? "main" : ref]?.get(
        decodeURIComponent(url.split(`/${ref}/`)[1]!),
      );
      return text === undefined ? new Response("404", { status: 404 }) : new Response(text);
    }
    return new Response("?", { status: 500 });
  }) as typeof fetch;
}

const inFolder = (files: Map<string, string>, folder: string) =>
  new Map([...files].map(([p, t]) => [`${folder}/${p}`, t]));

describe("fetchGhDesign", () => {
  const main = filesFromOps(smallOps(), { name: "Shop" });
  const mainRepo = (): Repo => ({
    refs: { main: new Map([...inFolder(main, "shop"), ["README.md", "hi"], ["src/app.ts", "x"]]) },
  });

  it("lists the tree, keeps only the design's own files, and reads each from raw", async () => {
    const log: string[] = [];
    const got = await fetchGhDesign(parseGhSpec("acme/designs:shop")!, github(mainRepo(), log));
    expect(got.files).toEqual(main);
    expect(got.base).toBeNull();
    expect(got.fork).toBeNull();
    expect(log.filter((u) => u.startsWith("https://api.github.com/"))).toHaveLength(1);
    expect(
      log.every((u) => /^https:\/\/(api\.github\.com|raw\.githubusercontent\.com)\//.test(u)),
    ).toBe(true);
    expect(log.some((u) => u.includes("README") || u.includes("src/app"))).toBe(false);
  });

  it("finds the design's folder when the link doesn't say", async () => {
    expect((await fetchGhDesign(parseGhSpec("acme/designs")!, github(mainRepo()))).folder).toBe(
      "shop",
    );
  });

  it("says which folders when there are several designs", async () => {
    const repo = mainRepo();
    repo.refs.main!.set("other/archnm.yaml", "name: O\n");
    await expect(fetchGhDesign(parseGhSpec("acme/designs")!, github(repo))).rejects.toThrow(
      /several designs.*:other|:shop/,
    );
  });

  it("reads a fork's branch and the design on main to compare it with", async () => {
    const forked = filesFromOps([...smallOps()], { name: "Shop (fork)" });
    const repo = mainRepo();
    repo.refs["archnm/shop/zeek-11-26"] = inFolder(forked, "shop");
    const log: string[] = [];
    const got = await fetchGhDesign(
      parseGhSpec("acme/designs@archnm/shop/zeek-11-26:shop")!,
      github(repo, log),
    );
    expect(got.fork).toBe("zeek-11-26");
    expect(got.design).toBe("shop");
    expect(got.files).toEqual(forked);
    expect(got.base).toEqual(main);
    expect(log.filter((u) => u.startsWith("https://api.github.com/"))).toHaveLength(2);
  });

  it("shows a fork of a design that isn't on main yet, without a comparison", async () => {
    const repo: Repo = {
      refs: { main: new Map([["README.md", "hi"]]), "archnm/new/x": inFolder(main, "shop") },
    };
    const got = await fetchGhDesign(parseGhSpec("acme/designs@archnm/new/x:shop")!, github(repo));
    expect(got.base).toBeNull();
    expect(got.files.size).toBe(main.size);
  });

  async function says(f: typeof fetch, link = "acme/designs:shop") {
    const e = await fetchGhDesign(parseGhSpec(link)!, f).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(BackendError);
    return e as BackendError;
  }

  it("says plainly when the repository or branch isn't there", async () => {
    const e = await says(github(mainRepo()), "acme/designs@nope:shop");
    expect(e.code).toBe("missing");
    expect(e.message).toMatch(/no public .*private repository can't be opened/);
  });

  it("says when there is no design in the folder", async () => {
    const e = await says(github(mainRepo()), "acme/designs:src");
    expect(e.message).toMatch(/no design in src/);
  });

  it("says when GitHub's limit is used up, and when it resets", async () => {
    const reset = Math.floor(Date.now() / 1000) + 600;
    const limited = (async () =>
      new Response("{}", {
        status: 403,
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
      })) as unknown as typeof fetch;
    const e = await says(limited);
    expect(e.code).toBe("refused");
    expect(e.message).toMatch(/paused requests.*60 an hour.*resets at/);
    const plain = (async () => new Response("{}", { status: 429 })) as unknown as typeof fetch;
    expect((await says(plain)).message).toMatch(/Try again in a little while/);
  });

  it("says when it can't reach GitHub", async () => {
    const e = await says((async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch);
    expect(e.code).toBe("offline");
    expect(e.message).toMatch(/Couldn't reach GitHub/);
  });

  it("says when a file of the design is missing, and when the answer isn't a list", async () => {
    const f = github(mainRepo());
    const gone: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes("model/")
        ? new Response("", { status: 404 })
        : f(input, init)) as typeof fetch;
    expect((await says(gone)).message).toMatch(/no public file/);
    const odd = (async () => Response.json({ nothing: 1 })) as unknown as typeof fetch;
    expect((await says(odd)).code).toBe("failed");
  });

  it("refuses a repository too big to list, and a design with too many files or bytes", async () => {
    const trunc = (async () =>
      Response.json({ tree: [], truncated: true })) as unknown as typeof fetch;
    expect((await says(trunc)).message).toMatch(/too big to list/);

    const many: Repo = { refs: { main: new Map([["shop/archnm.yaml", "name: x\n"]]) } };
    for (let i = 0; i <= MAX_FILES; i++) many.refs.main!.set(`shop/model/f${i}.yaml`, "{}");
    expect((await says(github(many))).message).toMatch(/too big to open from GitHub/);

    const large: Repo = {
      refs: {
        main: new Map([
          ["shop/archnm.yaml", "name: x\n"],
          ["shop/model/a.yaml", "a".repeat(2 * 1024 * 1024)],
        ]),
      },
    };
    expect((await says(github(large))).message).toMatch(/too big.*limit is 400 files and 3 MB/);
  });

  it("sends no cookies, token or referrer", async () => {
    const seen: RequestInit[] = [];
    const f = github(mainRepo());
    const spy = (async (input: RequestInfo | URL, init?: RequestInit) => (
      seen.push(init ?? {}),
      f(input, init)
    )) as typeof fetch;
    await fetchGhDesign(parseGhSpec("acme/designs:shop")!, spy);
    expect(seen.length).toBeGreaterThan(0);
    for (const init of seen) {
      expect(init.credentials).toBe("omit");
      expect(init.referrerPolicy).toBe("no-referrer");
      expect(Object.keys(init.headers ?? {})).toEqual(["accept"]);
    }
  });
});
