import { NO_SELECTION } from "./constants";
// Notes and links on the diagram: which one is selected or being written, who can be
// @mentioned in them, going to one, and starting one on a box or an arrow.
import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LINK_H, LINK_W } from "../../shared/model.ts";
import { type PeerInfo } from "../presence";
import { type ModelIndex } from "../../shared/project.ts";
import { type Selection } from "../canvas/Scene";
import type { Store } from "../store";
import { DRAFT, type NoteDraft, type Mentionable } from "../ui/Notes";
import { spotFor } from "../../shared/notes.ts";

import { parseHash } from "../route";
import type { LatestRef } from "./latest";
import type { Navigate, SceneRef } from "./types";

export function useNotes({
  store,
  idx,
  diagramId,
  scene,
  ready,
  latest,
  navigate,
  route,
  peers,
  setSel,
}: {
  store: Store;
  idx: ModelIndex;
  diagramId: string | null;
  scene: SceneRef;
  ready: boolean;
  latest: LatestRef;
  navigate: Navigate;
  route: ReturnType<typeof parseHash>;
  peers: PeerInfo[];
  setSel: Dispatch<SetStateAction<Selection>>;
}) {
  /** A note or link selected (its id, or DRAFT for one being written), and that draft. */
  const [noteSel, setNoteSel] = useState<string | null>(null);
  const [draft, setDraft] = useState<NoteDraft | null>(null);
  // Who a note can @mention: everyone who's written in this design's notes, and who's here.
  // Agents aren't listed one by one: @agent stands for them all.
  const mentionable = useMemo(() => {
    const by = new Map<string, Mentionable>();
    const add = (a: { id: string; name: string; kind: Mentionable["kind"] }, hint?: string) => {
      if (a.id === store.me.id || a.kind !== "human" || by.has(a.id) || !a.name) return;
      by.set(a.id, {
        id: a.id,
        name: a.name.replace(/\s+/g, "-"),
        kind: a.kind,
        ...(hint ? { hint } : {}),
      });
    };
    for (const p of peers) add(p.user, "here now");
    for (const n of idx.notes.values()) add(n.author);
    for (const rs of idx.replies.values()) for (const r of rs) add(r.author);
    return [...by.values()];
  }, [peers, idx, store.me.id]);
  const closeNote = useCallback(() => {
    setNoteSel(null);
    setDraft(null);
  }, []);

  /** Select a note or link on this diagram (boxes and arrows let go). */
  const selectNote = useCallback((id: string) => {
    scene.current?.select(NO_SELECTION);
    setSel(NO_SELECTION);
    if (id !== DRAFT) setDraft(null);
    setNoteSel(id);
  }, []);

  /** Go to a note from the list: its diagram, centred on it, selected. */
  const openNote = useCallback(
    (id: string) => {
      const n = idx.notes.get(id);
      if (!n) return;
      if (n.diagramId !== diagramId) navigate(n.diagramId, null, "note");
      setTimeout(
        () => {
          const box = n.objectId
            ? latest.current.idx.placements.get(n.diagramId)?.get(n.objectId)
            : undefined;
          const arrow = n.connectionId ? scene.current?.connectionAnchor(n.connectionId) : null;
          const w = n.kind === "link" ? LINK_W / 2 : 0;
          const h = n.kind === "link" ? LINK_H / 2 : -15;
          const o = arrow ?? box ?? { x: 0, y: 0 };
          scene.current?.centerAt({ x: n.x + o.x + w, y: n.y + o.y + h });
          selectNote(id);
        },
        n.diagramId !== diagramId ? 120 : 0,
      );
    },
    [idx, diagramId, navigate, selectNote],
  );

  // A link to a note (…/n/<note>) opens it once the diagram is up.
  const openedNote = useRef<string | null>(null);
  useEffect(() => {
    const id = route.noteId;
    if (!ready || !id || openedNote.current === id || !idx.notes.has(id)) return;
    openedNote.current = id;
    openNote(id);
  }, [route.noteId, ready, idx]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Start a comment pinned to a connection's arrow here (from its card or its menu). */
  const noteOnConnection = useCallback(
    (connectionId: string) => {
      const mid = diagramId ? scene.current?.connectionAnchor(connectionId) : null;
      if (!diagramId || !mid) return;
      const there = [...idx.notes.values()].filter(
        (n) => n.diagramId === diagramId && n.connectionId === connectionId && !n.resolved,
      ).length;
      scene.current?.select(NO_SELECTION);
      setSel(NO_SELECTION);
      setDraft({
        kind: "note",
        diagramId,
        objectId: null,
        connectionId,
        x: 14 + there * 26,
        y: -10,
      });
      setNoteSel(DRAFT);
    },
    [idx, diagramId],
  );

  /** Start a note or a link pinned to a box (from its panel or its menu). */
  const noteOnBox = useCallback(
    (kind: "note" | "link", objectId: string) => {
      if (!diagramId || !idx.placements.get(diagramId)?.has(objectId)) return;
      const at = spotFor(idx, diagramId, kind, objectId);
      scene.current?.select(NO_SELECTION);
      setSel(NO_SELECTION);
      setDraft({ kind, diagramId, ...at });
      setNoteSel(DRAFT);
    },
    [idx, diagramId],
  );
  return {
    noteSel,
    setNoteSel,
    draft,
    setDraft,
    mentionable,
    closeNote,
    selectNote,
    openNote,
    noteOnConnection,
    noteOnBox,
  };
}
