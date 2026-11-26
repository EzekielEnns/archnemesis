// The specification of who may do what to a design (server/access.ts), written as tables:
// {admin, owner, editor, viewer, signed-in but not listed, guest, no one}
//   x {private, team, GitHub repo (read / push / none) on a GitHub sign-in, a repo on another
//      provider, a public repo with public links on / off}
//   x {no link, a valid link, expired, revoked, a link for another design, a link for a fork}
//   x {view, fork, edit, manage}.
// Each cell is the person's answer through the gathering function and can(), with fakes for GitHub
// and the link store; the expected answers are written out below, not computed.
import { describe, expect, it } from "vitest";
import type { Principal } from "./auth.ts";
import {
  can,
  canCreate,
  canShare,
  designAccess,
  type AccessSources,
  type DesignAccess,
  type DesignAction,
  type LinkRow,
  type RepoRights,
  type Who,
} from "./access.ts";

const NOW = 1_000_000;
const ACTIONS: DesignAction[] = ["view", "fork", "edit", "manage"];
const person = (id: string, roles: Principal["roles"], kind: Principal["kind"] = "human") =>
  ({ id, name: id, kind, roles }) satisfies Principal;

const PEOPLE = {
  admin: person("u:admin", ["admin"]),
  owner: person("u:owner", ["editor"]),
  editor: person("u:editor", ["editor"]),
  viewer: person("u:viewer", ["viewer"]),
  unlisted: person("u:unlisted", []),
  guest: { kind: "guest" } as Who,
  none: null as Who,
};
type Persona = keyof typeof PEOPLE;
const PERSONAS = Object.keys(PEOPLE) as Persona[];

interface Scenario {
  github: boolean;
  repo: boolean;
  public: boolean;
  publicLinks: boolean;
  priv: boolean;
  rights: RepoRights;
}
const base: Scenario = {
  github: false,
  repo: false,
  public: false,
  publicLinks: false,
  priv: false,
  rights: "none",
};
const SCENARIOS = {
  private: { ...base, priv: true },
  team: base,
  "github, read": { ...base, github: true, repo: true, rights: "read" },
  "github, push": { ...base, github: true, repo: true, rights: "push" },
  "github, no access": { ...base, github: true, repo: true, rights: "none" },
  "another provider": { ...base, repo: true, rights: "none" },
  "public repo, links on": { ...base, repo: true, public: true, publicLinks: true },
  // The default (ARCHNM_PUBLIC_LINKS unset) and a company instance behind its sign-in: nothing anonymous.
  "public repo, links off": { ...base, repo: true, public: true },
} satisfies Record<string, Scenario>;
type ScenarioName = keyof typeof SCENARIOS;

const LINKS: Record<string, LinkRow> = {
  valid: { id: "l1", doc: "d1", expiresAt: null, revokedAt: null },
  expired: { id: "l2", doc: "d1", expiresAt: NOW - 1, revokedAt: null },
  revoked: { id: "l3", doc: "d1", expiresAt: null, revokedAt: NOW - 5 },
  other: { id: "l4", doc: "d2", expiresAt: null, revokedAt: null },
  fork: { id: "l5", doc: "d1@f", expiresAt: null, revokedAt: null },
  soon: { id: "l6", doc: "d1", expiresAt: NOW + 60_000, revokedAt: null },
};
type LinkCase = "none" | keyof typeof LINKS;

function sources(s: Scenario): AccessSources {
  const repo = { owner: "acme", repo: "shop" };
  return {
    designOf: (doc) => (["d1", "d1@f", "d1@g", "d2"].includes(doc) ? doc.split("@")[0]! : null),
    ownerOf: (doc) => (doc === "d1" ? "u:owner" : doc === "d1@f" ? "u:forker" : null),
    isPrivate: (d) => s.priv && d === "d1",
    githubRepo: (d) => (s.repo && d === "d1" ? repo : null),
    githubSignIn: s.github,
    publicLinks: s.publicLinks,
    rights: () => s.rights,
    isPublic: () => s.public,
    linkByToken: (t) => LINKS[t] ?? null,
    now: () => NOW,
  };
}

function access(s: ScenarioName, who: Who, link: LinkCase, doc = "d1"): DesignAccess {
  return designAccess(sources(SCENARIOS[s]), who, doc, link === "none" ? null : link)!;
}

/** "VFEM" letters for view, fork, edit, manage. */
const letters = (a: string) => ACTIONS.filter((x) => a.includes(x[0]!.toUpperCase()));
const NONE = "";

// What each person may do with no link, scenario by scenario.
const PLAIN: Record<ScenarioName, Record<Persona, string>> = {
  private: {
    admin: NONE,
    owner: "VFEM",
    editor: NONE,
    viewer: NONE,
    unlisted: NONE,
    guest: NONE,
    none: NONE,
  },
  team: {
    admin: "VFEM",
    owner: "VFEM",
    editor: "VFE",
    viewer: "V",
    unlisted: NONE,
    guest: NONE,
    none: NONE,
  },
  "github, read": {
    admin: "VFM",
    owner: "VFM",
    editor: "VF",
    viewer: "V",
    unlisted: NONE,
    guest: NONE,
    none: NONE,
  },
  "github, push": {
    admin: "VFEM",
    owner: "VFEM",
    editor: "VFE",
    viewer: "V",
    unlisted: NONE,
    guest: NONE,
    none: NONE,
  },
  "github, no access": {
    admin: NONE,
    owner: NONE,
    editor: NONE,
    viewer: NONE,
    unlisted: NONE,
    guest: NONE,
    none: NONE,
  },
  "another provider": {
    admin: "VFEM",
    owner: "VFEM",
    editor: "VFE",
    viewer: "V",
    unlisted: NONE,
    guest: NONE,
    none: NONE,
  },
  "public repo, links on": {
    admin: "VFEM",
    owner: "VFEM",
    editor: "VFE",
    viewer: "V",
    unlisted: NONE,
    guest: NONE,
    none: NONE,
  },
  "public repo, links off": {
    admin: "VFEM",
    owner: "VFEM",
    editor: "VFE",
    viewer: "V",
    unlisted: NONE,
    guest: NONE,
    none: NONE,
  },
};

// What a valid link for this document changes: only what's listed (the rest is as above).
const WITH_LINK: Partial<Record<ScenarioName, Partial<Record<Persona, string>>>> = {
  private: { admin: "VF", editor: "VF", viewer: "V" },
  "github, no access": { admin: "VF", owner: "VF", editor: "VF", viewer: "V" },
  "public repo, links on": { guest: "V" },
};

describe("can(): every cell of the matrix", () => {
  let cells = 0;
  for (const s of Object.keys(SCENARIOS) as ScenarioName[]) {
    for (const p of PERSONAS) {
      const withLink = WITH_LINK[s]?.[p] ?? PLAIN[s][p];
      // Nothing the link names, or a link that no longer works, changes anything.
      const cases: [LinkCase, string][] = [
        ["none", PLAIN[s][p]],
        ["valid", withLink],
        ["soon", withLink],
        ["expired", PLAIN[s][p]],
        ["revoked", PLAIN[s][p]],
        ["other", PLAIN[s][p]],
        // A link to a fork of this design reads this design, and nothing more.
        [
          "fork",
          p === "unlisted" || p === "none" || (p === "guest" && s !== "public repo, links on")
            ? NONE
            : PLAIN[s][p]!.includes("V")
              ? PLAIN[s][p]!
              : "V",
        ],
      ];
      for (const [link, expected] of cases) {
        it(`${p} on ${s}, ${link} link`, () => {
          const a = access(s, PEOPLE[p], link);
          const got = ACTIONS.filter((x) => can(PEOPLE[p], a, x));
          expect(got).toEqual(letters(expected));
        });
        cells += ACTIONS.length;
      }
    }
  }
  it("covers the whole matrix", () => {
    // 8 scenarios x 7 people x 7 link cases x 4 actions
    expect(cells).toBe(8 * 7 * 7 * 4);
  });
});

describe("a link is for one document", () => {
  const editor = PEOPLE.editor;
  it("a design's link doesn't open its other forks", () => {
    const a = designAccess(sources(SCENARIOS.private), editor, "d1@g", "valid")!;
    expect(a.link).toBeNull();
    expect(can(editor, a, "view")).toBe(false);
  });
  it("a fork's link is that fork, and read access to its base, not to its other forks", () => {
    const s = sources(SCENARIOS["github, no access"]);
    expect(designAccess(s, editor, "d1@f", "fork")!.link).toBe("doc");
    expect(designAccess(s, editor, "d1", "fork")!.link).toBe("base");
    expect(designAccess(s, editor, "d1@g", "fork")!.link).toBeNull();
    expect(designAccess(s, editor, "d2", "fork")!.link).toBeNull();
  });
  it("a link is never edit or manage, and an unknown token is nothing", () => {
    const a = access("private", PEOPLE.editor, "valid");
    expect(can(PEOPLE.editor, a, "edit")).toBe(false);
    expect(can(PEOPLE.editor, a, "manage")).toBe(false);
    expect(access("private", PEOPLE.editor, "valid").link).toBe("doc");
    expect(designAccess(sources(SCENARIOS.private), editor, "d1", "not-a-token")!.link).toBeNull();
  });
  it("there is no such document", () => {
    expect(designAccess(sources(SCENARIOS.team), editor, "nope")).toBeNull();
  });
});

describe("agents", () => {
  const agent = person("agent:owner", ["editor"], "agent");
  const alices = { ...agent, for: "u:owner" };
  it("an agent gets what its person gets, and never uses a link", () => {
    const a = designAccess(sources(SCENARIOS.private), alices, "d1", "valid")!;
    expect(a.link).toBeNull();
    expect(ACTIONS.filter((x) => can(alices, a, x))).toEqual(["view", "fork", "edit", "manage"]);
    const other = designAccess(sources(SCENARIOS.private), agent, "d1", "valid")!;
    expect(ACTIONS.filter((x) => can(agent, other, x))).toEqual([]);
  });
  it("an agent never makes links", () => {
    const a = designAccess(sources(SCENARIOS.private), alices, "d1")!;
    expect(can(alices, a, "manage")).toBe(true);
    expect(canShare(alices, a)).toBe(false);
    expect(canShare(PEOPLE.owner, access("private", PEOPLE.owner, "none"))).toBe(true);
    expect(canShare(PEOPLE.editor, access("team", PEOPLE.editor, "none"))).toBe(false);
  });
  it("on a GitHub sign-in an agent is judged by its person's GitHub answer; none without one", () => {
    const s = sources(SCENARIOS["github, push"]);
    const seen: (string | null)[] = [];
    const spy: AccessSources = {
      ...s,
      rights: (p) => (seen.push(p), "push"),
    };
    designAccess(spy, alices, "d1");
    designAccess(spy, agent, "d1");
    expect(seen).toEqual(["u:owner"]);
    expect(can(agent, designAccess(spy, agent, "d1")!, "view")).toBe(false);
  });
});

describe("the owner's own role still counts", () => {
  it("an owner who has become a viewer manages and sees, but doesn't edit or fork", () => {
    const demoted = person("u:owner", ["viewer"]);
    const a = access("team", demoted, "none");
    expect(ACTIONS.filter((x) => can(demoted, a, x))).toEqual(["view", "manage"]);
  });
  it("making designs is for editors and admins", () => {
    expect(canCreate(PEOPLE.editor)).toBe(true);
    expect(canCreate(PEOPLE.admin)).toBe(true);
    for (const p of ["viewer", "unlisted", "guest", "none"] as const)
      expect(canCreate(PEOPLE[p])).toBe(false);
  });
  it("a fork's starter manages the fork, not the design", () => {
    const forker = person("u:forker", ["editor"]);
    expect(can(forker, access("team", forker, "none", "d1@f"), "manage")).toBe(true);
    expect(can(forker, access("team", forker, "none", "d1"), "manage")).toBe(false);
  });
});
