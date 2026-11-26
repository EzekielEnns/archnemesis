import { useEffect, useState, useSyncExternalStore } from "react";
import { Bench, benchSize } from "./Bench";
import { backend } from "./backend";
import { BackendError } from "./backend/types.ts";
import { hashFor, parseHash } from "./route";
import { DESIGN_KEY, stored } from "./storage";
import { Store } from "./store";
import { Authorize } from "./ui/Authorize";
import { OpenShared, remoteFragment, sharedFragment } from "./ui/OpenShared";
import { SignIn } from "./ui/Peers";
import { Workspace } from "./Workspace";

/** Which design is open: the one in the URL, else the last one you had open, else the first. */
function useDesign(): string | null {
  const [design, setDesign] = useState(() => parseHash().design);
  // Not signed in, so the designs can't be listed: open a stand-in, whose store finds out
  // and shows the sign-in.
  const [locked, setLocked] = useState(false);
  useEffect(() => {
    // A link that carries a design isn't a design to open: the page for it takes over.
    const f = () => sharedFragment() === null && setDesign(parseHash().design);
    window.addEventListener("hashchange", f);
    return () => window.removeEventListener("hashchange", f);
  }, []);
  useEffect(() => {
    if (design) return;
    void backend.designs
      .list()
      .then((list) => {
        const last = stored(DESIGN_KEY);
        const pick = list.find((d) => d.key === last) ?? list[0];
        // Keep an old #/d/<diagram> link working: it moves under the design.
        const old = parseHash();
        if (pick) location.replace(`#${hashFor({ ...old, design: pick.key })}`);
      })
      // Not signed in, so the designs can't be listed; otherwise leave it as it was.
      .catch((e) => e instanceof BackendError && e.code === "signin" && setLocked(true));
  }, [design]);
  return design ?? (locked ? SIGN_IN_FIRST : null);
}

const SIGN_IN_FIRST = "~signin";

/** The page's hash, kept up to date: a link pasted into this tab changes it. */
function useHash(): string {
  return useSyncExternalStore(
    (f) => (
      window.addEventListener("hashchange", f),
      () => window.removeEventListener("hashchange", f)
    ),
    () => location.hash,
  );
}

export function App() {
  const hash = useHash();
  // An MCP client signing in (/oauth/authorize sent the browser here): only that page.
  const oauth = /^#~authorize=([\w-]+)$/.exec(hash)?.[1];
  if (oauth && backend.oauth) return <Authorize id={oauth} />;
  // A link that carries a design, or names one on GitHub: open it, then go to it.
  const shared = backend.portable ? sharedFragment(hash) : null;
  if (shared) return <OpenShared key={shared} fragment={shared} />;
  return <Main />;
}

function Main() {
  const bench = benchSize();
  const design = useDesign();
  if (bench) return <Bench count={bench} />;
  if (!design) return null;
  // A design read from GitHub is fetched again on a reload, before it opens (or says why it can't).
  const again = remoteFragment(design);
  if (again)
    return (
      <OpenShared key={design} fragment={again}>
        <DesignApp design={design} />
      </OpenShared>
    );
  // A store per design: switching designs starts clean.
  return <DesignApp key={design} design={design} />;
}

function DesignApp({ design }: { design: string }) {
  const [store] = useState(() => new Store(design));
  useEffect(() => store.start(), [store]);
  useSyncExternalStore(store.subscribe, store.getVersion);
  if (store.connectivity === "signin") return <SignIn store={store} />;
  if (store.connectivity === "missing") return <Elsewhere design={design} />;
  return <Workspace store={store} />;
}

/**
 * The design in the link isn't here (renamed, never on this Archnemesis, or remembered from
 * another one): open the one you had last, or the first, instead of a dead end.
 */
function Elsewhere({ design }: { design: string }) {
  useEffect(() => {
    void backend.designs
      .list()
      .catch(() => [])
      .then((list) => {
        const last = stored(DESIGN_KEY);
        const pick =
          list.find((d) => d.key === last && d.key !== design) ??
          list.find((d) => d.key !== design);
        if (pick) location.replace(`#${hashFor({ ...parseHash(), design: pick.key })}`);
      });
  }, [design]);
  return null;
}
