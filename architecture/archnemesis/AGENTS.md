<!-- archnm: generated from the file format and archnm.yaml; edits here are replaced -->
# Keeping Archnemesis up to date

These YAML files are the architecture. People see them as diagrams in Archnemesis; the files are
the truth. Edit them, run `archnm check` until it prints `ok`, and open a pull request.

With Archnemesis's MCP connected, the same work goes through seven tools: `read` (search first,
then one thing; `scope` for a brief), `write` (a YAML fragment in this grammar, merged by
id, checked whole, one undo), `note`, `show`, `guide`, `design` and `index`.

## Get these right first

1. **`objects:` is a map keyed by id**, not a list: `shop-api: { kind: app, … }`. Never
   `- id: shop-api`. Leave `name` out when it's the same as the id.
2. **Ids are slugs, and permanent** (`refunds-worker`). Never change or reuse one;
   rename with `name`. `in`, `from`, `to`, `via` and view rules name ids that exist:
   check suggests the nearest when one is a typo.
3. **Entities are keyed by their type name** (`PaidOrder`: a letter, then letters, digits, _), under `entities:` in the file of
   the box that defines them, with `in:` that box. Everything points at one by that name.
   A name nothing defines yet is fine: it's TBD (a warning to fill in later).
4. **A box's `uses:` lists entities its `signature` doesn't already name.** A signature's
   types are worked out from it; don't repeat them. Quote a signature: it has colons.
5. **A connection's `carries:`** lists the entities that travel over it, by name.
   Connections are a list, one `{ from, to, label, … }` per line, in the caller's file.
6. **Not sure? `guess: true`.** On an object or a connection you believe but haven't
   confirmed. check lists guesses; confirm and drop it later.
7. **Never delete for being gone.** `status: removed` (gone, kept for history),
   `deprecated` (being retired) or `future` (decided, not built); say why in `context`.
8. **Never write `layout/`.** Archnemesis places boxes itself.
9. **Comments aren't kept** (Archnemesis rewrites files canonically): put it in `context` or `notes`.
10. **Never in the files:** secrets, keys, tokens, IP addresses or ranges, customer names.
    check refuses these, and anything matching this design's own patterns:
  - (none beyond the defaults)

## The loop

1. Read what's there first (`archnm outline`, or the files). Reuse objects; don't duplicate.
2. Edit the YAML. One change per pull request; say where each fact came from
   (`sources: [repo@sha:path:line]`).
3. `archnm check` names every problem as `file:line`, with what to write instead. A folder
   with errors is never applied. Warnings (TBD, guesses, no tech, no context) never block.

## A scope's file

```yaml
# model/payments.yaml
objects:
  payments:
    kind: system
    name: Payments
    tech: [Stripe]
    context: |
      Charges cards through Stripe. Retries twice, then marks the order unpaid.
  charge:
    kind: function
    in: payments
    signature: "(order: Order, card: CardToken) -> Result<PaidOrder, ChargeError>"
    uses: [Ledger]
    references:
      - code: payments:src/charge.rs#charge
      - link: https://stripe.com/docs/api/charges

entities:
  PaidOrder:
    in: payments
    extends: [Order]
    fields: { charge_id: text, paid_at: timestamp }
  ChargeError:
    in: charge
    values: [declined, expired, network]
  Ledger:
    in: payments
    fields:
      entries: "[LedgerEntry]"
      "balance(&self)": Money

connections:
  - { from: storefront, to: payments, label: charges the card, tech: HTTPS, carries: [PaidOrder] }
  - { from: charge, to: stripe-api, label: creates a charge, tech: HTTPS, guess: true }
```

`fields` is a map of name → type; a key with `( )` is a method (an interface). `values`
makes an enum. Neither: TBD. One value works where a list goes (`tech: Go`), and kinds and
statuses take any case; Archnemesis writes them back in one form.

## Files

```
archnm.yaml              the design's name and rules: forbid, tags, protect, limits, github
model/<system>.yaml     a top-level box with an inside, everything in it, and their entities
model/_top.yaml         every other top-level box (people, vendors), and homeless entities
code/<repo>/<path>.yaml a source file's module, its functions and calls, at the source's path
libraries.yaml          third-party packages the code uses
boundaries.yaml         where things run: projects, networks, regions, processes
views/<view>.yaml       one diagram: what's on it (rules or a list), its story and flows
decisions/<id>.yaml     one architecture decision: title, status, affects, text
layout/<view>.json      box positions: Archnemesis's alone
```

A new object needs only its entry: Archnemesis puts it on every diagram whose rules pick it. Code is
the same objects one layer down (`module` with `path: repo:path`, `function` in its file's
module, `library` with `package`); calls are connections. Things tagged `generated` come from
`archnm import`: describe and connect them freely, but don't hand-edit their names, paths or
sources. A `table` lives in its store with its `columns`; a foreign key is a connection
between tables with `column` (and `to_column`).

## More rules

- **Lowest true level.** A connection goes between the parts that really talk (component →
  store). Traffic through a load balancer is one connection to the backend with `via:`.
- **Right place.** `in:` is what it lives inside: apps and stores in a system, components in
  an app. Group a crowd under a parent rather than listing 20 siblings.
- **Diagrams stay readable:** at most 15 boxes and 20 lines. Fold externals, `hide_lines`
  for plumbing, a tighter `scope`, or split it. Give every view a `story:` and every box
  with an inside its own view; prefer rules (`children`, `neighbours`, `tag`) over lists.
- **Tags** are lowercase; a tag in a group is `group:value` with one of its values:
  - (none declared: any lowercase tag goes)
- **Decisions** get a numbered file each (`decisions/0003-short-title.yaml`). Never delete
  one: supersede it.

## Field reference

### archnm.yaml

| Field | Meaning |
|---|---|
| `name` | The design's name. |
| `version` | The file format's version. |
| `forbid` | Patterns (case-insensitive regular expressions) no text may contain: archnm check refuses them. IPs, private keys and API keys are always refused. |
| `tags` | Tag groups: tags written group:value, with the values allowed and their colours. |
| `protect` | Fields only people change (refs.sys): an agent's apply is refused, and a pull request that changes one says so. |
| `limits` | A diagram past these is too busy to read; check warns (15 boxes and 20 lines unless set). |
| `github` | The GitHub owner repo@sha:path sources point at (Acme). |

### Objects (model/*.yaml, code/**/*.yaml, libraries.yaml → objects, by id)

| Field | Meaning |
|---|---|
| `kind` * | actor: a person or role. system: a product or service as a whole. app: something that runs (a service, job, web app). store: where data rests (database, bucket, topic). component: a part inside an app. module: a package, crate, folder or source file (has a path). function: anything callable in the code (function, method, handler, job, script), inside its file module. library: a third-party package the code uses (has a package). table: a table, collection or dataset table, inside its store, with its columns listed on it (one box per table); a foreign key or a pointer to a row elsewhere is a connection to the other table that names its column. |
| `name` | What people call it. Leave out when it's the same as the id. |
| `in` | The id of the object this one lives inside (apps and stores in a system, components in an app). Leave out for top level. |
| `context` | Everything about it, in markdown: what it does and why first (a sentence or two), then whatever helps (examples, payloads and data shapes, decisions, open questions, how to build it). Not drawn; show gives it in full. |
| `tech` | Languages, frameworks or products: [Go, Cloud Run]. |
| `icon` | The logo to show when the one guessed from tech is wrong: a technology ("rust"), or "none" for no logo. |
| `path` | A module's place in its repo: repo:path (s-chan:crates/board/src/main.rs). It decides the module's file: code/<repo>/<path>.yaml for a source file, code/<repo>/<path>/_.yaml for a folder or package; its functions and their calls live there too. |
| `signature` | A function's inputs and what it returns: "(Cart, UserId) -> Order" (a name on an input is optional: "(cart: Cart)"). Quote it. The entities it names are its entities: don't list them in uses. |
| `uses` | Entities it works with that its signature doesn't name, by name: [Order, Ledger]. A name nothing defines yet becomes a TBD entity. |
| `package` | A library's package. Libraries live in libraries.yaml. |
| `columns` | A table's columns, in order. Shown in its panel and given to agents; never drawn as boxes. A foreign key is a connection to the other table with column (and to_column). |
| `status` | Leave out for live. future: decided, not built. deprecated: still there, being retired. removed: gone (kept for history; drawn only where a rule asks for status: removed). Never delete an object for being gone. |
| `external` | Run by someone else (a vendor, a customer). |
| `tags` | Lowercase labels. group:value for a tag group declared in archnm.yaml (personal-data:holds, owner:signals); the value must be one the group lists. |
| `refs` | Identifiers in other systems (sys: SYS-5, key: P4). Fields archnm.yaml protects are changed only by people. |
| `sources` | Where the facts come from, so a person or a drift job can check them: repo@ref:path[:line[-line]] (ref: a sha or a branch, on GitHub under archnm.yaml's github), repo:path for a file that isn't written yet, or an http(s) address. |
| `references` | What it points at outside the model, shown in its panel: links, images, docs, code, dependencies. One per target. |
| `notes` | Its running doc, in markdown: what's still needed, open questions, a checklist (- [ ] …). Not drawn. Comments pinned on a diagram are separate. |
| `guess` | true when it's believed but not confirmed (an agent inferred it); drawn fainter. Leave out once confirmed. |

### Connections (with their caller's objects → connections)

| Field | Meaning |
|---|---|
| `from` * | The caller's id. A connection lives in the caller's file. |
| `to` * | The callee's id. |
| `label` | What it does, as a short verb phrase ("reads orders"). |
| `description` | More detail, and its source. |
| `context` | For agents, in markdown: what travels over it (example requests and responses, payload shapes, auth, errors, retries). Not drawn; show gives it in full. |
| `tech` | Protocol or transport (HTTPS, Pub/Sub push). |
| `status` | Leave out for live; as for objects. One of: live, future, deprecated, removed. |
| `via` | An object the traffic passes through on the way (a load balancer, a gateway). Draw the connection to the real backend and name the middle here. |
| `sources` | Where the facts come from, so a person or a drift job can check them: repo@ref:path[:line[-line]] (ref: a sha or a branch, on GitHub under archnm.yaml's github), repo:path for a file that isn't written yet, or an http(s) address. |
| `guess` | true when it's believed but not confirmed (an importer matched the call by name, an agent inferred it); drawn fainter. Leave out once confirmed. |
| `column` | Between tables, a foreign key or pointer: the column on the from table that holds it (customer_id). The line is labelled with it. |
| `to_column` | The column on the to table it points at; leave out for its primary key. |
| `carries` | The entities that travel over it, by name: [PaidOrder]. A name nothing defines yet becomes a TBD entity. |
| `references` | What it points at: links, docs, code, images. One per target. |
| `notes` | Its running doc, in markdown, as an object's: what's still needed, open questions, a checklist. Not drawn. Comments pinned to its arrow are separate. |

### Diagrams (views/*.yaml)

| Field | Meaning |
|---|---|
| `name` * | The diagram's title. |
| `scope` | The object whose inside this diagram shows; leave out for a landscape. |
| `arrows` | How arrows are drawn; leave out for curved. One of: curved, elbow, straight. |
| `tidy` | Which way Tidy lays it out. Moves nothing on its own. One of: right, down. |
| `keep_tidy` | Lay it out again on its own whenever boxes or arrows come or go. Leave it out unless asked: it moves boxes people placed. |
| `boundaries` | Draw boundaries (projects, networks) as frames. |
| `color_by` | Colour boxes by a tag group from archnm.yaml (personal-data), with a legend. |
| `story` | How to read it, in a few lines of markdown: what it shows and where to start. Shown as the diagram's caption. |
| `context` | For agents, in markdown: the brief behind this view (goals, constraints, what's decided, what's still open, where the code is, what to do next). Not drawn; given in full to an agent that opens the view. |
| `fold` | groups: boxes fold into one box per group: tag (externals without one together); opening a group box opens that group's view. A view never folds the group it's about (include tag: group:x). externals: all externals into one box. none: each drawn. Left out: only externals fold by group on a landscape (no scope), none elsewhere. |
| `unfolded` | Folded groups opened on this view (Unfold here): each is drawn as a frame around its boxes that folds back. A group: tag's value, or externals for the externals without one. |
| `hide_lines` | Connections touching what these pick aren't drawn here (shared infrastructure, logging); the boxes still are. |
| `lanes` | A tag group from archnm.yaml: tidy lays its values out as columns, in the order archnm.yaml lists them, each framed. |
| `boxes` | Hand-picked: exactly these objects. Not with include/exclude. |
| `include` | Rules for what's on it; new matches appear on their own. |
| `exclude` | Rules for what to leave off. |
| `flows` | Step-by-step stories played on this diagram. |
| `links` | Docs about the diagram as a whole (a box's own docs go on the box). |

### Rules (include / exclude, in views and boundaries)

| Field | Meaning |
|---|---|
| `ids` | These objects, by id. |
| `children` | Everything directly inside this object. |
| `descendants` | Everything inside this object, at any depth. |
| `neighbours` | Everything connected to this object. |
| `tag` | Everything with this tag. |
| `kind` | Everything of this kind. One of: actor, system, app, store, component, module, function, library, table. |
| `status` | Everything with this status. One of: live, future, deprecated, removed. |
| `uses` | Whatever calls or uses something of this kind (uses: library for a dependency graph). |
| `guess` | Guesses: in hide_lines, every guessed line (a call matched by name); in include/exclude, guessed boxes. |

### Flows (views/*.yaml → flows)

| Field | Meaning |
|---|---|
| `name` * | What the flow shows ("Check out"). |
| `kind` | story (left out): told step by step with a panel. path: a route lit through the graph all at once, for following calls through code. |
| `steps` * | In order. |

### Flow steps

| Field | Meaning |
|---|---|
| `from` * | Who acts (an object id). |
| `to` * | Who it acts on; the same id as from for something done inside one box. |
| `text` | What happens in this step. |

### Links (views/*.yaml → links)

| Field | Meaning |
|---|---|
| `title` | What to call it; defaults to the address. |
| `url` * | An http or https address. |

### Boundaries (boundaries.yaml → boundaries)

| Field | Meaning |
|---|---|
| `id` * | The boundary's key. |
| `name` * | Name it by role ("prod project", "private services subnet"), never by a cloud ID or an address range. |
| `kind` * | What kind of place it is. One of: cloud, project, host, network, subnet, region, edge, trust, process, group. |
| `in` | The boundary this one sits inside. |
| `description` | What runs here and why. |
| `include` | What runs here; tags are best, so new things fall in on their own. |
| `exclude` | Exceptions. |

### Entities (model/*.yaml, code/**/*.yaml → entities, by name)

| Field | Meaning |
|---|---|
| `in` | The id of the box that defines it (Order in the orders service). Leave out when nothing owns it yet. |
| `extends` | Entities it inherits from, or (an interface) implements, by name: [Order]. |
| `context` | What it is and anything worth knowing, in markdown. |
| `fields` | Name → type: { id: uuid, items: "[OrderItem]", note: text? }. A key with ( ) is a method ("charge(amount: Money)": Receipt), which makes it an interface. A type that's another entity's name links to it. |
| `values` | An enum's values (pending, paid, cancelled), instead of fields. |

### Decisions (decisions/<id>.yaml)

| Field | Meaning |
|---|---|
| `title` * | What was decided, in a line. |
| `status` * | proposed: open. accepted: in force. rejected: considered and turned down. superseded: replaced (say by what in superseded_by). |
| `date` | When it was decided: YYYY-MM-DD. |
| `affects` | The objects it changes (ids); they show a badge linking here. |
| `superseded_by` | The decision that replaced this one (its file name, without .yaml). |
| `text` | The record, in markdown: context, the decision, consequences. |

### Tag groups (archnm.yaml → tags → <group>)

| Field | Meaning |
|---|---|
| `description` | What the group means; shown in the legend. |
| `values` * | The values allowed after the colon. |
| `colors` | value → #rrggbb, for colouring diagrams by this group. |

\* required

## Commands

```sh
archnm check [dir]          # every problem as file:line; exits 1 on any error
archnm outline [dir]        # the whole model as an outline
archnm explain <view> [dir] # which rule put each box on a diagram
archnm fmt [dir]            # rewrite files in canonical form
```
