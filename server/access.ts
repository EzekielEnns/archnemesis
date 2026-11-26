// Who may do what to one design: the one place that decides.
//
// The instance's sign-in comes first (a person gets through the provider and the role lists, or
// they are nobody: see server/auth.ts). After that, every question about a design (a route, the
// sync socket, who's here, the MCP) is can(who, access, action), and nothing else:
//
//   view    see it, read its model, open it
//   fork    make their own copy (a branch where they may edit it, else a private copy)
//   edit    change it
//   manage  delete it, share it, make or revoke its links, connect it to a repo
//
// can() is pure. It judges a DesignAccess (what is known about the design, for this person, from
// one request); designAccess() gathers that from the server's records, through AccessSources, so
// tests and the server's caches both plug in. Nothing here trusts anything the client says about
// itself: a share link is only a token the server looked up.
//
// Order of rules, in can():
//   1. No one, or no role (not on the lists): nothing. A guest (rule 5) may only view.
//   2. What the instance's roles give: a viewer views and an editor edits team designs;
//      a private design is its owner's alone; the owner (any role, shown to the server by id)
//      and an admin manage what they may view; admins don't see others' private designs.
//   3. A design that follows a GitHub repo, on an instance that signs in with GitHub: viewing needs
//      read on the repo, editing needs push (the person's own GitHub answer). Other providers
//      ignore the repo and the roles decide.
//   4. A share link adds view (and fork, for those who may create designs) for the one document
//      it names; it never adds edit or manage, and never raises a role.
import type { Principal } from "./auth.ts";

/** Someone with no account who came in on a share link to a public repo's design. */
export interface Guest {
  kind: "guest";
}

export type Who = Principal | Guest | null;
export type DesignAction = "view" | "fork" | "edit" | "manage";
/** What GitHub says the person may do on a repo (unknown counts as none). */
export type RepoRights = "none" | "read" | "push";

/** A GitHub repo a design follows. */
export interface RepoRef {
  owner: string;
  repo: string;
}

/** What is known about one document (a design or a fork), for one person and one request. */
export interface DesignAccess {
  /** Who made the design; for a fork, who started it. */
  owner: string | null;
  /** Only its owner sees it. */
  private: boolean;
  /** The GitHub repo it follows: whether it's public, and what this person may do there. */
  repo: { public: boolean; rights: RepoRights } | null;
  /** The instance signs in with GitHub (so the repo's permissions count). */
  githubSignIn: boolean;
  /** ARCHNM_PUBLIC_LINKS: a link to a public repo's design works without signing in. */
  publicLinks: boolean;
  /** A link presented with the request: valid, unexpired, unrevoked, and for this document ("doc") or for a fork of it ("base"). */
  link: "doc" | "base" | null;
}

/** Whether `who` made the design (or is the agent of whoever did). */
export function owns(who: Who, owner: string | null): boolean {
  if (!who || who.kind === "guest") return false;
  // On this machine an agent acts for "anyone local", so a design with no owner is its to manage.
  if (who.kind === "agent" && who.for === "local:*" && !owner) return true;
  if (!owner) return false;
  if (who.id === owner) return true;
  return (
    who.kind === "agent" &&
    !!who.for &&
    (who.for === owner || (who.for === "local:*" && owner.startsWith("local:")))
  );
}

/** The person whose GitHub sign-in speaks for `who` (an agent acts for its person; "anyone local" has none). */
export function personOf(who: Who): string | null {
  if (!who || who.kind === "guest") return null;
  if (who.kind === "agent") return who.for && who.for !== "local:*" ? who.for : null;
  return who.id;
}

function guestMay(d: DesignAccess, action: DesignAction): boolean {
  return action === "view" && d.publicLinks && !!d.repo?.public && d.link !== null;
}

/** Whether a person may do `action` on a document. Default deny. */
export function can(who: Who, d: DesignAccess, action: DesignAction): boolean {
  if (!who) return false;
  if (who.kind === "guest") return guestMay(d, action);
  if (!who.roles.length) return false;
  const admin = who.roles.includes("admin");
  const editor = admin || who.roles.includes("editor");
  const mine = owns(who, d.owner);

  // What the roles give, before the repo and links.
  let view = d.private ? mine : true;
  // A repo's own permissions, where GitHub is how people sign in.
  const gated = d.githubSignIn && d.repo !== null;
  if (gated && d.repo!.rights === "none") view = false;
  const edit = view && editor && !(gated && d.repo!.rights !== "push");
  const fork = view && editor;
  const manage = view && (mine || (admin && !d.private));

  switch (action) {
    case "view":
      return view || d.link !== null;
    case "fork":
      return fork || (d.link === "doc" && editor);
    case "edit":
      return edit;
    case "manage":
      return manage;
  }
}

/** May they make or revoke links for it: those who manage it, and only a person (never an agent). */
export function canShare(who: Who, d: DesignAccess): boolean {
  return !!who && who.kind === "human" && can(who, d, "manage");
}

/** Whether a person may make new designs at all (an instance-wide question, not about one design). */
export function canCreate(who: Who): boolean {
  return (
    !!who && who.kind !== "guest" && (who.roles.includes("editor") || who.roles.includes("admin"))
  );
}

/** A share link as the store keeps it. */
export interface LinkRow {
  id: string;
  /** The document it grants: a design's key, or "<design>@<fork>". */
  doc: string;
  expiresAt: number | null;
  revokedAt: number | null;
}

/** What a link grants on `doc` (of `design`): itself, a base read for a fork's link, or nothing. */
function linkRelation(
  row: LinkRow | null,
  doc: string,
  design: string,
  now: number,
): DesignAccess["link"] {
  if (!row || row.revokedAt !== null || (row.expiresAt !== null && row.expiresAt <= now))
    return null;
  if (row.doc === doc) return "doc";
  // A fork's link also reads what the fork needs from its base (not the base's other forks).
  if (doc === design && row.doc.startsWith(`${design}@`)) return "base";
  return null;
}

/** What gathering needs from the server (or from a test). Reads only; no network. */
export interface AccessSources {
  /** The design a document belongs to, or null when there's no such document. */
  designOf(doc: string): string | null;
  /** Who made it (a fork: who started it). */
  ownerOf(doc: string): string | null;
  isPrivate(design: string): boolean;
  /** The GitHub repo the design follows, or null (no git, or a repo elsewhere). */
  githubRepo(design: string): RepoRef | null;
  githubSignIn: boolean;
  publicLinks: boolean;
  /** What `person` may do on the repo, as last asked of GitHub: none when unknown. */
  rights(person: string, repo: RepoRef): RepoRights;
  /** Whether the repo is public, as last asked: false when unknown. */
  isPublic(repo: RepoRef): boolean;
  /** The link a token names (same cost whether or not it exists), or null. */
  linkByToken(token: string): LinkRow | null;
  now(): number;
}

/** Everything `can` needs for one person on one document; null when there's no such document. */
export function designAccess(
  src: AccessSources,
  who: Who,
  doc: string,
  token?: string | null,
): DesignAccess | null {
  const design = src.designOf(doc);
  if (design === null) return null;
  const repo = src.githubRepo(design);
  const person = personOf(who);
  // Agents never use links: only a person (or a guest) holding a link counts.
  const holds = who !== null && who.kind !== "agent" && !!token;
  const row = holds ? src.linkByToken(token) : null;
  return {
    owner: src.ownerOf(doc),
    private: src.isPrivate(design),
    repo: repo
      ? { public: src.isPublic(repo), rights: person ? src.rights(person, repo) : "none" }
      : null,
    githubSignIn: src.githubSignIn,
    publicLinks: src.publicLinks,
    link: linkRelation(row, doc, design, src.now()),
  };
}
