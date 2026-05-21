/**
 * useOpenCVMatcher.ts  v1.3
 * ──────────────────────────
 * Canvas-pixel template matching using OpenCV.js.
 *
 * Strategy:
 *  1. Load opencv.js once from CDN (cached on window.cv)
 *  2. Crop the template region from the source canvas
 *  3. For each of 8 orientations (4 rotations × 2 flip states):
 *       - Prepare the source mat for that orientation (rotate + optional flip)
 *       - Match the ORIGINAL sharp 0° template against the prepared source
 *       - Map hit coordinates back to original canvas space
 *  4. Collect all hits above threshold, tag with rotation + flip
 *  5. Non-max suppression (IoU) to deduplicate
 *  6. Return results in SVG/canvas pixel coords
 *
 * v1.3 key changes vs v1.2:
 *  ─ Added FLIP support (horizontal + vertical).
 *    Architectural door symbols that face the other way are a mirror image,
 *    not a 180° rotation. Without flip support those instances score poorly
 *    because the arc curves in the wrong direction. Now all 8 rigid-body
 *    orientations are tested: 0°/90°/180°/270° × (normal / h-flip).
 *  ─ `rotation` field in CVMatchResult now encodes both rotation and flip
 *    as a human-readable string e.g. "90°↔" so the sidebar can show it.
 *  ─ Coordinate remapping extended to handle the flip component.
 *  ─ Template stays at 0° unflipped for every pass — source is transformed
 *    instead, keeping correlation scores consistent across all orientations.
 *  ─ Default threshold 0.60 (60 %).
 */

import { useState, useCallback, useRef } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CVMatchResult {
  id:        string;
  score:     number;          // 0–1 normalised correlation
  rotation:  number;          // degrees: 0 | 90 | 180 | 270
  flipped:   boolean;         // true = horizontal flip applied after rotation
  orientationLabel: string;   // human-readable e.g. "90°↔"
  bbox: {
    x: number; y: number;    // top-left in CANVAS pixel coords
    w: number; h: number;
  };
  snapPoints: Array<{ x: number; y: number; type: 'endpoint' | 'midpoint' | 'centroid' }>;
}

export interface UseOpenCVMatcherReturn {
  isReady:      boolean;
  isSearching:  boolean;
  matches:      CVMatchResult[];
  templateCrop: ImageData | null;
  buildTemplate: (
    canvas: HTMLCanvasElement,
    vpBox:  { x: number; y: number; w: number; h: number },
    zoom:   number,
    pan:    { x: number; y: number },
  ) => void;
  findMatches: (
    canvas:     HTMLCanvasElement,
    threshold?: number,
    rotations?: number[],
    flips?:     boolean[],
  ) => Promise<void>;
  clearAll: () => void;
}

// ─── Orientation descriptor ───────────────────────────────────────────────────

interface Orientation {
  deg:     number;    // 0 | 90 | 180 | 270
  flipped: boolean;   // horizontal flip after rotation
  label:   string;
}

function buildOrientations(rotations: number[], flips: boolean[]): Orientation[] {
  const out: Orientation[] = [];
  for (const deg of rotations) {
    for (const flipped of flips) {
      out.push({
        deg,
        flipped,
        label: flipped ? `${deg}°↔` : `${deg}°`,
      });
    }
  }
  return out;
}

// ─── OpenCV loader ────────────────────────────────────────────────────────────

const OPENCV_URL = 'https://docs.opencv.org/4.x/opencv.js';

declare global {
  interface Window { cv: any; cvLoadPromise?: Promise<void>; }
}

function loadOpenCV(): Promise<void> {
  if (window.cv && typeof window.cv.matchTemplate === 'function') return Promise.resolve();
  if (window.cvLoadPromise) return window.cvLoadPromise;

  window.cvLoadPromise = new Promise<void>((resolve, reject) => {
    const existing = document.getElementById('opencv-js');
    if (existing) {
      const poll = setInterval(() => {
        if (window.cv && typeof window.cv.matchTemplate === 'function') { clearInterval(poll); resolve(); }
      }, 100);
      return;
    }
    const script = document.createElement('script');
    script.id    = 'opencv-js';
    script.src   = OPENCV_URL;
    script.async = true;
    script.onload = () => {
      const poll = setInterval(() => {
        if (window.cv && typeof window.cv.matchTemplate === 'function') { clearInterval(poll); resolve(); }
      }, 100);
    };
    script.onerror = () => reject(new Error('Failed to load opencv.js'));
    document.head.appendChild(script);
  });
  return window.cvLoadPromise;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function snapPointsForBBox(x: number, y: number, w: number, h: number): CVMatchResult['snapPoints'] {
  return [
    { x: x + w / 2, y: y + h / 2, type: 'centroid' },
    { x,             y,             type: 'endpoint' },
    { x: x + w,     y,             type: 'endpoint' },
    { x: x + w,     y: y + h,      type: 'endpoint' },
    { x,             y: y + h,      type: 'endpoint' },
    { x: x + w / 2, y,             type: 'midpoint' },
    { x: x + w / 2, y: y + h,      type: 'midpoint' },
    { x,             y: y + h / 2,  type: 'midpoint' },
    { x: x + w,     y: y + h / 2,  type: 'midpoint' },
  ];
}

function iou(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  if (inter === 0) return 0;
  return inter / (a.w * a.h + b.w * b.h - inter);
}

const IOU_THRESHOLD = 0.3;

function nms(results: CVMatchResult[]): CVMatchResult[] {
  const sorted = [...results].sort((a, b) => b.score - a.score);
  const kept: CVMatchResult[] = [];
  for (const r of sorted) {
    if (!kept.some(k => iou(k.bbox, r.bbox) > IOU_THRESHOLD)) kept.push(r);
  }
  return kept;
}

// ─── Source mat preparation ───────────────────────────────────────────────────
//
// We ALWAYS keep the template at 0° (original, sharp).
// Instead we transform the SOURCE for each orientation pass.
//
// Rotation uses transpose+flip (lossless, no interpolation).
// Flip uses cv.flip after rotation.
//
// Combined transform applied to source for orientation (deg, flipped):
//   1. Rotate source by `deg` CW
//   2. If flipped: flip horizontally (flipCode = 1)
//
// A symbol that appears at orientation (deg, flipped) in the original canvas
// will look like the original 0° unflipped template in this prepared source.

function prepareSourceMat(cv: any, srcGray: any, deg: number, flipped: boolean): any {
  // Step 1 — rotate
  let rotated: any;
  if (deg === 0) {
    rotated = srcGray.clone();
  } else if (deg === 180) {
    rotated = new cv.Mat();
    cv.flip(srcGray, rotated, -1);
  } else {
    // 90 or 270
    const transposed = new cv.Mat();
    cv.transpose(srcGray, transposed);
    rotated = new cv.Mat();
    if (deg === 90)       cv.flip(transposed, rotated, 1);   // flip horizontally
    else /* 270 */        cv.flip(transposed, rotated, 0);   // flip vertically
    transposed.delete();
  }

  // Step 2 — horizontal flip
  if (flipped) {
    const flippedMat = new cv.Mat();
    cv.flip(rotated, flippedMat, 1);
    rotated.delete();
    return flippedMat;
  }
  return rotated;
}

// ─── Coordinate remapping ─────────────────────────────────────────────────────
//
// Given a hit at (hitX, hitY) in the PREPARED (rotated+flipped) source,
// recover the top-left corner of the bbox in the ORIGINAL canvas space.
//
// We invert the transform: first undo the flip, then undo the rotation.
// All arithmetic is on the CENTRE of the bbox for clarity.

function remapToOriginal(
  hitX: number, hitY: number,
  deg: number, flipped: boolean,
  srcW: number, srcH: number,
  bboxW: number, bboxH: number,   // bbox dims IN ORIGINAL canvas space
): { x: number; y: number } {

  // Dimensions of the prepared (rotated) source
  const rotW = (deg === 90 || deg === 270) ? srcH : srcW;
  const rotH = (deg === 90 || deg === 270) ? srcW : srcH;

  // Template dims in prepared source space (always origTemplW × origTemplH)
  // which equals bboxW × bboxH when deg=0/180, and bboxH × bboxW when deg=90/270
  const tmplInPrepW = (deg === 90 || deg === 270) ? bboxH : bboxW;
  const tmplInPrepH = (deg === 90 || deg === 270) ? bboxW : bboxH;

  // Centre of hit in prepared source space
  let cx = hitX + tmplInPrepW / 2;
  let cy = hitY + tmplInPrepH / 2;

  // Step 1 — undo horizontal flip
  if (flipped) {
    cx = rotW - 1 - cx;
    // cy unchanged
  }

  // Step 2 — undo rotation
  let origCx: number, origCy: number;
  switch (deg) {
    case 0:
      origCx = cx;
      origCy = cy;
      break;
    case 90:
      // rotate 90 CW maps (ox,oy) → (srcH-1-oy, ox)  in rotated space
      // i.e. rotX = srcH-1-oy, rotY = ox
      // inverse: oy = srcH-1-rotX, ox = rotY
      origCx = cy;
      origCy = srcH - 1 - cx;
      break;
    case 180:
      origCx = srcW - 1 - cx;
      origCy = srcH - 1 - cy;
      break;
    case 270:
      // rotate 270 CW maps (ox,oy) → (oy, srcW-1-ox) in rotated space
      // inverse: ox = srcW-1-rotY, oy = rotX
      origCx = srcW - 1 - cy;
      origCy = cx;
      break;
    default:
      origCx = cx;
      origCy = cy;
  }

  // Top-left of bbox in original canvas space
  return {
    x: Math.round(origCx - bboxW / 2),
    y: Math.round(origCy - bboxH / 2),
  };
}

// ─── Single orientation pass ──────────────────────────────────────────────────

function runOrientationPass(
  cv:         any,
  srcGray:    any,
  templGray:  any,       // always 0°, never rotated
  orient:     Orientation,
  threshold:  number,
  idxOffset:  number,
  origTemplW: number,
  origTemplH: number,
  srcW:       number,
  srcH:       number,
): CVMatchResult[] {

  const { deg, flipped, label } = orient;

  // Prepare source for this orientation
  const preparedSrc = prepareSourceMat(cv, srcGray, deg, flipped);

  // Check template fits in prepared source
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

      // Bbox dims in original canvas space
      const bboxW = (deg === 90 || deg === 270) ? origTemplH : origTemplW;
      const bboxH = (deg === 90 || deg === 270) ? origTemplW : origTemplH;

      const orig = remapToOriginal(c, r, deg, flipped, srcW, srcH, bboxW, bboxH);

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

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useOpenCVMatcher(): UseOpenCVMatcherReturn {
  const [isReady,      setIsReady]      = useState(false);
  const [isSearching,  setIsSearching]  = useState(false);
  const [matches,      setMatches]      = useState<CVMatchResult[]>([]);
  const [templateCrop, setTemplateCrop] = useState<ImageData | null>(null);
  const templateRef = useRef<ImageData | null>(null);

  const ensureReady = useCallback(async () => {
    if (isReady) return true;
    try { await loadOpenCV(); setIsReady(true); return true; }
    catch (e) { console.error('OpenCV load failed', e); return false; }
  }, [isReady]);

  // ── buildTemplate ───────────────────────────────────────────────────────────
  const buildTemplate = useCallback((
    canvas: HTMLCanvasElement,
    vpBox:  { x: number; y: number; w: number; h: number },
    zoom:   number,
    pan:    { x: number; y: number },
  ) => {
    const cx = (vpBox.x - pan.x) / zoom;
    const cy = (vpBox.y - pan.y) / zoom;
    const cw = vpBox.w / zoom;
    const ch = vpBox.h / zoom;
    const clampedX = Math.max(0, Math.round(cx));
    const clampedY = Math.max(0, Math.round(cy));
    const clampedW = Math.min(canvas.width  - clampedX, Math.round(cw));
    const clampedH = Math.min(canvas.height - clampedY, Math.round(ch));
    if (clampedW < 4 || clampedH < 4) return;
    const crop = canvas.getContext('2d')!.getImageData(clampedX, clampedY, clampedW, clampedH);
    templateRef.current = crop;
    setTemplateCrop(crop);
    setMatches([]);
  }, []);

  // ── findMatches ─────────────────────────────────────────────────────────────
  const findMatches = useCallback(async (
    canvas:    HTMLCanvasElement,
    threshold  = 0.60,                    // 60% default
    rotations  = [0, 90, 180, 270],
    flips      = [false, true],           // test both normal and h-flipped
  ) => {
    const tmpl = templateRef.current;
    if (!tmpl) return;
    const ok = await ensureReady();
    if (!ok) return;

    setIsSearching(true);
    await new Promise<void>(r => requestAnimationFrame(() => r()));

    const cv          = window.cv;
    const allResults: CVMatchResult[] = [];
    const origTemplW  = tmpl.width;
    const origTemplH  = tmpl.height;

    try {
      // Build source grayscale Mat
      const srcMat  = cv.imread(canvas);
      const srcGray = new cv.Mat();
      cv.cvtColor(srcMat, srcGray, cv.COLOR_RGBA2GRAY);
      srcMat.delete();
      const srcW = srcGray.cols;
      const srcH = srcGray.rows;

      // Build template grayscale Mat — always stays at 0°, never transformed
      const tmpCanvas = document.createElement('canvas');
      tmpCanvas.width  = origTemplW;
      tmpCanvas.height = origTemplH;
      tmpCanvas.getContext('2d')!.putImageData(tmpl, 0, 0);
      const templMat  = cv.imread(tmpCanvas);
      const templGray = new cv.Mat();
      cv.cvtColor(templMat, templGray, cv.COLOR_RGBA2GRAY);
      templMat.delete();

      // Build all 8 orientations (4 rotations × 2 flip states)
      const orientations = buildOrientations(rotations, flips);

      let idxOffset = 0;
      for (const orient of orientations) {
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

    } catch (err) {
      console.error('OpenCV matchTemplate error', err);
    }

    const deduped = nms(allResults);
    deduped.sort((a, b) => b.score - a.score);
    setMatches(deduped);
    setIsSearching(false);
  }, [ensureReady]);

  // ── clearAll ────────────────────────────────────────────────────────────────
  const clearAll = useCallback(() => {
    templateRef.current = null;
    setTemplateCrop(null);
    setMatches([]);
  }, []);

  return { isReady, isSearching, matches, templateCrop, buildTemplate, findMatches, clearAll };
}