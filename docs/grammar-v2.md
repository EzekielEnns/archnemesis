# Grammar v2

The file format, rewritten for agents that write it in parallel, one scope each, and for people
who review it. Nothing old is kept: v1 files aren't read. Designs already on a server are rewritten in v2
the next time they're written (the live doc is the source of truth; see "Moving over").

## The idea

Strict about the graph, free about the prose. What tools reason over (ids, kinds, `in`, connection
ends, entity names, fields) is checked. What people and agents explain in (`context`, notes,
descriptions) is free markdown, never checked. Loose in, tidy out: the reader takes the natural
forms an agent might write, and the writer puts back one canonical form, so git only sees that.

Unknowns never block. An entity nobody has defined is a TBD entity; a guess is marked `guess: true`;
a design not built yet is `status: planned`. `check` lists those as warnings for a later pass.

## Files

- `archnm.yaml`: as now.
- `model/<scope>.yaml`: a top-level box and everything inside it (as now). The entities defined in a
  box live in the file that box is in, so one agent owning a scope owns its entities too.
- `model/_top.yaml`: top-level boxes with nothing inside them, and entities with no home (was
  `model/landscape.yaml`, which wasn't about the landscape view).
- `code/**/*.yaml`: the code layer, same grammar.
- `entities.yaml`: gone (its entities move into the files above).
- `views/`, `boundaries.yaml`, `decisions/`, notes: as now, apart from references (below).
- `layout/<view>.json`: named fields (below).

## A scope's file

```yaml
# model/payments.yaml
objects:
  payments:
    kind: system
    name: Payments
    tech: [Stripe]
    external: true
    context: |
      Charges cards through Stripe. Retries twice, then marks the order unpaid.
  charge:
    kind: function
    in: payments
    signature: "(order: Order, card: CardToken) -> Result<PaidOrder, ChargeError>"
    uses: [Ledger] # entities it works with that its signature doesn't name
    references:
      - code: payments:src/charge.rs#charge
      - link: https://stripe.com/docs/api/charges

entities:
  PaidOrder:
    in: payments # the box that defines it
    extends: [Order]
    fields: { charge_id: text, paid_at: timestamp }
  ChargeError:
    in: charge
    values: [declined, expired, network]
  Ledger:
    in: payments
    fields:
      entries: "[LedgerEntry]"
      "balance(&self)": Money # a method: a key with ( )

connections:
  - { from: pizza-rocket, to: payments, label: charges the card, tech: HTTPS, carries: [PaidOrder] }
  - { from: charge, to: stripe-api, label: creates a charge, tech: HTTPS, guess: true }
```

## Rules

**Objects** are a map keyed by id (a duplicate id is a parse error). Ids are slugs
(letters, digits, `-`, `.`, `_`) and permanent. `name` is left out when it's the same as the id. `in` is the
parent's id. Other fields as in `shared/spec.ts`.

**Entities** are a map keyed by their type name (`PaidOrder`); that name is their id, and it's
what every reference uses: `extends`, `uses`, `carries`, field types, signatures. Renaming one
renames it everywhere (Archnemesis does that). `in` is the box that defines it (left out: no home yet).
`fields` is a map name → type; a key `name(…)` (no space before the bracket) is a method. `values` makes an enum. Neither: TBD.

**References** on a box:

- `uses: [Entity, …]`: entities it works with. What its signature names is worked out from the
  signature and not written.
- `references:` for everything else (code, link, doc, image, dependency), as now, without `entity:`.

**Connections** are a list, one line each when it fits (flow style), with `carries: [Entity, …]`
for what travels over them. A connection's key is `from>to` (+ label when two share ends).

**`guess: true`** replaces `confidence: name`: an object or connection someone (an importer, an
agent) believes but hasn't confirmed. Drawn fainter, listed by `check` and `curate`.

**Layout** (`layout/<view>.json`), one box per line, keys sorted:

```json
{
  "bake": { "x": 520, "y": 392, "parts": [130, 224] },
  "oven-db": { "x": 0, "y": 320, "w": 240, "h": 96 },
  "@arrows": { "pizza-rocket>payments": { "parts": [373, 87] } }
}
```

`w`/`h` only when not the default size for that kind. Agents never read or write layout.

## Reading: loose in

The reader accepts, and the writer normalises:

- a single value where a list goes (`carries: PaidOrder`, `tech: Stripe`), and a comma string for
  `tech` (`tech: Rust, Axum`);
- `kind`/`status` in any case;
- field types written as `"name type"` strings in a list (`fields: [id uuid, total Money]`);
- keys in any order.

## Parsing: strict where it matters

- YAML 1.2 core, no anchors/aliases (`&`, `*`, `<<`), no tags (`!x`), no duplicate keys: each is
  an error that says what to write instead.
- Scalars are typed by the schema, not by YAML: `no`, `1.10`, `null` in a string field stay
  strings.
- Comments aren't kept (files are rewritten canonically): `check` warns when a file has some, and
  says to put it in `context` or a note.

## Checking

| Level   | What                                                        | Blocks?                                                  |
| ------- | ----------------------------------------------------------- | -------------------------------------------------------- |
| Parse   | the strict subset above                                     | error                                                    |
| Shape   | each field against the schema                               | error: where, and what's allowed                         |
| Graph   | ids, `in`, connection ends, `extends` resolve               | error, with the nearest ids ("did you mean `payments`?") |
| Quality | TBD entities, guesses, no tech, no context, unused entities | warning                                                  |

All problems at once, each `file:line`. An entity name that's unknown everywhere (in `uses`,
`carries`, a field or a signature) makes a TBD entity rather than an error, unless it's within a
typo of an existing one: then it's an error with the suggestion. Same for object ids in
connections: close to a real id is an error with the suggestion; otherwise an error naming the
file that should define it.

## Schema

`shared/spec.ts` stays the one source: the JSON Schema (`schema/`), the AGENTS.md field
reference and the checker all come from it. `archnm init` (and the written folder) gets a
`.vscode/settings.json`-style schema mapping so editors complete and check the files.

## Moving over

No compatibility code. The server's live doc (Yjs/sqlite) is the source of truth for designs that
don't follow git, so they're simply written out in v2. Designs that follow git get one commit
rewriting their files (the fork that does this documents how). The format version in
`archnm.yaml` goes to 2; a folder with version 1 is refused with a one-line message saying to
convert it with `archnm convert` (a one-off script, deleted later).

## Decisions while building

Where the spec was silent or ambiguous, the simplest reading, as built:

- **One id rule for the files and the app** (`SAFE_KEY` in `shared/model.ts`):
  `[A-Za-z0-9][A-Za-z0-9._-]{0,99}`. Whatever the app accepts, the files accept: live designs
  have uppercase ids, and the writer keeps them as they are. Spaces and other characters are
  an error that suggests the slug.
- **Entity names** are type names (`TYPE_NAME`): `[A-Za-z][A-Za-z0-9_]{0,99}`, checked where
  entities are made and renamed (the card, `makeEntity`, the live document) as well as read.
  An entity in a live design named before that ("Paid Order", "order-status") is read as a
  type name (PaidOrder, OrderStatus), the words PascalCased, rather than refused.
- **Entities and objects are named apart.** An object id never removes an entity: `remove`
  names objects, views, boundaries and decisions. Removing a box (in the app, or `write`'s
  `remove`, or a `replace` that leaves it out) keeps the entities it defined, with no home.
- **A new entity's id is its name**, unless an entity already has that id (one read as
  `Order` and renamed `Purchase` in the app keeps the id `Order`): then `Order_2`. Entities
  are matched by name, never by id.
- **Strict YAML**: no directives (`%YAML`, `%TAG`), no tags at all (`!!str`, `!!binary`), no
  anchors or aliases. A duplicate key is an error naming the key and where
  (`` `kind` appears twice in hungry-human; keep one ``).
- **Text fields are text**: a list or a map where text goes (`name: [a, b]`, `in: [shop]`) is
  an error, not text made of it. `True`, `FALSE` and the like keep their source text in a
  text field; flags take `true`/`false` in any case.
- **One mistake, one error**: an object that doesn't read (a kind that isn't one, not a map)
  is still there for what points at it, so `in:`, connections and views that name it don't
  each report it missing. Errors point at the field's own line.
- **Prose is trimmed** (context, notes, a connection's description): leading and trailing
  space isn't kept, and multi-line text is a `|` block. Reading what was written changes
  nothing, whatever the live text had around it.
- **What a signature names stays derived**: whether a box's references include the entities
  its signature names isn't written, so the same file read against a box that has them or
  doesn't is no change.
- **Signatures and field types link, but don't make TBD entities.** Only `uses`, `carries`
  and `extends` do. A code signature names many types that are the language's or a library's
  (`Request`, `Router`), and turning each into a TBD entity on read would flood a design. A
  signature's type that _is_ an entity links to it. A TBD entity made in the app by typing a
  signature is written as `Name: {}` in `_top.yaml`.
- **A homeless TBD entity that a `uses`, `carries` or `extends` names isn't written**: reading
  makes it again from that name. One with a home, a context, or a name a typo away from
  another is written.
- **"Within a typo"** is an edit distance of 1 for names of 4 letters or fewer and 2 for
  longer, case ignored. The same measure suggests ids, fields, kinds and statuses.
- **References are a set.** The file can't keep the order of the ones it doesn't write (what
  a signature names), so the same references in another order are no change.
- **An agent's file owns its entities**, as it owns its connections: overlaying a written
  file (or `replace: true`) replaces each entity by name, and drops the base's entities
  defined in an object the file writes when the file leaves them out.
- **Exported views** (`files` with `view`, and copy) carry the entities their boxes use and
  define, so the names they point at are defined; nothing is ever written as a raw id.
- **Connections** with the same ends and label twice are an error (one line drawn twice).
- **`tech`** is a list on objects (`[Go, Cloud Run]`; split on commas outside brackets) and a
  string on connections (it's one protocol). Both read a string or a list.
- **Fields** are written as a flow map (`{ id: uuid }`) while there are four or fewer short
  ones, else a block. A method's key is `name(params)` and its value the return type
  (`"charge(amount: Money)": Receipt`); the model still keeps one line per field
  (`charge(amount: Money) -> Receipt`). An entity with two fields of one name keeps its list
  of lines.
- **Connections** are one line when they fit in 150 characters and have no multi-line text;
  otherwise block style. Flow collections are written unpadded (`{from: a, to: b}`); the
  reader takes either.
- **Order within an object** is fixed: kind, name, in, context, tech, icon, path, package,
  signature, columns, status, external, tags, refs, sources, uses, references, notes, guess.
  Link references come before the others.
- **Scalars**: numbers in YAML keep their source text, and `null`, `Null` and `NULL` read as
  that text; `~` and an empty value are still empty. Booleans are `true`/`false` only (YAML
  1.2), so `external: yes` is an error. `version` and `limits` read numbers from that text.
- **Comments**: the comment block a file opens with is its heading and isn't warned about;
  any other comment gets one warning per file, at its first line.
- **Quality warnings**: `no tech` for apps and stores; `no context` for systems, apps, stores
  and components (neither for externals or removed things); guesses are counted once per file
  rather than one warning each, since an import makes many.
- **`status: planned`** in "The idea" is the existing `future`.
- **v1's forms are errors that say what to write**, not read silently: an `objects` list,
  `entities.yaml`, `model/landscape.yaml`, layout arrays, `description`, object `links`, and a
  view link's `on:` (put it on the box's references).
- **`archnm convert`** reshapes v1 files into v2, reads them as any folder is read, and writes
  them out canonically: `description` and `context` join into `context`, links become link
  references, entity references become `uses`/`carries`, `confidence: name` becomes
  `guess: true`, and a view link pinned to a box moves onto the box.
- **Not built**: the `.vscode/settings.json` schema mapping (the schemas are written to
  `schema/` as before), and connections keyed by `from>to` in the files (they're matched by
  ends and label, as before).
