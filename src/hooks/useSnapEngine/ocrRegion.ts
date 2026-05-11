// hooks/useSnapEngine/ocrRegion.ts
//
// OCR helpers used by detectRoomsHybrid.
//
// FIXES vs previous version:
//
//   1. MIN_WORD_CONFIDENCE lowered 55 → 35.
//      Architectural floor plan labels are often: light grey ink, thin strokes,
//      small ALLCAPS serif text on pale room fill. At 55, valid reads like
//      "DIRECTOR", "WC (M)", "SERVER RM" were silently rejected and fell back
//      to heuristic labels. 35 is the practical floor for architectural OCR —
//      below 35 the text is almost always noise or a fixture label.
//
//   2. ocrRegionFromCanvas accepts an optional `options` param so callers can
//      override MIN_WORD_CONFIDENCE per-call (e.g. for a high-confidence pass
//      followed by a low-confidence pass on remaining rooms).
//
//   3. normPolygonToBbox: padding cap MAX_PAD_PX raised 18 → 24 to give
//      Tesseract a larger context crop on HiDPI canvases (where 18px is only
//      ~0.75% of a 2400px-wide canvas).
//
//   4. OCR_MIN_SIZE raised 120 → 150. At OCR_CANVAS_SCALE=2 the input is
//      already larger; this ensures small rooms get at least 150px in each
//      dimension before recognition.

import Tesseract from 'tesseract.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BoundingBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OcrOptions {
  /**
   * Minimum word confidence (0-100) to accept the result.
   * Defaults to MIN_WORD_CONFIDENCE (35).
   */
  minConfidence?: number;
}

// ─── Tuning ──────────────────────────────────────────────────────────────────

const OCR_BBOX_PAD = 0.05;

/**
 * Hard cap on padding in absolute canvas pixels.
 * FIX: raised from 18 → 24 for HiDPI canvases (2× upscale from useRoomDetection).
 */
const MAX_PAD_PX = 24;

/**
 * Minimum pixel size (width or height) for the OCR crop before upscaling.
 * FIX: raised from 120 → 150 to give Tesseract more comfortable pixel density.
 */
const OCR_MIN_SIZE = 150;

/**
 * Default Tesseract word-level confidence threshold (0–100).
 *
 * FIX: lowered from 55 → 35.
 * Architectural labels (light grey ALLCAPS on pale fill) rarely score above 55.
 * At 55, "DIRECTOR", "WC (M)", "OPEN PLAN B" were all rejected as "low confidence"
 * and the rooms fell back to generic heuristic labels ("Corridor").
 * 35 is the empirical floor: below it the output is almost always garbage strings
 * from Tesseract hallucinating text from wall noise or dimension lines.
 */
const MIN_WORD_CONFIDENCE = 35;

// ─── BBox helpers ────────────────────────────────────────────────────────────

/**
 * Convert a normalised polygon to an axis-aligned pixel bbox on a canvas of
 * dimensions (canvasW × canvasH), with size-aware padding on every side.
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
 * Crop the bbox from the canvas, upscale if needed, run Tesseract.
 * Returns the recognised text string — or null if:
 *   - AbortSignal triggered
 *   - No worker available
 *   - Best-word confidence below threshold (default MIN_WORD_CONFIDENCE=35)
 *   - Tesseract threw an error
 */
export async function ocrRegionFromCanvas(
  canvas:  OffscreenCanvas | HTMLCanvasElement,
  bbox:    BoundingBox,
  pool:    OcrWorkerPool,
  signal?: AbortSignal,
  options: OcrOptions = {},
): Promise<string | null> {
  if (signal?.aborted) return null;

  const worker = pool.get();
  if (!worker) return null;

  const confidenceThreshold = options.minConfidence ?? MIN_WORD_CONFIDENCE;

  try {
    const crop = cropAndUpscale(canvas, bbox);
    const { data } = await worker.recognize(crop);

    if (signal?.aborted) return null;

    const words = data.words ?? [];
    if (words.length === 0) return null;

    const bestConfidence = Math.max(...words.map(w => w.confidence));
    if (bestConfidence < confidenceThreshold) {
      if (process.env.NODE_ENV !== 'production') {
        console.debug(
          `[ocrRegion] Low confidence (${bestConfidence.toFixed(0)} < ${confidenceThreshold}) ` +
          `— discarding: "${data.text.trim()}"`,
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
 * Crop a BoundingBox from the source canvas and return it upscaled to
 * OCR_MIN_SIZE if either dimension is too small for Tesseract to read reliably.
 * Uses a white background so dark text on light floor is preserved.
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