// hooks/useSnapEngine/ocrRegion.ts
//
// OCR helpers used by detectRoomsHybrid.
//
// FIXES vs previous version:
//   1. normPolygonToBbox now uses size-aware padding instead of a flat 10%:
//      padding is capped at MAX_PAD_PX (18px) so small rooms don't bleed into
//      neighbouring rooms. Previous 10% on a small room could expand the crop
//      by the full width of an adjacent room, confusing Tesseract completely.
//   2. ocrRegionFromCanvas upscales the crop to OCR_MIN_SIZE before passing
//      to Tesseract — small rooms at SCALE=0.4 were too tiny for reliable OCR.
//   3. Confidence filter — any result whose best-word confidence is below
//      MIN_WORD_CONFIDENCE (55) is returned as null, preventing garbage strings
//      from reaching extractRoomLabel.
//   4. OcrWorkerPool uses PSM.SPARSE_TEXT instead of SINGLE_BLOCK so it
//      handles labels that are split across two lines (e.g. "LOBBY /\nCORRIDOR").

import Tesseract from 'tesseract.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BoundingBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ─── Tuning ──────────────────────────────────────────────────────────────────

/**
 * Fractional padding added to each side of the OCR crop.
 * REDUCED from 0.10 to 0.05 — 10% on a small room was wide enough to pull in
 * an entire neighbouring room's pixels, causing Tesseract to read the wrong label.
 */
const OCR_BBOX_PAD = 0.05;

/**
 * Hard cap on padding in absolute canvas pixels.
 * Regardless of room size, the crop never expands by more than this many pixels
 * on each side. Prevents large-canvas plans from over-expanding small-room crops.
 * 18px at typical 800px canvas width ≈ 2.25% — safe for any room ≥ 36px wide.
 */
const MAX_PAD_PX = 18;

/**
 * Minimum pixel size (width or height) for the OCR crop before upscaling.
 * Tesseract performs poorly on crops smaller than ~100px. We scale the crop
 * up to this size if either dimension is smaller.
 */
const OCR_MIN_SIZE = 120;

/**
 * Tesseract word-level confidence threshold (0–100).
 * Results below this are treated as noise and returned as null.
 * The region will fall back to areaHeuristicLabel.
 */
const MIN_WORD_CONFIDENCE = 55;

// ─── BBox helpers ────────────────────────────────────────────────────────────

/**
 * Convert a normalised polygon to an axis-aligned pixel bbox on a canvas of
 * dimensions (canvasW × canvasH), with size-aware padding on every side.
 *
 * FIXED: padding is now min(canvasDim * OCR_BBOX_PAD, MAX_PAD_PX) so small
 * rooms don't bleed their crop into adjacent rooms.
 */
export function normPolygonToBbox(
  polygon: Array<{ nx: number; ny: number }>,
  canvasW: number,
  canvasH: number,
): BoundingBox {
  let minNx = 1, maxNx = 0, minNy = 1, maxNy = 0;
  for (const p of polygon) {
    if (p.nx < minNx) minNx = p.nx;
    if (p.nx > maxNx) maxNx = p.nx;
    if (p.ny < minNy) minNy = p.ny;
    if (p.ny > maxNy) maxNy = p.ny;
  }

  // Size-aware padding: proportional but capped so small rooms stay tight
  const padX = Math.min(canvasW * OCR_BBOX_PAD, MAX_PAD_PX);
  const padY = Math.min(canvasH * OCR_BBOX_PAD, MAX_PAD_PX);

  const x  = Math.max(0,        Math.round(minNx * canvasW - padX));
  const y  = Math.max(0,        Math.round(minNy * canvasH - padY));
  const x2 = Math.min(canvasW,  Math.round(maxNx * canvasW + padX));
  const y2 = Math.min(canvasH,  Math.round(maxNy * canvasH + padY));

  return { x, y, w: Math.max(1, x2 - x), h: Math.max(1, y2 - y) };
}

// ─── Worker pool ─────────────────────────────────────────────────────────────

export class OcrWorkerPool {
  private workers: Tesseract.Worker[];
  private next = 0;

  private constructor(workers: Tesseract.Worker[]) {
    this.workers = workers;
  }

  static async create(size: number): Promise<OcrWorkerPool> {
    const results = await Promise.allSettled(
      Array.from({ length: size }, () => createWorker()),
    );
    const workers = results
      .filter((r): r is PromiseFulfilledResult<Tesseract.Worker> =>
        r.status === 'fulfilled' && r.value !== null,
      )
      .map(r => r.value);

    if (workers.length === 0) {
      console.warn('[OcrWorkerPool] All workers failed to initialise — OCR disabled, using area heuristics');
    }

    return new OcrWorkerPool(workers);
  }

  get(): Tesseract.Worker | null {
    if (this.workers.length === 0) return null;
    return this.workers[this.next++ % this.workers.length];
  }

  async terminate(): Promise<void> {
    await Promise.allSettled(this.workers.map(w => w.terminate()));
    this.workers = [];
  }
}

async function createWorker(): Promise<Tesseract.Worker> {
  const worker = await Tesseract.createWorker('eng', 1, {
    logger: process.env.NODE_ENV === 'production'
      ? undefined
      : (m: unknown) => {
          if (
            typeof m === 'object' && m !== null &&
            'status' in m &&
            (m as { status: string }).status !== 'recognizing text'
          ) {
            console.debug('[Tesseract]', m);
          }
        },
  });

  // SPARSE_TEXT handles multi-line labels like "LOBBY /\nCORRIDOR" better
  // than SINGLE_BLOCK which expects one uniform text block.
  await worker.setParameters({
    tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT,
  });

  return worker;
}

// ─── Region OCR ──────────────────────────────────────────────────────────────

/**
 * Crop the bbox from the canvas, upscale it if needed, run Tesseract, and
 * return the recognised text string — or null if:
 *   - the AbortSignal was triggered
 *   - no worker was available (pool empty)
 *   - the best-word confidence is below MIN_WORD_CONFIDENCE
 *   - Tesseract threw an error
 */
export async function ocrRegionFromCanvas(
  canvas:  OffscreenCanvas | HTMLCanvasElement,
  bbox:    BoundingBox,
  pool:    OcrWorkerPool,
  signal?: AbortSignal,
): Promise<string | null> {
  if (signal?.aborted) return null;

  const worker = pool.get();
  if (!worker) return null;

  try {
    // Crop and optionally upscale so Tesseract has enough pixels to work with
    const crop = cropAndUpscale(canvas, bbox);

    const { data } = await worker.recognize(crop);

    if (signal?.aborted) return null;

    // Filter by best-word confidence — discard low-confidence garbage
    const words = data.words ?? [];
    if (words.length === 0) return null;

    const bestConfidence = Math.max(...words.map(w => w.confidence));
    if (bestConfidence < MIN_WORD_CONFIDENCE) {
      if (process.env.NODE_ENV !== 'production') {
        console.debug(
          `[ocrRegion] Low confidence (${bestConfidence.toFixed(0)}) — discarding: "${data.text.trim()}"`,
        );
      }
      return null;
    }

    return data.text.trim() || null;
  } catch (err) {
    if (signal?.aborted) return null;
    console.warn('[ocrRegion] Tesseract error:', err);
    return null;
  }
}

// ─── Canvas crop + upscale ───────────────────────────────────────────────────

/**
 * Crop a BoundingBox from the source canvas and return it as an
 * HTMLCanvasElement or OffscreenCanvas, upscaled to OCR_MIN_SIZE if either
 * dimension is too small for Tesseract to read reliably.
 *
 * We use a white background so dark text on a light floor is preserved even
 * after upscaling.
 */
function cropAndUpscale(
  source: OffscreenCanvas | HTMLCanvasElement,
  bbox:   BoundingBox,
): HTMLCanvasElement | OffscreenCanvas {
  const scale = Math.max(
    1,
    OCR_MIN_SIZE / Math.min(bbox.w, bbox.h),
  );

  const outW = Math.round(bbox.w * scale);
  const outH = Math.round(bbox.h * scale);

  if (typeof OffscreenCanvas !== 'undefined') {
    const oc  = new OffscreenCanvas(outW, outH);
    const ctx = oc.getContext('2d') as OffscreenCanvasRenderingContext2D;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, outW, outH);
    ctx.drawImage(
      source as CanvasImageSource,
      bbox.x, bbox.y, bbox.w, bbox.h,
      0, 0, outW, outH,
    );
    return oc;
  }

  const canvas  = document.createElement('canvas');
  canvas.width  = outW;
  canvas.height = outH;
  const ctx     = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, outW, outH);
  ctx.drawImage(
    source as CanvasImageSource,
    bbox.x, bbox.y, bbox.w, bbox.h,
    0, 0, outW, outH,
  );
  return canvas;
}