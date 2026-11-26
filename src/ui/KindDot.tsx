import type { ObjectKind } from "../../shared/model.ts";

export const KIND_CSS: Record<ObjectKind, string> = {
  actor: "#a78bfa",
  system: "#60a5fa",
  app: "#34d399",
  store: "#fbbf24",
  component: "#f472b6",
  module: "#f0a060",
  function: "#7dcfcf",
  library: "#c792ea",
  table: "#f2c46d",
};

export function KindDot({ kind, external = false }: { kind: ObjectKind; external?: boolean }) {
  const color = KIND_CSS[kind];
  return (
    <span
      className="dot"
      style={
        external
          ? { border: `2px solid ${color}`, background: "transparent" }
          : { background: color }
      }
    />
  );
}
