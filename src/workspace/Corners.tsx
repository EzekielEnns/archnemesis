// The corners of the page: zoom and minimap bottom left, help and layers bottom right, the people
// island top right, and the bug report.
import { Peers } from "../ui/Peers";
import { Bug } from "lucide-react";
import { layerCounts, LayersButton, LayersPanel } from "../ui/Layers";
import { NotesMenu } from "../ui/Notes";
import { notesOn } from "../../shared/project.ts";
import { backend } from "../backend";
import { PerfMeter, setPerfMeterOn } from "../ui/Perf";
import { ReportDialog } from "../ui/Report";
import { BottomLeft, HelpButton } from "../ui/Chrome";
import { JobBanner } from "../ui/JobBanner";

import type { WorkspaceBag } from "./useInteraction";

/** Zoom, the minimap and animation switches, and the performance meter. */
export function BottomCorner({
  zoom,
  minimap,
  setMinimap,
  animate,
  setAnimate,
  scene,
  perfOn,
  setPerfOn,
}: Pick<
  WorkspaceBag,
  "zoom" | "minimap" | "setMinimap" | "animate" | "setAnimate" | "scene" | "perfOn" | "setPerfOn"
>) {
  return (
    <>
      <BottomLeft
        zoom={zoom}
        minimap={minimap}
        animate={animate}
        onAnimate={() => setAnimate((v) => !v)}
        onZoom={(f) => scene.current?.zoomBy(f)}
        onZoomReset={() => scene.current?.zoomTo(1)}
        onMinimap={() => setMinimap((m) => !m)}
        onCenter={() => scene.current?.center()}
        onFit={() => scene.current?.fit()}
      >
        {perfOn && (
          <PerfMeter
            onClose={() => {
              setPerfMeterOn(false);
              setPerfOn(false);
            }}
          />
        )}
      </BottomLeft>
    </>
  );
}

/** The bug or feature report being written. */
export function ReportHost({
  report,
  setReport,
  toast,
  store,
  idx,
  sel,
  diagramId,
}: Pick<WorkspaceBag, "report" | "setReport" | "toast" | "store" | "idx" | "sel" | "diagramId">) {
  return (
    <>
      {report && (
        <ReportDialog
          kind={report}
          place={{
            design: store.designKey,
            branch: store.branch,
            view: diagramId
              ? { id: diagramId, name: idx.diagrams.get(diagramId)?.name ?? diagramId }
              : null,
            selected: sel.nodes.map((id) => idx.objects.get(id)?.key ?? id),
          }}
          onCancel={() => setReport(null)}
          onDone={(id, error) => {
            setReport(null);
            toast(
              id !== null
                ? `Sent, thanks (#${id}). It's kept with agents' feedback: archnm telemetry feedback.`
                : `Couldn't send it: ${error}`,
              id !== null ? "info" : "error",
            );
          }}
        />
      )}
    </>
  );
}

/** The help button, the report button, and the layers panel. */
export function HelpCorner({
  graph,
  help,
  setHelp,
  setReport,
  layersOpen,
  setLayersOpen,
  idx,
  diagramId,
  layers,
  toggleLayer,
  setAllLayers,
}: Pick<
  WorkspaceBag,
  | "graph"
  | "help"
  | "setHelp"
  | "setReport"
  | "layersOpen"
  | "setLayersOpen"
  | "idx"
  | "diagramId"
  | "layers"
  | "toggleLayer"
  | "setAllLayers"
>) {
  return (
    <>
      <HelpButton on={help} onClick={() => setHelp((h) => !h)}>
        {backend.report && (
          <button
            className="icon-btn"
            onClick={() => setReport("bug")}
            title="Report a bug or request a feature"
          >
            <Bug size={16} />
          </button>
        )}
        <LayersButton
          open={layersOpen}
          active={(["tech", "references", "notes"] as const).filter((k) => layers[k]).length}
          onClick={() => setLayersOpen((o) => !o)}
        />
      </HelpButton>
      {layersOpen && (
        <LayersPanel
          layers={layers}
          counts={{
            ...layerCounts(idx, graph?.nodes ?? []),
            comments: diagramId
              ? notesOn(idx, diagramId).filter((n) => n.note.kind === "note").length
              : 0,
            groups: graph?.groups.filter((g) => g.boundary).length ?? 0,
          }}
          onToggle={toggleLayer}
          onAll={setAllLayers}
          onClose={() => setLayersOpen(false)}
        />
      )}
    </>
  );
}

/** Running jobs, then who else is here and the notes list. */
export function PeersIsland({
  follow,
  openNote,
  setSettings,
  store,
  idx,
  diagramId,
  peers,
  ownTabs,
}: Pick<
  WorkspaceBag,
  "follow" | "openNote" | "setSettings" | "store" | "idx" | "diagramId" | "peers" | "ownTabs"
>) {
  return (
    <>
      <JobBanner here={store.here} design={store.design} />
      <Peers
        store={store}
        onAccount={() => setSettings("account")}
        peers={peers}
        ownTabs={ownTabs}
        diagramName={(id) =>
          id ? (idx.diagrams.get(id)?.name ?? "another diagram") : "nowhere yet"
        }
        onFollow={follow}
        before={
          <>
            <NotesMenu idx={idx} diagramId={diagramId} onOpen={openNote} />
            <span className="sep" />
          </>
        }
      />
    </>
  );
}
