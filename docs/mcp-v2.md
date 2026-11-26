# MCP v2: the tools

The agent-facing surface, on top of `docs/grammar-v2.md`. It replaces the
35 tools in `server/mcp.ts`. No compatibility: the old names go.

## Principles

- Split by intent: `read`, `note`, `guide` are read-only (auto-approvable); `write`, `design`,
  `index` change things.
- Every read is capped and steers: what's shown, what's left ("37 more, showing 10"), and the
  call that gets the rest. Refs in every line (an id, `repo:path#fn`) work in any other tool.
- Text, not JSON, for the model: compact lines and indented trees. No `structuredContent`
  (clients show it instead of the text).
- Writes are in the file grammar. Errors are all at once, each with where, the nearest real
  id, and a corrected example; nothing is half-applied.
- Teach in descriptions and errors. Server instructions ≤ 2,500 characters: the mental model, the
  loop (read → write with dry_run → fork/propose), and pointers to `guide`.

## Tools (8)

### `read` (read-only)

One tool for looking, by what's asked:

| Param                                                                        | Gives                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `q`                                                                          | search: ranked over names, ids, context, tags, entities, paths; fuzzy. The usual way in. `kind`, `in` filter.                                                                                                                                            |
| `ref`                                                                        | one thing (a box, an entity, a connection `a>b`, a view, `repo:path#fn`, a link): itself in full, its edges as `→ id  label (tech) carries X` lines, what's inside as ids with one line each, notes and decisions on it.                                 |
| `ref` + `depth` (1–4), `follow` (calls, callers, carries, in, uses)          | a bounded walk, as an indented tree                                                                                                                                                                                                                      |
| `ref` + `impact: upstream\|downstream`                                       | computed: everything that depends on it / it depends on, by hops, counted                                                                                                                                                                                |
| `from` + `to`                                                                | computed: the routes between two things                                                                                                                                                                                                                  |
| `scope` + `budget` (tokens, default 4000)                                    | the scope slice: the scope in full, direct neighbours as contracts (name, kind, purpose, exposed functions with signatures, entities taken/returned/carried, connection labels and tech), the rest as names; ranked by distance then connections         |
| `view`                                                                       | a view: its boxes, arrows as drawn, flows; or with no value, the list of views                                                                                                                                                                           |
| `lens` (problems, drift, guesses, flags, hotspots, cycles, spof, mismatches) | what `check`/`curate`/`review` gave, as findings with refs                                                                                                                                                                                               |
| `history` (+ `ref`, `by`)                                                    | recent changes, who made them (an agent's session: "Agent · s-1a2b", or its worker name) and their labels; `by` keeps one session or worker                                                                                                             |
| `diff` (+ `in`, `by`)                                                        | on a fork: what it changed against its main, grouped (boxes, connections, entities, views; + added, ~ changed with the fields, - removed), refs on every line, capped with counts; `in` keeps one box's subtree, `by` what one session or worker touched |
| `file`                                                                       | a file's text as written (what the person sees in git)                                                                                                                                                                                                   |
| `here`                                                                       | what the person is looking at: their view, selection, recent steps                                                                                                                                                                                       |

`limit` (default 20) and `detail: brief|full` apply to all. Always `design` (key; may be left out
when there's one).

### `write`

`yaml`: a fragment in the file grammar (objects, entities, connections, views, flows, boundaries),
merged by id into the agent's fork (made on first write when the design follows git). Leaving
something out never deletes it; `remove: [ids]` does (box ids; `view:<key>`, `boundary:<id>`,
`decision:<id>`; connections by `from>to[:label]`; entities by name). `dry_run: true` returns the diff and every problem without writing. `scope: id`
refuses changes outside that box's subtree (for parallel agents); a change to a neighbour comes
back as an error saying to `note` it instead. `tidy: view` lays a view out after. `undo: change`
reverts one. Returns what changed (refs and links) and the warnings left (TBD, guesses).

### `note`

Notes and flags on anything: `add` (text, about ref; `flag: true` marks it as something wrong or
missing), `reply`, `resolve`, `list` (about, open only by default). Structured claims for parallel
work: `claim: {field, value, evidence}` on a note about a neighbour.

### `show` (changes only what the person sees)

`open` a view or box in the person's canvas, `spotlight` refs, `tour` (steps: refs + a line each),
`render` a view as an image for a model that can see.

### `guide` (read-only)

No topic: the index. Topics: `grammar` (the short guide: one full scope file and the rules agents
get wrong), field reference sections, `views`, `code`, and the playbooks (`map`, `design`, `tour`,
`mentor`).

### `design`

`list` designs and forks; `create` (empty or the example); `delete`; `fork` (start a named one);
`propose` (the link for a pull request: hand it to the person); `discard`.

### `index`

The factory's static pass on the person's machine: `start` (repo path: the one shell command to
run there; it surveys and indexes, and sends it straight to Archnemesis), `scan` (ticket: what it found,
and a draft in the file grammar), `import` (ticket: write the code layer, tagged generated),
`progress` (say how a long job is going).

### `feedback`

When Archnemesis itself gets in the agent's way: `kind` (bug, confusing, missing, wrong-answer),
`text`, optional `tool`. Kept with the session's last 20 calls; answers with its id. Not
read-only, not destructive.

## Telemetry and feedback

Every agent tool call is a row in `telemetry.sqlite`, next to the server's database
(`ARCHNM_TELEMETRY_DB` moves it): time, MCP session id, client name/version (from initialize),
actor, tool, mode (the read option or the action: `search`, `view`, `yaml+tidy`, `create`…),
design, args as JSON (capped at 8 KB, yaml included), duration, outcome (`ok`; `refused`:
Not written; `invalid`: any other error answer; `exception`), answer size, error and warning
counts, the first error line, and the stack for exceptions. The page's WebMCP posts its calls
to `/api/telemetry/call` when there's a server. Nothing leaves the machine.

- `ARCHNM_TELEMETRY=off`: no call log (feedback is still kept: the agent chose to send it).
- Kept 30 days, at most 100,000 calls. A logging failure never fails a call.
- `archnm telemetry`: per tool and mode (calls, refusal and error rates, p50/p95, mean answer
  size); writes to valid (failed writes before each one that went in, per session: median,
  worst, sessions that ended on a failed write); the error first-lines that repeat, with ids
  and numbers taken out; open feedback. `session <id>`, `repro <call-id>` (the call, the
  writes before it in the session on that design, and the design's folder), `feedback
[resolve <id>]`. Admins: `GET /api/telemetry` (`?since=`).

## Prompts (MCP prompts, and `guide` topics for clients without them)

- `/map` (repos or a scope): wave 0 `index` per repo in parallel → the skeleton → one brief per
  scope (`read scope:`) for parallel agents, each `write scope:` → the edge join (`read
lens: mismatches`) → depth → `design propose`.
- `/design` (a goal): one agent writes the skeleton (scopes, contracts, connections) as
  `status: planned` → briefs per scope → fill in, contract changes as notes to the skeleton's
  author → `propose`.
- `/tour` (a topic or a view): `read here` → a `show tour` through what matters.
- `/mentor` (what the person is working on): `read here` and their fork's changes → lenses on what
  it touches (impact, spof, mismatches, drift) → explain, with the decisions behind it.

## Old → new

| Old                                                                       | New                      |
| ------------------------------------------------------------------------- | ------------------------ |
| find                                                                      | read q                   |
| show, context, explain                                                    | read ref                 |
| path                                                                      | read from/to             |
| show impact                                                               | read impact              |
| outline, views                                                            | read view                |
| curate, check, review, flag lists                                         | read lens                |
| history, trail                                                            | read history / read here |
| files                                                                     | read file                |
| apply, write, link, tidy, undo                                            | write                    |
| note, notes, resolve_note, flag                                           | note                     |
| open, point, render                                                       | show                     |
| format, guide resource                                                    | guide                    |
| designs, create_design, delete_design, forks, fork, propose, discard_fork | design                   |
| index_repo, scan, import_code, progress                                   | index                    |

## WebMCP: the same tools in the page

The tools live in `shared/` as functions over the model (and a small host interface: the live
doc, the person, the canvas), so the server's MCP and the web app call the same code and one set
of tests covers both. The server adds what needs it (`index`, git forks); the page adds the
canvas.

The web app registers them with WebMCP when the browser has it (Chrome's preview:
`document.modelContext.registerTool`, older builds and guides `navigator.modelContext`; feature-
detect both, register with an `AbortSignal`, unregister when the design closes). In the page:

- They work for the person, on the live doc, with their rights but in the agent's own name; nothing new to log in to.
- `show` and `read here` are direct: the agent is in the page the person is looking at, so
  tours and mentoring are best here.
- `write` changes only a fork or the open draft, and every change is undoable; `design delete`
  and `discard` aren't offered.
- It's what makes the local, in-browser demo agent-ready with no server at all.

Chrome docs: https://developer.chrome.com/docs/ai/webmcp/imperative-api

## Decisions while building

Where the spec left room, the simplest reading:

- **One core, two adapters.** Each tool is a function over a `Host` (shared/tools/host.ts):
  the design's state and index, `commit(ops, label)`, undo, url, and optionally a canvas,
  designs, an indexer and a renderer. server/mcp.ts and src/webmcp.ts only build hosts and
  register `TOOLS`; tests run on an in-memory host (shared/tools/memhost.ts).
- **write merges at the YAML level.** The fragment is merged into the design's own files
  (each field set; `null` takes it off), new things go to a scratch file `model/_write.yaml`,
  then the whole set is read and checked, and only problems that weren't there before refuse
  the write. The diff becomes ops, so it's one step with one undo.
- **Connections match on from, to and label.** Without a label, the one connection between
  those ends matches; with several, the answer asks for the label (`a>b:label`).
- **`files` stays** (whole files, as `read {file}` shows them); a separate `replace` mode was
  dropped: `remove` plus `yaml` covers it.
- **scope** refuses boxes, entities, connections, boundaries, decisions and views outside the
  box; placing an outside box on a view inside the scope is allowed.
- **read ref on code** (module, function, library, table) answers with the code context
  (where it runs, its calls across processes, libraries) that `context` gave.
- **Lenses.** `spof`: things with two or more direct callers, ranked by how much depends on
  them upstream. `mismatches`: a connection carrying a TBD entity, or (where an end is a
  function) one neither end uses or defines, and lines between the same ends that disagree
  on tech. Claims stay under `flags` for now.
- **show tour** holds the call up to `wait_s` (default 55) in total, then returns where it
  got to; call again with `at` to go on.
- **Prompts take one optional argument, `focus`** ("This time: …").
- **The page writes through the store**, as the person's own edits do: live and undoable,
  or to their fork on a design that follows git (the answer says so). `index` isn't offered
  in the page (the upload goes to the server); `design` there lists, forks and proposes.
- **Each kind has its own ids in remove.** A bare id in `remove` is a box; views, boundaries
  and decisions are `view:<key>`, `boundary:<id>`, `decision:<id>`, since a view and a box often
  share one (shop-api). In yaml, `objects: {x: null}` takes only the box, `views: {x: null}`
  only the view. read shows views as `view:<key>` too, and takes it as a ref.
- **Two connections between the same ends** need the label, on remove and on a write without
  one: the answer lists them (`checkout>payments:charges cards`, `checkout>payments:second`).
- **undo is write's**: write's changes (with their tidy, and index import) are steps in the
  agent's undo; notes aren't (reply, resolve or reopen them instead). The answer says what it
  took back ("Undone: wrote 1 box, 1 connection."); with dry_run it only says what it would.
- **tidy is part of the write**: one undo, one history line; a view to tidy that doesn't
  exist stops the write before anything changes; with scope, only views about the scope.
- **The page's agent** works for the person, in its own name ("Agent (for <person>)", kind agent):
  the person's rights, but protect applies to it, history shows it, and its undo is its own
  (the person's ⌘Z doesn't take its changes back, nor it theirs). It reads the live design
  even while the person looks into the past. On a design that follows git its edits go to the
  person's fork in the person's name (the fork's endpoint takes the person's sign-in), so
  undo there is the person's. design in the page offers list, fork and propose.
- **Caps**: a file comes 200 lines at a time (`read {file, from}`), a view's outline and its
  "why" by limit, a long route with its middle left out (the hop count said), and a box's or
  entity's long lists (fields, references, links, decisions, defines) with counts.
- **No `who` on read ref**: who worked on a box's code needs the forge (the server's
  "Who works on" card); left for later rather than half done here.
- **No structuredContent.** Claude Code shows a result's structuredContent instead of its
  text, so an agent saw `{"view":"landscape"}` where the outline should have been. Results are
  text (and images) only; `Out.data` stays for tests and in-process callers.
- **Sessions.** The transport is stateless (a server per request), so Archnemesis mints an id on
  initialize, returns it in `Mcp-Session-Id`, and keeps per session the client's name and
  the design last used. A call without design goes there and says so ("on delivery: the
  design this session last used"). design create sets it, to the agent's fork when the new
  design follows git (the fork is made then, and the answer says so first), and names the
  view the design starts with.
- **A view's mode follows what's written**: boxes makes it hand-picked and drops its
  include/exclude; include/exclude makes it follow rules and drops its boxes.
- **Prose in {…}**: a comma (stray keys with spaces or ending in punctuation) or a colon (the
  YAML library's "block in flow") is one error per line saying to quote it or use block
  style; the library's other messages are translated by code. Every example writes context
  quoted or in block style.
- **A tidy that moves nothing** says so, with the direction it's in and the other one to try.
- **Removing a box with boxes inside**, when that breaks views, leads with what's inside.
- **An empty answer says what was checked**: a lens with nothing found is "problems: none.
  … (checked 24 boxes, 23 connections, 2 views)"; a search with no hits says what it
  searched and the nearest names; a view with no boxes says why.
- **read view gives its definition** as written (scope, include/exclude or boxes, in the
  grammar), so an agent sees a view before overwriting it; the guide's views section lists
  exactly what read view returns.
- **A box with lines of its own stays a box.** A box whose insides are on a view used to be a
  frame around them, and a line can't end on a frame, so a service with its stores inside lost
  every line. Now a box frames its insides only when it has no lines of its own to the rest of
  the view; otherwise it's a box with its insides beside it. A file (module) always frames its
  functions. (Lines ending on frames would need the canvas, router, renderer and score to
  take frames as ends: more than this needs.)
- **A scoped view draws its own box when that box has lines** to what's on the view (a service
  whose calls are made at the service, with only stores inside): rules add it, explained as
  "the view's own box, for its lines to what's here", and the scope's frame isn't drawn then.
- **A view with a scope and nothing else** follows rules: the scope's children and neighbours,
  as the guide says. `boxes: []` is still an empty hand-picked view.
- **remove is read loosely**: `remove:` in the yaml is the parameter; a string that is a list
  (`"[view:a, view:b]"`, JSON or YAML) or refs split by commas (when no part has a space) is a
  list. A removed view takes its layout and arrow shapes with it.
- **A connection's label with commas** is read whole when it can only mean one thing: keys with
  no value right after `label` (or `description`) that aren't connection fields are the rest
  of it. A box's context with a comma is still an error (the stray words could be a field
  forgotten); examples quote both.
- **Workers on one fork.** All of a person's agents are `agent:<login>`, so they share one fork.
  Each MCP session is named in history and on every write answer: "Agent · s-1a2b", or the
  worker name it gave with `as` on write or note ("Agent · ordering-mapper"), for that call
  only (trial 7: subagents share a session). The history entry's actor carries the short id, so `by` matches either. Each
  session has its own undo. The manager's playbook is `guide {topic: "manage"}`; /map and
  /design point at it.
- **read diff compares through the files** (both sides written and read back), so things
  line up by key; a fork's main is main at the fork's base commit (what the fork changed).
  `by` keeps what that session's history entries touched.
- **The scripts Archnemesis hands out are built on demand.** A server started from the source
  (`node server/main.ts`) has no dist/, so `curl …/archnm-index.cjs` 404'd. It now builds a
  missing script with vite the first time it's asked for (in dev, at startup), once however
  many ask; index start checks the script is there before handing out the command, and if it
  can't be, says why and gives the manual route instead.
- **Mapping by reading** (no indexer) is taught where it's needed: index start (and its
  fallback), the map playbook, and guide {topic: "map-by-reading"}. The map playbook opens
  with one repo in one pass; the waves are for many repos or a big one.
- **read's description leads with q, ref and scope**; the rest is one line pointing at
  guide {topic: "read"}, which has every option.
- **write's parameters written in the yaml are the parameters** (tidy, remove, scope, dry_run,
  as, label, direction): lifted out before the fragment is read. One given beside the yaml
  wins (remove: both, merged), and the answer says which were taken or ignored.
- **path on apps and components** (where their code lives), not only modules. Import, drift,
  code context and the file layout only ever look at a module's path, so an app's path is
  information for people and agents and changes nothing there. A store, system or actor still
  can't have one. kind: library without a package warns that your own shared code is a module.
- **Repos are known, not registered by hand**: the repos index start brought in for the
  design (by name) and those its paths and sources already use. A write warns when a new path
  names another; with none known (no index, no paths yet) it says nothing. scan says the
  repo's name and how to write its paths. (No archnm.yaml `repos:`: the two sources cover it.)
- **Telemetry in its own file**, not the designs' database, so backups of designs stay small.
- **Old text helpers stay** where tests cover them (viewSlice, trailText, notesText,
  reviewText, outlineModel, describe, find); only `impactText`, dead and untested, went.
- **Git everywhere, one mechanism** (trial 5): the design a fresh Archnemesis starts with (the
  example, or one empty design) goes into git like every new design (`startInGit`, unless
  ARCHNM_NEW_IN_GIT=0 or no lasting disk), so fork, read {diff} and propose work on it too. No
  draft mode and no "changed" status: the fork's diff is the marker (read {diff} and the canvas
  show changed fields on existing boxes). Where a design truly has no git, fork's error says
  how to get one (connect a repo from the branch menu) and to write directly until then.
- **Lines end on frames** (trial 5, replaces trial 2's "a box with lines stays a box"): a box
  whose insides are on the view is a frame, and its own lines end on the frame; so does the
  view's scope (no longer added as a box beside its own insides). The projection gives a frame
  as an edge end (`lineEnds`); the canvas, renderer, score and tidy (ELK, to the frame's group)
  route to it, and libavoid gets a free point on the frame's facing side (the binding takes
  no direction). A box's line to something inside itself can't be drawn: read {view} lists it
  under "not drawn", with the fix (model it on the part that does it).
- **A ref that's both a box and a view** reads as the box, and the answer says so and gives
  view:<key>. **A view's settings changed by a write** are said apart from tidy's moves.
  **Functions straight in a component** warn once per box (a plan too: a module with no path
  yet is fine). **Signature types** link to defined entities only and never make a TBD; the TBD
  warning says so. **Render** labels a merged arrow with each label (the canvas keeps
  "2 connections" and its hover).
- **Big designs stay fast, and one call never freezes the rest** (trial 6: a dry-run import of
  1,835 functions held the event loop for 5+ minutes). planChanges checked each change by
  replaying every op so far (quadratic): now one running draft (`Checker`) takes each change's
  ops on top of the last, rolled back if they fail, so each error still names its change and a
  failure still changes nothing (`onError: "skip"` drops only that change). Uniqueness checks
  use indexes kept as the draft changes, and name lookups are maps. Reading a design's files
  found each entry's line by scanning its map (quadratic in a big file): now a map per YAML
  map. A write's starting files, their read and check are kept per design version, so a dry run
  and the write after it, and lens problems, read the design once. No worker thread: planning
  2,000 functions takes ~35 ms and 20,000 ~250 ms, under the ~1s that would need one. The
  import yields to the event loop between its steps (plan, write, rules), so other calls get
  in, and sends MCP progress notifications when the client passed a progressToken.
  server/scale.test.ts times all of it (a 10s bound, printed).
- **Code refs everywhere** (trial 7: workers read raw YAML to find ids). `repo:path` and
  `repo:path#fn` (`#Class.method` for a method, or `#method` when only one has it) work
  wherever a box's id does: write turns them into ids before merging (object keys, `in`,
  connection ends, a view's scope, boxes and rules, flow steps, a link's `on`, boundary rules,
  remove), and findObject takes them, so apply and every other tool do too. A path an app or
  component holds counts as well as a module's. One that names nothing says so, and for a key
  how to add the box. Lines show both: `repo:path#fn [id …]`.
- **Import places code by the boxes' paths.** A folder or file whose path an app or component
  has is that box (no module beside it), so what's below goes inside it, the deepest such box
  first; `under` takes the rest. The dry run lists, per box, the top folders and files it gets
  and how many land inside. Every source file is a module, functions or not; a method is a
  function named `Class.method()` (an existing one found by its bare name keeps its name);
  the built-in reader finds methods whose types hold `{…}`, signatures over several lines,
  class fields and consts holding arrow functions.
- **`as` is per call.** It names that call's writes and notes; without it, the session's
  short id. The session's undo actor was renamed by each call and the log kept the same
  object, so an old entry's name changed with it: each commit now logs a copy.
- **Guesses apart.** `{guess: true}` is a rule: in hide_lines it leaves guessed lines off a
  view; in include/exclude it picks guessed boxes. Crossings that involve a guessed line are
  counted apart (`3 crossings (and 5 with guessed lines)`): review never makes them a must,
  and suggests confirming or hiding them. `null` on a new box's or connection's field means
  not set. A flow step between boxes with no connection between them (or what's inside
  them, either way) warns.
- **Propose leads with what matters**: the design's boxes, connections, flows, views,
  entities, then code, libraries and layout last, under a headline of counts with the views'
  and flows' names; the answer shows 25 and says how many more. **read {ref} on a file**
  says each call once with how many (`helper() ×5`), guesses marked, capped at `limit` with
  the read for the rest. **Prose in YAML**: a colon in a block-style value or in `{…}`, and a
  comma in `{…}`, name the field and give it quoted.
- **Stacked forks** (trial 8: a plan on an unmerged map proposed the map's 5,800 changes too).
  `design {action: "fork", design: <a fork>}` starts from that fork (its edits committed
  first): its branch starts at the parent's head, and read {diff} and propose compare with
  the parent as it is now. The pull request's base is the parent's branch (GitHub, GitLab and
  Forgejo all take any base), and the answer says to merge the parent first. Without a forge,
  Archnemesis merges into main only, so it says to merge the parent, then this. When the parent
  closes, the fork compares with main again.
- **Apply a dry run by id.** A dry run that would change something answers with
  `write {apply: "dry-…"}`. It keeps what was asked and a fingerprint of the design's files,
  in the server's memory, for an hour. apply writes exactly that, once; it refuses when the
  files changed since (someone wrote in between), or when sent with more to write.
- **Search by any term.** Several words rank by the whole query and by each word (so
  `personal.ts PersonalTokens main.ts` lists all three); a word that is a ref (`repo:path#fn`)
  puts that box first.
- **`in` on every lens.** Problems keep the ones that name a box inside (as a whole word) or
  sit in its views' files; review and the drift worklists keep theirs.
- **Who made it.** Placing a box on a view (or bending a line there) is logged as a change to
  the view, not the box. read {diff, by} counts something added as theirs only if the first
  change to it was theirs. A write logged at most 50 ids, so a big write lost the rest
  (19 of 43 connections): now up to 5,000.
- **A function's own id** is on read {ref}'s head line (`ref: web:a.ts#run · id run-1x`).
- **Tables.** Columns written another way (`- id uuid pk`, `- {id: uuid}`) get one error for
  the list, with the shape and the first one rewritten, instead of "needs a name" per column.
  guide {topic: "tables"} is built from spec.ts (a column's fields, column/to_column).
- **Planning changes to what exists.** The design playbook says to write the change on the
  box in the plan fork (context, signature, status, a note); the diff is what reviewers see.
  Changed fields on generated boxes already show field by field in read {diff} and as changed
  on the canvas (both compare what the files say; tested), and an import only touches their
  sources and status, so the plan stays. With stacked forks that answers "where's the modify
  marker": no marker is built. If one is still asked for, the smallest would be the canvas
  and the brief reading the fork's diff as a `changed` badge on the box, not a field.
- **Guesses that the code can't make.** The built-in reader links a name-only call to a
  function in the calling file or a file it imports (TS/JS relative imports, Python
  `import`/`from`, Go packages by folder); `x.f()` in TS/JS is a method call (only a class's
  methods, or `f` from `import * as x`); a helper defined inside a function isn't a target from
  another file. On Archnemesis itself: 3,731 guesses → 3,334, cross-file 1,916 → 1,602, and
  `json() → whatsnew.end` gone. read {scope} and read {ref} leave guessed calls out by default,
  counted, with `guesses: true` to show them.
- **Lenses on a fork look at the fork** (trial 9: 48 design-wide items each time, so the plan
  was checked by rendering). On a fork, problems, review and drift keep the findings about
  boxes the fork added or changed (and the ends of lines it added) and views it added or
  changed, against its main or the fork it's stacked on; `all: true` gives the whole design.
  The other lenses (hotspots, cycles…) stay design-wide: they're about shape, not a change.
  `view:` narrows any lens to the boxes on that view and that view's file.
- **Decisions in the diff and the write's answer.** read {diff} has a decisions group, as
  propose does. A write listed a decision only as "(and 1 decision)"; it now says
  `+ decision <id> "<title>"` (or `~` with the fields), and the history label counts it.
- **A planned file with no path has no ref of its own.** codeRef took the nearest module with
  a path, so functions in `shares.ts` (no path) borrowed the folder's: `server/signin#dropDoc`.
  The ref now comes from the module a function is in, or it's the function's id.
- **Box-level read {ref}** leaves guessed calls out too, counted, with `guesses: true`.
- **Planned code goes live on import.** A module or function with status future that the
  import matches (by path, then by name in its file) becomes live, keeping what was written;
  a planned file named but with no path is matched by name in its folder's module and given
  its path. The design playbook and the grammar say how to name planned code.
- **Whole contexts.** read {ref} shows a box's whole context (it cut a long one at its first
  paragraph), code boxes included; a search line that cuts one says `(cut; read {ref} for
all)`. No append syntax: a merge of prose would need its own rules for where the new text
  goes and how a retry doesn't add it twice, and reading the whole context and writing it
  back is already one read and one write.
- **The design playbook** describes a planned change in the box's context only: a note is for
  a question or a claim to someone else, not the change.
- **A crowded view warns.** A write that grows a view past 14 boxes says so, with the fixes
  (group into a box with its own view, fold externals, exclude some). It's said after the
  write, since rules place the boxes then; a dry run doesn't.

## Later

- Provenance on facts beyond `generated` and `guess` (static / agent / person) and evidence
  (`file:line`) on agent claims.
- A deterministic edge join (`lens: mismatches` starts as "both sides disagree on carries/tech").
- A code-mode `query` tool, when tasks need ten reads or more.
