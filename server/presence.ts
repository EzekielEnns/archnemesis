// Who's on Archnemesis: people on sockets (their awareness) and agents over MCP (no socket, so
// remembered for a while after their last tool call), as each viewer is allowed to see them.
//
// A person shows to others only on designs those others may view (server/perms.ts), so nothing here
// gives away that a private design is open, or where. A guest on a share link is one anonymous
// "Guest": whatever name its browser claims is replaced on the server (see guestUser).
import type { Connection, Document } from "@hocuspocus/server";
import type { HereEntry, Progress } from "../shared/api.ts";
import type { Principal } from "./auth.ts";
import type { Hub } from "./live.ts";
import type { ConnContext, Viewer } from "./perms.ts";

/** An agent (over MCP) counts as on Archnemesis this long after its last tool call. */
const AGENT_ACTIVE_MS = 5 * 60_000;

type Entry = HereEntry["user"];

/** A guest as everyone else sees it: no name, no id of its own that means anything. */
export const guestUser = (guestId: string): Entry => ({
  id: guestId,
  name: "Guest",
  color: "#9ca3af",
  kind: "human",
});

interface AgentRecord {
  p: Principal;
  doc: string;
  diagram: string | null;
  what: string;
  at: number;
  progress?: Progress;
}

const docLabel = (hub: Hub, doc: string): string | null => {
  const live = hub.get(doc);
  if (!live) return null;
  return live.name() + (doc.includes("@") ? ` @${doc.slice(doc.indexOf("@") + 1)}` : "");
};

export class Presence {
  private hub: Hub;
  private agents = new Map<string, AgentRecord>();
  private agentSweep: NodeJS.Timeout | null = null;
  private timer: NodeJS.Timeout | null = null;
  private last = new Map<string, string>();

  constructor(hub: Hub) {
    this.hub = hub;
  }

  /**
   * An agent called a tool on `doc` (a design or fork): it shows to those who may see that design
   * until it's been quiet for AGENT_ACTIVE_MS.
   */
  agentSeen(p: Principal, doc: string, diagram: string | null, what: string): void {
    if (p.kind !== "agent") return;
    const was = this.agents.get(p.id);
    // A job's progress stays until it's done, or the agent moves to another design.
    const progress = was?.doc === doc ? was.progress : undefined;
    this.agents.set(p.id, {
      p,
      doc,
      diagram,
      what,
      at: Date.now(),
      ...(progress ? { progress } : {}),
    });
    if (!was || was.doc !== doc || was.diagram !== diagram || was.what !== what) this.changed();
    this.agentSweep ??= setInterval(() => {
      const cut = Date.now() - AGENT_ACTIVE_MS;
      let gone = false;
      for (const [id, a] of this.agents) if (a.at < cut) gone = this.agents.delete(id) || gone;
      if (gone) this.changed();
      if (!this.agents.size && this.agentSweep) {
        clearInterval(this.agentSweep);
        this.agentSweep = null;
      }
    }, 30_000);
  }

  /** An agent says what it's on in a long job: shown beside it and across the design's top. */
  agentProgress(p: Principal, doc: string, progress: Progress | null): void {
    const a = this.agents.get(p.id);
    if (!a || a.doc !== doc) return;
    if (progress) a.progress = progress;
    else delete a.progress;
    this.changed();
    // Done: it shows "done" for a while, then goes.
    if (progress?.done)
      setTimeout(() => {
        const now = this.agents.get(p.id);
        if (now?.progress === progress) this.agentProgress(p, doc, null);
      }, 20_000);
  }

  /** Awareness client ids that belong to guests' connections, on one document. */
  private guestClients(d: Document): Map<number, string> {
    const out = new Map<number, string>();
    for (const [conn, v] of d.connections as Map<
      Connection<ConnContext>,
      { clients: Set<number> }
    >) {
      const ctx = conn.context;
      if (ctx?.guest) for (const c of v.clients) out.set(c, ctx.guestId);
    }
    return out;
  }

  /** Everyone connected, one entry per person per document, as `viewer` may see them. */
  here(viewer: Viewer): HereEntry[] {
    const { hub } = this;
    const out: HereEntry[] = [];
    for (const [doc, d] of hub.hocuspocus.documents) {
      const label = docLabel(hub, doc);
      if (label === null || !hub.perms.can(viewer.who, doc, "view", viewer.pass)) continue;
      const guests = this.guestClients(d);
      const seen = new Set<string>();
      for (const [client, st] of d.awareness.getStates()) {
        const s = st as { user?: Entry; diagram?: string | null };
        const gid = guests.get(client);
        const user = gid ? guestUser(gid) : s.user;
        if (!user?.id || seen.has(user.id)) continue;
        seen.add(user.id);
        const diagram = typeof s.diagram === "string" ? s.diagram : null;
        out.push({
          doc,
          docName: label,
          diagram,
          diagramName: diagram ? (hub.get(doc)?.state.diagrams.get(diagram)?.name ?? null) : null,
          user: { id: user.id, name: user.name, color: user.color, kind: user.kind },
        });
      }
    }
    // Agents over MCP, unless they're also on a socket (a walkthrough) and listed already.
    const listed = new Set(out.map((e) => e.user.id));
    const cut = Date.now() - AGENT_ACTIVE_MS;
    for (const a of this.agents.values()) {
      if (a.at < cut || listed.has(a.p.id)) continue;
      const label = docLabel(hub, a.doc);
      if (label === null || !hub.perms.can(viewer.who, a.doc, "view", viewer.pass)) continue;
      out.push({
        doc: a.doc,
        docName: label,
        diagram: a.diagram,
        diagramName: a.diagram
          ? (hub.get(a.doc)?.state.diagrams.get(a.diagram)?.name ?? null)
          : null,
        user: { id: a.p.id, name: a.p.name, color: "#c084fc", kind: "agent" },
        activity: a.what,
        for: a.p.for,
        at: a.at,
        ...(a.progress ? { progress: a.progress } : {}),
      });
    }
    return out;
  }

  /** Send everyone their own list soon, once a burst of changes settles. */
  changed(force = false): void {
    if (force) this.last.clear();
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.send();
    }, 250);
  }

  private send(): void {
    const made = new Map<string, string>();
    const keys = new Set<string>();
    for (const d of this.hub.hocuspocus.documents.values()) {
      for (const conn of d.connections.keys() as Iterable<Connection<ConnContext>>) {
        const ctx = conn.context;
        if (!ctx) continue;
        const who = ctx.guest ? { kind: "guest" as const } : ctx.principal;
        const key = `${ctx.guest ? ctx.guestId : (ctx.principal?.id ?? "")}|${ctx.pass ?? ""}`;
        keys.add(key);
        let msg = made.get(key);
        if (msg === undefined) {
          msg = JSON.stringify({ type: "here", people: this.here({ who, pass: ctx.pass }) });
          made.set(key, msg);
        }
        if (this.last.get(key) !== msg) conn.sendStateless(msg);
      }
    }
    // Remembered per viewer; one who has left is forgotten, so coming back hears the list again.
    this.last = new Map([...made].filter(([k]) => keys.has(k)));
  }

  closeTimers(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.agentSweep) clearInterval(this.agentSweep);
  }
}
