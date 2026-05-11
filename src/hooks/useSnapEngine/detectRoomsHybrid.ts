// hooks/useSnapEngine/detectRoomsHybrid.ts
//
// Three-stage pipeline:
//
//   Stage 1 — BFS geometry   (detectRooms)
//     Rasterise walls → erode inner wall → flood fill → convex hulls.
//     Now includes filterDimensionLineRegions() to discard grid cells
//     produced by architectural dimension-line annotations.
//
//   Stage 2 — Geometric exclusion   (roomExclusion.isGeometryExcluded)
//     Discard title blocks, borders, and tiny wall fragments without
//     spending any OCR budget on them.
//     ADDED: boundaryExclusion() removes regions whose centroids fall
//     outside the main building footprint (title block, legend, north
//     arrow, revision panel all live outside the building envelope).
//
//   Stage 3 — OCR labelling   (ocrRegion + roomExclusion.extractRoomLabel)
//     Crop each candidate region from the full-res canvas and run
//     Tesseract.js. Regions whose OCR text matches exclusion patterns
//     are discarded. Falls back to relative-area label if OCR returns nothing.
//
// FIXES vs previous version:
//   1. estimateWallThickness() — derives median wall thickness in BFS pixels
//      from wallLines stroke lengths and passes it to detectRooms so the
//      erosion radius is data-driven rather than a hard-coded constant.
//   2. ocrAndLabel passthrough widened — extractRoomLabel returning null no
//      longer silently discards valid OCR text. Raw OCR text (>=2 chars, after
//      basic sanitisation) is now used directly when extractRoomLabel returns
//      null, so room names like "OFFICE 1", "WC (M)", "SERVER RM" survive even
//      if they don't match the allowlist in roomExclusion.
//   3. Deduplication improved — threshold raised to DEDUP_DIST_NORM=0.06 and
//      a secondary same-label proximity check (0.10 diagonal) eliminates the
//      "double polygon" artefact where thin-wall BFS produces two overlapping
//      regions with identical labels.
//   4. SCALE constant is now imported from detectRooms.ts instead of being
//      re-declared here — prevents silent drift if the value ever changes.
//   5. Relative labelling — heuristic labels are now derived relative to the
//      largest detected room in the set, not against hardcoded absolute fractions.
//   6. Boundary exclusion — CLUSTER_RADIUS tightened 0.45 → 0.35 so the
//      bottom-right title block and bottom-left legend box (which are far from
//      the building centroid on plans like GROUND FLOOR PLAN BLOCK A) are
//      excluded. The previous 0.45 radius was large enough to pull them in.

import type { WallLineNorm } from '@/types/viewerTypes';
import {
  detectRooms,
  areaHeuristicLabel,
  buildRelativeLabelFn,
  SCALE,
} from './detectRooms';
import type { DetectedRoom }  from './detectRooms';
import { isGeometryExcluded, isOcrExcluded, extractRoomLabel } from './roomExclusion';
import {
  OcrWorkerPool,
  ocrRegionFromCanvas,
  normPolygonToBbox,
} from './ocrRegion';

export type { DetectedRoom };

// ─── Tuning ──────────────────────────────────────────────────────────────────

/** Number of Tesseract workers to run in parallel */
const OCR_POOL_SIZE = 3;

/**
 * Normalised distance threshold for centroid deduplication.
 * INCREASED from 0.04 to 0.06 to catch overlapping BFS regions from thin walls.
 */
const DEDUP_DIST_NORM = 0.06;

/**
 * Secondary dedup: two rooms with the same label whose centroids are closer
 * than this are almost certainly the same physical room detected twice.
 */
const DEDUP_SAME_LABEL_DIST = 0.10;

/**
 * Fractional margin added to the building footprint bounding box.
 * 0.015 = 1.5% of page width/height tolerance beyond the detected footprint edge.
 * REDUCED from 0.02 to 0.015 — tighter margin cuts legend / title bleed-in.
 */
const BOUNDARY_MARGIN = 0.015;

/**
 * If fewer than this fraction of rooms fall inside the estimated footprint bbox,
 * skip boundary exclusion (degenerate or very simple plan).
 */
const BOUNDARY_MIN_INSIDE_FRAC = 0.5;

// ─── Public API ──────────────────────────────────────────────────────────────

export interface HybridDetectionOptions {
  /** Full-resolution rendered PDF canvas — needed for high-quality OCR crops */
  pageCanvas: OffscreenCanvas | HTMLCanvasElement;
  /** Wall lines extracted by the snap engine */
  wallLines:  WallLineNorm[];
  /** Normalised page dimensions */
  dims:       { w: number; h: number };
  /** AbortSignal — abort detection when page changes or component unmounts */
  signal?:    AbortSignal;
  /**
   * Optional callback called after BFS completes and geometry exclusion runs,
   * before OCR starts. Useful for showing a progressive "geometry ready" state.
   */
  onGeometryReady?: (candidates: DetectedRoom[]) => void;
}

export async function detectRoomsHybrid(
  opts: HybridDetectionOptions,
): Promise<DetectedRoom[]> {
  const { pageCanvas, wallLines, dims, signal, onGeometryReady } = opts;

  // Estimate wall thickness from wallLines so erosion is data-driven
  const wallThicknessPx = estimateWallThickness(wallLines);

  // ── Stage 1: BFS geometry ─────────────────────────────────────────────────
  const allRegions = await detectRooms(wallLines, dims, signal, wallThicknessPx);
  if (signal?.aborted) return [];

  // ── Stage 2a: Geometric exclusion ─────────────────────────────────────────
  const geometryPassed = allRegions.filter(r => !isGeometryExcluded(r));
  if (signal?.aborted) return [];

  // ── Stage 2b: Boundary exclusion ──────────────────────────────────────────
  const candidates = boundaryExclusion(geometryPassed);
  if (signal?.aborted) return [];

  // ── Stage 2c: Apply relative heuristic labels ─────────────────────────────
  const relativeLabelFn = buildRelativeLabelFn(candidates);
  const relativeLabeled = candidates.map(r => ({
    ...r,
    label: relativeLabelFn(r.areaNorm),
  }));

  onGeometryReady?.(relativeLabeled);

  if (relativeLabeled.length === 0) return [];

  // ── Stage 3: OCR labelling ────────────────────────────────────────────────
  const pool = await OcrWorkerPool.create(OCR_POOL_SIZE);
  if (signal?.aborted) {
    await pool.terminate();
    return [];
  }

  const canvasW = pageCanvas instanceof OffscreenCanvas
    ? pageCanvas.width
    : (pageCanvas as HTMLCanvasElement).width;
  const canvasH = pageCanvas instanceof OffscreenCanvas
    ? pageCanvas.height
    : (pageCanvas as HTMLCanvasElement).height;

  let labeled: (DetectedRoom | null)[];

  try {
    labeled = await Promise.all(
      relativeLabeled.map(room =>
        ocrAndLabel(room, pageCanvas, canvasW, canvasH, pool, relativeLabelFn, signal),
      ),
    );
  } finally {
    await pool.terminate();
  }

  if (signal?.aborted) return [];

  const valid = labeled.filter(Boolean) as DetectedRoom[];

  // ── Stage 4: Deduplication ────────────────────────────────────────────────
  const deduped = deduplicateRooms(valid);

  return deduped.sort((a, b) => b.areaNorm - a.areaNorm);
}

// ─── Boundary exclusion ──────────────────────────────────────────────────────

/**
 * Detect the main building footprint and discard any room whose centroid
 * falls outside it.
 *
 * FIX: CLUSTER_RADIUS tightened from 0.45 to 0.35.
 *
 * The previous 0.45 radius (45% of page diagonal) was wide enough to pull in
 * the bottom-right title block and the bottom-left legend box on plans where
 * the building occupies the upper 60-70% of the page. Those annotation boxes
 * survived geometric exclusion and boundary exclusion alike.
 *
 * At 0.35, a building centred at (0.45, 0.40) on the page only pulls in rooms
 * within a 0.35-diagonal circle — the title block at (0.88, 0.85) and the
 * legend at (0.25, 0.85) are ~0.50 and ~0.47 from the centroid respectively,
 * both outside the tighter radius.
 *
 * Safety: BOUNDARY_MIN_INSIDE_FRAC = 0.5 prevents false exclusion on simple
 * plans or very L-shaped buildings where many rooms are far from the centroid.
 */
function boundaryExclusion(rooms: DetectedRoom[]): DetectedRoom[] {
  if (rooms.length <= 3) return rooms;

  const sorted = [...rooms].sort((a, b) => b.areaNorm - a.areaNorm);
  const anchor = sorted[0];

  // FIX: tightened from 0.45 to 0.35
  const CLUSTER_RADIUS = 0.35;

  let minNx = anchor.centroid.nx;
  let maxNx = anchor.centroid.nx;
  let minNy = anchor.centroid.ny;
  let maxNy = anchor.centroid.ny;

  for (const r of rooms) {
    const dx = r.centroid.nx - anchor.centroid.nx;
    const dy = r.centroid.ny - anchor.centroid.ny;
    if (Math.sqrt(dx * dx + dy * dy) < CLUSTER_RADIUS) {
      if (r.centroid.nx < minNx) minNx = r.centroid.nx;
      if (r.centroid.nx > maxNx) maxNx = r.centroid.nx;
      if (r.centroid.ny < minNy) minNy = r.centroid.ny;
      if (r.centroid.ny > maxNy) maxNy = r.centroid.ny;
    }
  }

  const x0 = Math.max(0, minNx - BOUNDARY_MARGIN);
  const x1 = Math.min(1, maxNx + BOUNDARY_MARGIN);
  const y0 = Math.max(0, minNy - BOUNDARY_MARGIN);
  const y1 = Math.min(1, maxNy + BOUNDARY_MARGIN);

  const inside = rooms.filter(r =>
    r.centroid.nx >= x0 && r.centroid.nx <= x1 &&
    r.centroid.ny >= y0 && r.centroid.ny <= y1,
  );

  if (inside.length < rooms.length * BOUNDARY_MIN_INSIDE_FRAC) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn(
        `[boundaryExclusion] Only ${inside.length}/${rooms.length} rooms inside ` +
        `footprint bbox — skipping exclusion`,
      );
    }
    return rooms;
  }

  if (process.env.NODE_ENV !== 'production' && inside.length < rooms.length) {
    const excluded = rooms.filter(r => !inside.includes(r));
    console.log(
      `[boundaryExclusion] Excluded ${excluded.length} out-of-bounds region(s):`,
      excluded.map(r =>
        `centroid=(${r.centroid.nx.toFixed(2)},${r.centroid.ny.toFixed(2)}) area=${(r.areaNorm * 100).toFixed(2)}%`,
      ),
    );
  }

  return inside;
}

// ─── Per-room OCR ────────────────────────────────────────────────────────────

async function ocrAndLabel(
  room:    DetectedRoom,
  canvas:  OffscreenCanvas | HTMLCanvasElement,
  canvasW: number,
  canvasH: number,
  pool:    OcrWorkerPool,
  labelFn: (areaNorm: number) => string,
  signal?: AbortSignal,
): Promise<DetectedRoom | null> {
  if (signal?.aborted) return null;

  const bbox   = normPolygonToBbox(room.polygon, canvasW, canvasH);
  const rawOcr = await ocrRegionFromCanvas(canvas, bbox, pool, signal);

  if (signal?.aborted) return null;

  // Step 1: hard exclusion
  if (rawOcr && isOcrExcluded(rawOcr)) return null;

  // Step 2: structured allowlist extractor
  const matchedLabel = extractRoomLabel(rawOcr);

  // Step 3: sanitised raw OCR passthrough
  const rawFallback = rawOcr ? sanitiseOcrText(rawOcr) : null;

  // Step 4: relative area heuristic — scale-calibrated
  const label = matchedLabel ?? rawFallback ?? labelFn(room.areaNorm);

  if (process.env.NODE_ENV !== 'production') {
    console.debug(
      `[ocrAndLabel] ${room.id} → matched="${matchedLabel}" raw="${rawOcr?.trim()}" ` +
      `sanitised="${rawFallback}" final="${label}" area=${(room.areaNorm * 100).toFixed(2)}%`,
    );
  }

  return { ...room, label };
}

/**
 * Light sanitisation of raw Tesseract output.
 * Collapses whitespace/newlines, strips leading/trailing punctuation artefacts.
 * Returns null if fewer than 2 printable characters remain.
 */
function sanitiseOcrText(raw: string): string | null {
  const cleaned = raw
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[^A-Za-z0-9(]+/, '')
    .replace(/[^A-Za-z0-9)]+$/, '')
    .trim();

  return cleaned.length >= 2 ? cleaned : null;
}

// ─── Wall thickness estimator ────────────────────────────────────────────────

function estimateWallThickness(wallLines: WallLineNorm[]): number {
  if (wallLines.length === 0) return 2;

  const lengths = wallLines
    .map(l => {
      const dx = l.nx2 - l.nx1;
      const dy = l.ny2 - l.ny1;
      return Math.sqrt(dx * dx + dy * dy);
    })
    .sort((a, b) => a - b);

  const quartileEnd = Math.max(1, Math.floor(lengths.length * 0.25));
  const quartile    = lengths.slice(0, quartileEnd);
  const median      = quartile[Math.floor(quartile.length / 2)];

  const bfsPx = Math.round(median * 1000 * SCALE);
  return Math.max(1, Math.min(8, bfsPx));
}

// ─── Deduplication ───────────────────────────────────────────────────────────

function deduplicateRooms(rooms: DetectedRoom[]): DetectedRoom[] {
  const sorted = [...rooms].sort((a, b) => b.areaNorm - a.areaNorm);
  const kept: DetectedRoom[] = [];

  for (const room of sorted) {
    const isDuplicate = kept.some(k => {
      const dx   = k.centroid.nx - room.centroid.nx;
      const dy   = k.centroid.ny - room.centroid.ny;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < DEDUP_DIST_NORM) return true;
      if (dist < DEDUP_SAME_LABEL_DIST && k.label === room.label) return true;

      return false;
    });

    if (!isDuplicate) kept.push(room);
  }

  return kept;
}