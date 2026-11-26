// Who may do what, the same for every way of signing in. Lists of people (ARCHNM_ADMINS,
// ARCHNM_EDITORS, ARCHNM_VIEWERS; see server/config.ts for the format and what each allows),
// from the environment (Nix, Terraform, compose).
import type { Role } from "../auth.ts";

export class Roles {
  private admins: string[];
  private editors: string[];
  private viewers: string[];

  constructor(lists: { admins: string[]; editors: string[]; viewers: string[] }) {
    this.admins = lists.admins;
    this.editors = lists.editors;
    this.viewers = lists.viewers;
  }

  /** The roles for someone signed in as `who` (a login or email), or none: they don't get in. */
  of(who: string): Role[] {
    const w = who.toLowerCase();
    const on = (l: string[]) =>
      l.some((e) => e === "*" || e === w || (e.startsWith("@") && w.endsWith(e)));
    if (on(this.admins)) return ["admin"];
    if (!this.editors.length || on(this.editors)) return ["editor"];
    if (!this.viewers.length || on(this.viewers)) return ["viewer"];
    return [];
  }

  /** Whether anyone at all who signs in gets in (a list is empty where that means everyone, or has "*"). */
  open(): boolean {
    const all = (l: string[]) => l.includes("*");
    return (
      all(this.admins) ||
      all(this.editors) ||
      all(this.viewers) ||
      !this.editors.length ||
      !this.viewers.length
    );
  }

  /** For the startup line: how many of each. */
  describe(): string {
    const n = (l: string[], all: string) => (l.length ? `${l.length}` : all);
    return `${this.admins.length} admin(s), editors: ${n(this.editors, "everyone")}, viewers: ${n(this.viewers, "everyone else")}`;
  }
}
