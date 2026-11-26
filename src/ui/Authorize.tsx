// The page an MCP client (Claude Code) opens to sign in: sign in to Archnemesis if you aren't,
// then Allow or Deny. Archnemesis then sends the browser back to the client.
import { Bot } from "lucide-react";
import { useEffect, useState } from "react";
import type { SignInPage } from "../../shared/api.ts";
import { backend } from "../backend";
import { SignInForm } from "./Peers";

type State =
  | { kind: "loading" }
  | { kind: "signin"; page: SignInPage }
  | { kind: "ask"; client: string; to: string; you: string; login: string }
  | { kind: "done"; text: string }
  | { kind: "error"; text: string };

export function Authorize({ id }: { id: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void backend.oauth
      ?.read(id)
      .then((r) => setState(r.kind === "ask" ? r : { kind: "signin", page: r.page }))
      .catch((e) => setState({ kind: "error", text: e instanceof Error ? e.message : String(e) }));
  }, [id]);
  const decide = async (allow: boolean) => {
    setBusy(true);
    let redirect: string;
    try {
      redirect = (await backend.oauth?.decide(id, allow)) ?? "";
    } catch (e) {
      setBusy(false);
      return setState({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    }
    setState({
      kind: "done",
      text: allow
        ? "Done: you can close this tab and go back to your agent."
        : "Said no. You can close this tab.",
    });
    location.href = redirect;
  };
  // Not signed in to Archnemesis yet: the same sign-in page, which brings the browser back here.
  if (state.kind === "signin") return <SignInForm page={state.page} />;
  return (
    <div className="signin">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void decide(true);
        }}
      >
        <h1>Archnemesis</h1>
        {state.kind === "loading" && <p>One moment…</p>}
        {state.kind === "ask" && (
          <>
            <p>
              <Bot size={15} /> <b>{state.client}</b> wants to use Archnemesis as you ({state.login}
              ): read the designs and edit them with your role here.
            </p>
            <p className="muted small">
              It goes back to {state.to}. Its access shows under Connect your agent, where you can
              revoke it.
            </p>
            <button type="submit" disabled={busy}>
              Allow
            </button>
            <button
              type="button"
              className="link-btn"
              disabled={busy}
              onClick={() => void decide(false)}
            >
              Deny
            </button>
          </>
        )}
        {(state.kind === "done" || state.kind === "error") && (
          <p className={state.kind === "error" ? "first-error" : ""}>{state.text}</p>
        )}
      </form>
    </div>
  );
}
