'use client';
 
// ─── hooks/usePlanarFill.ts ───────────────────────────────────────────────────
//
//  Vector-based region fill using planar graph face traversal.
//
//  ALGORITHM OVERVIEW
//  ──────────────────
//  1. Build planar graph
//     • Every svgLine is a raw edge.
//     • Each raw edge is split at every intersection point that lies on it
//       (using the pre-computed intersection list from useSvgSnapPoints).
//     • Result: a set of atomic half-edges where every node has degree ≥ 2
//       at true junctions.
//
//  2. Find enclosing face (click point → polygon)
//     • Project click onto nearest edge to get a seed directed half-edge.
//     • From each node, follow the "most clockwise next edge" rule:
//         given arrival direction θ_in, sort outgoing edges by
//         (θ_out - θ_in + 360) mod 360 ASCENDING and take the first.
//       This always traces the minimal (innermost) face to the LEFT of
//       the directed seed edge.
//     • Stop when we return to the seed node+edge (cycle closed) or after
//       a safety iteration cap.
//
//  3. Winding / orientation
//     • The minimal face traced by "most-clockwise" is the left face of
//       the seed directed edge, which is the INTERIOR region the click
//       point falls inside.
//     • We verify with a signed-area (shoelace) check and reverse if needed
//       so the returned polygon is always CCW (standard for rendering).
//
//  COORDINATE SPACE
//  ─────────────────
//  All inputs use PDF-pixel space (0..pdfDims.w × 0..pdfDims.h).
//  svgLines from useSvgSnapPoints use normalised coords (nx1,ny1,nx2,ny2).
//  Pass pdfDims so this hook can convert internally.
//
//  LIMITATIONS (v1)
//  ─────────────────
//  • Straight lines only — curves are approximated as their chord.
//    Curve support can be added by sampling beziers into polylines before
//    graph construction.
//  • Very dense drawings (>3000 split edges) will be slow on first build;
//    subsequent calls are O(face perimeter) via memoised graph.
//  • Open regions (exterior face) return null.
//
// ─────────────────────────────────────────────────────────────────────────────
 
import { useMemo } from 'react';
import type { SvgLine } from '@/hooks/useSvgSnapPoints';
 
// ── Public types ──────────────────────────────────────────────────────────────
 
export interface PlanarFillResult {
  /** Polygon vertices in PDF-pixel space, CCW winding */
  polygon:  Array<[number, number]>;
  /** Approximate area in px² (shoelace) */
  areaPx:   number;
  /** Approximate perimeter in px */
  perimPx:  number;
}
 
export interface PlanarGraph {
  /** nodes[i] = { x, y } in PDF-pixel space */
  nodes:  NodePx[];
  /** half-edges, each edge i has twin at i^1 */
  edges:  HalfEdge[];
  /** adjacency: nodeIdx → sorted list of outgoing half-edge indices */
  adj:    number[][];
}
 
interface NodePx { x: number; y: number }
 
interface HalfEdge {
  from:  number;   // node index
  to:    number;   // node index
  angle: number;   // atan2(dy,dx) in radians, cached
}
 
// ── Geometry helpers ──────────────────────────────────────────────────────────
 
const TAU = Math.PI * 2;
 
function angleBetween(ax: number, ay: number, bx: number, by: number): number {
  return Math.atan2(by - ay, bx - ax);
}
 
/** Signed area via shoelace — positive = CCW */
function signedArea(poly: Array<[number, number]>): number {
  let s = 0;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % n];
    s += x0 * y1 - x1 * y0;
  }
  return s / 2;
}
 
function perimeter(poly: Array<[number, number]>): number {
  let p = 0;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % n];
    p += Math.hypot(x1 - x0, y1 - y0);
  }
  return p;
}
 
/** Point-on-segment test — returns t ∈ [0,1] or null */
function pointOnSegmentT(
  px: number, py: number,
  x1: number, y1: number,
  x2: number, y2: number,
  tolerance: number,
): number | null {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 < 0.01) return null;
  const t = ((px - x1) * dx + (py - y1) * dy) / len2;
  if (t < -0.001 || t > 1.001) return null;
  const cx = x1 + t * dx, cy = y1 + t * dy;
  return Math.hypot(cx - px, cy - py) <= tolerance ? t : null;
}
 
// ── Node deduplication ────────────────────────────────────────────────────────
 
const SNAP_DIST = 4; // px — nodes closer than this are merged
 
function snapKey(x: number, y: number): string {
  return `${Math.round(x / SNAP_DIST)},${Math.round(y / SNAP_DIST)}`;
}
 
class NodePool {
  private map  = new Map<string, number>();
  nodes: NodePx[] = [];
 
  get(x: number, y: number): number {
    const k = snapKey(x, y);
    let i = this.map.get(k);
    if (i === undefined) {
      i = this.nodes.length;
      this.nodes.push({ x, y });
      this.map.set(k, i);
    }
    return i;
  }
}
 
// ── Graph builder ─────────────────────────────────────────────────────────────
 
/**
 * Build a planar half-edge graph from normalised svgLines.
 *
 * @param svgLines     From useSvgSnapPoints — normalised coords
 * @param intersections Pre-computed intersection points in PDF-pixel space
 *                      (from useSvgSnapPoints's intersectionCache)
 * @param pw           PDF width in pixels
 * @param ph           PDF height in pixels
 */
export function buildPlanarGraph(
  svgLines:      SvgLine[],
  intersections: Array<[number, number]>,
  pw:            number,
  ph:            number,
): PlanarGraph {
  const pool = new NodePool();
  const rawEdgePairs: Array<[number, number]> = []; // [fromIdx, toIdx]
 
  const SPLIT_TOL = SNAP_DIST * 1.5;
 
  for (const line of svgLines) {
    const x1 = line.nx1 * pw, y1 = line.ny1 * ph;
    const x2 = line.nx2 * pw, y2 = line.ny2 * ph;
    if (Math.hypot(x2 - x1, y2 - y1) < 1) continue;
 
    // Collect split points on this line
    const splits: Array<{ t: number; x: number; y: number }> = [
      { t: 0, x: x1, y: y1 },
      { t: 1, x: x2, y: y2 },
    ];
 
    for (const [ix, iy] of intersections) {
      const t = pointOnSegmentT(ix, iy, x1, y1, x2, y2, SPLIT_TOL);
      if (t !== null && t > 0.005 && t < 0.995) {
        splits.push({ t, x: ix, y: iy });
      }
    }
 
    splits.sort((a, b) => a.t - b.t);
 
    for (let i = 0; i < splits.length - 1; i++) {
      const a = splits[i], b = splits[i + 1];
      if (Math.hypot(b.x - a.x, b.y - a.y) < 1) continue;
      const ai = pool.get(a.x, a.y);
      const bi = pool.get(b.x, b.y);
      if (ai !== bi) rawEdgePairs.push([ai, bi]);
    }
  }
 
  const nodes = pool.nodes;
  const edges: HalfEdge[] = [];
  const adj: number[][] = Array.from({ length: nodes.length }, () => []);
 
  // Build half-edge pairs
  for (const [a, b] of rawEdgePairs) {
    const eIdx = edges.length; // even index
    const { x: ax, y: ay } = nodes[a];
    const { x: bx, y: by } = nodes[b];
    edges.push({ from: a, to: b, angle: angleBetween(ax, ay, bx, by) }); // eIdx
    edges.push({ from: b, to: a, angle: angleBetween(bx, by, ax, ay) }); // eIdx+1 (twin)
    adj[a].push(eIdx);
    adj[b].push(eIdx + 1);
  }
 
  // Sort adjacency lists by angle for O(log n) next-edge lookup
  for (let i = 0; i < adj.length; i++) {
    adj[i].sort((a, b) => edges[a].angle - edges[b].angle);
  }
 
  return { nodes, edges, adj };
}
 
// ── Face traversal ────────────────────────────────────────────────────────────
 
/**
 * Given a directed half-edge (arriving into node `to` from `from`),
 * return the index of the next half-edge in the left-face traversal.
 *
 * Rule: at node `to`, pick the outgoing edge whose angle is just
 * CLOCKWISE from the reversed arrival direction.
 *
 * In screen-space (Y down) "clockwise" means decreasing angle mod 2π.
 */
function nextFaceEdge(edgeIdx: number, graph: PlanarGraph): number {
  const edge    = graph.edges[edgeIdx];
  const nodeAdj = graph.adj[edge.to];
  if (nodeAdj.length === 0) return -1;
 
  // Reversed arrival angle (the twin's angle)
  const arrivalAngle = graph.edges[edgeIdx ^ 1].angle;
 
  // We want the next edge going CCW around `to` from arrivalAngle.
  // In half-edge planar traversal the left face uses:
  //   "the edge just after arrivalAngle in CCW order"
  // adj is sorted ascending by angle.
  // Find the first outgoing edge with angle > arrivalAngle.
 
  let best = -1;
  let bestDelta = Infinity;
 
  for (const eIdx of nodeAdj) {
    if (eIdx === (edgeIdx ^ 1)) continue; // skip the reverse of incoming
    const outAngle = graph.edges[eIdx].angle;
    // Delta going CCW (counter-clockwise, angle increasing)
    let delta = outAngle - arrivalAngle;
    if (delta <= 0) delta += TAU;
    if (delta < bestDelta) {
      bestDelta = delta;
      best = eIdx;
    }
  }
 
  // If no other edge, the only option is the twin itself (dead end)
  if (best === -1 && nodeAdj.length === 1) return nodeAdj[0];
  return best;
}
 
/**
 * Trace the face to the LEFT of directed half-edge `startEdge`.
 * Returns the ordered polygon vertices, or null if the face is unbounded
 * (cycle exceeds safetyLimit or encloses a suspiciously huge area).
 */
function traceFace(
  startEdge: number,
  graph:     PlanarGraph,
  maxIter:   number = 2000,
): Array<[number, number]> | null {
  const verts: Array<[number, number]> = [];
  let cur = startEdge;
 
  for (let i = 0; i < maxIter; i++) {
    const { from } = graph.edges[cur];
    const { x, y } = graph.nodes[from];
    verts.push([x, y]);
 
    cur = nextFaceEdge(cur, graph);
    if (cur === -1) return null; // dead end — open region
 
    if (graph.edges[cur].from === graph.edges[startEdge].from &&
        cur === startEdge) {
      break; // closed
    }
 
    // Closed cycle detected via start node revisit
    if (i > 2 && graph.edges[cur].from === graph.edges[startEdge].from) {
      break;
    }
  }
 
  if (verts.length < 3) return null;
  return verts;
}
 
// ── Seed edge finder ──────────────────────────────────────────────────────────
 
/**
 * Find the half-edge that, when used as seed, gives the face containing
 * (clickX, clickY).
 *
 * Strategy: find the nearest edge to the click point, then pick the
 * directed half-edge where the click point is to the LEFT.
 */
function findSeedEdge(
  clickX: number,
  clickY: number,
  graph:  PlanarGraph,
  searchRadius: number = 200,
): number | null {
  let bestDist  = Infinity;
  let bestEdge  = -1;
 
  // Only consider even-indexed edges (each pair represents one line)
  for (let i = 0; i < graph.edges.length; i += 2) {
    const e   = graph.edges[i];
    const { x: x1, y: y1 } = graph.nodes[e.from];
    const { x: x2, y: y2 } = graph.nodes[e.to];
 
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1) continue;
 
    const t = Math.max(0, Math.min(1, ((clickX - x1) * dx + (clickY - y1) * dy) / len2));
    const cx = x1 + t * dx, cy = y1 + t * dy;
    const dist = Math.hypot(clickX - cx, clickY - cy);
 
    if (dist < bestDist) {
      bestDist = dist;
      // Determine which directed half-edge has click on its left side
      // Cross product (edge dir) × (click - edge start) > 0 → left of edge i
      const cross = dx * (clickY - y1) - dy * (clickX - x1);
      bestEdge = cross >= 0 ? i : i + 1;
    }
  }
 
  if (bestEdge === -1 || bestDist > searchRadius) return null;
  return bestEdge;
}
 
// ── Main exported function ────────────────────────────────────────────────────
 
/**
 * Find the minimal polygon enclosing (clickX, clickY) in the planar graph.
 *
 * Returns null if the click is in the exterior (unbounded) face or too
 * far from any edge.
 */
export function findEnclosingPolygon(
  clickX: number,
  clickY: number,
  graph:  PlanarGraph,
  opts: {
    searchRadius?: number;
    maxIter?:      number;
    /** Max area in px² — reject huge/exterior faces */
    maxAreaPx?:    number;
  } = {},
): PlanarFillResult | null {
  const {
    searchRadius = 300,
    maxIter      = 2000,
    maxAreaPx    = Infinity,
  } = opts;
 
  const seedEdge = findSeedEdge(clickX, clickY, graph, searchRadius);
  if (seedEdge === null) return null;
 
  const polygon = traceFace(seedEdge, graph, maxIter);
  if (!polygon || polygon.length < 3) return null;
 
  const area = Math.abs(signedArea(polygon));
  if (area > maxAreaPx) return null;
 
  // Ensure CCW (positive signed area in screen-space = CW, so we flip)
  const sa = signedArea(polygon);
  const ccwPoly = sa > 0 ? [...polygon].reverse() : polygon;
 
  return {
    polygon:  ccwPoly,
    areaPx:   area,
    perimPx:  perimeter(ccwPoly),
  };
}
 
// ── React hook ────────────────────────────────────────────────────────────────
 
export interface UsePlanarFillOptions {
  svgLines:      SvgLine[];
  /** Pre-computed intersections in PDF-pixel space from useSvgSnapPoints */
  intersections: Array<[number, number]>;
  pdfDimensions: { w: number; h: number } | null;
}
 
export interface UsePlanarFillReturn {
  /** Graph is null until svgLines + pdfDimensions are available */
  graph:   PlanarGraph | null;
  /** Synchronous: find the face enclosing (x,y) in PDF-pixel space */
  fillAt:  (x: number, y: number, opts?: Parameters<typeof findEnclosingPolygon>[2]) => PlanarFillResult | null;
  /** Stats for debugging */
  stats:   { nodes: number; edges: number } | null;
}
 
export function usePlanarFill({
  svgLines,
  intersections,
  pdfDimensions,
}: UsePlanarFillOptions): UsePlanarFillReturn {
 
  const graph = useMemo<PlanarGraph | null>(() => {
    if (!pdfDimensions || svgLines.length === 0) return null;
    const t0 = performance.now();
    const g  = buildPlanarGraph(svgLines, intersections, pdfDimensions.w, pdfDimensions.h);
    console.log(
      `[usePlanarFill] graph built in ${(performance.now() - t0).toFixed(1)}ms — ` +
      `${g.nodes.length} nodes, ${g.edges.length / 2} edges`,
    );
    return g;
  }, [svgLines, intersections, pdfDimensions]);
 
  const fillAt = (
    x:    number,
    y:    number,
    opts?: Parameters<typeof findEnclosingPolygon>[2],
  ): PlanarFillResult | null => {
    if (!graph) return null;
    return findEnclosingPolygon(x, y, graph, opts);
  };
 
  const stats = graph
    ? { nodes: graph.nodes.length, edges: graph.edges.length / 2 }
    : null;
 
  return { graph, fillAt, stats };
}
 