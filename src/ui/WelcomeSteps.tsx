// What the welcome shows after one of its agent ways is chosen: a few steps, each one sentence
// and the exact thing to type or paste. The words differ by where this page runs.
import type { ReactNode } from "react";
import type { McpSetup } from "../../shared/api.ts";
import { AgentCommand, Cmd } from "./ConnectAgent";
import {
  MAP_ASK,
  MAP_ASK_PUBLIC,
  PLAN_ASK,
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

/** Running Archnemesis on your own machine: the README's commands. */
function RunLocal() {
  return (
    <>
      {RUN_LOCAL.map((c) => (
        <Cmd key={c} text={c} />
      ))}
      <p className="small muted">Needs Docker and a tokens.json first: README.md, Docker.</p>
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
        This page can't read a repo or take an agent. Mapping code takes Archnemesis running on your
        own machine, with an agent started in the repo's folder.
      </p>
      <Step n={1}>
        Run Archnemesis on your machine:
        <RunLocal />
      </Step>
      <Step n={2}>
        Open <code>http://127.0.0.1:5190</code>, connect your agent, and paste “Map this repo into
        Archnemesis”.
      </Step>
      <Note>You can still start blank or open the example here. Both stay in this browser.</Note>
    </>
  );
}

function ConnectOnServer({ mcp, agent }: { mcp: McpSetup; agent: boolean }) {
  return (
    <>
      <AgentCommand mcp={mcp} />
      <Ready on={agent}>
        {agent
          ? "An agent is connected."
          : "Waiting for an agent. This line changes when one connects."}
      </Ready>
      <Note>
        An agent inside Chrome can use this page too (WebMCP), with your rights. To switch that on:{" "}
        <code>{WEBMCP_FLAG}</code>
      </Note>
    </>
  );
}

function ConnectInPage() {
  return (
    <>
      <Ready on>Chrome is offering this page's tools to agents.</Ready>
      <Step n={1}>Ask your agent to use the tools on this page.</Step>
      <Step n={2}>
        Try:
        <Cmd text={WEBMCP_ASK} />
        <Cmd text={MAP_ASK_PUBLIC} />
      </Step>
      <Step n={3}>Watch it appear. The agent's edits carry its name, and it can undo its own.</Step>
      <Note>It can't read files on your computer from here: give it a link, or describe it.</Note>
    </>
  );
}

function ConnectNowhere() {
  return (
    <>
      <p>Pick one.</p>
      <h3>With Claude Code (one command)</h3>
      <Step n={1}>
        Run this in a terminal. It gives Claude Code a Chrome it can drive.
        <Cmd text={WEBMCP_CLAUDE} />
      </Step>
      <Step n={2}>In that Chrome, open this page.</Step>
      <Step n={3}>
        Ask:
        <Cmd text={WEBMCP_ASK} />
      </Step>
      <h3>In your own Chrome</h3>
      <Step n={1}>
        Open this and set it to Enabled:
        <Cmd text={WEBMCP_FLAG} />
      </Step>
      <Step n={2}>Relaunch Chrome and come back to this page.</Step>
      <Step n={3}>Use an agent that works inside Chrome.</Step>
      <Note>
        This is Chrome's WebMCP, still a trial. No agent? Start blank or open the example: both work
        without one.
      </Note>
    </>
  );
}

/** The title and body of one of the agent ways, for where this page runs. */
export function stepsFor(
  detail: Exclude<Detail, null>,
  p: { place: Place; mcp: McpSetup | null; agent: boolean; onDetail: (d: Detail) => void },
): { title: string; body: ReactNode } {
  if (detail === "local") return { title: "Map a repo with an agent", body: <Local /> };
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
  if (p.place === "server" && p.mcp)
    return { title: "Connect an agent", body: <ConnectOnServer mcp={p.mcp} agent={p.agent} /> };
  if (p.place === "page-agent") return { title: "Connect an agent", body: <ConnectInPage /> };
  return { title: "Connect an agent", body: <ConnectNowhere /> };
}
