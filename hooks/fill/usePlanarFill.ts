'use client';

// ─── hooks/usePlanarFill.ts ───────────────────────────────────────────────────
//
//  Region fill via raster flood-fill on the SVG line layer.
//
//  WHY RASTER INSTEAD OF PLANAR GRAPH
//  ────────────────────────────────────
//  Architectural PDF drawings have imperfect topology: wall lines don't form
//  clean closed polygons, T-junctions have sub-pixel gaps, and door openings
//  intentionally break the perimeter. Planar half-edge traversal requires
//  perfectly connected topology and fails on real drawings.
//
//  Raster flood-fill handles all of these naturally:
//    1. Rasterize all svgLines onto an offscreen canvas at a fixed resolution
//    2. Use a thick stroke (LINE_WIDTH_PX) to close sub-pixel gaps
//    3. BFS flood-fill from the click point, stopping at wall pixels
//    4. Trace the filled region boundary (Moore neighbourhood)
//    5. Simplify the polygon with Ramer-Douglas-Peucker
//
//  Performance: 0.5× scale → ~512×512 canvas → <10ms fill + trace
//
// ─────────────────────────────────────────────────────────────────────────────

import { useMemo, useCallback } from 'react';
import type { SvgLine } from '@/hooks/snapEngine/useSvgSnapPoints';

// ── Public types ──────────────────────────────────────────────────────────────

export interface PlanarFillResult {
  polygon:  Array<[number, number]>;   // PDF-pixel space, CCW winding
  areaPx:   number;                     // px² (shoelace)
  perimPx:  number;
}

// Kept for API compatibility — not used by the raster path
export interface PlanarGraph {
  nodes: Array<{ x: number; y: number }>;
  edges: Array<{ from: number; to: number; angle: number }>;
  adj:   number[][];
}

// ── Constants ─────────────────────────────────────────────────────────────────

const RASTER_SCALE  = 0.5;       // raster pixels per PDF pixel
const LINE_WIDTH_PX = 4;         // stroke width on raster canvas — closes small gaps
const MAX_FILL_RASTER = 3_000_000; // abort if region exceeds this many raster pixels

// ── Geometry helpers ──────────────────────────────────────────────────────────

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

function perimeterOf(poly: Array<[number, number]>): number {
  let p = 0;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % n];
    p += Math.hypot(x1 - x0, y1 - y0);
  }
  return p;
}

// ── RDP polygon simplification ────────────────────────────────────────────────

function rdp(
  pts: Array<[number, number]>,
  eps: number,
  s = 0,
  e = pts.length - 1,
): Array<[number, number]> {
  if (e <= s + 1) return [pts[s]];
  const [x1, y1] = pts[s], [x2, y2] = pts[e];
  const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy;
  let maxD = 0, maxI = s;
  for (let i = s + 1; i < e; i++) {
    const [px, py] = pts[i];
    const d = len2 === 0
      ? Math.hypot(px - x1, py - y1)
      : Math.abs(dy * px - dx * py + x2 * y1 - y2 * x1) / Math.sqrt(len2);
    if (d > maxD) { maxD = d; maxI = i; }
  }
  if (maxD <= eps) return [pts[s]];
  return [...rdp(pts, eps, s, maxI), ...rdp(pts, eps, maxI, e)];
}

function simplifyPolygon(poly: Array<[number, number]>, eps: number): Array<[number, number]> {
  if (poly.length < 4) return poly;
  const out = rdp(poly, eps, 0, poly.length - 1);
  out.push(poly[poly.length - 1]);
  return out;
}

// ── Core: raster flood-fill ───────────────────────────────────────────────────

function rasterFloodFill(
  svgLines: SvgLine[],
  pdfW: number,
  pdfH: number,
  clickX: number,
  clickY: number,
): { filled: Uint8Array; rw: number; rh: number; count: number } | null {
  const rw = Math.ceil(pdfW * RASTER_SCALE);
  const rh = Math.ceil(pdfH * RASTER_SCALE);

  // 1. Rasterize lines onto offscreen canvas
  const canvas = new OffscreenCanvas(rw, rh);
  const ctx    = canvas.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, rw, rh);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth   = LINE_WIDTH_PX;
  ctx.lineCap     = 'square';

  for (const ln of svgLines) {
    ctx.beginPath();
    ctx.moveTo(ln.nx1 * rw, ln.ny1 * rh);
    ctx.lineTo(ln.nx2 * rw, ln.ny2 * rh);
    ctx.stroke();
  }

  const img     = ctx.getImageData(0, 0, rw, rh);
  const px      = img.data;
  const isWall  = (x: number, y: number) =>
    x >= 0 && x < rw && y >= 0 && y < rh && px[(y * rw + x) * 4] >= 128;

  // 2. Find non-wall seed near click point
  let sx = Math.round(clickX * RASTER_SCALE);
  let sy = Math.round(clickY * RASTER_SCALE);

  if (isWall(sx, sy)) {
    let found = false;
    outer: for (let r = 1; r <= 12; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue; // ring only
          if (!isWall(sx + dx, sy + dy)) {
            sx += dx; sy += dy; found = true; break outer;
          }
        }
      }
    }
    if (!found) return null;
  }

  // 3. BFS flood-fill (4-connected)
  const filled  = new Uint8Array(rw * rh);
  const queue   = new Int32Array(rw * rh * 2);
  let head = 0, tail = 0, count = 0;

  const push = (x: number, y: number) => {
    if (isWall(x, y)) return;
    const i = y * rw + x;
    if (filled[i]) return;
    filled[i] = 1;
    queue[tail++] = x;
    queue[tail++] = y;
    count++;
  };

  push(sx, sy);
  while (head < tail) {
    if (count > MAX_FILL_RASTER) return null; // exterior / huge area
    const x = queue[head++], y = queue[head++];
    if (x > 0)      push(x - 1, y);
    if (x < rw - 1) push(x + 1, y);
    if (y > 0)      push(x, y - 1);
    if (y < rh - 1) push(x, y + 1);
  }

  return { filled, rw, rh, count };
}

// ── Moore-neighbour boundary tracing ─────────────────────────────────────────

function traceBoundary(
  filled: Uint8Array,
  rw: number,
  rh: number,
): Array<[number, number]> {
  // Start: topmost-leftmost filled pixel
  let sx = -1, sy = -1;
  outer: for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      if (filled[y * rw + x]) { sx = x; sy = y; break outer; }
    }
  }
  if (sx === -1) return [];

  const DX = [1, 1, 0, -1, -1, -1, 0, 1];
  const DY = [0, 1, 1,  1,  0, -1,-1,-1];

  const isFilled = (x: number, y: number) =>
    x >= 0 && x < rw && y >= 0 && y < rh && filled[y * rw + x] === 1;

  const boundary: Array<[number, number]> = [];
  let cx = sx, cy = sy, entryDir = 4; // entered from west
  const maxSteps = rw * rh;

  for (let step = 0; step < maxSteps; step++) {
    boundary.push([cx, cy]);
    const back = (entryDir + 4) % 8;
    let moved = false;
    for (let i = 1; i <= 8; i++) {
      const dir = (back + i) % 8;
      const nx = cx + DX[dir], ny = cy + DY[dir];
      if (isFilled(nx, ny)) {
        entryDir = (dir + 4) % 8;
        cx = nx; cy = ny; moved = true; break;
      }
    }
    if (!moved || (cx === sx && cy === sy)) break;
  }

  return boundary;
}

// ── findEnclosingPolygon (public API, raster-backed) ─────────────────────────

export function findEnclosingPolygon(
  clickX: number,
  clickY: number,
  _graph: PlanarGraph,   // unused — kept for API compat
  opts: {
    searchRadius?: number;
    maxIter?:      number;
    maxAreaPx?:    number;
    _svgLines?:    SvgLine[];
    _pdfW?:        number;
    _pdfH?:        number;
  } = {},
): PlanarFillResult | null {
  const { maxAreaPx = Infinity, _svgLines, _pdfW, _pdfH } = opts;
  if (!_svgLines || !_pdfW || !_pdfH) return null;

  const fill = rasterFloodFill(_svgLines, _pdfW, _pdfH, clickX, clickY);
  if (!fill) return null;

  const areaPx = fill.count / (RASTER_SCALE * RASTER_SCALE);
  if (areaPx > maxAreaPx) return null;

  const raw = traceBoundary(fill.filled, fill.rw, fill.rh);
  if (raw.length < 3) return null;

  // Thin the boundary by sampling every 2nd point before RDP
  const sampled: Array<[number, number]> = raw.filter((_, i) => i % 2 === 0);
  const simplified = simplifyPolygon(sampled, 1.5);
  if (simplified.length < 3) return null;

  // Scale to PDF-pixel space
  const inv = 1 / RASTER_SCALE;
  const polygon: Array<[number, number]> = simplified.map(([x, y]) => [x * inv, y * inv]);

  // Ensure CCW
  const sa = signedArea(polygon);
  const ccw: Array<[number, number]> = sa > 0 ? [...polygon].reverse() : polygon;

  return { polygon: ccw, areaPx, perimPx: perimeterOf(ccw) };
}

// ── Stub buildPlanarGraph (API compat) ────────────────────────────────────────

export function buildPlanarGraph(
  _svgLines:      SvgLine[],
  _intersections: Array<[number, number]>,
  _pw:            number,
  _ph:            number,
): PlanarGraph {
  return { nodes: [], edges: [], adj: [] };
}

// ── React hook ────────────────────────────────────────────────────────────────

export interface UsePlanarFillOptions {
  svgLines:      SvgLine[];
  intersections: Array<[number, number]>;
  pdfDimensions: { w: number; h: number } | null;
}

export interface UsePlanarFillReturn {
  graph:         PlanarGraph | null;
  fillAt:        (x: number, y: number, opts?: Parameters<typeof findEnclosingPolygon>[2]) => PlanarFillResult | null;
  stats:         { nodes: number; edges: number } | null;
  svgLines:      SvgLine[];
  pdfDimensions: { w: number; h: number } | null;
}

export function usePlanarFill({
  svgLines,
  intersections,
  pdfDimensions,
}: UsePlanarFillOptions): UsePlanarFillReturn {

  const graph = useMemo<PlanarGraph | null>(() =>
    (pdfDimensions && svgLines.length > 0)
      ? { nodes: [], edges: [], adj: [] }
      : null,
  [svgLines.length > 0, pdfDimensions?.w, pdfDimensions?.h]);

  const fillAt = useCallback((
    x: number,
    y: number,
    opts?: Parameters<typeof findEnclosingPolygon>[2],
  ): PlanarFillResult | null => {
    if (!pdfDimensions) return null;
    return findEnclosingPolygon(x, y, graph as PlanarGraph, {
      ...opts,
      _svgLines:  svgLines,
      _pdfW:      pdfDimensions.w,
      _pdfH:      pdfDimensions.h,
    });
  }, [graph, svgLines, pdfDimensions]);

  return { graph, fillAt, stats: null, svgLines, pdfDimensions };
}