// A fork's changes drawn on the canvas like a file diff, over the boxes:
//   new       a green outline and "+ new"
//   changed   a +n −n badge, and under the box its old lines (struck, red) and new ones (green)
//   deleted   drawn by the scene as a real box (main's, put back for the diff), tagged here
// It only draws; the boxes themselves are the scene's.
import { useEffect, useState } from "react";
import { RotateCcw, X } from "lucide-react";
import type { Op } from "../../shared/model";
import type { CanvasNode, ModelIndex } from "../../shared/project";
import type { Removed, RemovedView, WhatsNew } from "../../shared/whatsnew";
import { worldToScreen } from "../canvas/camera";
import type { Scene, SceneView } from "../canvas/Scene";

interface Props {
  scene: Scene | null;
  diagramId: string | null;
  nodes: CanvasNode[];
  diff: WhatsNew;
  /** Boxes that are main's deleted things, drawn for the diff. */
  gone: Set<string>;
}

/** Lines shown under a box before "+n more". */
const SHOWN = 4;

export function DiffLayer(p: Props) {
  const [view, setView] = useState<SceneView | null>(null);
  useEffect(() => {
    const off = p.scene?.watch((v) => setView({ camera: v.camera, moving: v.moving }));
    return () => void off?.();
  }, [p.scene]);
  if (!view) return null;
  const cam = view.camera;
  const added = new Set(p.diff.added ?? []);
  const lines = p.diff.lines ?? {};
  const at = (x: number, y: number, w: number, h: number) => {
    const a = worldToScreen(cam, { x, y });
    return { left: a.x, top: a.y, width: w * cam.scale, height: h * cam.scale };
  };
  const detail = cam.scale >= 0.55;

  const marks = p.nodes.flatMap((n) => {
    const m = view.moving.get(n.id);
    const box = at(m?.x ?? n.x, m?.y ?? n.y, n.w, n.h);
    if (p.gone.has(n.id)) {
      return [
        <div key={n.id} className="diff-box gone" style={box}>
          <span className="diff-tag gone">− deleted · on main</span>
        </div>,
      ];
    }
    if (added.has(n.id)) {
      return [
        <div key={n.id} className="diff-box added" style={box}>
          <span className="diff-tag added">+ new</span>
        </div>,
      ];
    }
    const ls = lines[n.id];
    if (!ls?.length) return [];
    const plus = ls.filter((l) => l[0] === "+").length;
    const minus = ls.length - plus;
    return [
      <div key={n.id} className="diff-box changed" style={box}>
        <span className="diff-tag changed">
          {plus > 0 && <b className="plus">+{plus}</b>}
          {minus > 0 && <b className="minus">−{minus}</b>}
        </span>
        {detail && (
          <div className="diff-lines" style={{ top: box.height + 6 }}>
            {ls.slice(0, SHOWN).map(([sign, text], i) => (
              <div key={i} className={sign === "+" ? "dl plus" : "dl minus"}>
                <span className="dl-sign">{sign === "+" ? "+" : "−"}</span>
                {text}
              </div>
            ))}
            {ls.length > SHOWN && <div className="dl more">+{ls.length - SHOWN} more</div>}
          </div>
        )}
      </div>,
    ];
  });

  return <div className="diff-layer">{marks}</div>;
}

/** What putting a deleted thing back takes: it, anything deleted it was inside (first), its boxes, and its lines whose other end is here. */
function restoreOps(r: Removed, all: Removed[], idx: ModelIndex, views: RemovedView[] = []): Op[] {
  const byId = new Map(all.map((x) => [x.restore.object.id, x]));
  const chain: Removed[] = [];
  for (
    let cur: Removed | undefined = r;
    cur;
    cur = cur.restore.object.parentId ? byId.get(cur.restore.object.parentId) : undefined
  )
    chain.unshift(cur);
  const back = new Set(chain.map((x) => x.restore.object.id));
  const there = (id: string) => idx.objects.has(id) || back.has(id);
  const ops: Op[] = [];
  for (const x of chain) ops.push({ op: "object.put", object: x.restore.object });
  for (const x of chain)
    for (const pl of x.restore.placements)
      if (idx.diagrams.has(pl.diagramId)) ops.push({ op: "placement.put", placement: pl });
  // Its own view (and those of what it was inside) as on main, with the boxes on it that are here.
  for (const v of views) {
    if (!v.diagram.scopeId || !back.has(v.diagram.scopeId)) continue;
    ops.push({ op: "diagram.put", diagram: v.diagram });
    for (const pl of v.placements)
      if (there(pl.objectId)) ops.push({ op: "placement.put", placement: pl });
  }
  const seen = new Set<string>();
  for (const x of chain)
    for (const c of x.restore.connections)
      if (!seen.has(c.id) && there(c.fromId) && there(c.toId))
        (seen.add(c.id), ops.push({ op: "connection.put", connection: c }));
  return ops;
}

/** The card for a deleted thing in a diff: it as it is on main (its YAML), and putting it back. */
export function DeletedCard(p: {
  r: Removed;
  all: Removed[];
  views: RemovedView[];
  idx: ModelIndex;
  canEdit: boolean;
  onRestore: (ops: Op[], label: string) => void;
  onClose: () => void;
}) {
  const lines = p.all.length ? p.r.restore.connections.length : 0;
  return (
    <aside className="inspector simple deleted-card">
      <button className="icon panel-close" onClick={p.onClose} title="Close (Esc)">
        <X size={14} />
      </button>
      <div className="body">
        <div className="eyebrow deleted-eyebrow">Deleted on this fork · still on main</div>
        <div className="deleted-name">{p.r.name}</div>
        <div className="flow-label">On main</div>
        <pre className="yaml-block">
          {p.r.yaml
            .replace(/\n$/, "")
            .split("\n")
            .map((l, i) => (
              <div key={i} className="dl minus">
                <span className="dl-sign">−</span>
                {l}
              </div>
            ))}
        </pre>
        {lines > 0 && (
          <p className="deleted-note">
            {lines} line{lines === 1 ? "" : "s"} to it went too: restoring brings back the ones
            whose other end is still here.
          </p>
        )}
      </div>
      <div className="footer">
        <button
          className="act"
          disabled={!p.canEdit}
          onClick={() => p.onRestore(restoreOps(p.r, p.all, p.idx, p.views), `restore ${p.r.name}`)}
          title="Put it back on this fork, as it is on main"
        >
          <RotateCcw size={14} />
          <span>Restore</span>
        </button>
      </div>
    </aside>
  );
}
