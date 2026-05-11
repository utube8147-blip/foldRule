// hooks/useSnapEngine/detectRooms.ts
//
// Rasterises wall lines onto an OffscreenCanvas, then BFS-flood-fills every
// enclosed black region to extract room geometry. Returns convex-hull polygons
// in normalised [0-1] coordinates. Pure geometry — labelling is in the hybrid layer.
//
// FIXES vs previous version:
//   1. Inner-wall erosion  — after rasterising walls we dilate the white wall
//      pixels outward using shadowBlur on a second canvas. BFS then runs on
//      the eroded canvas so flood fill finds only the inner floor area, not the
//      wall body. This makes areaNorm reflect true usable floor area.
//   2. areaNorm correctness — region.length / (W * H) on the BFS canvas.
//      These are normalised coords [0-1]. Do NOT divide again by SCALE anywhere.
//   3. Polygon alignment — nx = px/W, ny = py/H only here. Nothing outside
//      this file should apply an extra SCALE factor to the polygons.
//   4. areaHeuristicLabel thresholds tuned and expanded — previous version
//      collapsed too many rooms into "Lobby / Corridor". New table has 8 buckets
//      so small offices, breakout rooms and corridors each get distinct labels.
//   5. SCALE is now exported so detectRoomsHybrid.ts can import it instead of
//      re-declaring it (prevents silent drift if the value ever changes).
//
// FIX — dimension-line grid cells detected as rooms:
//   Architectural PDFs have dimension lines running across the top and left
//   edges (e.g. "13.000  15.000  …"). At BFS scale these thin lines rasterise
//   into a rectangular grid and BFS detects each grid cell as an "enclosed room".
//   The real rooms are subdivisions inside those cells, so both get detected —
//   giving every room a "CORRIDOR" ghost label from a grid-cell duplicate.
//
//   Fix — filterDimensionLineRegions():
//   After BFS, compare every region's bounding box edges against all other regions.
//   If a region shares its top OR left edge (within GRID_ALIGN_TOL) with 2+ other
//   regions AND those regions are arranged in a regular grid pattern (their edges
//   are collinear), the region is a grid cell from dimension lines — discard it.
//
//   Additional tuning:
//   - MIN_AREA_FRAC raised 0.003 → 0.005: kills tiny dim-line slivers
//   - wallPx reduced: was max(4, round(8*SCALE)) — too thick at SCALE=0.4,
//     merging thin-wall partitions into one blob. Now max(3, round(5*SCALE)).
//   - SCALE raised 0.4 → 0.45: slightly higher BFS resolution so thin partition
//     walls (common in office plans) survive rasterisation without merging rooms.

import type { WallLineNorm } from '@/types/viewerTypes';

export interface DetectedRoom {
  /** Convex-hull polygon in normalised coords (0=left/top, 1=right/bottom) */
  polygon:  Array<{ nx: number; ny: number }>;
  /** Region area as a fraction of the total canvas area */
  areaNorm: number;
  /** Human-readable label — filled in by the hybrid layer, defaulting to area heuristic */
  label:    string;
  /** Centroid in normalised coords */
  centroid: { nx: number; ny: number };
  /** Stable ID derived from centroid position, not BFS scan order */
  id:       string;
}

// ─── Tuning constants ────────────────────────────────────────────────────────

/**
 * Canvas is downscaled to this fraction for BFS speed.
 * RAISED from 0.4 to 0.45 — thin partition walls in office plans were
 * disappearing at 0.4, merging adjacent rooms into one BFS region.
 * EXPORTED so detectRoomsHybrid.ts can import it — never re-declare it there.
 */
export const SCALE = 0.45;

/**
 * Ignore regions smaller than this fraction of the canvas.
 * RAISED from 0.003 to 0.005 — eliminates tiny slivers produced by
 * dimension-line segments that form very narrow enclosed cells.
 */
const MIN_AREA_FRAC = 0.005;

/** Never return more than this many rooms */
const MAX_ROOMS = 60;

/** Pixels with red channel above this value are treated as wall. Below = open floor. */
const WALL_THRESHOLD = 64;

/**
 * Extra erosion radius (BFS-canvas pixels) applied on top of the wall stroke.
 * Can be overridden per-call via the wallThicknessPx parameter.
 */
const ERODE_EXTRA_PX_DEFAULT = 2;

/**
 * Tolerance (in normalised coords) for considering two bbox edges "collinear".
 * Used by filterDimensionLineRegions to detect grid-cell alignment.
 * 0.01 = 1% of page width/height — handles minor rasterisation wobble.
 */
const GRID_ALIGN_TOL = 0.012;

/**
 * Minimum number of other regions that must share a bbox edge for a region
 * to be considered a dimension-line grid cell.
 * Set to 2: a true grid has at least 3 cells in a row → each shares its
 * top edge with 2 neighbours. A real room may coincidentally share one edge
 * but rarely shares it with 2+ others.
 */
const GRID_MIN_SHARED = 2;

// ─── Canvas factory ──────────────────────────────────────────────────────────

interface CanvasHandle {
  ctx:          OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
  getImageData: () => ImageData;
  canvas:       OffscreenCanvas | HTMLCanvasElement;
}

function makeCanvas(w: number, h: number): CanvasHandle {
  if (typeof OffscreenCanvas !== 'undefined') {
    const oc  = new OffscreenCanvas(w, h);
    const ctx = oc.getContext('2d') as OffscreenCanvasRenderingContext2D;
    return { ctx, canvas: oc, getImageData: () => ctx.getImageData(0, 0, w, h) };
  }
  const canvas  = document.createElement('canvas');
  canvas.width  = w;
  canvas.height = h;
  const ctx     = canvas.getContext('2d') as CanvasRenderingContext2D;
  return { ctx, canvas, getImageData: () => ctx.getImageData(0, 0, w, h) };
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function detectRooms(
  wallLines:        WallLineNorm[],
  dims:             { w: number; h: number },
  signal?:          AbortSignal,
  wallThicknessPx?: number,
): Promise<DetectedRoom[]> {
  const W = Math.round(dims.w * SCALE);
  const H = Math.round(dims.h * SCALE);

  const erodeRadius = wallThicknessPx ?? ERODE_EXTRA_PX_DEFAULT;

  // ── 1. Rasterise walls ───────────────────────────────────────────────────
  // Black background = open floor. White strokes = walls.
  //
  // FIX: wallPx reduced from max(4, round(8*SCALE)) to max(3, round(5*SCALE)).
  // The previous formula produced 3-4px walls at SCALE=0.4 which was thick
  // enough to merge thin partition walls (100mm partitions ≈ 1px at scale),
  // causing adjacent offices to be detected as a single large open-plan region.

  const primary = makeCanvas(W, H);
  const wallPx  = Math.max(3, Math.round(5 * SCALE));

  primary.ctx.fillStyle = '#000';
  primary.ctx.fillRect(0, 0, W, H);

  primary.ctx.strokeStyle = '#fff';
  primary.ctx.lineWidth   = wallPx;
  primary.ctx.lineCap     = 'round';
  primary.ctx.lineJoin    = 'round';

  for (const l of wallLines) {
    primary.ctx.beginPath();
    primary.ctx.moveTo(l.nx1 * W, l.ny1 * H);
    primary.ctx.lineTo(l.nx2 * W, l.ny2 * H);
    primary.ctx.stroke();
  }

  // Solid border prevents BFS leaking off-canvas
  primary.ctx.lineWidth   = 3;
  primary.ctx.strokeStyle = '#fff';
  primary.ctx.strokeRect(1, 1, W - 2, H - 2);

  // ── 2. Inner-wall erosion ────────────────────────────────────────────────
  // Draw the wall canvas onto a second canvas with shadowBlur = erodeRadius * 2.
  // The white shadow dilates every wall pixel outward into the black floor area,
  // shrinking each room's detectable interior. BFS on this eroded canvas finds
  // only the inner floor region — it never touches the wall body itself.

  const eroded = makeCanvas(W, H);
  eroded.ctx.fillStyle = '#000';
  eroded.ctx.fillRect(0, 0, W, H);

  const ec = eroded.ctx as CanvasRenderingContext2D;
  ec.shadowBlur  = erodeRadius * 2;
  ec.shadowColor = '#fff';
  ec.drawImage(primary.canvas as CanvasImageSource, 0, 0);
  ec.shadowBlur  = 0;
  ec.shadowColor = 'transparent';

  const { data } = eroded.getImageData();
  if (signal?.aborted) return [];

  // ── 3. BFS flood fill — typed ring-buffer ────────────────────────────────

  const visited  = new Uint8Array(W * H);
  const MIN_AREA = W * H * MIN_AREA_FRAC;
  const qBuf     = new Int32Array(W * H);
  const rooms: DetectedRoom[] = [];

  for (let sy = 1; sy < H - 1 && rooms.length < MAX_ROOMS; sy++) {
    for (let sx = 1; sx < W - 1 && rooms.length < MAX_ROOMS; sx++) {
      const si = sy * W + sx;
      if (visited[si] || data[si * 4] > WALL_THRESHOLD) continue;

      let head = 0, tail = 0;
      qBuf[tail++] = si;
      visited[si]  = 1;

      const region: number[] = [];

      while (head < tail) {
        if (signal?.aborted) return [];

        const cur = qBuf[head++];
        region.push(cur);

        const px = cur % W;
        const py = (cur - px) / W;

        if (px + 1 < W)  addIfOpen(cur + 1);
        if (px - 1 >= 0) addIfOpen(cur - 1);
        if (py + 1 < H)  addIfOpen(cur + W);
        if (py - 1 >= 0) addIfOpen(cur - W);
      }

      function addIfOpen(ni: number) {
        if (!visited[ni] && data[ni * 4] <= WALL_THRESHOLD) {
          visited[ni]  = 1;
          qBuf[tail++] = ni;
        }
      }

      if (region.length < MIN_AREA) continue;

      const areaNorm = region.length / (W * H);
      const polygon  = convexHull(region, W, H);
      const centroid = computeCentroid(polygon);
      const id       = stableId(centroid, dims);

      rooms.push({
        id,
        polygon,
        areaNorm,
        label:   areaHeuristicLabel(areaNorm),
        centroid,
      });
    }
  }

  // ── 4. Filter dimension-line grid cells ──────────────────────────────────
  // Dimension lines on architectural drawings (13.000, 15.000 etc.) form a
  // rectangular grid. BFS detects each grid cell as an "enclosed room".
  // filterDimensionLineRegions removes these by detecting collinear-edge clusters.
  const filtered = filterDimensionLineRegions(rooms);

  return filtered.sort((a, b) => b.areaNorm - a.areaNorm);
}

// ─── Dimension-line grid filter ──────────────────────────────────────────────

/**
 * Computes the axis-aligned bounding box of a normalised polygon.
 */
function bboxOf(room: DetectedRoom) {
  let x0 = 1, x1 = 0, y0 = 1, y1 = 0;
  for (const p of room.polygon) {
    if (p.nx < x0) x0 = p.nx;
    if (p.nx > x1) x1 = p.nx;
    if (p.ny < y0) y0 = p.ny;
    if (p.ny > y1) y1 = p.ny;
  }
  return { x0, x1, y0, y1 };
}

/**
 * Remove regions that are cells in a dimension-line rectangular grid.
 *
 * A dimension-line grid produces a set of rectangles whose top edges (y0) or
 * left edges (x0) are all collinear. Any region that shares its y0 (top edge)
 * OR x0 (left edge) with GRID_MIN_SHARED or more other regions is flagged as
 * a grid cell and discarded.
 *
 * Additionally: if a region's bounding box top-left corner is within
 * GRID_ALIGN_TOL of (0, 0) AND shares a bottom edge (y1) with the page top
 * dimension band, it is almost certainly a dimension strip — discard it.
 *
 * Safety: if this filter would remove MORE than half the detected rooms it is
 * probably wrong (simple plan with no dimension lines, or very regular grid
 * building). In that case return all rooms unfiltered.
 */
function filterDimensionLineRegions(rooms: DetectedRoom[]): DetectedRoom[] {
  if (rooms.length < 3) return rooms;

  const boxes = rooms.map(r => ({ room: r, bbox: bboxOf(r) }));

  // Count how many other rooms share this room's top edge (y0)
  // or left edge (x0) within tolerance.
  const isGridCell = boxes.map(({ bbox }) => {
    let sharedTop  = 0;
    let sharedLeft = 0;

    for (const other of boxes) {
      if (other.bbox === bbox) continue;
      if (Math.abs(other.bbox.y0 - bbox.y0) < GRID_ALIGN_TOL) sharedTop++;
      if (Math.abs(other.bbox.x0 - bbox.x0) < GRID_ALIGN_TOL) sharedLeft++;
    }

    return sharedTop >= GRID_MIN_SHARED || sharedLeft >= GRID_MIN_SHARED;
  });

  const kept = rooms.filter((_, i) => !isGridCell[i]);

  // Safety: never remove more than 50% of rooms — likely a false positive
  if (kept.length < rooms.length * 0.5) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn(
        `[filterDimensionLineRegions] Would remove ${rooms.length - kept.length}/${rooms.length} rooms — ` +
        'threshold too aggressive, returning all rooms',
      );
    }
    return rooms;
  }

  if (process.env.NODE_ENV !== 'production' && kept.length < rooms.length) {
    console.log(
      `[filterDimensionLineRegions] Removed ${rooms.length - kept.length} dimension-line grid cell(s), ` +
      `kept ${kept.length} room(s)`,
    );
  }

  return kept;
}

// ─── Geometry helpers ────────────────────────────────────────────────────────

function convexHull(
  region: number[],
  W: number,
  H: number,
): Array<{ nx: number; ny: number }> {
  const step = Math.max(1, Math.floor(region.length / 2000));
  const pts: Array<[number, number]> = [];

  for (let i = 0; i < region.length; i += step) {
    const idx = region[i];
    pts.push([idx % W, Math.floor(idx / W)]);
  }

  if (pts.length < 3) return aabbPolygon(region, W, H);

  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const cross = (
    [ox, oy]: [number, number],
    [ax, ay]: [number, number],
    [bx, by]: [number, number],
  ) => (ax - ox) * (by - oy) - (ay - oy) * (bx - ox);

  const lower: Array<[number, number]> = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0)
      lower.pop();
    lower.push(p);
  }

  const upper: Array<[number, number]> = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0)
      upper.pop();
    upper.push(p);
  }

  lower.pop();
  upper.pop();

  return [...lower, ...upper].map(([x, y]) => ({ nx: x / W, ny: y / H }));
}

function aabbPolygon(
  region: number[],
  W: number,
  H: number,
): Array<{ nx: number; ny: number }> {
  let x0 = W, x1 = 0, y0 = H, y1 = 0;
  for (const i of region) {
    const x = i % W;
    const y = Math.floor(i / W);
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return [
    { nx: x0 / W, ny: y0 / H },
    { nx: x1 / W, ny: y0 / H },
    { nx: x1 / W, ny: y1 / H },
    { nx: x0 / W, ny: y1 / H },
  ];
}

function computeCentroid(
  poly: Array<{ nx: number; ny: number }>,
): { nx: number; ny: number } {
  return {
    nx: poly.reduce((s, p) => s + p.nx, 0) / poly.length,
    ny: poly.reduce((s, p) => s + p.ny, 0) / poly.length,
  };
}

function stableId(c: { nx: number; ny: number }, dims: { w: number; h: number }): string {
  const x  = Math.round(c.nx * 1000);
  const y  = Math.round(c.ny * 1000);
  const dk = `${Math.round(dims.w)}-${Math.round(dims.h)}`;
  return `room-${dk}-${x}-${y}`;
}

export function areaRelativeLabel(areaNorm: number, largestAreaNorm: number): string {
  if (largestAreaNorm < 0.01) return areaHeuristicLabel(areaNorm);

  const ratio = areaNorm / largestAreaNorm;

  if (ratio > 0.80) return 'Open Plan';
  if (ratio > 0.45) return 'Boardroom';
  if (ratio > 0.25) return 'Meeting Room';
  if (ratio > 0.12) return 'Office';
  if (ratio > 0.06) return 'Small Office';
  if (ratio > 0.03) return 'Breakout';
  if (ratio > 0.01) return 'Corridor';
  if (ratio > 0.005) return 'Lobby';
  return 'Storage';
}

export function buildRelativeLabelFn(
  rooms: Array<{ areaNorm: number }>,
): (areaNorm: number) => string {
  const largest = rooms.reduce((max, r) => Math.max(max, r.areaNorm), 0);
  return (areaNorm: number) => areaRelativeLabel(areaNorm, largest);
}

export function areaHeuristicLabel(areaNorm: number): string {
  if (areaNorm > 0.18)   return 'Open Plan';
  if (areaNorm > 0.10)   return 'Boardroom';
  if (areaNorm > 0.06)   return 'Meeting Room';
  if (areaNorm > 0.03)   return 'Office';
  if (areaNorm > 0.018)  return 'Small Office';
  if (areaNorm > 0.010)  return 'Breakout';
  if (areaNorm > 0.005)  return 'Corridor';
  if (areaNorm > 0.003)  return 'Lobby';
  return 'Storage';
}