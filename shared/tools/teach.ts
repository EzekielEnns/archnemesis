// What the tools teach: the server's instructions (kept under 2,500 characters: the mental
// model, the loop, where to read more), and the playbooks, served as MCP prompts and as guide
// topics for clients without prompts.

export const INSTRUCTIONS = `Archnemesis holds a software architecture that people and agents edit together, live. Boxes (actor, system, app, store, component; for code: module, function, library, table) nest with \`in\`; connections join them (from>to, label, tech, carries); entities (DTOs, enums, by type name) are what boxes use and connections carry; views draw parts of it. It's saved as YAML files in git, and that file grammar is also how you write.

Tools:
- read (read-only): search (q), one thing (ref), a walk (ref + depth/follow), impact, routes (from/to), a brief for one box (scope + budget), views, lenses (problems, flags, spof, cycles, mismatches…), history, files, and what the person sees (here). Answers are capped and end with the call that gets more.
- write: a YAML fragment (objects:, entities:, connections:, views:) merged by id. Leaving something out never deletes it; remove: [refs] does. dry_run first when unsure. Every problem comes back at once with where and the nearest real id; nothing is half-applied. On a design that follows git it goes to your fork.
- note: notes, flags (something wrong or missing) and claims (what you learned about a box you don't own).
- show: open, spotlight, tour or render in the person's canvas. Changes nothing.
- guide (read-only): the grammar, the field reference, and playbooks: map, plan, design, tour, mentor.
- design: list, create, fork, propose (a pull-request link to hand the person), delete, discard.
- index: map a repo on the person's machine (start gives a shell command; then scan, import).
- feedback: when Archnemesis gets in your way (a wrong answer, a confusing error, something missing), tell us with feedback: it's how the tools get fixed.

Refs: box ids (shop-api), repo:path#fn for code, entity names (Invoice), a>b for a connection, view keys, links. Every ref works in every tool.

The loop: read {q} → read {ref} or {scope} → write {dry_run} → write → read {lens: "problems"} → design {action: "propose"}.

In parallel: each agent takes one scope (read {scope}, write {scope}); what it learns about a neighbour is a note claim, not an edit. One agent owns the contracts between scopes.

Write what's true: context says what a box does and why, first (in quotes inside {…}: context: "…"); guess: true for what you believe but haven't confirmed; status: future for what's planned; an entity with no fields is TBD (fine). About 12 boxes a view.

Tools that act on a design take design (its key); leave it out to stay on the one you last used.`;

export const TOPIC_READ = `read, every option. Answers are capped (limit, default 20), say what's left, and end with the call that gets it; every line starts with a ref you can pass back.
- {} : what the design is, its top level, its views (a view's ref is view:<key>).
- q (+ kind, in): search ids, names, tech, tags, paths, context, entities, views; fuzzy.
- ref: one thing in full (a box, an entity, a connection a>b, view:<key>, repo:path#fn, a note, a link): its edges as "→ id label (tech) carries X", what's inside, notes, decisions. detail: "full" for everything.
- ref + depth (1-4) / follow (calls, callers, carries, in, uses): a walk, as an indented tree.
- ref + impact (upstream: what depends on it; downstream: what it depends on): computed, counted by hops.
- from + to: the routes between two things.
- scope (+ budget in tokens, default 4000): a brief for working inside one box: it in full, its neighbours as contracts (purpose, functions with signatures, entities, connection labels and tech), the rest as names.
- view: how it reads (boxes, lines, crossings), its boxes, arrows, flows, its definition, why each box is there. view: "*" lists the views.
- lens: problems, review, drift, guesses, flags, hotspots, cycles, spof, mismatches (+ ref to narrow it to one box).
- history (+ ref, by: a session or worker): recent changes, who made them, their labels.
- diff (+ in, by): on a fork, what it changed against its main, grouped.
- file: a file as written ("*" lists them; long ones in pages: file + from).
- here: what the person is looking at (their view, selection, recent steps).
Example: read {q: "checkout"} then read {ref: "checkout", impact: "upstream"}.`;

export const MANUAL_MAP = `Mapping a repo by reading it (no indexer):
- Read: the manifests (package.json, go.mod, Cargo.toml, pyproject.toml, pom.xml / build.gradle), Dockerfiles, compose, Kubernetes, Helm or Terraform files (what runs, its ports, and the env vars that name other services, databases, queues and vendors), the entry points (main, cmd/, server, index, route tables, job and queue consumers), the README, and the comment at the top of each main file.
- Write, in one fragment:
  - a system for the product; an app for each thing that runs on its own (a service, a web app, a worker, a job, a CLI), with path: repo:path for its code root; a store for each database, cache, queue or bucket (in the app that owns it, or the system when it's shared); actors for who uses it; vendors as external systems.
  - one level of code under each app: its top folders or packages as modules (kind: module, path: repo:path), not every file; functions only where they matter (entry points, handlers), with signatures. Your own shared code is a module too; kind: library is a third-party package (with package: {ecosystem, name, version}, the version as the manifest or lockfile has it): write the ones the manifests list that the code leans on, each with a connection from the app or module that uses it; they show on a Dependencies view, made with the first one.
  - a view for every box with something inside (the system, each app): views: {<app>: {name, scope: <app>}} gets its insides and neighbours by itself. Without one, opening the box shows nothing.
  - connections: label what travels in a few words ("Session signals", "Usage"), tech how (HTTP, gRPC, SQL, a queue); topic names, caveats and the how go in description, not the label. Lines both ways between two boxes are drawn as one two-way line. What you saw in code or config (a client, a URL, a queue name), write as is; what you infer from a name or an env var, mark guess: true.
  - context first on every box (what it does and why, quoted).
- Repos: a path is <repo>:<path in it>. The repo's name is the one index start registers (the repo folder's name, or the script's --repo; scan says it), and the one paths already in the design use; a write warns when a path names another. With no index at all, pick one short name (the repo's folder name) and use it everywhere.
- Then read {lens: "problems"}, fix, and design {action: "propose"}.`;

export const PLAYBOOKS = {
  map: {
    title: "Map a system",
    args: "repos or a scope",
    text: `One repo, one service (or a few small ones)? Do it yourself, in one pass: index {action: "start", path} (or, with no indexer, read the repo as below); write the system, its apps and stores, and the connections between them, context first; then index {action: "import", ticket, under, calls} for the code (or its top folders as modules): scan says how the calls were found and which calls to bring (exact, all or none) for this repo; when the better way is installing an indexer, ask the person; a view per app (scope: <app>); read {lens: "problems"}; design {action: "propose"}.

${MANUAL_MAP}

Where import puts the code: a folder or file whose path a box already has goes in that box (give each app its code root first: path: repo:server; a component can have one too: a folder, repo:server/tools; one file, repo:server/main.ts, which becomes a module inside it; or a pattern for files that share a flat folder, repo:server/{git,forks}*.ts, on a component or on a grouping module), the deepest such box first, and what's below it follows; only the rest goes in under. Give the paths, then dry_run the import: it lists, per box, the top folders and files it gets and how many land inside. Files are modules whether or not they have functions; a method is a function named Class.method. With a SCIP indexer, each function comes with its signature, and a new one with its doc comment as its context; each new file comes with its leading comment as its context. Write context where that's missing or says too little, not signatures. Tests, fixtures and generated code are left out of the index, so don't make boxes to hold them.

Grouping: a box that only holds other parts (the server's "request edge", the UI's "editing") is a component, with a path pattern for the code in it (path: "repo:server/{auth.ts,signin/*.ts}"); components nest. A module is a real folder or file only. A component given its path after the import: the write moves the imported files it claims into it, from the box above it (no in: on each file).
Views for code: a view per app or component (scope: it), not one per file. A view of a component shows its files (a component of three files or fewer needs none: opening it on the canvas draws them); folders and files (modules) need no view of their own: opening one on the canvas makes it, and the problems lens doesn't ask for one. Make a view for a file only when its functions are the story (a flow, a hot spot). Any ref works where an id does: repo:path, repo:path#Class.method (in keys, in:, from/to, flow steps, view boxes and scope, remove).

Many repos, or a big one: map it in waves, many agents in parallel, each with a small context.

0. Skeleton (static), one per repo, in parallel: index {action: "start", path} gives a shell command to run on the person's machine; then index {action: "scan", ticket} gives what runs, what holds state, specs, and a draft in the file grammar. Write the skeleton (systems, apps, stores, the connections between them). Network topology from manifests becomes groups: a cluster or a VPC is a box the others are in.
1. Surface, one agent per scope, in parallel. Brief each with read {scope: id, budget: 4000}. Each writes its own scope only, write {scope: id, yaml}: what it is (context first), what it exposes (functions with signatures), what it calls and carries (connections with carries), and entities it defines. What it learns about a neighbour: note {action: "add", about: neighbour, claim: {field, value, evidence: "repo:path:line"}}.
2. Edge join: read {lens: "mismatches"} and read {lens: "flags"}; settle each claim with the scope's owner, or flag it for a person.
3. Depth, per scope, in parallel: components and code (index {action: "import", ticket, under}), now against real neighbour contracts.
4. Review: read {lens: "review"} until nothing is under must; then design {action: "propose"} and hand the person the link.

Look hardest where static analysis is blind: queues, URLs built from config, shared databases, dynamic dispatch. Mark what you infer guess: true. Say how a long job is going: index {action: "progress", text, step, of}.

Running the agents yourself (briefing, watching, correcting): guide {topic: "manage"}.`,
  },
  design: {
    title: "Design a system",
    args: "a goal",
    text: `Plan on a fork. A design that follows git puts your writes on your own fork by itself (design {action: "create"} and every write say which); a plan for an existing design starts with design {action: "fork"}. The fork's diff is the "changed" marker: read {diff: true} lists what you added, changed (field by field) and removed against main, and the canvas shows the same; don't add a status or a tag for it. If design {action: "fork"} says the design has no git, that Archnemesis keeps designs out of git: write directly (each write is in read {history: true} and can be undone), and when you hand it over, list what you changed.

A plan on top of a map that isn't merged yet: design {action: "fork", design: "<the map's fork>"} stacks your fork on it, so your diff and pull request show only the plan, not the map.

To plan a change to an existing box (code included), write the change on it in the plan fork: in its context (add a paragraph, e.g. "Share links (planned): …", and keep what was there: read {ref} shows all of it), and its signature or status if those change. That's enough: notes are for questions and claims to someone else, not for the change itself. There's no "modify" marker: the diff is the marker. read {diff: true} lists each changed box with the fields that changed, the canvas draws it as changed, and that is what reviewers see. Boxes the importer made (tagged generated) take changes like any other: an import only updates their sources, their signatures (from the indexer) and whether the code is gone, so what you wrote stays.

New code, planned so the importer picks it up when it lands: a new file is a module with its path (path: "<repo>:server/signin/shares.ts", kind: module, status: future) inside the folder's module; its functions go in it, named as the code will name them (name: "dropDoc()", status: future), so their ref is <repo>:server/signin/shares.ts#dropDoc. When the code is imported, the importer finds them by that path and name and turns them live, with no second box. A planned file without a path has no ref of its own (its functions show by id).

Third-party packages the design leans on (a framework, an ORM, a queue client) are library boxes, not only words in tech: {kind: library, package: {ecosystem: npm, name: hono, version: 4.6.0}} (the version when you know it, from the manifest or the lockfile: its links then point at that version), with a connection from what uses it (from: api, to: hono). The first one makes a Dependencies view by itself; each gets its registry links, and "what uses this?" then has an answer.

A small design (about 20 boxes): do it yourself, in one pass: the systems, apps and stores with their contracts and connections (status: future), then the components and functions inside, in a few writes; dry_run first; then steps 3 and 4 below.

A big one: divide and conquer, agents in parallel.

1. One agent writes the skeleton: the scopes (systems, apps, stores), the contracts (entities with fields, functions with signatures) and the connections between scopes (label, tech, carries), all status: future. It is the only writer of contracts. Write it in one or two fragments; dry_run first.
2. Then one agent per scope fills in its inside, in parallel: read {scope: id} for its brief, write {scope: id, yaml} for its components, functions and entities. A contract change is a note claim to the skeleton's author, not an edit.
3. Look at it: read {lens: "review"} and read {lens: "problems"}; show {open: view} or show {render: view}.
4. design {action: "propose"}: the person reviews the shape on the canvas. When the code lands, the importer turns future into live; what's still future isn't built.

Running the agents yourself (briefing, watching, correcting): guide {topic: "manage"}.`,
  },
  plan: {
    title: "Plan something new with a person",
    args: "what they want to build",
    text: `Planning with a person, from an idea to something worth building. They look at the big picture and cut; you keep it small and off the shelf. Don't draw the big version first: the usual first design is three times what's wanted, and the person spends the session cutting it.

1. The goal, in one sentence, before any box: what it does for whom ("light novels translated to English that I can read in a smooth UI"). Not said? Ask once. Write it as the system's context. Everything after is measured against it.

2. Off the shelf first. For each thing the goal needs, in this order: an existing tool or service that already does it; a library that does it; a few lines of glue; and only then code of your own. A part you'd write yourself says in its context why nothing existing fits. Check what you name: the registry for the current version, the docs, the licence, a site's terms before planning to fetch from it. Queues, workers, caches, schedulers, sync protocols and hand-written clients are the usual things to not build.

3. The big picture, three views the person reads first, about 12 boxes each:
   - the shape (the system's view): who uses it, the apps, the stores, the outside services, and what travels between them.
   - dependencies: every library and tool the plan leans on, each a library box (package: {ecosystem, name, version}, a docs link, and in its context what it does for us and what it saves us writing), connected from the app that uses it. The first library makes this view.
   - deploy (views: {deploy: {name: "Deploy", boundaries: true, ...}}): where each part runs (the machine, the image, the volume, the network it listens on), how it's reached, and what it needs from outside. Boundaries are the machines and networks.
   Only what the goal needs, all status: future. What you'd add "for later" isn't drawn: it goes on the roadmap (decisions: {roadmap: {title: "Roadmap: not in the first version", status: proposed, text: "- <thing>: <why later>"}}).
   show {open} the shape, and say in a few lines what's in and what's on the roadmap. Then stop and let them look.

4. The review round. They comment on boxes; read them with note {action: "list"} (each says what it's on). Answer in chat with a table: what it's on, what they said, what you'll do. Read each as one of: "can a library do this?" (find one), "what is this?" (it's unclear: rename it and say it plainly, or cut it), "simpler" (cut it down to what the goal needs), "skip" (to the roadmap). Ask only what is really open, once. Then reply in each thread with what you did, change the design (remove what's cut; the fork's diff shows it), and leave the threads for them to resolve. Expect more than one round; each should end smaller.

5. The code shape, once the cut is agreed and not before: the repo as it will be, folder by folder (a module per folder and per file, with path, config and test files too, each file in its folder's box); the functions that matter with signatures; tables with columns; what's created once and passed in. A view per folder. Entities for what crosses a boundary.

6. Lock it in. Each choice the person questioned or agreed ("why this and not that?") is a decision: what was picked, what it beat and why, status accepted, affects: the boxes. read {lens: "review"} and read {lens: "problems"}, then design {action: "propose"}.

Throughout: when they ask "why X?", answer with the alternative and what each costs here, and say which you'd pick. When something you said turns out wrong (a terms page, a version), say so first and change the plan.`,
  },
  tour: {
    title: "Show someone around",
    args: "a topic or a view",
    text: `Give a tour.

1. read {here: true}: where the person is and what they've selected.
2. Plan the stops: read {view}, read {ref}, flows (read {view} lists them), the decisions behind it. Five to eight stops; one idea each.
3. show {tour: [{ref | refs | view, flow, step, say, code}]}: the call holds while they read and press Next. If they ask something it returns the question: answer it (show {open, say}), then show {tour, at}. If it pauses, call it again with at.
4. End with show {done: true} and where to go next.`,
  },
  mentor: {
    title: "Mentor someone on their change",
    args: "what they're working on",
    text: `Bring a staff engineer's judgement to what the person is working on.

1. read {here: true}, and their fork's changes (read {history: true}).
2. For what it touches: read {ref, impact: "upstream"} (what breaks), read {lens: "spof", ref}, read {lens: "mismatches", ref}, read {lens: "drift", ref}, read {lens: "cycles", ref}.
3. Read the decisions on those boxes (read {ref, detail: "full"}): why it's built this way.
4. Explain what matters, worst first, with refs; walk them through it with show {spotlight} or a short tour. Leave what's left as notes on the boxes.`,
  },
} as const;

export const GRAMMAR_TIPS = `Rules agents get wrong:
- objects: is a map keyed by id, never a list. Ids are slugs and permanent: rename with name.
- in: is the parent's id; from/to are ids; carries/uses/extends are entity type names.
- Text in {…} with a comma, a colon or a # goes in quotes (an unquoted # starts a comment and drops the rest of the line) (context, a connection's label or description): {kind: actor, context: "Orders food, pays, tracks it."}, {from: a, to: b, label: "charges cards, then emails"}; a long one in block style (context: | on its own line, the text indented under it).
- A signature's types are worked out from it: don't repeat them in uses. Quote a signature. Its types link to entities that are defined; one that isn't (Money, CustomerId) stays plain text, with no warning. A name in uses, carries or extends that nothing defines is a TBD entity, with a warning until you define it.
- Connect at the lowest level that's true: the component (or function) that makes the call, not its app. A parent's lines are drawn from its children's: on a view of the app they end on its frame, one level up on the app's box. A box's line to something inside itself can't be drawn. Where many calls roll up onto one line (app to app), a connection between the two boxes themselves names the whole: its label is drawn, with how many more are inside ("verifies people (+12 inside)").
- A fragment merges: write only the fields you change; null takes a field off; remove: [ref] deletes (box ids; view:<key>, boundary:<id>, decision:<id>; a>b:label; entity names).
- Flows are written under their view: views: {checkout: {flows: [{name: "Place an order", steps: [{from: a, to: b, text: "…"}]}]}}.
- A decision has its own words: decisions: {0004-queue: {title, status: proposed|accepted|superseded, date, affects: [box ids], text}} (text, not context; affects, not about).
- A connection is matched by from, to and label: write the same line again to change it. Two between the same ends: say the label, or it asks. To move a line to other ends, name the old one: - {was: "checkout>ledger", from: checkout, to: books} (its label and the rest come along; :label after was when two share the ends).
- Planned code (status: future) is named as the code will be: a file module with path: "<repo>:<path>", its functions inside it by their code names (name: "make()"). The importer then finds them by path and name when the code lands, and turns them live.
- A table (kind: table, in its store) has columns, a list: columns: [{name: id, type: uuid, pk: true}, {name: order_id, type: uuid}, {name: email, type: text, personal: true}]. A foreign key is a connection from the table to the one it points at, with column (and to_column, when it isn't the other's primary key): {from: order-items, to: orders, column: order_id}.
- A component's path: a folder (repo:server/tools) gets that folder's files; one file (repo:server/main.ts) gets that file, as a module inside it; a pattern (repo:server/{git,forks}*.ts, repo:server/**/*.ts) gets the files it matches, for files that share a flat folder.
- A big first write: send it with dry_run. If it's refused, its answer gives an id: write {onto: id, yaml: <only the corrected entries>} fixes it without sending the rest again (edits: [{old, new}] for text that isn't YAML yet, like a colon to quote).
- Never write layout; never secrets, IPs or customer names.`;

export const TOPIC_VIEWS = `Views (diagrams): views: {<key>: {name, scope, story, include|boxes, exclude, flows}}.
- Rules keep a view current: include: [{children: shop}, {neighbours: shop}], exclude: [{kind: library}] ({top: true} is every box at the top level: what a new design's Landscape follows); or hand-picked, boxes: [ids]. Writing boxes makes it hand-picked (its include/exclude go); writing include/exclude makes it follow rules (its boxes go).
- A view with scope X and no rules gets X's children and neighbours. Every box with an inside wants its own view scoped to it.
- A box whose insides are on the view is drawn as a frame around them, and its own lines end on the frame (the view's scope too). Lines are drawn between the nearest things drawn, so model them on the children: the parent's follow.
- About 12 boxes a view (the checks warn past 15). Too many parts in one box? Group them in components inside it (a component with a path pattern; components nest). Busy? fold: externals, hide_lines: [rule], lanes: <tag group>, arrows: elbow; then write {tidy: view}. fold: externals gathers the boxes marked external: true (vendors, other companies' systems) into one box per group; it doesn't touch a box that's only tagged. hide_lines takes the same rules as include ({ids: [a, b]}, {tag: plumbing}, {kind: library}, {kind: function} for calls between code, {guess: true}, {external: true} for the lines to outside services): lines touching what they pick aren't drawn; the boxes stay. A kind takes the lines drawn to boxes of that kind: {kind: function} takes the lines to functions on the view, and keeps the lines between files (the calls rolled up). On a view of a box, hide_lines: [{between: neighbours}] keeps only the lines that touch the box's insides: the lines between two of its neighbours go.
- flows: [{name, kind: story|path, steps: [{from, to, text}]}] tells a route step by step. A step goes between any two boxes, either way: it needs no connection under it, and the order is yours.
- read {view: key} gives: how it reads (boxes, lines, crossings), its boxes and arrows as drawn, flows, its definition as written (scope, include/exclude or boxes: read it before overwriting a view), and why each box is there. read {view: "*"} lists the views. show {render: key} draws it, to look.
- A view a person arranged by hand is theirs. Add to it and leave the rest where it is: no tidy, no lanes, no fold on it unless they asked (tidy skips it and says so). Boxes you add land next to what they connect to. If what you're adding would take it past about 12 boxes, make a second view for the new part instead of crowding theirs.
- Look at every view you changed before you say it's done: show {render: key}. Lines through boxes, labels on top of each other or a write that says "reads worse now" mean it isn't.
- A new design starts with a landscape view that follows rules (actors and systems).`;

export const TOPIC_MANAGE = `Managing agents that write in parallel to one fork: you brief, watch, correct and propose; they each write one scope.

1. The fork. One fork for the whole job: write anything first (it goes to your fork; the answer names it, e.g. shop@agent-zeek) or design {action: "fork", design, name}. Every agent of the same person writes to that same fork: give each worker its key.
2. Brief each worker, one scope each, in parallel: its slice (read {scope: id, budget: 4000}: the box, its neighbours' contracts), the fork key, its name and its scope. "You are ordering-mapper. design: shop@agent-zeek. Write only with write {scope: "ordering", as: "ordering-mapper", label: "…"}. What you learn about a neighbour is a note claim, not an edit. Quote context and labels." A scoped write changes what's inside the scope, adds tables to a store the scope reads or writes, adds an outside service no one has (external: true, in the vendors' group), gives a component a path (the imported files it claims move in by themselves), and writes views whose scope is it or a box inside it; anything else is the manager's.
   as names the worker in history ("Agent · ordering-mapper") for that call only: a write without it is credited to the session's short id (s-1a2b). Subagents share their parent's MCP session, so each worker passes as on every write and note, and you pass your own (or none) on yours. They share its undo too: undo only right after your own write. Dry runs and refused writes are kept by id, not by worker: pass the id you were given. A write too big to send comfortably goes in parts: a dry run of the first part, then write {onto: its id, yaml: <the next part>} adds to it, and one apply writes it all. A dry run's answer stops at 60 lines; to change one before applying it, write {onto: dry-id, yaml: <entries>}: an entry takes the fields sent and keeps the rest; null drops an entry or a field. The contracts between scopes (entities, signatures, connections) stay yours.
3. Watch, as they go:
   - read {diff: true}: what the fork changed against main, grouped (boxes, connections, entities, views; + added, ~ changed with the fields, - removed). in: "ordering" for one subtree; by: "ordering-mapper" for one worker.
   - read {history: true, by: "ordering-mapper"}: its steps, with their labels.
   - read {lens: "problems"} and {lens: "mismatches"}: what doesn't hold together; note {action: "list"}: claims and questions from the workers.
4. Correct on the fork: write it yourself (your own undo; theirs stays theirs), or note the worker's box with what to change. Settle each claim: change the contract, or answer the note.
5. When read {lens: "review"} has nothing under must: design {action: "propose", design: "<fork>"}, and hand the person the link with what was done and what's left (open notes, guesses).`;

export const TOPIC_CODE = `Code is the same boxes one layer down.
- module: a crate, package, folder or file (path: repo:path); function: anything callable, in its file's module, with signature; library: a third-party package (package: {ecosystem, name, version}); table: in its store, with columns.
- Calls are connections; between processes, name how it travels in tech (HTTP, queue).
- Refs: repo:path for a module, repo:path#fn for a function (repo:path#Class.method for a method). They work wherever an id does, write's keys and ends included; lines show both (repo:path#fn [id …]). read {ref: "repo:path#fn"} gives where it runs, what it calls and what calls it.
- index {action: "start"} reads a repo on the person's machine; import brings files and functions in, tagged generated (describe and connect them; don't rename them). Calls the importer guessed by name are guess: true.
- Libraries stay off code views: the first library written makes a Dependencies view (key dependencies; include: [{kind: library}, {uses: library}]) that draws each with what uses it.`;
