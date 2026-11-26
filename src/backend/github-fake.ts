// A pretend public GitHub for tests: one repository and its branches, answering the reads the
// loader makes (the file list of a branch, and each file). Never a real network. The log shows
// every call and every Authorization header, so a test can check nothing about the visitor was sent.

export interface FakeRepo {
  /** branch -> path -> text */
  branches: Map<string, Map<string, string>>;
  default: string;
  /** Every call: "GET /path" for the API, "RAW /path" for file reads. */
  log: string[];
  /** The Authorization header of every API call (all null: nothing identifies the visitor). */
  auth: (string | null)[];
}

export function fakeRepo(branches: Record<string, Record<string, string>>, def = "main"): FakeRepo {
  return {
    branches: new Map(Object.entries(branches).map(([b, f]) => [b, new Map(Object.entries(f))])),
    default: def,
    log: [],
    auth: [],
  };
}

/** A fetch that answers as api.github.com and raw.githubusercontent.com for `owner/repo`. */
export function githubFetch(repo: FakeRepo, where = "acme/designs"): typeof fetch {
  const filesOf = (ref: string) => repo.branches.get(ref === "HEAD" ? repo.default : ref);
  const tree = /^\/repos\/([^/]+\/[^/]+)\/git\/trees\/(.+?)\?recursive=1$/;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://raw.githubusercontent.com/")) {
      repo.log.push(`RAW ${url.replace("https://raw.githubusercontent.com", "")}`);
      const rest = url.slice(`https://raw.githubusercontent.com/${where}/`.length);
      for (const ref of [...repo.branches.keys(), "HEAD"]) {
        if (!rest.startsWith(`${ref}/`)) continue;
        const text = filesOf(ref)?.get(decodeURIComponent(rest.slice(ref.length + 1)));
        return text === undefined ? new Response("no", { status: 404 }) : new Response(text);
      }
      return new Response("no", { status: 404 });
    }
    if (!url.startsWith("https://api.github.com/")) return new Response("?", { status: 500 });
    const path = url.slice("https://api.github.com".length);
    repo.auth.push(new Headers(init?.headers).get("authorization"));
    repo.log.push(`GET ${path}`);
    const m = tree.exec(path);
    if (!m || m[1] !== where) return Response.json({}, { status: 404 });
    const files = filesOf(decodeURIComponent(m[2]!));
    if (!files) return Response.json({}, { status: 404 });
    return Response.json({
      tree: [...files].map(([p, t]) => ({ path: p, type: "blob", size: t.length })),
      truncated: false,
    });
  }) as typeof fetch;
}
