// hooks/useSnapEngine/detectRoomsHybrid.ts
//
// Three-stage pipeline:
//
//   Stage 1 — BFS geometry   (detectRooms)
//   Stage 2 — Geometric + boundary exclusion
//   Stage 3 — OCR labelling
//
// FIXES vs previous version:
//
//   1. CLUSTER_RADIUS raised 0.35 → 0.42.
//      The tighter 0.35 radius was excluding real bottom-floor rooms on tall
//      plans (e.g. WC (M), Breakout, Open Plan B) whose centroids at ny≈0.75
//      were 0.38–0.45 from the anchor. Those rooms were falling back to
//      heuristic labels ("Corridor", "Breakout") instead of OCR labels.
//      0.42 keeps them in while still excluding annotation boxes (legend at
//      ny≈0.85 is 0.48+ from anchor — safely outside).
//
//   2. ocrAndLabel passthrough: extractRoomLabel returning null now falls
//      through to sanitiseOcrText (raw OCR) before the area heuristic.
//      Previously null silently discarded valid text like "WC (M)", "Server Rm",
//      "Director" that didn't match the allowlist patterns in extractRoomLabel.
//
//   3. BOUNDARY_MARGIN raised 0.015 → 0.02 to give bottom-row rooms a bit
//      more tolerance. Plans where the building extends to 95%+ of page height
//      were clipping the bottom rooms with the tighter margin.

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
 */
const DEDUP_DIST_NORM = 0.06;

/**
 * Secondary dedup: two rooms with the same label whose centroids are closer
 * than this are almost certainly the same physical room detected twice.
 */
const DEDUP_SAME_LABEL_DIST = 0.10;

/**
 * Fractional margin added to the building footprint bounding box.
 * FIX: raised from 0.015 to 0.02 — bottom-row rooms on tall plans were
 * being clipped when the building extends close to the page edge.
 */
const BOUNDARY_MARGIN = 0.02;

/**
 * If fewer than this fraction of rooms fall inside the estimated footprint bbox,
 * skip boundary exclusion (degenerate or very simple plan).
 */
const BOUNDARY_MIN_INSIDE_FRAC = 0.5;

// ─── Public API ──────────────────────────────────────────────────────────────

export interface HybridDetectionOptions {
  pageCanvas: OffscreenCanvas | HTMLCanvasElement;
  wallLines:  WallLineNorm[];
  dims:       { w: number; h: number };
  signal?:    AbortSignal;
  onGeometryReady?: (candidates: DetectedRoom[]) => void;
}

export async function detectRoomsHybrid(
  opts: HybridDetectionOptions,
): Promise<DetectedRoom[]> {
  const { pageCanvas, wallLines, dims, signal, onGeometryReady } = opts;

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
 * Detect the main building footprint and discard rooms whose centroids fall
 * outside it.
 *
 * FIX: CLUSTER_RADIUS raised from 0.35 → 0.42.
 *
 * At 0.35, rooms in the bottom row of a two-storey floor plan (centroids at
 * ny ≈ 0.75–0.82) were outside the cluster when the anchor (largest room,
 * usually open plan) sat at ny ≈ 0.40. Their diagonal distances were 0.38–0.47,
 * just above the old threshold. They survived geometry exclusion but then got
 * kicked by boundary exclusion and fell back to heuristic labels ("Corridor").
 *
 * At 0.42, legend boxes (typically ny > 0.85, distance > 0.48) and title blocks
 * (ny > 0.88, distance > 0.50) remain excluded because they're farther away.
 *
 * Safety: BOUNDARY_MIN_INSIDE_FRAC=0.5 prevents mass exclusion on L-shaped
 * buildings or open plans with very few detected rooms.
 */
function boundaryExclusion(rooms: DetectedRoom[]): DetectedRoom[] {
  if (rooms.length <= 3) return rooms;

  const sorted = [...rooms].sort((a, b) => b.areaNorm - a.areaNorm);
  const anchor = sorted[0];

  // FIX: raised from 0.35 to 0.42
  const CLUSTER_RADIUS = 0.42;

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

  // Step 1: hard exclusion — discard annotation regions entirely
  if (rawOcr && isOcrExcluded(rawOcr)) return null;

  // Step 2: structured label extractor (title-cases, strips area annotations)
  const matchedLabel = extractRoomLabel(rawOcr);

  // Step 3: FIX — sanitised raw OCR passthrough.
  // extractRoomLabel returning null no longer silently drops the room.
  // "WC (M)", "Director", "Server Rm" all pass step 1 but may not match
  // extractRoomLabel's allowlist — they survive here and go straight to the label.
  const rawFallback = rawOcr ? sanitiseOcrText(rawOcr) : null;

  // Step 4: relative area heuristic — last resort
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
 * Light sanitisation of raw Tesseract output for the passthrough path.
 * Collapses whitespace/newlines, strips leading/trailing punctuation.
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