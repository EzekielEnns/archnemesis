// The commands in ⌘K: the ones without a button of their own, in the order they're listed.
import type { Dispatch, SetStateAction } from "react";
import { moveOps, newDiagram } from "../../shared/actions.ts";
import { shiftBends, straighten } from "../../shared/align.ts";
import { LAYOUT_DIRECTIONS } from "../../shared/model.ts";
import {
  ARROW_STYLES,
  KIND_LABEL,
  OBJECT_KINDS,
  now,
  type ArrowStyle,
} from "../../shared/model.ts";
import { adoptRules } from "../../shared/views.ts";
import type { Op } from "../../shared/model.ts";
import { type CanvasGraph, type ModelIndex } from "../../shared/project.ts";
import { type Selection } from "../canvas/Scene";
import type { Store } from "../store";
import { foldMode } from "../../shared/project.ts";
import { type Command } from "../ui/Palette";
import { backend } from "../backend";
import { setPerfMeterOn } from "../ui/Perf";
import { type ToolId } from "../ui/Chrome";

import { recording, setRecording } from "../trail";
import type { Run, ToastFn } from "./toasts";
import type { Navigate, SceneRef } from "./types";
import type { useDialogs } from "./useDialogs";
import type { useArrows } from "./useArrows";
import type { useUp } from "./useUp";
import type { useDiagramActions } from "./useDiagramActions";
import type { Diagram } from "../../shared/model.ts";

export interface CommandCtx {
  idx: ModelIndex;
  diagramId: string | null;
  graph: CanvasGraph | null;
  store: Store;
  sel: Selection;
  run: Run;
  toast: ToastFn;
  scene: SceneRef;
  simple: boolean;
  setTool: Dispatch<SetStateAction<ToolId>>;
  startFlow: () => void;
  setMarking: ReturnType<typeof useDialogs>["setMarking"];
  setReport: ReturnType<typeof useDialogs>["setReport"];
  perfOn: boolean;
  setPerfOn: Dispatch<SetStateAction<boolean>>;
  navigate: Navigate;
  backTo: ReturnType<typeof useUp>["backTo"];
  upName: string;
  up: () => void;
  exportAs: ReturnType<typeof useDiagramActions>["exportAs"];
  minimap: boolean;
  setMinimap: Dispatch<SetStateAction<boolean>>;
  animate: boolean;
  setAnimate: Dispatch<SetStateAction<boolean>>;
  setHelp: Dispatch<SetStateAction<boolean>>;
  showNew: boolean;
  setShowNew: Dispatch<SetStateAction<boolean>>;
  myArrows: ReturnType<typeof useArrows>["myArrows"];
  setMyArrows: ReturnType<typeof useArrows>["setMyArrows"];
  diagramArrows: ArrowStyle;
}

// Everything without a button of its own lives in ⌘K.
/**
 * Arrow style: for this diagram or every diagram (saved in their files, so it's in the
 * repo, one undo step), or just for you (this browser).
 */
function arrowCommands(c: CommandCtx): Command[] {
  const { idx, diagramId, store, run, toast, myArrows, setMyArrows, diagramArrows } = c;
  const d = diagramId ? idx.diagrams.get(diagramId) : undefined;
  const name = (st: ArrowStyle) =>
    st === "curved" ? "Curved" : st === "elbow" ? "Elbow" : "Straight";
  const out: Command[] = [];
  for (const st of ARROW_STYLES) {
    if (d && store.canEdit && st !== diagramArrows) {
      out.push({
        id: `arrows-diagram-${st}`,
        label: `Arrows: ${name(st)} on this diagram`,
        hint: "for everyone",
        run: () =>
          void run(
            [{ op: "diagram.put", diagram: { ...d, arrows: st, updatedAt: now() } }],
            `arrows ${st}`,
          ).then(() => toast(`${name(st)} arrows on ${d.name}. ⌘Z undoes it`)),
      });
    }
  }
  for (const st of ARROW_STYLES) {
    const others = [...idx.diagrams.values()].filter((x) => (x.arrows ?? "curved") !== st);
    if (store.canEdit && others.length > 1) {
      out.push({
        id: `arrows-all-${st}`,
        label: `Arrows: ${name(st)} on every diagram`,
        hint: "for everyone",
        run: () =>
          void run(
            others.map((x) => ({
              op: "diagram.put" as const,
              diagram: { ...x, arrows: st, updatedAt: now() },
            })),
            `arrows ${st} everywhere`,
          ).then(() => toast(`${name(st)} arrows on every diagram. ⌘Z undoes it`)),
      });
    }
  }
  for (const st of ARROW_STYLES) {
    if (st === myArrows) continue;
    out.push({
      id: `arrows-me-${st}`,
      label: `Arrows: ${name(st)}, just for me`,
      hint: "this browser",
      run: () => {
        const before = myArrows;
        setMyArrows(st);
        toast(`${name(st)} arrows, just for you`, {
          label: "Undo",
          run: () => setMyArrows(before),
        });
      },
    });
  }
  if (myArrows) {
    out.push({
      id: "arrows-me-clear",
      label: `Arrows: use the diagram's (${name(diagramArrows).toLowerCase()})`,
      hint: "this browser",
      run: () => {
        const before = myArrows;
        setMyArrows(null);
        toast(`Arrows follow the diagram again`, {
          label: "Undo",
          run: () => setMyArrows(before),
        });
      },
    });
  }
  return out;
}
/** Fit, centre, zoom, place a kind, connect, a new flow. */
function viewCommands(c: CommandCtx): (Command | null)[] {
  const { scene, simple, setTool, startFlow } = c;
  return [
    { id: "fit", label: "Fit to screen", hint: "F", run: () => scene.current?.fit() },
    { id: "center", label: "Centre the view", run: () => scene.current?.center() },
    { id: "zoom100", label: "Zoom to 100%", run: () => scene.current?.zoomTo(1) },
    ...OBJECT_KINDS.filter((k) => !(simple && k === "library")).map((k, i) => ({
      id: `place-${k}`,
      label: `Place ${KIND_LABEL[k].toLowerCase()}`,
      hint: String(i + 2),
      run: () => setTool(k),
    })),
    { id: "connect", label: "Connect two boxes", hint: "C", run: () => setTool("connect") },
    { id: "new-flow", label: "New flow on this diagram", run: () => startFlow() },
  ];
}

/** Marking confusion, reports, the performance meter, recording the trail. */
function reportCommands(c: CommandCtx): (Command | null)[] {
  const { toast, setMarking, setReport, perfOn, setPerfOn } = c;
  return [
    backend.trail
      ? {
          id: "mark-confusing",
          label: "Mark this as confusing",
          hint: "! · say what you were trying to do; kept in your trail for an agent to read",
          run: () => setMarking(""),
        }
      : null,
    backend.report
      ? {
          id: "report-bug",
          label: "Report a bug",
          hint: "what went wrong; sent with where you are, the frame rate and recent errors",
          run: () => setReport("bug"),
        }
      : null,
    backend.report
      ? {
          id: "request-feature",
          label: "Request a feature",
          hint: "what you'd like Archnemesis to do",
          run: () => setReport("feature"),
        }
      : null,
    {
      id: "perf-meter",
      label: perfOn ? "Hide performance meter" : "Show performance meter",
      hint: "frame rate, frame time, re-renders, stalls and memory, in a corner; remembered in this browser",
      run: () => {
        setPerfMeterOn(!perfOn);
        setPerfOn(!perfOn);
      },
    },
    backend.trail
      ? {
          id: "record-trail",
          label: recording() ? "Stop recording my navigation" : "Record my navigation",
          hint: "where you go between views and how, in this browser, so an agent can read it (trail) and find where you get lost",
          run: () => {
            setRecording(!recording());
            toast(
              recording()
                ? "Recording your moves between views. ⌘K again to stop; ask an agent to read the trail."
                : "Stopped recording your moves.",
            );
          },
        }
      : null,
  ];
}

/** A new diagram, and whether this one follows the model. */
function diagramCommands(c: CommandCtx): (Command | null)[] {
  const { idx, diagramId, run, toast, navigate } = c;
  return [
    {
      id: "new-diagram",
      label: "New diagram",
      run: () => {
        const { ops, diagram } = newDiagram("Untitled diagram");
        void run(ops, "new diagram").then(() => navigate(diagram.id, null, "new"));
      },
    },
    (() => {
      const d = diagramId ? idx.diagrams.get(diagramId) : undefined;
      if (!d) return null;
      return d.rules
        ? {
            id: "rules-off",
            label: "Hand-pick this diagram (stop following the model)",
            run: () =>
              void run(
                [{ op: "diagram.put", diagram: { ...d, rules: null, updatedAt: now() } }],
                "hand-pick diagram",
              ),
          }
        : {
            id: "rules-on",
            label: "Make this diagram follow the model",
            run: () => {
              void run(
                [{ op: "diagram.put", diagram: { ...adoptRules(idx, d), updatedAt: now() } }],
                "diagram follows the model",
              ).then(() =>
                toast(
                  d.scopeId
                    ? `New things inside ${idx.objects.get(d.scopeId)?.name} will show up here`
                    : "Boxes you add stay; rules live in the diagram's file",
                ),
              );
            },
          };
    })(),
  ];
}

/** Straighten the diagram or the picked boxes. */
function straightenCommands(c: CommandCtx): (Command | null)[] {
  const { idx, diagramId, graph, store, sel, run, toast } = c;
  if (!(graph && store.canEdit)) return [];
  return [
    {
      id: "straighten",
      label:
        sel.nodes.length >= 2
          ? `Straighten the ${sel.nodes.length} selected boxes`
          : "Straighten this diagram",
      hint: "rows and columns",
      run: () => {
        const moved = straighten(graph.nodes, graph.edges, {
          only: sel.nodes.length >= 2 ? new Set(sel.nodes) : undefined,
        });
        if (!diagramId || !moved.size) return toast("Already straight");
        const moves = [...moved].map(([id, p]) => ({ id, ...p }));
        const before = new Map(graph.nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
        const bends: Op[] = shiftBends(
          graph.edges.flatMap((e) => (e.shape ? [e.shape] : [])),
          before,
          moved,
        ).map((arrow) => ({ op: "arrow.put", arrow }));
        void run([...moveOps(idx, diagramId, moves), ...bends], "straighten").then(() =>
          toast(`Straightened ${moves.length} box${moves.length === 1 ? "" : "es"}. ⌘Z undoes it`),
        );
      },
    },
  ];
}

/** Lay out left to right or top to bottom. */
function layoutDirectionCommands(c: CommandCtx): (Command | null)[] {
  const { idx, diagramId, graph, store, run, toast, scene } = c;
  if (!(graph && store.canEdit)) return [];
  return [
    ...LAYOUT_DIRECTIONS.map((direction) => ({
      id: `layout-${direction}`,
      label: direction === "right" ? "Lay out left to right" : "Lay out top to bottom",
      hint: "callers first",
      run: () => {
        if (!diagramId) return;
        void (async () => {
          const { layoutOps } = await import("../../shared/layout.ts");
          const ops = await layoutOps(idx, diagramId, direction, store.config.tags);
          if (!ops.length) return toast("Already laid out that way");
          await run(ops, "lay out");
          scene.current?.fit();
          toast(`Laid out ${graph.nodes.length} boxes. ⌘Z undoes it`);
        })();
      },
    })),
  ];
}

/** Keep tidy, boundaries. */
function tidyCommands(c: CommandCtx, d: Diagram): (Command | null)[] {
  const { idx, store, run, toast, scene } = c;
  const keep = LAYOUT_DIRECTIONS.filter((dir) => !(d.keepTidy && dir === d.tidy)).map(
    (direction) => ({
      id: `tidy-${direction}`,
      label: `Keep tidy, ${direction === "right" ? "left to right" : "top to bottom"}`,
      hint: "lays out when boxes or arrows change",
      run: () =>
        void (async () => {
          const { layoutOps } = await import("../../shared/layout.ts");
          const ops: Op[] = [
            {
              op: "diagram.put",
              diagram: { ...d, tidy: direction, keepTidy: true, updatedAt: now() },
            },
            ...(await layoutOps(idx, d.id, direction, store.config.tags)),
          ];
          await run(ops, "keep tidy");
          scene.current?.fit();
          toast(
            `Keeping ${d.name} tidy: it lays itself out when boxes or arrows come or go. ⌘Z undoes it`,
          );
        })(),
    }),
  );
  const stop = d.keepTidy
    ? [
        {
          id: "tidy-off",
          label: "Stop keeping tidy",
          hint: "boxes stay where they are",
          run: () =>
            void run(
              [
                {
                  op: "diagram.put",
                  diagram: { ...d, keepTidy: false, updatedAt: now() },
                },
              ],
              "stop keeping tidy",
            ).then(() => toast(`${d.name} stays as you place it`)),
        },
      ]
    : [];
  // Boundaries (projects, networks): frames around the boxes, where there are any.
  const frames = idx.boundaries.size
    ? [
        {
          id: "boundaries",
          label: d.boundaries ? "Hide boundaries" : "Show boundaries",
          hint: "projects, networks and subnets as frames",
          run: () =>
            void run(
              [
                {
                  op: "diagram.put",
                  diagram: { ...d, boundaries: !d.boundaries, updatedAt: now() },
                },
              ],
              d.boundaries ? "hide boundaries" : "show boundaries",
            ),
        },
      ]
    : [];
  return [...keep, ...stop, ...frames];
}

/** Colour by a tag group, fold externals, lanes, a story. */
function lookCommands(c: CommandCtx, d: Diagram): (Command | null)[] {
  const { store, run, scene } = c;
  // Colour by a tag group from archnm.yaml (personal-data, risk): for everyone.
  const colours = [
    ...Object.entries(store.config.tags ?? {})
      .filter(([g]) => g !== d.colorBy)
      .map(([g, t]) => ({
        id: `color-by-${g}`,
        label: `Colour by ${g}`,
        hint: t.description ?? t.values.join(", "),
        run: () =>
          void run(
            [{ op: "diagram.put", diagram: { ...d, colorBy: g, updatedAt: now() } }],
            `colour by ${g}`,
          ),
      })),
    ...(d.colorBy
      ? [
          {
            id: "color-by-off",
            label: "Stop colouring",
            hint: `by ${d.colorBy}`,
            run: () =>
              void run(
                [
                  {
                    op: "diagram.put",
                    diagram: { ...d, colorBy: null, updatedAt: now() },
                  },
                ],
                "stop colouring",
              ),
          },
        ]
      : []),
  ];
  // Readability: fold externals, lanes by a tag group, a story to read it by.
  const folding = foldMode(d) !== "none";
  const put = (patch: Partial<typeof d>, label: string) =>
    void run([{ op: "diagram.put", diagram: { ...d, ...patch, updatedAt: now() } }], label);
  const readability = [
    {
      id: "fold",
      label: folding ? "Unfold externals" : "Fold externals",
      hint: folding
        ? "draw each vendor as its own box"
        : "vendors into one box, their arrows meet there",
      run: () =>
        put({ fold: folding ? "none" : "groups" }, folding ? "unfold externals" : "fold externals"),
    },
    ...(folding
      ? [
          {
            id: "fold-mode",
            label:
              foldMode(d) === "groups" ? "Fold externals into one box" : "Fold externals by group",
            hint: foldMode(d) === "groups" ? "not one per group: tag" : "one box per group: tag",
            run: () =>
              put({ fold: foldMode(d) === "groups" ? "externals" : "groups" }, "fold externals"),
          },
        ]
      : []),
    ...Object.keys(store.config.tags ?? {})
      .filter((g) => g !== d.lanes)
      .map((g) => ({
        id: `lanes-${g}`,
        label: `Lanes by ${g}`,
        hint: "a column per value; tidy to line them up",
        run: () => put({ lanes: g }, `lanes by ${g}`),
      })),
    ...(d.lanes
      ? [
          {
            id: "lanes-off",
            label: "No lanes",
            hint: `by ${d.lanes}`,
            run: () => put({ lanes: null }, "no lanes"),
          },
        ]
      : []),
    {
      id: "story",
      label: d.story ? "How to read this diagram" : "Add a story",
      hint: "its story and agent context, in the panel (or click the frame's title)",
      run: () => scene.current?.select({ nodes: [], edge: null, diagram: true }, true),
    },
  ];
  return [...colours, ...readability];
}

/** The commands that depend on this diagram's own settings. */
function diagramViewCommands(c: CommandCtx): (Command | null)[] {
  const { diagramId, idx, graph, store } = c;
  if (!(graph && store.canEdit)) return [];
  const d = diagramId ? idx.diagrams.get(diagramId) : undefined;
  if (!d) return [];
  return [...tidyCommands(c, d), ...lookCommands(c, d)];
}

/** Reset joints. */
function jointCommands(c: CommandCtx): (Command | null)[] {
  const { diagramId, graph, store, sel, run, toast } = c;
  if (!(graph && store.canEdit && diagramId && graph.edges.some((e) => e.shape))) return [];
  return [
    ...(sel.edge && graph.edges.find((e) => e.id === sel.edge)?.shape
      ? [
          {
            id: "arrow-reset",
            label: "Reset this arrow's joints",
            hint: "sides, bends, label",
            run: () => {
              const e = graph.edges.find((x) => x.id === sel.edge)!;
              void run([{ op: "arrow.delete", diagramId, from: e.from, to: e.to }], "reset arrow");
            },
          },
        ]
      : []),
    {
      id: "arrows-reset",
      label: "Reset all joints on this diagram",
      hint: `${graph.edges.filter((e) => e.shape).length} shaped`,
      run: () => {
        const ops: Op[] = graph.edges
          .filter((e) => e.shape)
          .map((e) => ({ op: "arrow.delete", diagramId, from: e.from, to: e.to }));
        void run(ops, "reset joints").then(() =>
          toast(
            `Reset the joints of ${ops.length} arrow${ops.length === 1 ? "" : "s"}. ⌘Z undoes it`,
          ),
        );
      },
    },
  ];
}

/** Up, undo, redo, export, minimap, animation, shortcuts, diff. */
function tailCommands(c: CommandCtx): (Command | null)[] {
  const {
    store,
    backTo,
    upName,
    up,
    exportAs,
    minimap,
    setMinimap,
    animate,
    setAnimate,
    setHelp,
    showNew,
    setShowNew,
  } = c;
  return [
    { id: "up", label: backTo ? `Back to ${upName}` : "Up a level", hint: "⌘↑", run: up },
    { id: "undo", label: "Undo", hint: "⌘Z", run: () => void store.undo() },
    { id: "redo", label: "Redo", hint: "⇧⌘Z", run: () => void store.redo() },
    { id: "png", label: "Export diagram as PNG", hint: "⇧⌘E", run: () => void exportAs("png") },
    { id: "json", label: "Export model as JSON", run: () => void exportAs("json") },
    {
      id: "minimap",
      label: minimap ? "Hide minimap" : "Show minimap",
      hint: "M",
      run: () => setMinimap((m) => !m),
    },
    {
      id: "animate",
      label: animate ? "Animate only what's selected" : "Animate every arrow",
      hint: "A",
      run: () => setAnimate((v) => !v),
    },
    { id: "shortcuts", label: "Keyboard shortcuts", hint: "?", run: () => setHelp(true) },
    ...(store.branch
      ? [
          {
            id: "diff",
            label: showNew ? "Stop diffing with main" : "Diff with main",
            hint: "D",
            run: () => setShowNew((v) => !v),
          },
        ]
      : []),
  ];
}

/** Everything without a button of its own lives in ⌘K. */
export function buildCommands(c: CommandCtx): Command[] {
  return [
    ...viewCommands(c),
    ...reportCommands(c),
    ...diagramCommands(c),
    ...straightenCommands(c),
    ...layoutDirectionCommands(c),
    ...diagramViewCommands(c),
    ...arrowCommands(c),
    ...jointCommands(c),
    ...tailCommands(c),
  ].filter((x): x is Command => x !== null);
}
