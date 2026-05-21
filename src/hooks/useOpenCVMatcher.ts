/**
 * useOpenCVMatcher.ts  v1.0
 * ──────────────────────────
 * Canvas-pixel template matching using OpenCV.js.
 *
 * Strategy:
 *  1. Load opencv.js once from CDN (cached on window.cv)
 *  2. Crop the template region from the source canvas
 *  3. Run cv.matchTemplate (TM_CCOEFF_NORMED) at 4 rotations (0/90/180/270°)
 *  4. Collect all hits above threshold, tag with rotation angle
 *  5. Non-max suppression (IoU) to deduplicate
 *  6. Return results in SVG/canvas pixel coords
 *
 * Drop-in replacement for the Hu-moment SVG matcher — same rubber-band
 * draw flow, same MatchResult shape, different (much more accurate) engine.
 */

import { useState, useCallback, useRef } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CVMatchResult {
  id:       string;
  score:    number;          // 0-1 normalised correlation
  rotation: number;          // degrees: 0 | 90 | 180 | 270
  bbox: {
    x: number; y: number;   // top-left in CANVAS pixel coords
    w: number; h: number;
  };
  /** Snap points in canvas pixel coords */
  snapPoints: Array<{ x: number; y: number; type: 'endpoint' | 'midpoint' | 'centroid' }>;
}

export interface UseOpenCVMatcherReturn {
  isReady:      boolean;
  isSearching:  boolean;
  matches:      CVMatchResult[];
  templateCrop: ImageData | null;
  /** Crop template from the canvas using a viewport box */
  buildTemplate: (
    canvas:  HTMLCanvasElement,
    vpBox:   { x: number; y: number; w: number; h: number },
    zoom:    number,
    pan:     { x: number; y: number },
  ) => void;
  /** Run matching against the full canvas */
  findMatches: (
    canvas:    HTMLCanvasElement,
    threshold?: number,
    rotations?: number[],
  ) => Promise<void>;
  clearAll: () => void;
}

// ─── OpenCV loader ────────────────────────────────────────────────────────────

const OPENCV_URL = 'https://docs.opencv.org/4.x/opencv.js';

declare global {
  interface Window {
    cv: any;
    cvLoadPromise?: Promise<void>;
  }
}

function loadOpenCV(): Promise<void> {
  if (window.cv && typeof window.cv.matchTemplate === 'function') {
    return Promise.resolve();
  }
  if (window.cvLoadPromise) return window.cvLoadPromise;

  window.cvLoadPromise = new Promise<void>((resolve, reject) => {
    const existing = document.getElementById('opencv-js');
    if (existing) {
      // Script already injected — poll until cv is ready
      const poll = setInterval(() => {
        if (window.cv && typeof window.cv.matchTemplate === 'function') {
          clearInterval(poll);
          resolve();
        }
      }, 100);
      return;
    }
    const script = document.createElement('script');
    script.id  = 'opencv-js';
    script.src = OPENCV_URL;
    script.async = true;
    script.onload = () => {
      // cv may still be initialising (WASM compile)
      const poll = setInterval(() => {
        if (window.cv && typeof window.cv.matchTemplate === 'function') {
          clearInterval(poll);
          resolve();
        }
      }, 100);
    };
    script.onerror = () => reject(new Error('Failed to load opencv.js'));
    document.head.appendChild(script);
  });

  return window.cvLoadPromise;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Rotate an ImageData by 0 / 90 / 180 / 270 degrees */
function rotateImageData(src: ImageData, deg: number): ImageData {
  if (deg === 0) return src;
  const { width: sw, height: sh, data: sd } = src;
  const [dw, dh] = deg === 90 || deg === 270 ? [sh, sw] : [sw, sh];
  const dst = new ImageData(dw, dh);
  const dd  = dst.data;

  for (let sy = 0; sy < sh; sy++) {
    for (let sx = 0; sx < sw; sx++) {
      const si = (sy * sw + sx) * 4;
      let dx: number, dy: number;
      if (deg === 90)       { dx = sh - 1 - sy; dy = sx; }
      else if (deg === 180) { dx = sw - 1 - sx; dy = sh - 1 - sy; }
      else                  { dx = sy;           dy = sw - 1 - sx; } // 270
      const di = (dy * dw + dx) * 4;
      dd[di]     = sd[si];
      dd[di + 1] = sd[si + 1];
      dd[di + 2] = sd[si + 2];
      dd[di + 3] = sd[si + 3];
    }
  }
  return dst;
}

/** Build snap points from a bbox */
function snapPointsForBBox(
  x: number, y: number, w: number, h: number,
): CVMatchResult['snapPoints'] {
  return [
    { x: x + w / 2, y: y + h / 2, type: 'centroid'  },
    { x,             y,             type: 'endpoint'  },
    { x: x + w,     y,             type: 'endpoint'  },
    { x: x + w,     y: y + h,      type: 'endpoint'  },
    { x,             y: y + h,      type: 'endpoint'  },
    { x: x + w / 2, y,             type: 'midpoint'  },
    { x: x + w / 2, y: y + h,      type: 'midpoint'  },
    { x,             y: y + h / 2,  type: 'midpoint'  },
    { x: x + w,     y: y + h / 2,  type: 'midpoint'  },
  ];
}

/** IoU deduplication */
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
    if (!kept.some(k => iou(k.bbox, r.bbox) > IOU_THRESHOLD)) {
      kept.push(r);
    }
  }
  return kept;
}

// ─── Core matching (runs per rotation) ───────────────────────────────────────

function runMatchTemplate(
  cv:        any,
  srcMat:    any,         // full grayscale source
  templData: ImageData,   // rotated template ImageData
  deg:       number,
  threshold: number,
  idxOffset: number,
): CVMatchResult[] {
  const { width: tw, height: th } = templData;

  // Build template Mat from ImageData
  const tmp = document.createElement('canvas');
  tmp.width  = tw;
  tmp.height = th;
  const tc = tmp.getContext('2d')!;
  tc.putImageData(templData, 0, 0);
  const templMat  = cv.imread(tmp);
  const templGray = new cv.Mat();
  cv.cvtColor(templMat, templGray, cv.COLOR_RGBA2GRAY);
  templMat.delete();

  // Run matchTemplate
  const result = new cv.Mat();
  cv.matchTemplate(srcMat, templGray, result, cv.TM_CCOEFF_NORMED);
  templGray.delete();

  // Collect hits above threshold
  const matches: CVMatchResult[] = [];
  const data = result.data32F as Float32Array;
  const cols = result.cols;
  const rows = result.rows;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const score = data[r * cols + c];
      if (score >= threshold) {
        // For 90/270 rotated templates w/h swap back to original orientation
        const bw = (deg === 90 || deg === 270) ? th : tw;
        const bh = (deg === 90 || deg === 270) ? tw : th;
        matches.push({
          id:       `cv-${deg}-${idxOffset + r * cols + c}`,
          score,
          rotation: deg,
          bbox:     { x: c, y: r, w: bw, h: bh },
          snapPoints: snapPointsForBBox(c, r, bw, bh),
        });
      }
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

  // Load OpenCV eagerly
  const ensureReady = useCallback(async () => {
    if (isReady) return true;
    try {
      await loadOpenCV();
      setIsReady(true);
      return true;
    } catch (e) {
      console.error('OpenCV load failed', e);
      return false;
    }
  }, [isReady]);

  // ── buildTemplate ───────────────────────────────────────────────────────────
  const buildTemplate = useCallback((
    canvas: HTMLCanvasElement,
    vpBox:  { x: number; y: number; w: number; h: number },
    zoom:   number,
    pan:    { x: number; y: number },
  ) => {
    // Convert viewport box → canvas pixel coords
    const cx = (vpBox.x - pan.x) / zoom;
    const cy = (vpBox.y - pan.y) / zoom;
    const cw = vpBox.w / zoom;
    const ch = vpBox.h / zoom;

    const clampedX = Math.max(0, Math.round(cx));
    const clampedY = Math.max(0, Math.round(cy));
    const clampedW = Math.min(canvas.width  - clampedX, Math.round(cw));
    const clampedH = Math.min(canvas.height - clampedY, Math.round(ch));

    if (clampedW < 4 || clampedH < 4) return;

    const ctx  = canvas.getContext('2d')!;
    const crop = ctx.getImageData(clampedX, clampedY, clampedW, clampedH);
    templateRef.current = crop;
    setTemplateCrop(crop);
    setMatches([]);
  }, []);

  // ── findMatches ─────────────────────────────────────────────────────────────
  const findMatches = useCallback(async (
    canvas:    HTMLCanvasElement,
    threshold  = 0.65,
    rotations  = [0, 90, 180, 270],
  ) => {
    const tmpl = templateRef.current;
    if (!tmpl) return;

    const ok = await ensureReady();
    if (!ok) return;

    setIsSearching(true);
    await new Promise<void>(r => requestAnimationFrame(() => r()));

    const cv = window.cv;
    const allResults: CVMatchResult[] = [];

    try {
      // Build source grayscale Mat from full canvas
      const srcMat  = cv.imread(canvas);
      const srcGray = new cv.Mat();
      cv.cvtColor(srcMat, srcGray, cv.COLOR_RGBA2GRAY);
      srcMat.delete();

      let idxOffset = 0;
      for (const deg of rotations) {
        const rotated = rotateImageData(tmpl, deg);

        // Skip if rotated template larger than source
        const tw = rotated.width;
        const th = rotated.height;
        if (tw > srcGray.cols || th > srcGray.rows) continue;

        const hits = runMatchTemplate(cv, srcGray, rotated, deg, threshold, idxOffset);
        allResults.push(...hits);
        idxOffset += srcGray.cols * srcGray.rows;
      }

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