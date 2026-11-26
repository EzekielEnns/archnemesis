// How a tool call went, from its arguments and its answer: which mode of the tool it used, and
// whether it was ok, refused (Not written), invalid or an exception. Shared, so the page's
// WebMCP judges its calls the same way the server does (server/telemetry.ts keeps them).

export type Outcome = "ok" | "refused" | "invalid" | "exception";

/** Which option or action of a tool a call used: what read was asked, what write did. */
export function modeOf(tool: string, a: Record<string, unknown> = {}): string {
  const has = (k: string) => a[k] !== undefined && a[k] !== null && a[k] !== "" && a[k] !== false;
  if (tool === "read") {
    if (has("here")) return "here";
    if (has("history")) return "history";
    if (has("file")) return "file";
    if (has("lens")) return `lens:${String(a.lens)}`;
    if (has("from") || has("to")) return "route";
    if (has("scope")) return "scope";
    if (has("view")) return "view";
    if (has("ref") && has("impact")) return "impact";
    if (has("ref") && (has("depth") || has("follow"))) return "walk";
    if (has("ref")) return "ref";
    if (has("q") || has("kind") || has("in")) return "search";
    return "overview";
  }
  if (tool === "write") {
    if (has("undo")) return has("dry_run") ? "undo:dry" : "undo";
    const parts = ["yaml", "files", "remove", "tidy"].filter(has);
    return `${parts.join("+") || "empty"}${has("dry_run") ? ":dry" : ""}`;
  }
  if (tool === "show")
    return ["tour", "render", "done", "open", "spotlight", "view"].find(has) ?? "none";
  if (tool === "note" || tool === "design") return String(a.action ?? "list");
  if (tool === "index") return String(a.action ?? "");
  if (tool === "guide") return String(a.topic ?? "index");
  if (tool === "feedback") return String(a.kind ?? "");
  return "";
}

/** What an answer's text says about how it went: refused, invalid, or ok, with its error and warning lines. */
export function judge(
  text: string,
  isError: boolean,
): { outcome: Outcome; errors: number; warnings: number; firstError: string | null } {
  const lines = text.split("\n");
  const errs = lines.filter((l) => l.startsWith("error: "));
  const warnings = lines.filter((l) => l.startsWith("warning: ")).length;
  if (!isError) return { outcome: "ok", errors: 0, warnings, firstError: null };
  const refused = /^Not written\b/.test(text);
  return {
    outcome: refused ? "refused" : "invalid",
    errors: Math.max(1, errs.length),
    warnings,
    firstError: (errs[0] ?? (refused ? lines[1] : lines[0]) ?? "").slice(0, 400) || null,
  };
}
