// A click on the canvas that changes what's selected: connect mode takes the clicked box as the
// other end, and the card opens or closes by the tool and by whether you or the app selected.
import { Scene, type Selection } from "../canvas/Scene";

import type { SceneCallbacks } from "../canvas/Scene";

import type { SceneDeps } from "./sceneCallbacks";

export function selectHandler(deps: SceneDeps, getScene: () => Scene): SceneCallbacks["onSelect"] {
  const {
    latest,
    makeConnection,
    setNoteSel,
    setDraft,
    setConnectFrom,
    setTool,
    setSel,
    setPanel,
    setFresh,
  } = deps;
  /** Connect mode: true when the click was the end (or the start) of a connection. */
  const connectClick = (next: Selection, s: Scene): boolean => {
    // Connect mode: the box clicked is the other end.
    const from = latest.current.connectFrom;
    if (from && next.nodes.length === 1 && next.nodes[0] !== from) {
      setConnectFrom(null);
      setTool("select");
      makeConnection(from, next.nodes[0]!, s);
      return true;
    }
    // The connect tool: the first box clicked is where it starts.
    if (latest.current.tool === "connect" && !from && next.nodes.length === 1) {
      setConnectFrom(next.nodes[0]!);
      setSel(next);
      return true;
    }
    return false;
  };
  // Whether the card was open when a press on empty canvas let go of everything: a pan puts both back.
  let cardWas = false;
  return (next, fromCode, back) => {
    const s = getScene();
    if (back) {
      setSel(next);
      if (cardWas) setPanel(true);
      return;
    }
    if (next.nodes.length || next.edge || next.boundary || next.diagram) {
      setNoteSel(null);
      setDraft(null);
    }
    if (connectClick(next, s)) return;
    setSel(next);
    // Simple mode: a click with the view tool reads it; letting go of everything closes it.
    // A click with the select tool shows what flows in and out, not the card: the card is a
    // right-click (which comes after this and opens it again).
    if (!next.nodes.length && !next.edge && !next.boundary && !next.diagram)
      setPanel((open) => {
        cardWas = open;
        return false;
      });
    else if (latest.current.simple && latest.current.tool === "select" && !fromCode)
      setPanel(false);
    else if (latest.current.tool === "view" && (next.nodes.length === 1 || next.edge))
      setPanel(true);
    // A deleted thing in a diff can't be edited: a click reads it (what it was, putting it back).
    else if (next.nodes.length === 1 && latest.current.gone.has(next.nodes[0]!)) setPanel(true);
    setFresh((f) => (f && (next.nodes[0] === f || next.edge === f) ? f : null));
  };
}
