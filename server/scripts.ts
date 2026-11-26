// The one-file scripts Archnemesis hands out (curl … | node -): the repo reader (index start) and
// the channel. `npm run build` makes them into dist/; a server started straight from the
// source (node server/main.ts) builds the missing one on demand, once, so the command an
// agent was given never 404s. Where it can't (no vite: a production install without dist),
// it says exactly what's wrong.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const SCRIPTS = {
  "archnm-index.cjs": "vite.index.config.ts",
  "archnm-channel.mjs": "vite.channel.config.ts",
} as const;
export type Script = keyof typeof SCRIPTS;

export type Ready = { ok: true; path: string } | { ok: false; error: string };

export class Scripts {
  private building = new Map<Script, Promise<Ready>>();
  private root: string;
  /** For tests: how a missing script gets built (default: vite with its config). */
  private builder: (config: string) => Promise<void>;
  constructor(root: string, builder?: (config: string) => Promise<void>) {
    this.root = root;
    this.builder =
      builder ??
      (async (config) => {
        const vite = await import("vite");
        await vite.build({
          configFile: join(this.root, config),
          root: this.root,
          logLevel: "warn",
        });
      });
  }

  path(name: Script): string {
    return join(this.root, "dist", name);
  }

  /** The script, built if it's missing; never throws. */
  ensure(name: Script): Promise<Ready> {
    const at = this.path(name);
    if (existsSync(at)) return Promise.resolve({ ok: true, path: at });
    let p = this.building.get(name);
    if (!p) {
      p = (async (): Promise<Ready> => {
        try {
          console.log(
            `archnm: building ${name} (dist/ doesn't have it; npm run build makes them all)`,
          );
          await this.builder(SCRIPTS[name]);
          return existsSync(at)
            ? { ok: true, path: at }
            : { ok: false, error: `building ${name} finished but dist/${name} isn't there` };
        } catch (e) {
          return {
            ok: false,
            error: `dist/${name} is missing and building it failed: ${(e as Error).message.split("\n")[0]}`,
          };
        } finally {
          this.building.delete(name);
        }
      })();
      this.building.set(name, p);
    }
    return p;
  }

  async read(name: Script): Promise<{ ok: true; data: Buffer } | { ok: false; error: string }> {
    const r = await this.ensure(name);
    if (!r.ok) return r;
    try {
      return { ok: true, data: await readFile(r.path) };
    } catch (e) {
      return { ok: false, error: `couldn't read dist/${name}: ${(e as Error).message}` };
    }
  }
}
