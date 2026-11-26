// The card for what's selected: floating beside it in simple mode, or the deleted thing's card
// while diffing.
import { makeNote } from "../../shared/model.ts";
import { Inspector } from "../ui/Inspector";
import { connName } from "../ui/Notes";
import { spotFor } from "../../shared/notes.ts";
import { DeletedCard } from "../ui/DiffLayer";
import { backend } from "../backend";

import { FloatIf } from "./FloatIf";
import type { WorkspaceBag } from "./useInteraction";

/** The card beside what is selected. */
type CardProps = Pick<
  WorkspaceBag,
  | "floatRef"
  | "trail"
  | "remember"
  | "goBack"
  | "goToObject"
  | "setHoverPair"
  | "setImpactOn"
  | "impactNow"
  | "removeSelected"
  | "noteSel"
  | "openNote"
  | "noteOnBox"
  | "navigate"
  | "open"
  | "graph"
  | "opened"
  | "openHere"
  | "setTool"
  | "setConnectFrom"
  | "panel"
  | "setPanel"
  | "fresh"
  | "setFresh"
  | "whatsNew"
  | "goneIds"
  | "scene"
  | "toast"
  | "store"
  | "idx"
  | "simple"
  | "run"
  | "sel"
  | "diagramId"
>;

/** The card beside what is selected. */
export function CardHost(props: CardProps) {
  const {
    floatRef,
    noteSel,
    panel,
    setPanel,
    whatsNew,
    goneIds,
    toast,
    store,
    idx,
    simple,
    run,
    sel,
    diagramId,
  } = props;
  return (
    <>
      {diagramId &&
        !noteSel &&
        (!simple || panel) &&
        (sel.nodes.length > 0 || sel.edge || sel.boundary || sel.diagram) && (
          <FloatIf on={simple} ref={floatRef}>
            {sel.nodes.length === 1 && goneIds.has(sel.nodes[0]!) ? (
              <DeletedCard
                r={goneIds.get(sel.nodes[0]!)!}
                all={whatsNew?.removed ?? []}
                views={whatsNew?.removedViews ?? []}
                idx={idx}
                canEdit={store.canEdit}
                onRestore={(ops, label) =>
                  void run(ops, label).then(
                    () => (setPanel(false), toast(`${label.replace(/^restore /, "")} is back`)),
                  )
                }
                onClose={() => setPanel(false)}
              />
            ) : (
              <InspectorCard {...props} diagramId={diagramId} />
            )}
          </FloatIf>
        )}
    </>
  );
}

/** The card for a box, an arrow, a frame or the diagram itself. */
function InspectorCard(props: Omit<CardProps, "diagramId"> & { diagramId: string }) {
  const {
    trail,
    remember,
    goBack,
    goToObject,
    setHoverPair,
    setImpactOn,
    impactNow,
    removeSelected,
    openNote,
    noteOnBox,
    navigate,
    open,
    graph,
    opened,
    openHere,
    setTool,
    setConnectFrom,
    setPanel,
    fresh,
    setFresh,
    scene,
    store,
    idx,
    simple,
    run,
    sel,
    diagramId,
  } = props;
  return (
    <Inspector
      simple={simple}
      fresh={fresh}
      onClose={() => {
        setPanel(false);
        setFresh(null);
      }}
      design={{ key: store.designKey, name: store.designName }}
      onHoverConnection={(c) => {
        const e = c && graph?.edges.find((x) => x.connectionIds.includes(c.id));
        setHoverPair(e ? [e.from, e.to] : null);
      }}
      canEdit={store.canEdit}
      impact={
        impactNow && {
          way: impactNow.way,
          count: impactNow.count,
          hops: impactNow.hops,
          off: impactNow.off,
        }
      }
      onImpact={(way) =>
        setImpactOn(way && sel.nodes.length === 1 ? { id: sel.nodes[0]!, way } : null)
      }
      back={trail.length ? { label: trail[trail.length - 1]!.label, run: goBack } : null}
      onShowConnection={(c) => {
        setHoverPair(null);
        remember();
        // The arrow it's drawn as here, if any: select it and bring both ends into view.
        const e = graph?.edges.find((x) => x.connectionIds.includes(c.id));
        if (e) {
          scene.current?.select({ nodes: [], edge: e.id }, true);
          scene.current?.frameBoxes([e.from, e.to]);
          return;
        }
        // Not drawn here: the diagram that shows it.
        const both = [...(idx.placedOn.get(c.fromId) ?? [])].find((d) =>
          idx.placedOn.get(c.toId)?.has(d),
        );
        if (both) navigate(both, c.toId, "panel");
      }}
      insights={
        backend.insights && {
          touched: (id) => backend.insights!.touched(store.design, id),
          libstats: () => backend.insights!.libstats(store.design),
        }
      }
      onAddNote={noteOnBox}
      onSelectFrame={() => {
        // Unfolded: the card gets out of the way (the frame's own selection brings it back).
        scene.current?.select({ nodes: [], edge: null }, true);
        setPanel(false);
      }}
      openedHere={diagramId ? (opened[diagramId] ?? []) : []}
      drawnHere={(id) => !!graph?.nodes.some((n) => n.id === id)}
      onOpenHere={openHere}
      onGoTo={(id) => {
        remember();
        goToObject(id);
      }}
      onCommentConnection={(connectionId, text) => {
        const mid = scene.current?.connectionAnchor(connectionId);
        if (!diagramId || !mid) return;
        const there = [...idx.notes.values()].filter(
          (n) => n.diagramId === diagramId && n.connectionId === connectionId && !n.resolved,
        ).length;
        const note = makeNote({
          diagramId,
          kind: "note",
          author: store.me,
          text,
          objectId: null,
          connectionId,
          x: 14 + there * 26,
          y: -10,
        });
        void run([{ op: "note.put", note }], `commented on ${connName(idx, connectionId)}`);
      }}
      onComment={(objectId, text) => {
        if (!diagramId) return;
        const note = makeNote({
          diagramId,
          kind: "note",
          author: store.me,
          text,
          ...spotFor(idx, diagramId, "note", objectId),
        });
        void run(
          [{ op: "note.put", note }],
          `commented on ${idx.objects.get(objectId)?.name ?? "it"}`,
        );
      }}
      me={store.me.name}
      onOpenNote={openNote}
      idx={idx}
      config={store.config}
      diagramId={diagramId}
      graph={graph}
      selection={sel}
      run={run}
      log={() => store.log(500)}
      onNavigate={(d, o) => {
        remember();
        navigate(d, o, "panel");
      }}
      onOpen={open}
      onRemove={removeSelected}
      onConnect={() => {
        if (sel.nodes.length !== 1) return;
        setTool("connect");
        setConnectFrom(sel.nodes[0]!);
      }}
    />
  );
}
