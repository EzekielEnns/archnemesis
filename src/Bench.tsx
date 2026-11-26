import { backend } from "./backend";
import { useEffect, useRef, useState } from "react";
import { Scene, type SceneStats } from "./canvas/Scene";
import { generate } from "./demo/generate";

// The canvas stress test (?n=500|2000|5000|10000): a generated graph and a frame meter,
// nothing saved. The real app is Workspace.
const SIZES = [500, 2000, 5000, 10000];

export function Bench({ count }: { count: number }) {
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<Scene | null>(null);
  const [stats, setStats] = useState<SceneStats | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const s = new Scene({ onStats: setStats, loadIcon: (t, c) => backend.icons.svg(t, c) });
    if (import.meta.env.DEV) (window as unknown as { __scene: Scene }).__scene = s;
    void s.init(el).then((ok) => {
      if (!ok) return;
      scene.current = s;
      s.sync(generate(count));
      s.fit();
    });
    return () => {
      scene.current = null;
      s.destroy();
    };
  }, [count]);

  return (
    <div className="bench">
      <div ref={host} className="canvas" />
      <header className="toolbar floating">
        <a className="brand" href="/">
          Archnemesis
        </a>
        <span className="sep" />
        <label>
          boxes
          <select value={count} onChange={(e) => (location.search = `?n=${e.target.value}`)}>
            {SIZES.map((n) => (
              <option key={n} value={n}>
                {n.toLocaleString()}
              </option>
            ))}
          </select>
        </label>
        <button onClick={() => scene.current?.fit()}>
          Fit <kbd>F</kbd>
        </button>
      </header>
      {stats && <Meter stats={stats} />}
    </div>
  );
}

export function benchSize(): number | null {
  const n = Number(new URLSearchParams(location.search).get("n"));
  return SIZES.includes(n) ? n : null;
}

function Meter({ stats }: { stats: SceneStats }) {
  const tone = stats.fps === 0 ? "idle" : stats.fps >= 55 ? "good" : stats.fps >= 30 ? "ok" : "bad";
  return (
    <aside className="meter">
      <div className={`fps ${tone}`}>{stats.fps === 0 ? "idle" : `${stats.fps} fps`}</div>
      <div>{stats.frameMs.toFixed(1)} ms cpu / frame</div>
      <div>{Math.round(stats.scale * 100)}% zoom</div>
      <div>
        {stats.visible.toLocaleString()} / {stats.nodes.toLocaleString()} boxes drawn
      </div>
      <div>{stats.edges.toLocaleString()} edges</div>
    </aside>
  );
}
