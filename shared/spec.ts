// The file format, once. Everything about what may be written in an Archnemesis folder comes from
// here: the JSON schemas in schema/ (`archnm schema` writes them; a test keeps them equal),
// the fields `archnm check` accepts, and the reference in the AGENTS.md Archnemesis writes into
// every folder. Change a field here and all three follow.
import {
  ARROW_STYLES,
  BOUNDARY_KINDS,
  DECISION_STATUSES,
  ECOSYSTEMS,
  FLOW_KINDS,
  FOLD_MODES,
  LAYOUT_DIRECTIONS,
  OBJECT_KINDS,
  STATUSES,
} from "./model.ts";

export type Schema = Record<string, unknown>;

const SLUG = "^[a-zA-Z0-9][a-zA-Z0-9._-]*$";
const str = (description: string, extra: Schema = {}): Schema => ({
  type: "string",
  description,
  ...extra,
});
const list = (items: Schema, description: string): Schema => ({
  type: "array",
  items,
  description,
});
const oneOf = (values: readonly string[], description: string): Schema => ({
  enum: [...values],
  description,
});
const bool = (description: string): Schema => ({ type: "boolean", description });
/** A list of words, or one word on its own (written back as a list). */
const words = (description: string): Schema => ({
  anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
  description,
});
/** An object's id: letters, digits, - . _ (shared/model.ts SAFE_KEY). */
const ID = "^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$";
/** An entity's name, which is its id: a type name as code writes it (shared/model.ts TYPE_NAME). */
const TYPE_NAME = "^[A-Za-z][A-Za-z0-9_]{0,99}$";

const SOURCES = list(
  { type: "string" },
  "Where the facts come from, so a person or a drift job can check them: repo@ref:path[:line[-line]] (ref: a sha or a branch, on GitHub under archnm.yaml's github), repo:path for a file that isn't written yet, or an http(s) address.",
);
const STATUS_TEXT =
  "Leave out for live. future: decided, not built. deprecated: still there, being retired. removed: gone (kept for history; drawn only where a rule asks for status: removed). Never delete an object for being gone.";

const RULE: Schema = {
  type: "object",
  description: "One rule: exactly one of these.",
  minProperties: 1,
  maxProperties: 1,
  additionalProperties: false,
  properties: {
    ids: list({ type: "string" }, "These objects, by id."),
    children: str("Everything directly inside this object."),
    descendants: str("Everything inside this object, at any depth."),
    neighbours: str("Everything connected to this object."),
    tag: str("Everything with this tag."),
    kind: oneOf(OBJECT_KINDS, "Everything of this kind."),
    status: oneOf(STATUSES, "Everything with this status."),
    uses: oneOf(
      OBJECT_KINDS,
      "Whatever calls or uses something of this kind (uses: library for a dependency graph).",
    ),
    guess: {
      type: "boolean",
      enum: [true],
      description:
        "Guesses: in hide_lines, every guessed line (a call matched by name); in include/exclude, guessed boxes.",
    },
  },
};

/** One reference: what a box or a connection points at. */
const REFERENCE_ITEM: Schema = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  maxProperties: 2,
  description: "Exactly one of link, image, doc, code, dependency, and an optional title.",
  properties: {
    link: str("An http or https address (a runbook, an RFC, a dashboard).", { format: "uri" }),
    image: str("A picture of it: an http(s) address, or a file in the design (assets/erd.png)."),
    doc: str("A markdown file in the design (docs/auth.md)."),
    code: str("Where it is in the code: repo:path, repo:path#L12 or repo:path#function."),
    dependency: str(
      "A library it uses: the library object's id. Every node using that library is found from it.",
    ),
    title: str("What to call it; defaults to the address or path."),
  },
};

export const OBJECT: Schema = {
  type: "object",
  additionalProperties: false,
  required: ["kind"],
  description:
    "Keyed by its id: a slug (shop-api; letters, digits, - . _) given once. Never change or reuse it; rename with name.",
  properties: {
    kind: oneOf(
      OBJECT_KINDS,
      "actor: a person or role. system: a product or service as a whole. app: something that runs (a service, job, web app). store: where data rests (database, bucket, topic). component: a part inside an app. module: a package, crate, folder or source file (has a path). function: anything callable in the code (function, method, handler, job, script), inside its file module. library: a third-party package the code uses (has a package). table: a table, collection or dataset table, inside its store, with its columns listed on it (one box per table); a foreign key or a pointer to a row elsewhere is a connection to the other table that names its column.",
    ),
    name: str("What people call it. Leave out when it's the same as the id.", { minLength: 1 }),
    in: str(
      "The id of the object this one lives inside (apps and stores in a system, components in an app). Leave out for top level.",
    ),
    context: str(
      "Everything about it, in markdown: what it does and why first (a sentence or two), then whatever helps (examples, payloads and data shapes, decisions, open questions, how to build it). Not drawn; show gives it in full.",
    ),
    tech: words("Languages, frameworks or products: [Go, Cloud Run]."),
    icon: str(
      'The logo to show when the one guessed from tech is wrong: a technology ("rust"), or "none" for no logo.',
    ),
    path: str(
      "A module's place in its repo: repo:path (s-chan:crates/board/src/main.rs). It decides the module's file: code/<repo>/<path>.yaml for a source file, code/<repo>/<path>/_.yaml for a folder or package; its functions and their calls live there too.",
      { pattern: "^[A-Za-z0-9._-]+:[^\\s:]+$" },
    ),
    signature: str(
      'A function\'s inputs and what it returns: "(Cart, UserId) -> Order" (a name on an input is optional: "(cart: Cart)"). Quote it. The entities it names are its entities: don\'t list them in uses.',
    ),
    uses: words(
      "Entities it works with that its signature doesn't name, by name: [Order, Ledger]. A name nothing defines yet becomes a TBD entity.",
    ),
    package: {
      type: "object",
      additionalProperties: false,
      required: ["ecosystem", "name"],
      description: "A library's package. Libraries live in libraries.yaml.",
      properties: {
        ecosystem: oneOf(ECOSYSTEMS, "The registry it comes from."),
        name: str("Its name there (tokio, @tanstack/react-query)."),
        version: str("The version in use."),
      },
    },
    columns: list(
      {
        type: "object",
        additionalProperties: false,
        required: ["name"],
        properties: {
          name: str("The column's name.", { minLength: 1 }),
          type: str("Its type as the database says it (uuid, text, timestamptz, vector(512))."),
          pk: { type: "boolean", description: "Part of the primary key." },
          unique: { type: "boolean", description: "Unique." },
          nullable: { type: "boolean", description: "May be empty." },
          personal: {
            type: "boolean",
            description:
              "Holds data about a person: a key from it across regions is a residency warning.",
          },
          description: str("A sentence about it, when the name doesn't say."),
        },
      },
      "A table's columns, in order. Shown in its panel and given to agents; never drawn as boxes. A foreign key is a connection to the other table with column (and to_column).",
    ),
    status: oneOf(STATUSES, STATUS_TEXT),
    external: { type: "boolean", description: "Run by someone else (a vendor, a customer)." },
    tags: list(
      { type: "string" },
      "Lowercase labels. group:value for a tag group declared in archnm.yaml (personal-data:holds, owner:signals); the value must be one the group lists.",
    ),
    refs: {
      type: "object",
      additionalProperties: { type: "string" },
      propertyNames: { pattern: "^[a-z][a-z0-9_-]{0,31}$" },
      description:
        "Identifiers in other systems (sys: SYS-5, key: P4). Fields archnm.yaml protects are changed only by people.",
    },
    sources: SOURCES,
    references: list(
      REFERENCE_ITEM,
      "What it points at outside the model, shown in its panel: links, images, docs, code, dependencies. One per target.",
    ),
    notes: str(
      "Its running doc, in markdown: what's still needed, open questions, a checklist (- [ ] …). Not drawn. Comments pinned on a diagram are separate.",
    ),
    guess: bool(
      "true when it's believed but not confirmed (an agent inferred it); drawn fainter. Leave out once confirmed.",
    ),
  },
};

export const CONNECTION: Schema = {
  type: "object",
  additionalProperties: false,
  required: ["from", "to"],
  properties: {
    from: str("The caller's id. A connection lives in the caller's file."),
    to: str("The callee's id."),
    label: str('What it does, as a short verb phrase ("reads orders").'),
    description: str("More detail, and its source."),
    context: str(
      "For agents, in markdown: what travels over it (example requests and responses, payload shapes, auth, errors, retries). Not drawn; show gives it in full.",
    ),
    tech: str("Protocol or transport (HTTPS, Pub/Sub push)."),
    status: oneOf(STATUSES, "Leave out for live; as for objects."),
    via: str(
      "An object the traffic passes through on the way (a load balancer, a gateway). Draw the connection to the real backend and name the middle here.",
    ),
    sources: SOURCES,
    guess: bool(
      "true when it's believed but not confirmed (an importer matched the call by name, an agent inferred it); drawn fainter. Leave out once confirmed.",
    ),
    column: str(
      "Between tables, a foreign key or pointer: the column on the from table that holds it (customer_id). The line is labelled with it.",
    ),
    to_column: str("The column on the to table it points at; leave out for its primary key."),
    carries: words(
      "The entities that travel over it, by name: [PaidOrder]. A name nothing defines yet becomes a TBD entity.",
    ),
    references: list(
      REFERENCE_ITEM,
      "What it points at: links, docs, code, images. One per target.",
    ),
    notes: str(
      "Its running doc, in markdown, as an object's: what's still needed, open questions, a checklist. Not drawn. Comments pinned to its arrow are separate.",
    ),
  },
};

const ENTITY: Schema = {
  type: "object",
  additionalProperties: false,
  description:
    "Keyed by its name as code writes it (PaidOrder): that name is its id, and what everything else uses to point at it.",
  properties: {
    in: str(
      "The id of the box that defines it (Order in the orders service). Leave out when nothing owns it yet.",
    ),
    extends: words("Entities it inherits from, or (an interface) implements, by name: [Order]."),
    context: str("What it is and anything worth knowing, in markdown."),
    fields: {
      anyOf: [
        { type: "object", additionalProperties: { type: ["string", "null"] } },
        { type: "array", items: { type: "string" } },
      ],
      description:
        'Name → type: { id: uuid, items: "[OrderItem]", note: text? }. A key with ( ) is a method ("charge(amount: Money)": Receipt), which makes it an interface. A type that\'s another entity\'s name links to it.',
    },
    values: list(
      { type: "string" },
      "An enum's values (pending, paid, cancelled), instead of fields.",
    ),
  },
};

const MODEL_FILE: Schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "archnm/model.schema.json",
  title: "Archnemesis model file (model/*.yaml, code/**/*.yaml, libraries.yaml)",
  type: "object",
  additionalProperties: false,
  properties: {
    objects: {
      type: "object",
      additionalProperties: OBJECT,
      propertyNames: { pattern: ID },
      description:
        "The objects in this file, by id: a top-level object and everything inside it, or (_top.yaml) the top-level objects with nothing inside.",
    },
    entities: {
      type: "object",
      additionalProperties: ENTITY,
      propertyNames: { pattern: TYPE_NAME },
      description:
        "The entities the boxes in this file define (DTOs, interfaces, enums), by name. With no fields or values, it's TBD: a name to fill in later.",
    },
    connections: list(CONNECTION, "Connections whose caller is in this file, one line each."),
  },
};

const STEP: Schema = {
  type: "object",
  additionalProperties: false,
  required: ["from", "to"],
  properties: {
    from: str("Who acts (an object id)."),
    to: str("Who it acts on; the same id as from for something done inside one box."),
    text: str("What happens in this step."),
  },
};

const FLOW: Schema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "steps"],
  properties: {
    name: str('What the flow shows ("Check out").'),
    kind: oneOf(
      FLOW_KINDS,
      "story (left out): told step by step with a panel. path: a route lit through the graph all at once, for following calls through code.",
    ),
    steps: list(STEP, "In order."),
  },
};

const LINK: Schema = {
  type: "object",
  additionalProperties: false,
  required: ["url"],
  properties: {
    title: str("What to call it; defaults to the address."),
    url: str("An http or https address.", { format: "uri" }),
  },
};

const VIEW_FILE: Schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "archnm/view.schema.json",
  title: "Archnemesis view file (views/*.yaml): one diagram",
  type: "object",
  additionalProperties: false,
  required: ["name"],
  not: { required: ["boxes", "include"] },
  properties: {
    name: str("The diagram's title."),
    scope: str("The object whose inside this diagram shows; leave out for a landscape."),
    arrows: oneOf(ARROW_STYLES, "How arrows are drawn; leave out for curved."),
    tidy: oneOf(LAYOUT_DIRECTIONS, "Which way Tidy lays it out. Moves nothing on its own."),
    keep_tidy: {
      type: "boolean",
      description:
        "Lay it out again on its own whenever boxes or arrows come or go. Leave it out unless asked: it moves boxes people placed.",
    },
    boundaries: { type: "boolean", description: "Draw boundaries (projects, networks) as frames." },
    color_by: str("Colour boxes by a tag group from archnm.yaml (personal-data), with a legend."),
    story: str(
      "How to read it, in a few lines of markdown: what it shows and where to start. Shown as the diagram's caption.",
    ),
    context: str(
      "For agents, in markdown: the brief behind this view (goals, constraints, what's decided, what's still open, where the code is, what to do next). Not drawn; given in full to an agent that opens the view.",
    ),
    fold: oneOf(
      FOLD_MODES,
      "groups: boxes fold into one box per group: tag (externals without one together); opening a group box opens that group's view. A view never folds the group it's about (include tag: group:x). externals: all externals into one box. none: each drawn. Left out: only externals fold by group on a landscape (no scope), none elsewhere.",
    ),
    unfolded: list(
      { type: "string" },
      "Folded groups opened on this view (Unfold here): each is drawn as a frame around its boxes that folds back. A group: tag's value, or externals for the externals without one.",
    ),
    hide_lines: list(
      RULE,
      "Connections touching what these pick aren't drawn here (shared infrastructure, logging); the boxes still are.",
    ),
    lanes: str(
      "A tag group from archnm.yaml: tidy lays its values out as columns, in the order archnm.yaml lists them, each framed.",
    ),
    boxes: list(
      { type: "string" },
      "Hand-picked: exactly these objects. Not with include/exclude.",
    ),
    include: list(RULE, "Rules for what's on it; new matches appear on their own."),
    exclude: list(RULE, "Rules for what to leave off."),
    flows: list(FLOW, "Step-by-step stories played on this diagram."),
    links: list(LINK, "Docs about the diagram as a whole (a box's own docs go on the box)."),
  },
};

const BOUNDARY: Schema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "name", "kind"],
  properties: {
    id: str("The boundary's key.", { pattern: SLUG }),
    name: str(
      'Name it by role ("prod project", "private services subnet"), never by a cloud ID or an address range.',
    ),
    kind: oneOf(BOUNDARY_KINDS, "What kind of place it is."),
    in: str("The boundary this one sits inside."),
    description: str("What runs here and why."),
    include: list(RULE, "What runs here; tags are best, so new things fall in on their own."),
    exclude: list(RULE, "Exceptions."),
  },
};

const BOUNDARIES_FILE: Schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "archnm/boundaries.schema.json",
  title: "Archnemesis boundaries file (boundaries.yaml): where things run",
  type: "object",
  additionalProperties: false,
  properties: { boundaries: list(BOUNDARY, "Parents before the boundaries inside them.") },
};

const TAG_GROUP: Schema = {
  type: "object",
  additionalProperties: false,
  required: ["values"],
  properties: {
    description: str("What the group means; shown in the legend."),
    values: list({ type: "string" }, "The values allowed after the colon."),
    colors: {
      type: "object",
      additionalProperties: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
      description: "value → #rrggbb, for colouring diagrams by this group.",
    },
  },
};

const DECISION_FILE: Schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "archnm/decision.schema.json",
  title: "Archnemesis decision (decisions/<id>.yaml): one architecture decision record",
  type: "object",
  additionalProperties: false,
  required: ["title", "status"],
  properties: {
    title: str("What was decided, in a line."),
    status: oneOf(
      DECISION_STATUSES,
      "proposed: open. accepted: in force. rejected: considered and turned down. superseded: replaced (say by what in superseded_by).",
    ),
    date: str("When it was decided: YYYY-MM-DD.", { pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
    affects: list(
      { type: "string" },
      "The objects it changes (ids); they show a badge linking here.",
    ),
    superseded_by: str("The decision that replaced this one (its file name, without .yaml)."),
    text: str("The record, in markdown: context, the decision, consequences."),
  },
};

const CONFIG_FILE: Schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "archnm/archnm.schema.json",
  title: "archnm.yaml: the design's name and rules",
  type: "object",
  additionalProperties: false,
  properties: {
    name: str("The design's name."),
    version: { const: 2, description: "The file format's version." },
    forbid: list(
      { type: "string" },
      "Patterns (case-insensitive regular expressions) no text may contain: archnm check refuses them. IPs, private keys and API keys are always refused.",
    ),
    tags: {
      type: "object",
      additionalProperties: TAG_GROUP,
      propertyNames: { pattern: "^[a-z][a-z0-9-]{0,31}$" },
      description:
        "Tag groups: tags written group:value, with the values allowed and their colours.",
    },
    protect: list(
      { type: "string", pattern: "^(refs\\.[a-z][a-z0-9_-]{0,31}|name|in|status|kind)$" },
      "Fields only people change (refs.sys): an agent's apply is refused, and a pull request that changes one says so.",
    ),
    limits: {
      type: "object",
      additionalProperties: false,
      properties: {
        boxes: { type: "integer", minimum: 1, maximum: 500 },
        lines: { type: "integer", minimum: 1, maximum: 500 },
      },
      description:
        "A diagram past these is too busy to read; check warns (15 boxes and 20 lines unless set).",
    },
    github: str("The GitHub owner repo@sha:path sources point at (Acme)."),
  },
};

/** Every schema, by the file it's written to under schema/. */
export const SCHEMAS: Record<string, Schema> = {
  "archnm.schema.json": CONFIG_FILE,
  "model.schema.json": MODEL_FILE,
  "view.schema.json": VIEW_FILE,
  "boundaries.schema.json": BOUNDARIES_FILE,
  "decision.schema.json": DECISION_FILE,
};

/** The fields a schema allows, for check's "unknown field" errors. */
const fieldsOf = (s: Schema): string[] => Object.keys((s.properties ?? {}) as Schema);

export const FIELDS = {
  config: fieldsOf(CONFIG_FILE),
  model: fieldsOf(MODEL_FILE),
  object: fieldsOf(OBJECT),
  connection: fieldsOf(CONNECTION),
  view: fieldsOf(VIEW_FILE),
  boundaries: fieldsOf(BOUNDARIES_FILE),
  boundary: fieldsOf(BOUNDARY),
  entity: fieldsOf(ENTITY),
  link: fieldsOf(LINK),
  tagGroup: fieldsOf(TAG_GROUP),
  decision: fieldsOf(DECISION_FILE),
};

/** A field reference, as markdown, for AGENTS.md and the guide. */
export function fieldReference(): string {
  const table = (title: string, s: Schema) => {
    const props = (s.properties ?? {}) as Record<string, Schema>;
    const req = new Set((s.required as string[] | undefined) ?? []);
    const rows = Object.entries(props).map(([k, p]) => {
      const values = Array.isArray(p.enum) ? ` One of: ${(p.enum as string[]).join(", ")}.` : "";
      const what = String(p.description ?? "").replace(/\|/g, "\\|");
      return `| \`${k}\`${req.has(k) ? " *" : ""} | ${what}${p.enum && !what.includes(":") ? values : ""} |`;
    });
    return `### ${title}\n\n| Field | Meaning |\n|---|---|\n${rows.join("\n")}`;
  };
  return [
    table("archnm.yaml", CONFIG_FILE),
    table("Objects (model/*.yaml, code/**/*.yaml, libraries.yaml → objects, by id)", OBJECT),
    table("Connections (with their caller's objects → connections)", CONNECTION),
    table("Diagrams (views/*.yaml)", VIEW_FILE),
    table("Rules (include / exclude, in views and boundaries)", RULE),
    table("Flows (views/*.yaml → flows)", FLOW),
    table("Flow steps", STEP),
    table("Links (views/*.yaml → links)", LINK),
    table("Boundaries (boundaries.yaml → boundaries)", BOUNDARY),
    table("Entities (model/*.yaml, code/**/*.yaml → entities, by name)", ENTITY),
    table("Decisions (decisions/<id>.yaml)", DECISION_FILE),
    table("Tag groups (archnm.yaml → tags → <group>)", TAG_GROUP),
    "\\* required",
  ].join("\n\n");
}
