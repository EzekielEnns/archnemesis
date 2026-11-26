// Reads the old name: installs from before the rename set ATLAS_* variables. Each one whose
// ARCHNM_* twin is unset is copied across, with one warning on stderr. Import this first in
// every entry point, before anything reads process.env.
const OLD = "ATLAS_";
const NEW = "ARCHNM_";

const copied: string[] = [];
for (const [name, value] of Object.entries(process.env)) {
  if (!name.startsWith(OLD) || value === undefined) continue;
  const next = NEW + name.slice(OLD.length);
  if (process.env[next] !== undefined) continue;
  process.env[next] = value;
  copied.push(name);
}
if (copied.length)
  console.error(
    `archnm: ${copied.join(", ")} ${copied.length === 1 ? "is" : "are"} the old name${copied.length === 1 ? "" : "s"}; use ${copied.map((n) => NEW + n.slice(OLD.length)).join(", ")} instead (still read for now)`,
  );
