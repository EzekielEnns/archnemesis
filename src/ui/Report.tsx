// Report a bug or request a feature, from the app: kept on the server with agents' feedback
// (`archnm telemetry feedback` lists both), with where you were and how the page was doing.
import { useState } from "react";
import { backend } from "../backend";
import { Dialog } from "./Dialog";
import { perfSnapshot, recentErrors } from "./Perf";

export type ReportKind = "bug" | "feature";

export interface ReportPlace {
  design: string;
  branch?: string | null;
  view?: { id: string; name: string } | null;
  selected: string[];
}

export function ReportDialog({
  kind: start,
  place,
  onDone,
  onCancel,
}: {
  kind: ReportKind;
  place: ReportPlace;
  onDone: (id: number | null, error?: string) => void;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<ReportKind>(start);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [attach, setAttach] = useState(true);
  const send = async () => {
    setBusy(true);
    const context = attach
      ? {
          url: location.href,
          view: place.view ?? null,
          branch: place.branch ?? null,
          selected: place.selected.slice(0, 20),
          screen: `${innerWidth}×${innerHeight} @${devicePixelRatio}x`,
          browser: navigator.userAgent,
          perf: perfSnapshot(),
          errors: recentErrors().slice(-8),
        }
      : undefined;
    try {
      if (!backend.report) throw new Error("reports aren't kept here");
      onDone(
        await backend.report.send({
          kind,
          text: text.trim(),
          design: place.design,
          ...(context ? { context } : {}),
        }),
      );
    } catch (e) {
      onDone(null, (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={kind === "bug" ? "Report a bug" : "Request a feature"}
      confirm={kind === "bug" ? "Send report" : "Send request"}
      busy={busy}
      disabled={!text.trim() || busy}
      onConfirm={() => void send()}
      onCancel={onCancel}
    >
      <div className="report-kinds" role="radiogroup">
        {(["bug", "feature"] as const).map((k) => (
          <button
            key={k}
            role="radio"
            aria-checked={kind === k}
            className={kind === k ? "chip on" : "chip"}
            onClick={() => setKind(k)}
          >
            {k === "bug" ? "Bug" : "Feature"}
          </button>
        ))}
      </div>
      <textarea
        className="dialog-input report-text"
        rows={5}
        value={text}
        placeholder={
          kind === "bug"
            ? "What happened, and what you expected (e.g. dragging a frame moved only one box)"
            : "What you'd like to do, and why (e.g. comments on arrows, like on boxes)"
        }
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim()) void send();
        }}
      />
      <label className="muted small report-attach">
        <input type="checkbox" checked={attach} onChange={(e) => setAttach(e.target.checked)} />{" "}
        Include where I am ({place.view?.name ?? place.design}
        {place.selected.length ? `, ${place.selected.length} selected` : ""}), frame rate and recent
        errors
      </label>
    </Dialog>
  );
}
