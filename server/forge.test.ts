import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";
import { forgeOf, proposeUrl } from "./forge.ts";

describe("forgeOf", () => {
  const forges = loadConfig({}).git.forges;

  it("reads GitHub remotes in every shape", () => {
    for (const r of [
      "git@github.com:acme/designs.git",
      "https://github.com/acme/designs",
      "https://tok@github.com/acme/designs.git",
      "ssh://git@github.com/acme/designs.git",
    ])
      expect(forgeOf(r, forges), r).toEqual({
        kind: "github",
        web: "https://github.com/acme/designs",
      });
  });

  it("knows gitlab.com, with subgroups", () => {
    expect(forgeOf("git@gitlab.com:acme/infra/designs.git", forges)).toEqual({
      kind: "gitlab",
      web: "https://gitlab.com/acme/infra/designs",
    });
  });

  it("has no forge for local paths and unknown hosts", () => {
    expect(forgeOf("/var/lib/archnm/git/shop.git", forges)).toBeNull();
    expect(forgeOf("file:///tmp/x.git", forges)).toBeNull();
    expect(forgeOf("git@git.home.arpa:me/designs.git", forges)).toBeNull();
  });

  it("takes self-hosted forges from ARCHNM_FORGES", () => {
    const forges = loadConfig({ ARCHNM_FORGES: "git.home.arpa=forgejo, gl.corp=gitlab" }).git
      .forges;
    expect(forgeOf("ssh://git@git.home.arpa:2222/me/designs.git", forges)).toEqual({
      kind: "forgejo",
      web: "https://git.home.arpa/me/designs",
    });
    expect(forgeOf("git@gl.corp:a/b.git", forges)?.kind).toBe("gitlab");
  });
});

describe("proposeUrl", () => {
  it("fills in GitHub's compare page", () => {
    const u = new URL(
      proposeUrl(
        { kind: "github", web: "https://github.com/acme/designs" },
        { branch: "archnm/shop/zeek-11-20", base: "main", title: "T", body: "B" },
      ),
    );
    expect(u.pathname).toBe("/acme/designs/compare/main...archnm/shop/zeek-11-20");
    expect(u.searchParams.get("expand")).toBe("1");
    expect(u.searchParams.get("title")).toBe("T");
  });

  it("fills in GitLab's new merge request page", () => {
    const u = new URL(
      proposeUrl(
        { kind: "gitlab", web: "https://gitlab.com/a/b" },
        { branch: "x", base: "main", title: "T", body: "B" },
      ),
    );
    expect(u.pathname).toBe("/a/b/-/merge_requests/new");
    expect(u.searchParams.get("merge_request[source_branch]")).toBe("x");
  });
});
