# Archnemesis design

Why Archnemesis is shaped the way it is, and where each part lives. README says how to use
it; ROADMAP says what is next. This describes the code as it stands (2026-11-26).

## Goals

1. **AI-first.** An agent can read, change and check the architecture without a person
   tidying up after it, and can't leave it broken.
2. **Self-hostable**, with people and agents editing the same diagrams live.
3. **Kept up to date by an agent:** when the code changes, an agent proposes the matching
   architecture change, live or as a pull request, and a person reviews it.
4. **In source.** The model, the views and their layout are files in git.
5. **Runs anywhere.** One container for a team; or the same app with no server at all.

## The code, in four folders

```
shared/   pure code: the model, the Yjs document, the file grammar, checking, the agent
          tools, layout and routing maths. Runs in the browser and on the server.
server/   Node: HTTP API, live sync, MCP, git, GitHub, SQLite, sign-in, backups, telemetry.
src/      the React app and its PixiJS canvas. Talks to a Backend (src/backend/).
cli/      the `archnm` command: check, fmt, render, import, write, config, channel, ...
```

Lint holds the lines between them (eslint.config.js): `shared/` imports no Node and nothing
from `src/`, `server/` or `cli/`; `src/` imports nothing from `server/` or `cli/` and uses
no raw `fetch` outside `src/backend/`; the environment is read only in `server/config.ts`
(and `server/env-compat.ts`; tests and test support may read it). The pre-push hook
(lefthook.yml) runs lint with the tests and knip.

## One document, several ways in

```
 browser tabs ──Yjs/WebSocket──┐
                               ├──  live Y.Doc  ──▶ SQLite (update log + snapshots)
 agents ───────MCP /mcp────────┘        │
                                        ▼ a second after edits settle
                             folder of YAML per design (ARCHNM_ROOT/<design>) ◀── git pull / PR / editor
                                        │ on change: check, then apply as one batch
                                        ▼
                                     live Y.Doc
```

- **The live document is a Yjs doc** (`shared/doc.ts`). Objects, connections, diagrams and
  flows are nested Y.Maps, so two people editing different fields of one box both win.
  Every edit is a batch of ops (`shared/model.ts`), validated on a draft copy first,
  written in one transaction tagged with who made it, and logged.
- **Sync is Hocuspocus over WebSocket** (`/sync`), not WebRTC: the server has to see every
  edit to persist it, check it and write the files. Presence (cursors, selections, what you
  are dragging, which diagram you are on) is Yjs awareness.
- **Persistence is an append-only log of Yjs updates in SQLite** (`server/store.ts`,
  `node:sqlite`), compacted into a snapshot every 500 updates. The same file holds forks,
  git bindings, comment threads, personal tokens and GitHub sign-ins. The browser also
  caches the doc in IndexedDB, so a reload is instant and offline edits merge on reconnect.
- **Undo is per participant** (a Y.UndoManager per origin): it never undoes someone else.
- **Cleanup after concurrent edits:** if one person deletes a box while another connects to
  it, the server sweeps the dangling arrow once edits settle.
- **Files and document stay in step** (`server/files.ts`): document to files a second after
  edits settle; files to document when something else changes them, read as a whole folder,
  checked, applied as one batch. A folder with errors is never applied and never overwritten;
  the first error shows in everyone's history.
- **Backups** (`server/backup.ts`): a consistent copy of the database every few hours. The
  files hold the architecture and git holds the files, but threads, history and forks live
  only in the database. Litestream (`docker/start.sh`) can replicate it off the machine.

## Why our own YAML

IcePanel, Structurizr and LikeC4 each keep part of this in source, but none has a model,
views with rules, and layout all as reviewable files that also round-trip with a live
editor. So the format is ours, small, and designed for agents. It is defined once
(`shared/spec.ts`); `archnm schema` writes the JSON schemas from it, check takes its fields
from it, and AGENTS.md is generated from it. `docs/grammar-v2.md` is the grammar.

- **One way to write each thing**, loose in and tidy out. Unknown fields are errors. Output
  is canonical (fixed key order, defaults left out, lists sorted), so writing what was read
  gives the same bytes and diffs are minimal.
- **Keys, not ids or names.** A readable slug given once (`shop-api`) that survives a
  rename; agents and people refer to things the same way.
- **Layout is separate** (`layout/*.json`, one box per line) and owned by Archnemesis, so
  model changes and position changes never mix in a diff, and agents never write coordinates.
- **Views follow rules where they can** (children, neighbours, tag, ...), so adding a
  component puts it on every diagram it belongs on. `explain` says why each box is there.
- **Strict about the graph, free about prose.** Unknowns never block: an entity named but
  not defined is TBD, `guess: true` marks what is believed, `status: future` what is planned;
  check lists them as warnings.

`archnm check` validates schema, references, `in:` cycles, duplicate ids and names,
overlapping boxes, rules that match nothing, and forbidden content (IPs, keys, and the
patterns in `archnm.yaml`).

## Agents

Eight tools: `read`, `write`, `note`, `show`, `guide`, `design`, `index`, `feedback`
(`docs/mcp-v2.md`). They are described once, as functions over a `Host` (what the place they
run can do), in `shared/tools/`. Two hosts exist: the server's MCP endpoint
(`server/mcp.ts`, stateless streamable HTTP at `/mcp`, with prompts for the playbooks and the
grammar as a resource) and the page's WebMCP (`src/webmcp.ts`, for a browser agent, in the
server build and the static build alike). The same code, and the same tests, answer both.

Everything takes keys or names and answers in capped, compact text with the call that gets
more. `write` runs a batch on a copy of the document, applies the view rules and runs
`check`; anything that would leave a new error is refused whole, with every reason. `dry_run`
shows the effect. Agents are named participants: their edits show live with their own cursor
and undo; on a design that follows git they go to the agent's own fork.

Every agent tool call is logged to the server's own SQLite (`server/telemetry.ts`; nothing
leaves the machine), with the `feedback` tool for reports, read by `archnm telemetry`.

## Auth

`server/auth.ts` is the one place that decides what a request may do: `identify` (a
Principal) and `authorize` (read, edit, administer). A **provider** only answers who a
request is from; its contract is `server/auth/provider.ts`:

```
createProvider(ctx) -> { id, describe(), identify(creds) -> Identity | null,
                         ready?(), routes?(req, res, path), openToInternet? }
```

`identify` is synchronous (it also runs for WebSocket upgrades), so keys load in `ready()`.
The core does the rest for every provider alike: the role lists (`server/signin/roles.ts`,
matched against `Identity.login`), the signed session cookie (`server/signin/session.ts`),
personal tokens people make in the app (`server/signin/personal.ts`: hashed, revocable,
180 days, acting as their maker with the maker's current role), the static tokens file,
MCP OAuth for Claude Code (`server/signin/oauth.ts`), and "an agent is at most an editor".
`server/auth/gate.ts` is what the core hands a provider and where role checks happen, so a
provider cannot sign in someone the lists refuse.

Built in (`server/auth/providers/`): `local` (everyone, loopback only), `tokens` (a JSON
file, compared in constant time), `header` (a signed JWT verified on every request by
`server/auth/jwt.ts`, or a plain trusted header on loopback), of which `tailscale`, `iap`
and `cloudflare-access` are presets (`server/config.ts`); `oidc` and `github` (a button, a
redirect flow with state, nonce and PKCE tied to the browser). `gcip` is a worked example
outside the core (`examples/auth/gcip`), beside a template (`examples/auth/custom`);
`ARCHNM_AUTH=/path/provider.js` loads your own (`server/auth/load.ts`). A provider that
anyone on the internet could finish (`openToInternet`) refuses to start without the role
lists or `ARCHNM_OPEN=yes`.

Every HTTP request and WebSocket upgrade also checks Host and Origin against the public URL,
so a page on another site cannot drive a local Archnemesis (DNS rebinding).

A design can be private to its owner; otherwise everyone who may read the instance reads it.
Roles are per instance, not per design (see ROADMAP).

## Config

Every setting is an environment variable, read once by `loadConfig` (`server/config.ts`)
into a typed `Config` that is handed to everything else. `server/config-reference.ts` lists
each with its group, default and meaning; `archnm config` prints it, and a test fails when
config.ts reads a variable the reference omits. `server/env-compat.ts` copies old `ATLAS_*`
names to `ARCHNM_*` first. Invalid settings stop the server at start with a message.

## The server

```
server/main.ts      opens the port (and Vite in dev); on SIGTERM pending files are written
server/app.ts       createApp(config): builds the pieces, returns a Ctx and a request handler
server/routes/      one module per area, tried in order: signin, designs, design (one design),
                    git, github, import, icons, render, telemetry, upload, oauth
server/live.ts      Hub (the designs, the sync server) and Live (one document, main or fork)
server/gitsync.ts   a design that follows git (below)
server/files.ts     document <-> folder of files
server/store.ts     SQLite persistence
server/mcp.ts       the MCP host
```

`/api/config` (how to sign in, the MCP address) and the icons are reachable without signing
in; everything else needs someone who may read.

## Branches (git)

A design can follow a git repo (the branch pill, or `POST /api/d/<key>/git` with a remote,
or `{local: true}` for a bare repo next to the database). Everything is plain git, so it
works the same against GitHub, a self-hosted forge or a repo over ssh.

- **Main is a mirror.** One clone per design under `<state>/repos/<design>`, checked out
  detached at `origin/main`, fetched every 30s (`ARCHNM_GIT_POLL_MS`). File sync runs in
  mirror mode on that checkout: what git says goes into the live document, nothing is ever
  written back. Tabs on main are read-only.
- **Edits go to forks.** A fork is a document in the same database named `<design>@<fork>`,
  started as a copy of main. The first edit on main (`POST /edit`) joins the newest open fork
  a person started, or makes one, and the tab moves there. Agents get their own fork. Forks
  are rows in `forks`, so they survive restarts and container replacement; a fork's URL
  (`#/<design>@<fork>`) is the link you share.
- **Forks commit with plumbing.** After edits settle (`ARCHNM_GIT_IDLE_MS`, at most
  `ARCHNM_GIT_MAX_MS`) the fork's files go into a commit built with a throwaway index
  (`read-tree`, `update-index`, `write-tree`, `commit-tree`) and are pushed to
  `archnm/<design>/<fork>` (forks made before the rename keep `atlas/...`). The author is
  whoever edited most, the rest are Co-authored-by, the committer is Archnemesis. No working
  tree is touched, so main's mirror stays clean.
- **Merging** happens inside Archnemesis only for a repo with no forge: `merge-tree
  --write-tree`; a clean merge becomes a two-parent commit pushed to main, a conflict is
  refused. Whenever main contains a fork's branch, however it got there, the fork closes and
  its tabs move to main.
- **Only the pull request is forge-specific** (`server/forge.ts`): opening one and reading
  its state sit behind an adapter. Propose opens the forge's new-pull-request page filled
  in (GitHub, GitLab, Forgejo/Gitea via `ARCHNM_FORGES`). With the GitHub App
  (`server/github.ts`, set up by the manifest flow or from `ARCHNM_GITHUB_*`) it pushes with
  the app's token and opens the pull request as the signed-in person.

The clone uses the service user's git and ssh setup, so an ssh remote works with that user's
keys; an https remote can carry a token in its URL (never shown back). Comment threads are
conversation, not architecture: they live in the database and, on a design that follows git,
go straight onto main, never through a fork.

## The app

The app asks a **Backend** (`src/backend/types.ts`) for everything: config, who I am, the
list of designs, a design's live document, git, GitHub, tokens, sign-in, versions, reports,
telemetry. The capabilities beyond the first few are optional, and the UI shows a feature
only when the backend has it; the app never checks which backend it has.
`src/backend/index.ts` picks one at build time (`VITE_BACKEND`):

- `server.ts`: HTTP and a Hocuspocus WebSocket to the Node server.
- `local.ts`: everything in this browser (IndexedDB per design, one person who edits
  everything, no git, sign-in, sharing or other people). This is `pnpm build:static`.

Around it:

- `src/store.ts`: the browser's copy of the live document, plain records for the canvas
  and panels, per-tab undo, the change events.
- `src/Workspace.tsx` only assembles the page. The state is three layers of hooks in
  `src/workspace/`: `useDiagramState` (the model, dialogs, layout, selection, which diagram
  is open, who is here, the card, arrows, flows), `useCanvasSession` (navigation, notes,
  edits, the tour, the scene, peers, highlights, jumps, WebMCP) and `useInteraction` (flow
  and diff spotlight, going up, the card following its box, clipboard, keyboard, the menus and
  palette). Each region of the page is a component beside them (`TopBar`, `SidebarHost`,
  `CanvasLayers`, `CardHost`, `FlowHost`, `NotePanels`, `Dialogs`, ...); `src/ui/` holds the
  shared widgets.
- `src/canvas/`: PixiJS on WebGL, driven by `Scene.ts` rather than React, so a drag or zoom
  never re-renders a component. The scene is split by concern in `src/canvas/scene/`
  (`nodes`, `edges`, `arrows`, `groups`, `flow`, `overlay`, `minimap`, `peers`, `view`;
  pointer handling in `pointerDown`, `pointerMove`, `pointerUp` and `nodeDrag`; one hit test
  per event against plain rects and curves in `hit.ts`; `snap`, `measure`, `exportPng`).
  It draws on demand, hides boxes outside the view, and knows nothing about the model: it is
  handed a graph (`shared/project.ts`) and reports gestures through callbacks, which the
  app turns into ops (`shared/actions.ts`). Arrow routing (libavoid, in a worker) is
  `routeWorker.ts` and `avoid.ts`; `camera.ts` is zoom and pan.
- Navigation is a hash route (`src/route.ts`: `#/<design>[@<fork>]/d/<diagram>/o/<object>`), so no server
  routes are needed and the static build works under any path.
- Recording your own navigation is optional and per browser (`src/trail.ts`); the server
  keeps what it is sent per design.
