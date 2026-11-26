// "Connect your agent": the MCP address any agent can use, and Claude Code's commands as the
// worked example. Used in the welcome (Welcome.tsx) and at the top of the ? sheet.
import { Check, Copy, KeyRound } from "lucide-react";
import { useEffect, useState } from "react";
import type { McpSetup } from "../../shared/api.ts";
import { backend } from "../backend";
import type { TokenInfo } from "../backend/types.ts";
import { setStored, stored } from "../storage";
import { Dialog } from "./Dialog";
import { MAP_ASK, PLAN_ASK } from "./welcomeState";

/** Which setup the card shows: the tools alone, or the tools plus @agent (Claude Code's channel). */
type Way = "tools" | "channel";
const WAY_KEY = "archnm.agent-way";
// The keys from when this card was Claude's alone; still read, so a dismissed card stays dismissed.
const OLD_WAY_KEY = "archnm.claude-way";

/** One command (or prompt), with its copy button. */
export function Cmd({ text, n, label }: { text: string; n?: number; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () =>
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  return (
    <div className="agent-cmd-line">
      {n !== undefined && <span className="agent-step">{n}</span>}
      <code>
        {label && <span className="agent-cmd-label">{label}</span>}
        {text}
      </code>
      <button
        className="icon-btn"
        onClick={copy}
        title="Copy"
        aria-label={label ? `Copy ${label.toLowerCase()}` : "Copy"}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </div>
  );
}

const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

/** The personal tokens made so far, each with a way to revoke it. */
function TokenList({
  tokens,
  revoke,
}: {
  tokens: TokenInfo[];
  revoke: (id: string) => Promise<void>;
}) {
  const [revoking, setRevoking] = useState<TokenInfo | null>(null);
  return (
    <>
      {tokens.length > 0 && (
        <ul className="agent-tokens">
          {tokens.map((t) => (
            <li key={t.id} className="small">
              <span>
                {t.label} · made {day(t.created)} ·{" "}
                {t.used ? `used ${day(t.used)}` : "not used yet"} · runs out {day(t.expires)}
              </span>
              <button className="link-btn" onClick={() => setRevoking(t)}>
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
      {revoking && (
        <Dialog
          title={`Revoke ${revoking.label}?`}
          confirm="Revoke"
          tone="danger"
          onCancel={() => setRevoking(null)}
          onConfirm={() => void revoke(revoking.id).then(() => setRevoking(null))}
        >
          <p>
            Anything still using it (an agent, a script) stops reaching Archnemesis until it gets a
            new token.
          </p>
        </Dialog>
      )}
    </>
  );
}

/** Tools alone, or the tools plus @agent (Claude Code's channel). */
function WayTabs({ way, setWay }: { way: Way; setWay: (w: Way) => void }) {
  return (
    <div className="seg agent-way" role="tablist">
      <button
        role="tab"
        aria-selected={way === "tools"}
        className={way === "tools" ? "on" : ""}
        onClick={() => setWay("tools")}
      >
        Tools
      </button>
      <button
        role="tab"
        aria-selected={way === "channel"}
        className={way === "channel" ? "on" : ""}
        onClick={() => setWay("channel")}
      >
        Tools + @agent
      </button>
    </div>
  );
}

/** The three commands that let a note's @agent reach a running Claude Code session. */
function ChannelSteps({
  channel,
  ready,
  fill,
}: {
  channel: NonNullable<McpSetup["channel"]>;
  ready: boolean;
  fill: (c: string) => string;
}) {
  return (
    <>
      <p className="small">
        Write @agent in a note and your open Claude Code session answers it in the thread.
      </p>
      {ready && (
        <>
          <Cmd n={1} text={channel.download} />
          <Cmd n={2} text={fill(channel.command)} />
          <Cmd n={3} text={channel.start} />
          <p className="muted small">
            Start Claude Code with step 3 each time (it asks you to confirm: channels are a research
            preview). Without it you still get the tools; @agent waits for an agent to look.
          </p>
        </>
      )}
    </>
  );
}

/** The setup: the MCP address, then Claude Code's commands (tools alone or with @agent), and what to ask. */
export function AgentCommand({ mcp }: { mcp: McpSetup }) {
  // A personal token just made: shown once, in the command.
  const [token, setToken] = useState<string | null>(null);
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [way, setWayState] = useState<Way>(() =>
    mcp.channel && (stored(WAY_KEY) ?? stored(OLD_WAY_KEY)) === "channel" ? "channel" : "tools",
  );
  const setWay = (w: Way) => {
    setStored(WAY_KEY, w);
    setWayState(w);
  };
  const load = () => void backend.tokens?.list().then(setTokens);
  const hasTokens = !!backend.tokens && !!mcp.personal;
  useEffect(() => {
    if (hasTokens) load();
  }, [hasTokens]);
  const make = async () => {
    setError(null);
    try {
      setToken((await backend.tokens?.create("Agent")) ?? null);
    } catch {
      return setError("Couldn't make a token.");
    }
    load();
  };
  const revoke = async (id: string) => {
    await backend.tokens?.revoke(id);
    load();
  };
  // Signing in through the browser: a token by hand only if asked for (a script, CI). The
  // channel can't sign in through a browser, so it always takes a token where one's needed.
  const [byHand, setByHand] = useState(false);
  const channel = way === "channel" && mcp.channel ? mcp.channel : null;
  const tokenFirst = mcp.personal && (!mcp.oauth || byHand || !!channel);
  const fill = (c: string) => (token ? c.replace("<your token>", token) : c);
  const base = mcp.oauth && byHand ? (mcp.tokenCommand ?? mcp.command) : mcp.command;
  const ready = !tokenFirst || !!token;
  return (
    <div className="agent-cmd">
      <p className="small">
        Any agent that speaks MCP can connect: give it this address. MCP is the standard way agents
        use tools.
      </p>
      <Cmd text={mcp.url} />
      <h5 className="agent-client">Claude Code</h5>
      {mcp.channel && <WayTabs way={way} setWay={setWay} />}
      {channel ? (
        <ChannelSteps channel={channel} ready={ready} fill={fill} />
      ) : (
        <>
          <p className="small">One command adds it to Claude Code.</p>
          {ready && <Cmd text={fill(base)} />}
          {mcp.oauth && !byHand && (
            <p className="small">
              Then in Claude Code: <code>/mcp</code> → <b>{mcp.oauth}</b> → <b>Authenticate</b>, and
              press Allow here.
            </p>
          )}
        </>
      )}
      {tokenFirst && !token && (
        <button className="cta primary agent-token" onClick={() => void make()}>
          <KeyRound size={14} /> Make my token
        </button>
      )}
      {token && <p className="small">The token is only shown once: copy the commands now.</p>}
      {error && <p className="first-error small">{error}</p>}
      {mcp.note && <p className="muted small">{mcp.note}</p>}
      <h5 className="agent-client">Then ask it</h5>
      <Cmd text={MAP_ASK} />
      <Cmd text={PLAN_ASK} />
      {mcp.oauth && !byHand && !channel && (
        <button className="link-btn small" onClick={() => setByHand(true)}>
          For a script or CI: make a token instead
        </button>
      )}
      {mcp.personal && <TokenList tokens={tokens} revoke={revoke} />}
    </div>
  );
}
