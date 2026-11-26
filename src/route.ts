// Where you are, in the URL: #/<design>/d/<diagram>/o/<object> (or /n/<note>), or #/<design>@<fork>/...
// on a fork. Every part after the design is optional; links from the MCP and the history
// use the same shape, so a link to a fork is a link anyone can open.
export interface Route {
  /** The document: a design's key, or "<design>@<fork>". */
  design: string | null;
  diagramId: string | null;
  objectId: string | null;
  /** A note or link on the diagram, opened. */
  noteId?: string | null;
}

export function parseHash(hash = location.hash): Route {
  // Before designs: #/d/<diagram>, which belongs to whatever design opens by default.
  const old = hash.match(/^#\/d\/([^/]+)(?:\/o\/([^/]+))?/);
  if (old) return { design: null, diagramId: old[1] ?? null, objectId: old[2] ?? null };
  // Design keys are lowercase, but a link typed as #/Acme still means acme.
  const m = hash.match(
    /^#\/([a-z0-9][a-z0-9-]*(?:@[a-z0-9][a-z0-9-]*)?)(?:\/d\/([^/]+)(?:\/o\/([^/]+))?(?:\/n\/([^/]+))?)?/i,
  );
  const r: Route = {
    design: m?.[1]?.toLowerCase() ?? null,
    diagramId: m?.[2] ?? null,
    objectId: m?.[3] ?? null,
  };
  if (m?.[4]) r.noteId = m[4];
  return r;
}

export function hashFor(r: Route): string {
  if (!r.design) return "";
  return `/${r.design}${r.diagramId ? `/d/${r.diagramId}${r.objectId ? `/o/${r.objectId}` : ""}${r.noteId ? `/n/${r.noteId}` : ""}` : ""}`;
}

/**
 * A link to something in the design that's open (this fork included): a box on a diagram,
 * or a note. The one "Copy link" everywhere: a person opens it, an agent reads it with the
 * MCP (open, or context for a box).
 */
export function linkTo(to: {
  diagramId: string;
  objectId?: string | null;
  noteId?: string | null;
}): string {
  return `${location.origin}/#${hashFor({ design: parseHash().design, diagramId: to.diagramId, objectId: to.objectId ?? null, noteId: to.noteId ?? null })}`;
}

/** Put a link on the clipboard; true when it got there. */
export async function copyLink(to: Parameters<typeof linkTo>[0]): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(linkTo(to));
    return true;
  } catch {
    return false;
  }
}

/** Go to a diagram (and object) in the design that's open. */
export function go(diagramId: string, objectId?: string | null): void {
  location.hash = hashFor({ design: parseHash().design, diagramId, objectId: objectId ?? null });
}

/** A document name, split: the design it belongs to and the fork (null for main). */
export function splitDoc(doc: string): { design: string; branch: string | null } {
  const at = doc.indexOf("@");
  return at < 0
    ? { design: doc, branch: null }
    : { design: doc.slice(0, at), branch: doc.slice(at + 1) };
}

/** Go to another document of the same design, staying on the same diagram and object. */
export function goDoc(doc: string): void {
  const r = parseHash();
  location.hash = hashFor({ ...r, design: doc });
}

/**
 * A message to show once the next workspace opens: moving to a fork or back to main remounts
 * the workspace, which would drop a toast shown just before.
 */
let carried: { text: string; tone: "info" | "error" } | null = null;
export function carryToast(text: string, tone: "info" | "error" = "info"): void {
  carried = { text, tone };
}
export function takeCarried(): { text: string; tone: "info" | "error" } | null {
  const c = carried;
  carried = null;
  return c;
}

export type {
  BranchChoice,
  DesignInfo,
  ForkInfo,
  GitHubStatus,
  GitInfo,
  PullState,
  RepoChoice,
} from "../shared/api.ts";
