// A deterministic stress graph for the canvas (?n=2000): clusters of a dozen boxes, wired
// inside each cluster and now and then across. Same seed, same graph. Never touches the model.
import type { ObjectKind } from "../../shared/model.ts";
import { KIND_LABEL } from "../../shared/model.ts";
import {
  NODE_H,
  NODE_W,
  type CanvasEdge,
  type CanvasGraph,
  type CanvasNode,
} from "../canvas/types";

/** mulberry32: a tiny seeded PRNG, enough for test data. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ADJ = [
  "billing",
  "identity",
  "edge",
  "signal",
  "ledger",
  "search",
  "notify",
  "media",
  "risk",
  "report",
  "audit",
  "session",
];
const NOUN = [
  "api",
  "worker",
  "gateway",
  "store",
  "queue",
  "cache",
  "service",
  "console",
  "scheduler",
  "index",
  "bus",
  "proxy",
];
const KINDS: ObjectKind[] = ["system", "app", "app", "app", "store", "store", "actor", "component"];

const PER_CLUSTER = 12;
const COLS = 4; // boxes per row in a cluster
const GAP_X = 64;
const GAP_Y = 72;
const CLUSTER_GAP = 220;

export function generate(count: number, seed = 1): CanvasGraph {
  const rand = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;

  const clusters = Math.ceil(count / PER_CLUSTER);
  const clusterCols = Math.ceil(Math.sqrt(clusters));
  const clusterW = COLS * (NODE_W + GAP_X) - GAP_X;
  const clusterH = Math.ceil(PER_CLUSTER / COLS) * (NODE_H + GAP_Y) - GAP_Y;

  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];
  const edge = (from: CanvasNode, to: CanvasNode) =>
    edges.push({
      id: `e${edges.length}`,
      from: from.id,
      to: to.id,
      label: "",
      connectionIds: [],
      status: "live",
    });

  for (let i = 0; i < count; i++) {
    const c = Math.floor(i / PER_CLUSTER);
    const k = i % PER_CLUSTER;
    const ox = (c % clusterCols) * (clusterW + CLUSTER_GAP);
    const oy = Math.floor(c / clusterCols) * (clusterH + CLUSTER_GAP);
    const kind = pick(KINDS);
    nodes.push({
      id: `n${i}`,
      kind,
      name: `${pick(ADJ)}-${pick(NOUN)}`,
      subtitle: KIND_LABEL[kind],
      x: ox + (k % COLS) * (NODE_W + GAP_X),
      y: oy + Math.floor(k / COLS) * (NODE_H + GAP_Y),
      w: NODE_W,
      h: NODE_H,
      external: false,
      status: "live",
      childCount: 0,
      technology: "",
      hidden: 0,
      tags: [],
    });
  }

  for (let i = 0; i < count; i++) {
    const n = nodes[i] as CanvasNode;
    const k = i % PER_CLUSTER;
    // Each box calls the next one in its row, and the one below it now and then.
    if (k % COLS !== COLS - 1 && i + 1 < count && rand() < 0.8) edge(n, nodes[i + 1] as CanvasNode);
    if (k + COLS < PER_CLUSTER && i + COLS < count && rand() < 0.45)
      edge(n, nodes[i + COLS] as CanvasNode);
    // A few long-range calls into a random other cluster.
    if (rand() < 0.04) edge(n, nodes[Math.floor(rand() * count)] as CanvasNode);
  }

  return { nodes, edges: edges.filter((e) => e.from !== e.to), groups: [] };
}
