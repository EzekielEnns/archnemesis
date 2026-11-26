// AGENTS.md: everything an agent needs to keep this architecture up to date from the files
// alone (no app, no MCP), written into every design's folder. Generated from the file
// format (spec.ts) and the design's own archnm.yaml, so it never disagrees with check. The
// MCP serves the same rules as guide {topic: "grammar"}.
import type { FConfig } from "./files.ts";
import { fieldReference } from "./spec.ts";

/** First line of a generated AGENTS.md; a file without it was written by a person and is left alone. */
export const AGENTS_MARK =
  "<!-- archnm: generated from the file format and archnm.yaml; edits here are replaced -->";

/** Reads the old name: the first line files generated before the rename start with. */
const OLD_AGENTS_MARK =
  "<!-- atlas: generated from the file format and atlas.yaml; edits here are replaced -->";

export const isGeneratedAgents = (text: string | undefined): boolean =>
  !text || text.startsWith(AGENTS_MARK) || text.startsWith(OLD_AGENTS_MARK);

export function agentsGuide(config: FConfig = {}): string {
  const forbid = config.forbid?.length
    ? config.forbid.map((p) => `  - \`${p}\``).join("\n")
    : "  - (none beyond the defaults)";
  const groups = Object.entries(config.tags ?? {});
  const tags = groups.length
    ? groups
        .map(
          ([g, t]) =>
            `  - \`${g}:\` ${t.values.map((v) => `\`${v}\``).join(", ")}${t.description ? `: ${t.description}` : ""}`,
        )
        .join("\n")
    : "  - (none declared: any lowercase tag goes)";
  const protect = config.protect?.length ? config.protect.map((p) => `\`${p}\``).join(", ") : "";
  const limits = { boxes: config.limits?.boxes ?? 15, lines: config.limits?.lines ?? 20 };
  return `${AGENTS_MARK}
# Keeping ${config.name ?? "this architecture"} up to date

These YAML files are the architecture. People see them as diagrams in Archnemesis; the files are
the truth. Edit them, run \`archnm check\` until it prints \`ok\`, and open a pull request.

With Archnemesis's MCP connected, the same work goes through seven tools: \`read\` (search first,
then one thing; \`scope\` for a brief), \`write\` (a YAML fragment in this grammar, merged by
id, checked whole, one undo), \`note\`, \`show\`, \`guide\`, \`design\` and \`index\`.

## Get these right first

1. **\`objects:\` is a map keyed by id**, not a list: \`shop-api: { kind: app, … }\`. Never
   \`- id: shop-api\`. Leave \`name\` out when it's the same as the id.
2. **Ids are slugs, and permanent** (\`refunds-worker\`). Never change or reuse one;
   rename with \`name\`. \`in\`, \`from\`, \`to\`, \`via\` and view rules name ids that exist:
   check suggests the nearest when one is a typo.
3. **Entities are keyed by their type name** (\`PaidOrder\`: a letter, then letters, digits, _), under \`entities:\` in the file of
   the box that defines them, with \`in:\` that box. Everything points at one by that name.
   A name nothing defines yet is fine: it's TBD (a warning to fill in later).
4. **A box's \`uses:\` lists entities its \`signature\` doesn't already name.** A signature's
   types are worked out from it; don't repeat them. Quote a signature: it has colons.
5. **A connection's \`carries:\`** lists the entities that travel over it, by name.
   Connections are a list, one \`{ from, to, label, … }\` per line, in the caller's file.
6. **Not sure? \`guess: true\`.** On an object or a connection you believe but haven't
   confirmed. check lists guesses; confirm and drop it later.
7. **Never delete for being gone.** \`status: removed\` (gone, kept for history),
   \`deprecated\` (being retired) or \`future\` (decided, not built); say why in \`context\`.
8. **Never write \`layout/\`.** Archnemesis places boxes itself.
9. **Comments aren't kept** (Archnemesis rewrites files canonically): put it in \`context\` or \`notes\`.
10. **Never in the files:** secrets, keys, tokens, IP addresses or ranges, customer names.
    check refuses these, and anything matching this design's own patterns:
${forbid}

## The loop

1. Read what's there first (\`archnm outline\`, or the files). Reuse objects; don't duplicate.
2. Edit the YAML. One change per pull request; say where each fact came from
   (\`sources: [repo@sha:path:line]\`).
3. \`archnm check\` names every problem as \`file:line\`, with what to write instead. A folder
   with errors is never applied. Warnings (TBD, guesses, no tech, no context) never block.

## A scope's file

\`\`\`yaml
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
\`\`\`

\`fields\` is a map of name → type; a key with \`( )\` is a method (an interface). \`values\`
makes an enum. Neither: TBD. One value works where a list goes (\`tech: Go\`), and kinds and
statuses take any case; Archnemesis writes them back in one form.

## Files

\`\`\`
archnm.yaml              the design's name and rules: forbid, tags, protect, limits, github
model/<system>.yaml     a top-level box with an inside, everything in it, and their entities
model/_top.yaml         every other top-level box (people, vendors), and homeless entities
code/<repo>/<path>.yaml a source file's module, its functions and calls, at the source's path
libraries.yaml          third-party packages the code uses
boundaries.yaml         where things run: projects, networks, regions, processes
views/<view>.yaml       one diagram: what's on it (rules or a list), its story and flows
decisions/<id>.yaml     one architecture decision: title, status, affects, text
layout/<view>.json      box positions: Archnemesis's alone
\`\`\`

A new object needs only its entry: Archnemesis puts it on every diagram whose rules pick it. Code is
the same objects one layer down (\`module\` with \`path: repo:path\`, \`function\` in its file's
module, \`library\` with \`package\`); calls are connections. Things tagged \`generated\` come from
\`archnm import\`: describe and connect them freely, but don't hand-edit their names, paths or
sources. A \`table\` lives in its store with its \`columns\`; a foreign key is a connection
between tables with \`column\` (and \`to_column\`).

## More rules

- **Lowest true level.** A connection goes between the parts that really talk (component →
  store). Traffic through a load balancer is one connection to the backend with \`via:\`.
- **Right place.** \`in:\` is what it lives inside: apps and stores in a system, components in
  an app. Group a crowd under a parent rather than listing 20 siblings.${
    protect
      ? `
- **Protected: ${protect}.** Only people change these; if one looks wrong, say so in the pull request.`
      : ""
  }
- **Diagrams stay readable:** at most ${limits.boxes} boxes and ${limits.lines} lines. Fold externals, \`hide_lines\`
  for plumbing, a tighter \`scope\`, or split it. Give every view a \`story:\` and every box
  with an inside its own view; prefer rules (\`children\`, \`neighbours\`, \`tag\`) over lists.
- **Tags** are lowercase; a tag in a group is \`group:value\` with one of its values:
${tags}
- **Decisions** get a numbered file each (\`decisions/0003-short-title.yaml\`). Never delete
  one: supersede it.

## Field reference

${fieldReference()}

## Commands

\`\`\`sh
archnm check [dir]          # every problem as file:line; exits 1 on any error
archnm outline [dir]        # the whole model as an outline
archnm explain <view> [dir] # which rule put each box on a diagram
archnm fmt [dir]            # rewrite files in canonical form
\`\`\`
`;
}
