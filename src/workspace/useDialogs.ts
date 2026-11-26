// Which dialogs and pop-ups are open: the command palette, the shortcuts sheet, the report and
// "this is confusing" dialogs, settings, the layers panel and the performance meter.
import { useState } from "react";
import { type SettingsSection } from "../ui/LeftPanel";
import { perfMeterOn } from "../ui/Perf";
import { backFromGitHub } from "../storage";
import { type ReportKind } from "../ui/Report";

export function useDialogs() {
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  // The performance meter (remembered per browser) and the bug or feature report being written.
  const [perfOn, setPerfOn] = useState(perfMeterOn);
  const [report, setReport] = useState<ReportKind | null>(null);
  // "This is confusing": a line about what you were trying to do, kept in your trail.
  const [marking, setMarking] = useState<string | null>(null);
  // Settings, open at a section (the save icon opens it at the repo, your avatar at the account).
  // Back from connecting GitHub: straight to the repo settings, to pick the repo.
  const [settings, setSettings] = useState<SettingsSection | null>(() =>
    backFromGitHub() ? "repo" : null,
  );
  const [layersOpen, setLayersOpen] = useState(false);
  return {
    palette,
    setPalette,
    help,
    setHelp,
    perfOn,
    setPerfOn,
    report,
    setReport,
    marking,
    setMarking,
    settings,
    setSettings,
    layersOpen,
    setLayersOpen,
  };
}
