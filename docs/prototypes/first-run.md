# First run: notes for the owner

Open `first-run.html` beside this. Top bar: situation (1 to 5), layout (A or B), width (full or 900 px), and for situation 3 a box that pretends an agent has connected.

## Recommendation

A fresh install opens on an empty design with a centred welcome panel (layout A) that says what the product is in a headline and one sentence, then offers four ways in as cards, each showing the exact next thing to do. Choosing one either opens its steps in the same panel (the two agent ways) or tucks the panel into a small "Getting started" chip at the bottom and acts (start blank shows a hint on the tool dock; the example opens as its own design called Shop). The chip has an x that hides it for good; after that it lives under ? as "Getting started", and Esc always tucks the panel into the chip without hiding it for good.

Layout B (bottom strip) leaves the canvas almost clear and puts the same words in a strip along the bottom; it suits people who want to start drawing at once, but the panel in A is easier to read and gets the explanation noticed.

## The product in one sentence (three candidates)

1. **(used)** A shared diagram of how your software fits together, edited by you and your AI agents at the same time. (headline is the noun phrase; the lead sentence adds the parts)
2. Archnemesis draws a software system as boxes and connections, saved as files, that people and AI agents edit together.
3. A map of a software system: boxes for its parts, connections for how they talk, edited live by you and your agents.

Why 1: no jargon, says what it is first, says nothing about files or git (which a first-timer does not yet care about).

## Every string

| Where | Text | Runner-up / note |
|---|---|---|
| Welcome headline | A shared diagram of how your software fits together | Draw how your software fits together |
| Welcome lead | Boxes are the parts: people, systems, apps, databases, code. Connections show how they talk. You and your AI agents edit it together, live. | |
| Status line, demo | Your designs stay in this browser. | |
| Status line, demo with WebMCP | This browser lets agents use this page. | An agent in this browser can use this page. |
| Status line, server | Designs are saved as files on this server, and everyone you invite sees edits as they happen. | "Invite" is only true where there is sign-in: check |
| Status line, server, no agent | No agent connected yet. | |
| Status line, server, agent | An agent is connected. | |
| Eyebrow | Where do you want to start? | Pick a way in |
| Card 1 | Start blank / Place boxes yourself, then connect them. / Press 2 to 6, click the canvas | |
| Card 2, server | Map a repo with an agent / An AI agent reads your code and draws it here. / “Map this repo into Archnemesis” | |
| Card 2, demo with WebMCP | An AI agent draws a system from a public repo or from what you tell it. / “Map the repo at <link>…” | |
| Card 2, demo without WebMCP | Reading code needs Archnemesis on your own machine. / Needs Archnemesis on your machine | |
| Card 3, server | Connect an agent / Give an AI agent, such as Claude Code, access to this design. / Add 127.0.0.1:5190/mcp to your agent (the real address) | Agent connected: "Ask it to map a repo", tag "Connected" |
| Card 3, demo with WebMCP | Your browser can let an agent work on this design. / Nothing to install / tag "Ready" | |
| Card 3, demo without WebMCP | This page can't take an agent. Here is what can. / See what you need | |
| Card 4 | Open the example / A small online shop, already drawn. Your own design stays separate. / Opens “Shop” as its own design | |
| Panel footer | Don't show this again; Esc closes this. Find it again under ? → Getting started. | |
| Chip | Getting started (x: "Hide Getting started for good") | |
| After "never" | Hidden. You can find it again under ? → Getting started. | |
| After example | Opened “Shop” as its own design. Your blank design is still in the design menu. | |
| Dock hint after Start blank | Press 2 for an actor, 3 system, 4 app, 5 store or 6 component, then click the canvas. | |
| Hint after first box | Click a box to edit it. Press C, then click two boxes to connect them. | |
| Map detail, server | Your agent reads the repo, then draws its apps, databases and the connections between them into this design while you watch. Steps: connect first; open the agent in the repo's folder (it runs one command on your machine to read the code); paste the prompt | |
| Prompt: map | Map this repo into Archnemesis. Start with its apps, databases and the connections between them, then add the code inside each app. Tell me what you guessed. | |
| Prompt: map, public repo | Map the repo at <link to a public repo> into Archnemesis. Read its README and main folders, then draw its apps, databases and the connections between them. Tell me what you guessed. | |
| Prompt: plan | Plan this feature in Archnemesis: <describe the feature>. Start from what is already drawn, add what the feature needs as planned boxes and connections, and tell me what it touches. | |
| Map detail, WebMCP | In the browser an agent can't open files on your computer. Give it a link to a public repo it can read, or describe your system, and it draws what it finds. | |
| Map detail, no WebMCP | This page can't read a repo or take an agent. Mapping code takes Archnemesis running on your own machine, with an agent started in the repo's folder. | |
| Connect detail, server | Any agent that speaks MCP can connect: give it this address. MCP is the standard way agents use tools. Then Claude Code as one labelled example (command exactly as ConnectAgent builds it for the default case), then /mcp → archnm → Authenticate → Allow | Only place "MCP" appears |
| Connect detail, WebMCP | Your browser can give an agent the same tools you have on this page (WebMCP). It works on the design you have open, and its edits show under an agent's name, so you can tell them from yours. / The agent can read and change this design. It can't delete designs, and it can't read files on your computer. | |
| Connect detail, no WebMCP | An agent gets in through an address a server gives it, or through a browser that has WebMCP. This page has neither, so nothing here can take an agent yet. | |
| Buttons | All ways in; Got it; Got it, close this | |
| Shared link banner | You're viewing a shared design. It's read-only. [Make my own copy] | |
| Shared link tip | New here? This is a diagram of a software system. Boxes are its parts; connections show how they talk. Click a box to read about it. [Got it] | |
| Returning hint | This design is empty. Press 2 to 6 to place a box, or ask your agent to draw it. [Getting started] | |
| ? sheet rows | Getting started (shared link: What is this?); Connect your agent; Keyboard shortcuts | |

## What each situation shows

1. **Demo with WebMCP.** Full welcome. Agent ways say nothing to install, and that repo mapping works from a public link or a description, because the in-page tools have no `index` (a repo on the person's disk cannot be read) and nothing in a browser reads local files.
2. **Demo without WebMCP.** Full welcome, but the two agent cards are honest: no agent can reach a static page (no MCP address; `mcp: null` in the local backend). They lead to what works: another browser, or running it on your machine. Start blank and the example are fully usable.
3. **Self-hosted server.** Full welcome. The connect card shows the MCP address for any client and Claude Code's command as one example, then OAuth steps. Mapping a repo is real here (`index` start/scan/import). A status line says whether an agent has connected.
4. **Shared link.** No welcome. Read-only banner with "Make my own copy" and one dismissible tip. A first-timer is looking at someone's design; the useful thing is to read it. The tip stays reachable under ? as "What is this?".
5. **Returning, empty design.** No welcome. A quiet hint in the middle of the empty canvas, gone at the first box. "Getting started" stays under ?.

## Open questions (answer in a few words)

1. Show the welcome only once per browser/install, or once per new design that is empty? (Prototype: once; returning people get the hint.)
2. Should "Open the example" make a design called Shop in the list (prototype), or open it read-only without making anything?
3. What exactly should the demo say a WebMCP person does in the browser (which browser, flag, or assistant)? I wrote "open your browser's AI assistant", which I could not verify.
4. Is there a public way to run it on your machine to name on the demo page (docker command, image name)? I used the README's `docker build` and `docker run`, and the README says the image is private.
5. Keep "Don't show this again" in the panel as well as the chip's x, or only the x?
6. Is "Make my own copy" (shared links) planned for the first build? I found no such control in the code today.

## What building this would touch

- New component: the welcome panel and the chip (replacing `ConnectAgent` as the first-open card), with state kept in `src/storage` like `archnm.agent-card`.
- `src/ui/ConnectAgent.tsx`: `AgentCommand` reused for the server connect step; `seenAgentCard` replaced or kept for dismissal; stale "Got it" card goes.
- `src/ui/Shortcuts.tsx`: the ? sheet gets a "Getting started" row.
- `src/workspace/` (`Dialogs.tsx`, `Overlays.tsx`, `TopBar.tsx`/`Chrome.tsx` tool dock): where the panel mounts, a highlight on tool keys 2 to 6, the empty-canvas hint, the shared-link banner (`Banners.tsx` today covers past versions).
- `src/webmcp.ts` `modelContext()`: detect WebMCP to choose situation 1 or 2.
- `src/backend/local.ts`: `config().mcp` is null (situation 2 test); no example creation exists, so card 4 on the static build needs the example shop seeded as a design on request. `designs.create` only makes empty designs.
- Server: first start currently seeds the example (`server/live.ts`, `ARCHNM_EXAMPLES`); the decision means a fresh install seeds one empty design and offers the example on request. `mcpSetup` in `server/routes/signin.ts` supplies the address and command.
- Agent-connected status: needs a signal that an MCP client has called (the telemetry call log exists on the server).
- `shared/guide.ts` and `shared/tools/teach.ts`: keep the guide's "start" text and the prompts above consistent with whatever words ship.
- Read-only shared links and "Make my own copy": needs a backend fork/copy, which does not exist.

## Things in the current app's text that look wrong or misleading

- `ConnectAgent`: "Got it" and "It's under ? too." tell the person the card is gone but nothing says what the product is.
- `ConnectAgent` says "An agent reads and edits the architecture with you" with no explanation of what an agent or MCP is.
- Example prompts "show me around" and "what's open in the notes?" assume a design with content; on an empty design they do nothing useful.
- Shortcuts: "Place actor … component 2–6" omits 7 to 9 (module, function, table), which the dock shows.
- Shortcuts "Sidebar [" and "Minimap M": the left-panel decisions removed the minimap; check the keys still exist.
- README says the Docker image is "built on every push to main and published privately" in two sentences that contradict each other; no public install line exists for the demo to point at.
- Prototype note on colour: white text on `--accent` (#4f8cff) is 3.2:1, under AA; the prototype's filled buttons use #2b66d6 (5.3:1). The real `.cta.primary` has the same issue.
