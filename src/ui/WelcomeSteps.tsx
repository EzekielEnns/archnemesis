// What the welcome shows after one of its agent ways is chosen: a few steps, each one sentence
// and the exact thing to type or paste. The words differ by where this page runs.
import { useState, type ReactNode } from "react";
import type { McpSetup } from "../../shared/api.ts";
import { AgentCommand, Cmd } from "./ConnectAgent";
import {
  MAP_ASK,
  MAP_ASK_PUBLIC,
  PLAN_ASK,
  REPO_URL,
  RUN_LOCAL,
  WEBMCP_ASK,
  WEBMCP_CLAUDE,
  WEBMCP_FLAG,
  type Detail,
  type Place,
} from "./welcomeState";

const Step = ({ n, children }: { n: number; children: ReactNode }) => (
  <div className="wel-step">
    <span className="wel-n">{n}</span>
    <div>{children}</div>
  </div>
);

const Note = ({ children }: { children: ReactNode }) => <div className="wel-note">{children}</div>;

const Ready = ({ on, children }: { on: boolean; children: ReactNode }) => (
  <p className="wel-ready small muted">
    <span className={`wel-led${on ? " on" : ""}`} aria-hidden="true" />
    {children}
  </p>
);

/** Self-hosting at its simplest: the README's run-from-source commands. */
function RunLocal() {
  return (
    <>
      {RUN_LOCAL.map((c) => (
        <Cmd key={c} text={c} />
      ))}
      <p className="small muted">
        Run it in your project's folder. Needs Docker. It answers only on your own machine, with no
        sign-in, and saves each design as files under <code>./architecture</code> that you commit
        with the rest of your repo. Hosting it for a team is in the{" "}
        <a href={`${REPO_URL}#readme`} target="_blank" rel="noreferrer">
          README
        </a>
        .
      </p>
    </>
  );
}

function MapOnServer({ onDetail }: { onDetail: (d: Detail) => void }) {
  return (
    <>
      <p>
        Your agent reads the repo, then draws its apps, databases and the connections between them
        into this design while you watch.
      </p>
      <Step n={1}>
        Connect your agent first, if you haven't.{" "}
        <button className="link-btn" onClick={() => onDetail("connect")}>
          Show me how
        </button>
      </Step>
      <Step n={2}>
        Open the agent in the repo's folder. To read the code it runs one command on your machine.
      </Step>
      <Step n={3}>
        Paste:
        <Cmd text={MAP_ASK} />
      </Step>
      <h3>Then, to plan a change</h3>
      <Cmd text={PLAN_ASK} />
    </>
  );
}

function MapInPage({ onDetail }: { onDetail: (d: Detail) => void }) {
  return (
    <>
      <p>
        In the browser an agent can't open files on your computer. Give it a link to a public repo
        it can read, or describe your system, and it draws what it finds.
      </p>
      <Step n={1}>Ask an agent that runs in this browser to use this page.</Step>
      <Step n={2}>
        Paste, with a real link in place of the angle brackets:
        <Cmd text={MAP_ASK_PUBLIC} />
      </Step>
      <Note>
        For a repo on your own machine, run Archnemesis there. The agent can then read the code from
        the folder it works in.{" "}
        <button className="link-btn" onClick={() => onDetail("local")}>
          What that takes
        </button>
      </Note>
      <h3>Then, to plan a change</h3>
      <Cmd text={PLAN_ASK} />
    </>
  );
}

function Local() {
  return (
    <>
      <p>
        Mapping a repo takes your own copy of Archnemesis (self-hosted). The demo runs only in this
        browser, so an agent here can't read the code on your machine.
      </p>
      <Step n={1}>
        Start it on your machine:
        <RunLocal />
      </Step>
      <Step n={2}>
        Open <code>http://127.0.0.1:5190</code> and choose Connect an agent. It is one command.
      </Step>
      <Step n={3}>
        Start your agent in the repo's folder and ask:
        <Cmd text={MAP_ASK} />
      </Step>
    </>
  );
}

type Option = "page" | "server";

/** Option A: the agent uses this page's own tools, through Chrome (WebMCP). Works anywhere. */
function InPage({ on }: { on: boolean }) {
  return (
    <>
      {on && <Ready on>Chrome is already offering this page's tools to agents.</Ready>}
      <Step n={1}>
        Run this in a terminal. It gives Claude Code a Chrome it can drive.
        <Cmd text={WEBMCP_CLAUDE} />
      </Step>
      <Step n={2}>
        Have it open this page:
        <Cmd text={location.href.split("#")[0]!} />
      </Step>
      <Note>
        Using an agent inside your own Chrome instead? Paste this in a new tab, set it to Enabled
        and relaunch (a page can't open Chrome's settings for you):
        <Cmd text={WEBMCP_FLAG} />
      </Note>
    </>
  );
}

/** Option B: the agent connects to an Archnemesis server (MCP), and can read code on your machine. */
function ThroughServer({ mcp, agent }: { mcp: McpSetup | null; agent: boolean }) {
  if (!mcp)
    return (
      <>
        <p>Demo mode has no server. Start your own (self-host), then connect from there:</p>
        <RunLocal />
      </>
    );
  return (
    <>
      <AgentCommand mcp={mcp} />
      <Ready on={agent}>
        {agent
          ? "An agent is connected."
          : "Waiting for an agent. This line changes when one connects."}
      </Ready>
    </>
  );
}

function Connect({ place, mcp, agent }: { place: Place; mcp: McpSetup | null; agent: boolean }) {
  const [option, setOption] = useState<Option>(place === "server" ? "server" : "page");
  const tab = (id: Option, letter: string, name: string, how: string) => (
    <button
      role="tab"
      aria-selected={option === id}
      className={option === id ? "on" : undefined}
      onClick={() => setOption(id)}
    >
      <b>{letter}</b> {name} <span className="muted">{how}</span>
    </button>
  );
  return (
    <>
      <div className="seg wel-options" role="tablist" aria-label="How the agent connects">
        {tab("page", "A", "In this page", "WebMCP")}
        {tab("server", "B", "Through a server", "MCP")}
      </div>
      {option === "page" ? (
        <InPage on={place === "page-agent"} />
      ) : (
        <ThroughServer mcp={mcp} agent={agent} />
      )}
      <h3>Then ask it</h3>
      <Cmd text={option === "page" ? WEBMCP_ASK : MAP_ASK} />
      <p className="small muted">
        {option === "page"
          ? "It draws here while you watch. Its edits carry its name, and it can undo its own. From a page it can't read files on your computer: describe the system or give it a link."
          : "It reads the repo in the folder it runs in and draws here while you watch. Its edits carry its name, and it can undo its own."}
      </p>
    </>
  );
}

/** The title and body of one of the agent ways, for where this page runs. */
export function stepsFor(
  detail: Exclude<Detail, null>,
  p: { place: Place; mcp: McpSetup | null; agent: boolean; onDetail: (d: Detail) => void },
): { title: string; body: ReactNode } {
  if (detail === "local") return { title: "Self-host to map a repo", body: <Local /> };
  if (detail === "map" && p.place === "page")
    return { title: "Self-host to map a repo", body: <Local /> };
  if (detail === "map")
    return {
      title: "Map a repo with an agent",
      body:
        p.place === "server" ? (
          <MapOnServer onDetail={p.onDetail} />
        ) : p.place === "page-agent" ? (
          <MapInPage onDetail={p.onDetail} />
        ) : (
          <Local />
        ),
    };
  return {
    title: "Connect an agent",
    body: <Connect place={p.place} mcp={p.mcp} agent={p.agent} />,
  };
}
