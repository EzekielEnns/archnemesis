// An agent on a long job (mapping a code base) says what it's on with the MCP progress
// tool: a strip across the top of the design, with a bar when it gives step and of.
import { Bot, Check } from "lucide-react";
import type { HereEntry } from "../../shared/api.ts";

export function JobBanner({ here, design }: { here: HereEntry[]; design: string }) {
  const jobs = here.filter((e) => e.doc === design && e.progress);
  if (!jobs.length) return null;
  return (
    <div className="job-banners">
      {jobs.map((e) => {
        const p = e.progress!;
        const pct = p.of
          ? Math.min(100, Math.round(((p.done ? p.of : (p.step ?? 0)) / p.of) * 100))
          : null;
        return (
          <div key={e.user.id} className={`job-banner${p.done ? " done" : ""}`} role="status">
            {p.done ? <Check size={14} /> : <Bot size={14} />}
            <span className="job-who">{e.user.name}</span>
            <span className="job-text">{p.text}</span>
            {p.of && !p.done && (
              <span className="job-count">
                {p.step ?? 0} of {p.of}
              </span>
            )}
            {pct !== null && (
              <span className="job-bar">
                <span style={{ width: `${pct}%` }} />
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
