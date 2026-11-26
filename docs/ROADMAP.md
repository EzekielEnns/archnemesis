# Roadmap

What is next, then what is still open from earlier, then what has landed. The reasoning behind
the built parts is in DESIGN.md. Updated 2026-11-26.

## Next

- [ ] **Per-design permissions and share links.** Sign-in for the instance comes first
      (done: roles are per instance, a design can be private to its owner). Then roles per
      design. A share link grants view and fork on one design; on an instance that has
      sign-in, the link sits inside it (you sign in, then the link applies).
- [x] **The first-run view.** A new instance opens on one empty design with a welcome that
      says what Archnemesis is and what to do first (start blank, map a repo, connect an
      agent), with the example one click away. `ARCHNM_EXAMPLES=off` removes the example.
- [ ] **Split `server/live.ts` and `server/gitsync.ts`** (about 1,250 and 1,130 lines), and
      share the document upkeep (dangling references, view rules, file keys, per-agent undo)
      between the server and the local backend (`src/backend/local.ts`), so the two do not
      drift apart.
- [ ] **The Cloudflare relay.** The static app on Pages plus a small sync relay on a Durable
      Object, so people share a design without running a server. Nothing is built; the
      Backend interface (`src/backend/types.ts`) is where it plugs in.
- [ ] **Rename the GitHub repository and the container image** to Archnemesis. Then update
      `.github/workflows/image.yml` and the deploy examples that name the image, register
      `archnemesis.dev`, and claim `archnm` on npm. Always written "Archnemesis (`archnm`)" so
      search and models learn it as one.

## Still open from earlier

Not re-checked against the code on 2026-11-26: look before starting any of these.

**Canvas**
- [ ] The edit that starts a fork cannot be undone (⌘Z after the first edit on main).
- [ ] Arrows jump around: sides and ports re-picked for arrows that were not touched
      (`recomputeRoutes`, `chooseSides`, `ports`); keep an arrow's sides and slot unless its
      own ends moved.
- [ ] Viewer mode: read only, no handles or toolbar; click drills in, flows step, notes can be
      read and answered; the default for a shared link.
- [ ] Arrows do what boxes do: notes, links, tags, status, context in the panel.
- [ ] Double-click renames the top half of a box and opens only from the bottom strip
      (`src/canvas/scene/`); decide whether double-click should always open, rename on F2.
- [ ] One app on several hosts: an app placed in several host boundaries, drawn once per host
      and sharing its arrows (now a copy per host and duplicate arrows). Changes the model.
- [ ] More logos: Iconify Logos (CC0) as a second source behind `/api/icon`.
- [ ] Straight, curved or right-angle per arrow, and per diagram; one "tidy arrows" action
      that re-routes every arrow without moving boxes.

**Git**
- [ ] Catching up: a field-by-field three-way merge (`shared/merge.ts`), behind counts, a
      keep-mine / take-main conflict panel.
- [ ] `diff` and `catch_up` tools for agents; a change list and a diff overlay on diagrams;
      the change list in the pull request body.
- [ ] A design inside an existing service repo (an `architecture/` subpath); pushes to a
      fork's branch from elsewhere; webhooks from a forge on the tailnet.

**Notes and links**
- [ ] Notes pinned to a box or connection on a fork, live for everyone on it; opening a pull
      request copies them to it as comments. An RFC link on a fork, shown in the branch menu
      and put in the pull request's body. Later: pull request comments shown back on boxes.
- [ ] Full RFC support (writing and outlining an RFC in Archnemesis itself).

**Tables**
- [ ] An importer (Postgres `information_schema`, migrations, ORM models), like `archnm
      import` for code.

**Later**
- [ ] Delete or archive a design from the design menu and the MCP.
- [ ] Back up the design repos (restic or similar); the database already has backups and
      Litestream.
- [ ] A laptop copy of the design folders (Syncthing, never `.git` or the database).

## Landed

- **Model and files:** one model, many diagrams; the file grammar (`docs/grammar-v2.md`),
  `archnm check`, schemas, a generated AGENTS.md; layout in its own files; tables (a table
  box with its columns in the side panel; foreign keys as connections, across regions
  coloured and checked for personal data).
- **Live:** Yjs over Hocuspocus, SQLite log and snapshots, per-participant undo, presence;
  notes (comment threads on a view, pinned to boxes and arrows) and links, links in the files.
- **Agents:** MCP (eight tools, prompts, a guide resource) and WebMCP, sharing one
  implementation in `shared/tools/`; agents work on their own fork; telemetry and the
  `feedback` tool; the repo importer (`archnm import`, SCIP or ctags); the channel that
  brings an @agent note to a running Claude Code session.
- **Git:** main mirrors a repo, forks commit to `archnm/<design>/<fork>`, Propose opens the
  forge's pull request page (GitHub, GitLab, Forgejo/Gitea), the GitHub App (set up in one
  click or from the environment), merge inside Archnemesis for a repo with no forge.
- **Arrows:** curved, elbow and straight (libavoid), alignment guides, hand-shaped arrows
  saved in layout, Lay out / Tidy (ELK), opt-in Keep tidy.
- **Sign-in:** a provider interface (`server/auth/provider.ts`) with built-ins (local, tokens,
  header and its Tailscale / IAP / Cloudflare Access presets, oidc, github), a worked gcip
  example, your own module; one set of role lists; personal tokens; MCP OAuth.
- **Running it:** the Docker image (non-root, health check, Litestream), `docker-compose.yml`,
  the Nix package and NixOS module, the static build (`pnpm build:static`), hosting examples
  in `examples/deploy/`.
- **Code:** the cleanup into `shared` / `server` / `src` / `cli` with lint holding the lines,
  one config module, the Backend interface behind the app, the Workspace split into hooks.
- **Name:** renamed to Archnemesis (`archnm`); old names (`ATLAS_*`, `atlas.yaml`,
  `atlas.sqlite`, `atlas/...` fork branches, `X-Atlas-*`, `atlas_pat_`, `services.atlas`) are
  still read.
