/**
 * opencvWorker.ts  v1.0
 * ──────────────────────
 * Web Worker that owns the OpenCV.js runtime and performs all
 * template-matching work off the main thread.
 *
 * Message protocol
 * ────────────────
 * IN  (main → worker):
 *   { type: 'LOAD' }
 *   { type: 'FIND_MATCHES',
 *     srcImageData:    { data: Uint8ClampedArray, width: number, height: number },
 *     tmplImageData:   { data: Uint8ClampedArray, width: number, height: number },
 *     threshold:       number,
 *     rotations:       number[],
 *     flips:           boolean[],
 *     removeText:      boolean }
 *
 * OUT (worker → main):
 *   { type: 'READY' }
 *   { type: 'PROGRESS', phase: string, detail?: string }
 *   { type: 'RESULTS',  matches: CVMatchResult[] }
 *   { type: 'ERROR',    message: string }
 */

// ─── Types (duplicated here so the worker is self-contained) ──────────────────

interface CVMatchResult {
  id:               string;
  score:            number;
  rotation:         number;
  flipped:          boolean;
  orientationLabel: string;
  bbox: { x: number; y: number; w: number; h: number };
  snapPoints: Array<{ x: number; y: number; type: 'endpoint' | 'midpoint' | 'centroid' }>;
}

interface Orientation {
  deg:     number;
  flipped: boolean;
  label:   string;
}

// ─── OpenCV CDN ───────────────────────────────────────────────────────────────

const OPENCV_URL = 'https://docs.opencv.org/4.x/opencv.js';

// ─── Load OpenCV inside the worker ───────────────────────────────────────────

let cvReady = false;
let cvLoadPromise: Promise<void> | null = null;

function loadCV(): Promise<void> {
  if (cvReady) return Promise.resolve();
  if (cvLoadPromise) return cvLoadPromise;

  cvLoadPromise = new Promise<void>((resolve, reject) => {
    // importScripts is synchronous in workers
    try {
      // @ts-ignore — importScripts is a worker global
      importScripts(OPENCV_URL);
    } catch (e) {
      reject(new Error(`importScripts failed: ${e}`));
      return;
    }

    const poll = setInterval(() => {
      // @ts-ignore
      if (typeof cv !== 'undefined' && cv && typeof cv.matchTemplate === 'function') {
        clearInterval(poll);
        cvReady = true;
        resolve();
      }
    }, 80);

    // Timeout after 30 s
    setTimeout(() => { clearInterval(poll); reject(new Error('OpenCV load timeout')); }, 30_000);
  });

  return cvLoadPromise;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function snapPointsForBBox(
  x: number, y: number, w: number, h: number,
): CVMatchResult['snapPoints'] {
  return [
    { x: x+w/2, y: y+h/2, type: 'centroid' },
    { x,         y,         type: 'endpoint' },
    { x: x+w,   y,         type: 'endpoint' },
    { x: x+w,   y: y+h,    type: 'endpoint' },
    { x,         y: y+h,    type: 'endpoint' },
    { x: x+w/2, y,         type: 'midpoint' },
    { x: x+w/2, y: y+h,    type: 'midpoint' },
    { x,         y: y+h/2,  type: 'midpoint' },
    { x: x+w,   y: y+h/2,  type: 'midpoint' },
  ];
}

function iou(
  a: { x:number; y:number; w:number; h:number },
  b: { x:number; y:number; w:number; h:number },
): number {
  const ix = Math.max(0, Math.min(a.x+a.w, b.x+b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y+a.h, b.y+b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  if (inter === 0) return 0;
  return inter / (a.w*a.h + b.w*b.h - inter);
}

function nms(results: CVMatchResult[]): CVMatchResult[] {
  const sorted = [...results].sort((a, b) => b.score - a.score);
  const kept: CVMatchResult[] = [];
  for (const r of sorted) {
    if (!kept.some(k => iou(k.bbox, r.bbox) > 0.3)) kept.push(r);
  }
  return kept;
}

// ─── Text removal (blob eraser) ───────────────────────────────────────────────
// Erases connected components whose aspect ratio and area suggest text glyphs.

function matWithoutText(cv: any, gray: any): any {
  const binary   = new cv.Mat();
  const labels   = new cv.Mat();
  const stats    = new cv.Mat();
  const centroids = new cv.Mat();

  // Threshold to find dark ink on light background
  cv.threshold(gray, binary, 180, 255, cv.THRESH_BINARY_INV);

  const numLabels = cv.connectedComponentsWithStats(binary, labels, stats, centroids, 8, cv.CV_32S);

  const out = gray.clone();

  for (let i = 1; i < numLabels; i++) {
    const x  = stats.intAt(i, cv.CC_STAT_LEFT);
    const y  = stats.intAt(i, cv.CC_STAT_TOP);
    const w  = stats.intAt(i, cv.CC_STAT_WIDTH);
    const h  = stats.intAt(i, cv.CC_STAT_HEIGHT);
    const ar = w / Math.max(h, 1);
    const area = stats.intAt(i, cv.CC_STAT_AREA);

    // Heuristic: text glyphs are small, squarish–tallish blobs
    const isSmall        = w < 30 && h < 40;
    const isGlyphAspect  = ar >= 0.2 && ar <= 5.0;
    const isGlyphArea    = area >= 4 && area <= 600;

    if (isSmall && isGlyphAspect && isGlyphArea) {
      // Fill the bounding box with white (background) in output
      const roi = out.roi(new cv.Rect(x, y, w, h));
      roi.setTo(new cv.Scalar(255));
      roi.delete();
    }
  }

  binary.delete(); labels.delete(); stats.delete(); centroids.delete();
  return out;
}

// ─── Source mat preparation ────────────────────────────────────────────────────

function prepareSourceMat(cv: any, srcGray: any, deg: number, flipped: boolean): any {
  let rotated: any;
  if (deg === 0) {
    rotated = srcGray.clone();
  } else if (deg === 180) {
    rotated = new cv.Mat();
    cv.flip(srcGray, rotated, -1);
  } else {
    const transposed = new cv.Mat();
    cv.transpose(srcGray, transposed);
    rotated = new cv.Mat();
    if (deg === 90) cv.flip(transposed, rotated, 1);
    else             cv.flip(transposed, rotated, 0);
    transposed.delete();
  }
  if (flipped) {
    const flippedMat = new cv.Mat();
    cv.flip(rotated, flippedMat, 1);
    rotated.delete();
    return flippedMat;
  }
  return rotated;
}

// ─── Coordinate remapping ─────────────────────────────────────────────────────

function remapToOriginal(
  hitX: number, hitY: number,
  deg: number, flipped: boolean,
  srcW: number, srcH: number,
  bboxW: number, bboxH: number,
): { x: number; y: number } {
  const rotW        = (deg === 90 || deg === 270) ? srcH : srcW;
  const tmplInPrepW = (deg === 90 || deg === 270) ? bboxH : bboxW;
  const tmplInPrepH = (deg === 90 || deg === 270) ? bboxW : bboxH;

  let cx = hitX + tmplInPrepW / 2;
  let cy = hitY + tmplInPrepH / 2;

  if (flipped) cx = rotW - 1 - cx;

  let origCx: number, origCy: number;
  switch (deg) {
    case 0:   origCx = cx;           origCy = cy;           break;
    case 90:  origCx = cy;           origCy = srcH - 1 - cx; break;
    case 180: origCx = srcW - 1 - cx; origCy = srcH - 1 - cy; break;
    case 270: origCx = srcW - 1 - cy; origCy = cx;           break;
    default:  origCx = cx;           origCy = cy;
  }

  return { x: Math.round(origCx - bboxW / 2), y: Math.round(origCy - bboxH / 2) };
}

// ─── Single orientation pass ───────────────────────────────────────────────────

function runOrientationPass(
  cv: any,
  srcGray: any,
  templGray: any,
  orient: Orientation,
  threshold: number,
  idxOffset: number,
  origTemplW: number,
  origTemplH: number,
  srcW: number,
  srcH: number,
): CVMatchResult[] {
  const { deg, flipped, label } = orient;
  const preparedSrc = prepareSourceMat(cv, srcGray, deg, flipped);

  if (origTemplW > preparedSrc.cols || origTemplH > preparedSrc.rows) {
    preparedSrc.delete();
    return [];
  }

  const result = new cv.Mat();
  cv.matchTemplate(preparedSrc, templGray, result, cv.TM_CCOEFF_NORMED);
  preparedSrc.delete();

  const data  = result.data32F as Float32Array;
  const rCols = result.cols;
  const rRows = result.rows;
  const matches: CVMatchResult[] = [];

  for (let r = 0; r < rRows; r++) {
    for (let c = 0; c < rCols; c++) {
      const score = data[r * rCols + c];
      if (score < threshold) continue;

      const bboxW = (deg === 90 || deg === 270) ? origTemplH : origTemplW;
      const bboxH = (deg === 90 || deg === 270) ? origTemplW : origTemplH;
      const orig  = remapToOriginal(c, r, deg, flipped, srcW, srcH, bboxW, bboxH);

      matches.push({
        id:               `cv-${label}-${idxOffset + r * rCols + c}`,
        score,
        rotation:         deg,
        flipped,
        orientationLabel: label,
        bbox:             { x: orig.x, y: orig.y, w: bboxW, h: bboxH },
        snapPoints:       snapPointsForBBox(orig.x, orig.y, bboxW, bboxH),
      });
    }
  }

  result.delete();
  return matches;
}

// ─── ImageData → cv.Mat ───────────────────────────────────────────────────────

function imageDataToMat(cv: any, imgData: { data: Uint8ClampedArray; width: number; height: number }): any {
  // Build an RGBA Mat then convert
  const mat = cv.matFromArray(imgData.height, imgData.width, cv.CV_8UC4, Array.from(imgData.data));
  return mat;
}

// ─── Main matching routine ────────────────────────────────────────────────────

async function doFindMatches(msg: {
  srcImageData:  { data: Uint8ClampedArray; width: number; height: number };
  tmplImageData: { data: Uint8ClampedArray; width: number; height: number };
  threshold:     number;
  rotations:     number[];
  flips:         boolean[];
  removeText:    boolean;
}): Promise<CVMatchResult[]> {
  // @ts-ignore
  const cv = self.cv;

  const { srcImageData, tmplImageData, threshold, rotations, flips, removeText } = msg;

  const origTemplW = tmplImageData.width;
  const origTemplH = tmplImageData.height;

  // ── Source ────────────────────────────────────────────────────────────────
  self.postMessage({ type: 'PROGRESS', phase: 'Converting source image' });
  const srcMat     = imageDataToMat(cv, srcImageData);
  const srcGrayRaw = new cv.Mat();
  cv.cvtColor(srcMat, srcGrayRaw, cv.COLOR_RGBA2GRAY);
  srcMat.delete();

  let srcGray: any;
  if (removeText) {
    self.postMessage({ type: 'PROGRESS', phase: 'Removing text from source', detail: 'Erasing text blobs from source…' });
    srcGray = matWithoutText(cv, srcGrayRaw);
    srcGrayRaw.delete();
    self.postMessage({ type: 'PROGRESS', phase: 'Source text removed', detail: '✓ Source text erased' });
  } else {
    srcGray = srcGrayRaw;
  }

  const srcW = srcGray.cols;
  const srcH = srcGray.rows;

  // ── Template ──────────────────────────────────────────────────────────────
  self.postMessage({ type: 'PROGRESS', phase: 'Converting template' });
  const templMat     = imageDataToMat(cv, tmplImageData);
  const templGrayRaw = new cv.Mat();
  cv.cvtColor(templMat, templGrayRaw, cv.COLOR_RGBA2GRAY);
  templMat.delete();

  let templGray: any;
  if (removeText) {
    self.postMessage({ type: 'PROGRESS', phase: 'Removing text from template', detail: 'Erasing text blobs from template…' });
    templGray = matWithoutText(cv, templGrayRaw);
    templGrayRaw.delete();
    self.postMessage({ type: 'PROGRESS', phase: 'Template text removed', detail: '✓ Template text erased' });
  } else {
    templGray = templGrayRaw;
  }

  // ── 8 orientation passes ──────────────────────────────────────────────────
  const orientations: Orientation[] = [];
  for (const deg of rotations) {
    for (const flipped of flips) {
      orientations.push({ deg, flipped, label: flipped ? `${deg}°↔` : `${deg}°` });
    }
  }

  const allResults: CVMatchResult[] = [];
  let idxOffset = 0;

  for (let i = 0; i < orientations.length; i++) {
    const orient = orientations[i];
    self.postMessage({
      type:   'PROGRESS',
      phase:  `Matching orientation ${i + 1}/${orientations.length}`,
      detail: orient.label,
    });

    const hits = runOrientationPass(
      cv, srcGray, templGray,
      orient, threshold, idxOffset,
      origTemplW, origTemplH, srcW, srcH,
    );
    allResults.push(...hits);
    idxOffset += srcW * srcH;
  }

  templGray.delete();
  srcGray.delete();

  self.postMessage({ type: 'PROGRESS', phase: 'Non-maximum suppression' });
  const deduped = nms(allResults);
  deduped.sort((a, b) => b.score - a.score);
  return deduped;
}

// ─── Worker message handler ───────────────────────────────────────────────────

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;

  if (msg.type === 'LOAD') {
    try {
      self.postMessage({ type: 'PROGRESS', phase: 'Loading OpenCV.js…' });
      await loadCV();
      self.postMessage({ type: 'READY' });
    } catch (err: any) {
      self.postMessage({ type: 'ERROR', message: err.message });
    }
    return;
  }

  if (msg.type === 'FIND_MATCHES') {
    try {
      if (!cvReady) {
        self.postMessage({ type: 'PROGRESS', phase: 'Waiting for OpenCV…' });
        await loadCV();
        self.postMessage({ type: 'READY' });
      }
      const matches = await doFindMatches(msg);
      self.postMessage({ type: 'RESULTS', matches });
    } catch (err: any) {
      self.postMessage({ type: 'ERROR', message: err.message });
    }
    return;
  }
};