// How to use the app, for an agent teaching someone (MCP `guide`). Keep it true to the UI:
// when a control, key or label changes, change it here too (src/ui/Shortcuts.tsx has the keys).

export const GUIDE_TOPICS = [
  "start",
  "how",
  "ask",
  "explore",
  "boxes",
  "arrows",
  "diagrams",
  "flows",
  "notes",
  "branches",
  "agents",
  "keys",
] as const;
type GuideTopic = (typeof GUIDE_TOPICS)[number];

const TEXT: Record<GuideTopic, string> = {
  start: `Archnemesis in one minute
- A design is one architecture. The menu at the top left switches designs or starts one.
- Boxes are things (actor, system, app, store, component); arrows are how they talk. Every box
  lives in the model once and can be on many diagrams.
- The toolbar (top middle): Select (1), place a box (2 actor, 3 system, 4 app, 5 store,
  6 component), Connect (C), Note (N), Link (L), Find (⌘K).
- Click a box to edit it in the panel on the right. ↵ (or right-click → Open inside) opens
  what's inside it.
- Everyone sees everyone's edits live; their cursors and dots are at the top right.
- ⌘K finds anything and runs any command. ? shows every key. Right-click anything for more.
- It's more than a drawing: click a box and its panel answers what depends on it, what's
  off this diagram, who changes its code, and why it is the way it is (decisions).
- Or just ask the agent: "how does a verification get from invite to verdict?", "what
  breaks if AWS goes down?", "walk me through app-service".
Next: guide how (git, YAML, what's saved where), ask (what to ask), explore (finding your way).`,

  how: `How Archnemesis works (what's saved where)
- An architecture (a design) is plain files: YAML for the model and the views, JSON for where
  boxes sit. A design that follows git lives in a folder of a repo; "Where" below says which.
    archnm.yaml        the design's name, tag groups, settings
    model/*.yaml      the boxes, one file per top-level system, with their connections
    views/*.yaml      each diagram: its rules or picks, arrow style, flows, links
    layout/*.json     positions and hand-bent arrows; only Archnemesis writes these
    decisions/*.yaml  architecture decisions (ADRs), numbered
    AGENTS.md         how an agent should edit the files by hand
- The app and the files are the same thing. Edits in the browser (or by an agent through
  this MCP) are live for everyone at once, and Archnemesis writes them back to the files. A change
  to the files in git comes back into the app as an ordinary edit.
- main is read-only in the app: it mirrors the repo's branch. Your first edit starts a fork
  (yours, named for you and the day), saved to its own branch (archnm/<design>/<fork>). When
  it's ready, the branch menu opens a pull request; review and merge happen on GitHub, and
  then everyone's back on main. Nothing reaches main without a merge.
- Boxes can name their code: sources like app-service@main:src/app/clients (repo@ref:path).
  That's what "Who's touched it" reads, and what an agent opens to check the map is right.
- Notes (comment threads) are kept in Archnemesis, not in the files. Links and decisions are in
  the files.
- History: each change in the app is one line in the design's history (the agent's too).
  Commits on main are the versions Look back shows.
- Checking by hand: \`archnm check\` validates the folder (no secrets, IP addresses or customer
  names; every reference resolves); \`archnm fmt\` writes it in the canonical form.
- It doesn't run your services or read your cloud: the map is what people and agents put in
  it, kept honest by sources and review.`,

  ask: `Things to ask the agent (try them on your own design)
Understand it
- "Show me around" / "walk me through <a box>": a guided tour. Your screen glides from stop
  to stop with a caption; Next and Back move on, and you can ask questions on the way.
- "How does <a request> get from <A> to <B>?": the path through the boxes and arrows, and
  whether a flow already tells that story (it can play it on your screen).
- "What depends on <a box>?" / "what does it depend on?": everything upstream or downstream,
  however many hops, including things not drawn on this diagram.
- "Who works on <a box>?": the people behind the code its sources point at, from git, and
  how much of it was written with an agent.
- "Why is <a box> like this?": its decisions (with their RFC links), notes and links.
- "What changed this week?" / "who changed <a box>?": the edit history. To see the design
  as it was at an earlier commit, use Look back in the branch menu.
Change it
- "Add <a service> that reads from <a store>": boxes and arrows in one undoable step.
- "Make a flow for <a story>": numbered steps you can play with ← →.
- "Clean up this diagram": tidy, straighten arrows, reset joints; it renders and checks.
- "We decided <X>, here's the RFC": recorded as a decision on the boxes it changes.
- "Make a diagram of everything tagged <tag>" / "of app-service and what it talks to".
On a design that follows git, the agent's edits go to a fork and it hands you the pull
request link; it never merges.`,

  explore: `Finding your way around the architecture
- Click a box: its panel (right) has Details, Connections and History.
- Connections → "What depends on it" / "What it depends on" lights the whole chain on the
  canvas and says how many things, how many hops, and how many aren't on this diagram.
- "⇄ N off diagram" on a box (orange) means it talks to things not drawn here. Click it to
  list them; each opens a diagram where that arrow is drawn, or + adds the box here.
- Clicking through jumps between diagrams; the "← back" chip at the top of the panel (or
  ⌥←) returns to where you came from.
- Details: Also on (every diagram it's on), tags, technology, links, Decisions (what was
  decided and why, with the write-up), Sources (the code it is) and Who's touched it.
- Arrows animate: whatever's selected or lit runs dots caller to callee. A animates every
  arrow (just for you; off by default).
- The breadcrumb's branch menu → Look back shows the whole design as it was at an earlier
  commit, read-only, with "Back to now".
- ⌘K finds any box, diagram, flow or tag, and runs commands.`,

  boxes: `Boxes
- Place one: pick its kind in the toolbar (2–6) and click the canvas, or right-click the canvas
  and choose "Add … here". It starts as "New system" etc.: rename it in the panel or with F2.
- Edit it in the right-hand panel: name, tech, context (its text, in markdown), references
  (links, images, docs, code, dependencies), notes kept inside it, status, tags, external. The panel also lists its connections, its links, and the diagrams
  it's on.
- Inside: apps and stores live in a system, components in an app. ↵ opens a box's own
  diagram; ⌘↑ goes back up.
- Move: drag (it lines up with its neighbours; hold ⌥ to place it freely), or arrow keys
  (⇧ for bigger steps). ⌘D duplicates.
- ⌫ takes it off this diagram only; ⇧⌫ deletes it from the model everywhere.
- From the sidebar ([ opens it) you can drag any box in the model onto this diagram.`,

  arrows: `Arrows (connections)
- Draw one: press C, click one box then another; or drag from a box's edge to another box.
- Double-click an arrow to name it ("reads orders"); select it to edit technology and status.
- Lit arrows animate (dots run caller to callee); press A to animate every arrow, for you only.
- Arrows are model facts: draw them at the lowest level that's true (component → store) and
  they show between the right boxes on every diagram.
- Shape: select an arrow and drag its handles to bend it, pin which side of a box it leaves
  from, or slide its label along it. Right-click it → Reverse, or Reset joints.
- Style per diagram from ⌘K: "Arrows: curved / elbow / straight on this diagram" (or just
  for you). "Reset all joints on this diagram" straightens hand-bent arrows.`,

  diagrams: `Diagrams (views)
- The breadcrumb at the top left is where you are; double-click its last part to rename.
- New diagram: ⌘K → "New diagram". The sidebar ([) lists them all.
- Two kinds: hand-picked (exactly the boxes you put there), or following the model (rules
  like "everything inside Shop and what it talks to", so new boxes show up on their own).
  ⌘K → "Make this diagram follow the model" / "Hand-pick this diagram".
- Layout: drag boxes, or ⌘K → "Lay out left to right" (once; ⌘Z undoes it). "Keep tidy"
  re-lays it out after every change, for diagrams that should never be hand-arranged.
  F fits the screen, M the minimap.
- Export: ⌘K → "Export diagram as PNG" (⇧⌘E).`,

  flows: `Flows
- A flow tells a story over a diagram, step by step ("a customer places an order").
- Start one: ⌘K → "New flow on this diagram", or right-click the canvas → "New flow".
- Add steps: select two boxes in order (click, then ⇧-click) and add them as a step, with a
  sentence for what happens. Reorder or delete steps in the flow panel.
- Play it: ← and → step through; each step lights up its two boxes and the arrow, with dots
  running from caller to callee.`,

  notes: `Notes and links
- A note is a comment thread. Press N (or the speech-bubble tool) and click where it goes; on a
  box it's pinned there and moves with it. Type, Enter posts (⇧Enter for a new line).
- Click a note's pin to read and reply in the right-hand panel; Resolve when it's settled
  (it leaves the canvas, stays in the list). Hover a pin for a peek.
- A link points somewhere else (an RFC in Notion, a runbook). Press L, click, paste the
  address: the title is filled in from it. Dropped on a box it docks under it. Double-click
  opens it. A box's panel has Note and Link buttons too, and right-click → "Add a note".
- The speech-bubble button by the people at the top right lists every open note, resolved
  note and link in the design; click one to jump to it.
- Links are saved in the files (and git); note threads are kept in Archnemesis, not the files.`,

  branches: `Branches (designs that follow a git repo)
- The button next to the design name shows which version you're on. A design connected to
  a repo shows "main", which follows the repo and isn't edited directly.
- Your first edit on main starts a fork (named for you and the day) and moves you onto it;
  everyone on that fork edits it live, and it's saved to its own branch.
- When it's ready: the branch menu → open a pull request. Reviewing and merging happen on
  GitHub; once merged, the fork closes and everyone's back on main.
- Notes are the exception: you can leave and answer notes on main without a fork.
- Look back (in the same menu) lists main's commits; pick one to see the design as it was.`,

  agents: `Working with an agent (like this one)
- The agent edits the same design you see, live, with its own (purple) cursor and name, and
  each of its changes is one undo step in the history.
- Ask it to add or change boxes, arrows, diagrams and flows, explain how things connect, find
  a path from one box to another, tidy a diagram, read and answer notes, add links, or record
  a decision. guide ask has examples to try.
- It never moves your boxes by hand; it places new ones and can tidy a diagram if you ask.
- On a design that follows git, its edits go to a fork like yours.
- Connecting one: ? (top right) → "Connect your agent" has the MCP address any MCP client can
  use, and the commands for Claude Code as an example (one command to paste in a terminal). On
  an Archnemesis you sign in to (with Google), a client that signs in through the browser
  (Claude Code: run /mcp, pick the server and Authenticate) opens Archnemesis, you press Allow,
  and the agent acts as you with your role. Its access is listed in that card, to revoke. A
  script can use a token made there instead ("make a token instead").
- @agent in a note: with "Tools + @agent" in that card (the archnm channel, a Claude Code
  feature, in research preview), the note reaches your open Claude Code session within seconds
  and it answers in the thread. Start Claude Code with
  claude --dangerously-load-development-channels server:archnm
  and confirm the prompt each time (only Anthropic or an org admin can make a channel
  trusted, so the prompt can't be skipped). To skip typing the flag, add a shell alias:
  alias claude='claude --dangerously-load-development-channels server:archnm'
  Without the channel, an @agent note waits as a flag until an agent reads notes.`,

  keys: `Keys (? in the app shows them too)
Tools: 1 select · 2–6 place actor/system/app/store/component · C connect · N note · L link · Esc back to select
Boxes: ↵ open inside · ⌘↑ up a level · F2 rename · arrows nudge (⇧ ×5) · ⌘D duplicate · ⌫ off this diagram · ⇧⌫ delete everywhere · ⌥-drag off-grid
View: ⌘K find / run a command · F fit · ⌘+ / ⌘− zoom · [ sidebar · M minimap · A animate every arrow · ← → step through a flow · ⌥← back
History: ⌘Z undo · ⇧⌘Z redo · ⇧⌘E export PNG · ! mark this as confusing (kept in your trail)`,
};

/** The guide on a topic (or the start and the list of topics). */
export function guideText(topic?: string): string {
  const t = (GUIDE_TOPICS as readonly string[]).includes(topic ?? "")
    ? (topic as GuideTopic)
    : "start";
  const others = GUIDE_TOPICS.filter((x) => x !== t).join(", ");
  return `${TEXT[t]}\n\nOther topics: ${others}.\nTeach it as steps the person does in their browser, one or two at a time, and offer to do the work yourself when that's quicker. Show, don't list: pick one thing from their own design and do it with them (point at it, run the impact, play a flow), then offer the next.`;
}
