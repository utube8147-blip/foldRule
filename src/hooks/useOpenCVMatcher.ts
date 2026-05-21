/**
 * useOpenCVMatcher.ts  v2.2
 * ──────────────────────────
 * Thin React hook that manages a dedicated Web Worker running opencvWorker logic.
 * All OpenCV work (loading, text removal, template matching) happens off the
 * main thread so the UI never hangs.
 *
 * v2.2 changes:
 *  ─ Worker sends TEMPLATE_CLEANED message with the text-erased template pixels
 *    so TemplatePreview shows exactly what was matched against.
 *  ─ templateCrop state is updated to the cleaned version once the worker
 *    finishes text removal, giving visual proof of what was erased.
 *  ─ rawTemplateCrop added to the return value so callers can show before/after.
 *  ─ Buffer transfer fix from v2.1 retained (copy before transfer).
 */

import { useState, useCallback, useRef, useEffect } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CVMatchResult {
  id:               string;
  score:            number;
  rotation:         number;
  flipped:          boolean;
  orientationLabel: string;
  bbox: { x: number; y: number; w: number; h: number };
  snapPoints: Array<{ x: number; y: number; type: 'endpoint' | 'midpoint' | 'centroid' }>;
}

export interface UseOpenCVMatcherReturn {
  /** OpenCV in worker is loaded and ready */
  isReady:         boolean;
  /** A match run is currently in progress */
  isSearching:     boolean;
  /** Current verbose phase label from worker */
  workerPhase:     string;
  /** Optional extra detail for current phase */
  workerDetail:    string;
  matches:         CVMatchResult[];
  /** Original captured crop (before text removal) */
  rawTemplateCrop: ImageData | null;
  /**
   * Live template crop shown in preview:
   *  - While/before matching: the original raw crop
   *  - After text removal completes: the cleaned (text-erased) version
   * This is what the worker actually matched against.
   */
  templateCrop:    ImageData | null;
  buildTemplate: (
    canvas: HTMLCanvasElement,
    vpBox:  { x: number; y: number; w: number; h: number },
    zoom:   number,
    pan:    { x: number; y: number },
  ) => void;
  findMatches: (
    canvas:       HTMLCanvasElement,
    threshold?:   number,
    rotations?:   number[],
    flips?:       boolean[],
    removeText?:  boolean,
  ) => Promise<void>;
  clearAll: () => void;
}

// ─── Inlined worker source ────────────────────────────────────────────────────
// Compiled-JS equivalent of opencvWorker.ts — no bundler plugin required.
// Mirrors the Blob URL pattern used by useCornerDetection.

function getOpenCVWorkerSource(): string {
  return `
const OPENCV_URL = 'https://docs.opencv.org/4.x/opencv.js';
let cvReady = false;
let cvLoadPromise = null;

function loadCV() {
  if (cvReady) return Promise.resolve();
  if (cvLoadPromise) return cvLoadPromise;
  cvLoadPromise = new Promise(function(resolve, reject) {
    try { importScripts(OPENCV_URL); } catch(e) { reject(new Error('importScripts failed: ' + e)); return; }
    var poll = setInterval(function() {
      if (typeof cv !== 'undefined' && cv && typeof cv.matchTemplate === 'function') {
        clearInterval(poll); cvReady = true; resolve();
      }
    }, 80);
    setTimeout(function() { clearInterval(poll); reject(new Error('OpenCV load timeout')); }, 30000);
  });
  return cvLoadPromise;
}

function snapPointsForBBox(x, y, w, h) {
  return [
    { x: x + w / 2, y: y + h / 2, type: 'centroid' },
    { x: x,         y: y,         type: 'endpoint' },
    { x: x + w,     y: y,         type: 'endpoint' },
    { x: x + w,     y: y + h,     type: 'endpoint' },
    { x: x,         y: y + h,     type: 'endpoint' },
    { x: x + w / 2, y: y,         type: 'midpoint' },
    { x: x + w / 2, y: y + h,     type: 'midpoint' },
    { x: x,         y: y + h / 2, type: 'midpoint' },
    { x: x + w,     y: y + h / 2, type: 'midpoint' },
  ];
}

function iou(a, b) {
  var ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  var iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  var inter = ix * iy;
  if (inter === 0) return 0;
  return inter / (a.w * a.h + b.w * b.h - inter);
}

function nms(results) {
  var sorted = results.slice().sort(function(a, b) { return b.score - a.score; });
  var kept = [];
  for (var i = 0; i < sorted.length; i++) {
    var r = sorted[i];
    if (!kept.some(function(k) { return iou(k.bbox, r.bbox) > 0.3; })) kept.push(r);
  }
  return kept;
}

function matWithoutText(cv, gray) {
  var binary    = new cv.Mat();
  var labels    = new cv.Mat();
  var stats     = new cv.Mat();
  var centroids = new cv.Mat();
  cv.threshold(gray, binary, 180, 255, cv.THRESH_BINARY_INV);
  var numLabels = cv.connectedComponentsWithStats(binary, labels, stats, centroids, 8, cv.CV_32S);
  var out = gray.clone();
  for (var i = 1; i < numLabels; i++) {
    var x    = stats.intAt(i, cv.CC_STAT_LEFT);
    var y    = stats.intAt(i, cv.CC_STAT_TOP);
    var w    = stats.intAt(i, cv.CC_STAT_WIDTH);
    var h    = stats.intAt(i, cv.CC_STAT_HEIGHT);
    var ar   = w / Math.max(h, 1);
    var area = stats.intAt(i, cv.CC_STAT_AREA);
    if (w < 30 && h < 40 && ar >= 0.2 && ar <= 5.0 && area >= 4 && area <= 600) {
      var roi = out.roi(new cv.Rect(x, y, w, h));
      roi.setTo(new cv.Scalar(255));
      roi.delete();
    }
  }
  binary.delete(); labels.delete(); stats.delete(); centroids.delete();
  return out;
}

// Convert a single-channel (grayscale) OpenCV Mat to a transferable
// Uint8ClampedArray in RGBA layout (R=G=B=gray, A=255).
function grayMatToRGBA(mat) {
  var gd  = mat.data;          // Uint8Array, one byte per pixel
  var len = gd.length;
  var out = new Uint8ClampedArray(len * 4);
  for (var i = 0; i < len; i++) {
    var base = i * 4;
    out[base]     = gd[i];
    out[base + 1] = gd[i];
    out[base + 2] = gd[i];
    out[base + 3] = 255;
  }
  return out;
}

function prepareSourceMat(cv, srcGray, deg, flipped) {
  var rotated;
  if (deg === 0) {
    rotated = srcGray.clone();
  } else if (deg === 180) {
    rotated = new cv.Mat();
    cv.flip(srcGray, rotated, -1);
  } else {
    var transposed = new cv.Mat();
    cv.transpose(srcGray, transposed);
    rotated = new cv.Mat();
    if (deg === 90) cv.flip(transposed, rotated, 1);
    else             cv.flip(transposed, rotated, 0);
    transposed.delete();
  }
  if (flipped) {
    var flippedMat = new cv.Mat();
    cv.flip(rotated, flippedMat, 1);
    rotated.delete();
    return flippedMat;
  }
  return rotated;
}

function remapToOriginal(hitX, hitY, deg, flipped, srcW, srcH, bboxW, bboxH) {
  var rotW        = (deg === 90 || deg === 270) ? srcH : srcW;
  var tmplInPrepW = (deg === 90 || deg === 270) ? bboxH : bboxW;
  var cx = hitX + tmplInPrepW / 2;
  var cy = hitY + ((deg === 90 || deg === 270) ? bboxW : bboxH) / 2;
  if (flipped) cx = rotW - 1 - cx;
  var origCx, origCy;
  switch (deg) {
    case 0:   origCx = cx;             origCy = cy;             break;
    case 90:  origCx = cy;             origCy = srcH - 1 - cx;  break;
    case 180: origCx = srcW - 1 - cx;  origCy = srcH - 1 - cy;  break;
    case 270: origCx = srcW - 1 - cy;  origCy = cx;             break;
    default:  origCx = cx;             origCy = cy;
  }
  return { x: Math.round(origCx - bboxW / 2), y: Math.round(origCy - bboxH / 2) };
}

function runOrientationPass(cv, srcGray, templGray, orient, threshold, idxOffset, origTemplW, origTemplH, srcW, srcH) {
  var deg      = orient.deg;
  var flipped  = orient.flipped;
  var label    = orient.label;
  var preparedSrc = prepareSourceMat(cv, srcGray, deg, flipped);
  if (origTemplW > preparedSrc.cols || origTemplH > preparedSrc.rows) {
    preparedSrc.delete();
    return [];
  }
  var result = new cv.Mat();
  cv.matchTemplate(preparedSrc, templGray, result, cv.TM_CCOEFF_NORMED);
  preparedSrc.delete();
  var data  = result.data32F;
  var rCols = result.cols;
  var rRows = result.rows;
  var matches = [];
  for (var r = 0; r < rRows; r++) {
    for (var c = 0; c < rCols; c++) {
      var score = data[r * rCols + c];
      if (score < threshold) continue;
      var bboxW = (deg === 90 || deg === 270) ? origTemplH : origTemplW;
      var bboxH = (deg === 90 || deg === 270) ? origTemplW : origTemplH;
      var orig  = remapToOriginal(c, r, deg, flipped, srcW, srcH, bboxW, bboxH);
      matches.push({
        id:               'cv-' + label + '-' + (idxOffset + r * rCols + c),
        score:            score,
        rotation:         deg,
        flipped:          flipped,
        orientationLabel: label,
        bbox:             { x: orig.x, y: orig.y, w: bboxW, h: bboxH },
        snapPoints:       snapPointsForBBox(orig.x, orig.y, bboxW, bboxH),
      });
    }
  }
  result.delete();
  return matches;
}

function imageDataToMat(cv, imgData) {
  var mat = cv.matFromArray(imgData.height, imgData.width, cv.CV_8UC4, Array.from(imgData.data));
  return mat;
}

async function doFindMatches(msg) {
  var cvLib = self.cv;
  var srcImageData  = msg.srcImageData;
  var tmplImageData = msg.tmplImageData;
  var threshold     = msg.threshold;
  var rotations     = msg.rotations;
  var flips         = msg.flips;
  var removeText    = msg.removeText;
  var origTemplW    = tmplImageData.width;
  var origTemplH    = tmplImageData.height;

  // ── Source ────────────────────────────────────────────────────────────────
  self.postMessage({ type: 'PROGRESS', phase: 'Converting source image' });
  var srcMat     = imageDataToMat(cvLib, srcImageData);
  var srcGrayRaw = new cvLib.Mat();
  cvLib.cvtColor(srcMat, srcGrayRaw, cvLib.COLOR_RGBA2GRAY);
  srcMat.delete();

  var srcGray;
  if (removeText) {
    self.postMessage({ type: 'PROGRESS', phase: 'Removing text from source', detail: 'Erasing text blobs from source…' });
    srcGray = matWithoutText(cvLib, srcGrayRaw);
    srcGrayRaw.delete();
    self.postMessage({ type: 'PROGRESS', phase: 'Source text removed', detail: '✓ Source text erased' });
  } else {
    srcGray = srcGrayRaw;
  }

  var srcW = srcGray.cols;
  var srcH = srcGray.rows;

  // ── Template ──────────────────────────────────────────────────────────────
  self.postMessage({ type: 'PROGRESS', phase: 'Converting template' });
  var templMat     = imageDataToMat(cvLib, tmplImageData);
  var templGrayRaw = new cvLib.Mat();
  cvLib.cvtColor(templMat, templGrayRaw, cvLib.COLOR_RGBA2GRAY);
  templMat.delete();

  var templGray;
  if (removeText) {
    self.postMessage({ type: 'PROGRESS', phase: 'Removing text from template', detail: 'Erasing text blobs from template…' });
    templGray = matWithoutText(cvLib, templGrayRaw);
    templGrayRaw.delete();

    // ── Send cleaned template pixels back so TemplatePreview can show
    //    exactly what was matched against (white blobs where text was).
    //    Transfer the buffer zero-copy — it's no longer needed here.
    var cleanedRGBA = grayMatToRGBA(templGray);
    self.postMessage(
      {
        type:   'TEMPLATE_CLEANED',
        data:   cleanedRGBA,
        width:  templGray.cols,
        height: templGray.rows,
      },
      [cleanedRGBA.buffer],
    );

    self.postMessage({ type: 'PROGRESS', phase: 'Template text removed', detail: '✓ Template text erased' });
  } else {
    templGray = templGrayRaw;
  }

  // ── Orientation passes ────────────────────────────────────────────────────
  var orientations = [];
  for (var ri = 0; ri < rotations.length; ri++) {
    for (var fi = 0; fi < flips.length; fi++) {
      var deg     = rotations[ri];
      var flipped = flips[fi];
      orientations.push({ deg: deg, flipped: flipped, label: flipped ? deg + '°↔' : deg + '°' });
    }
  }

  var allResults = [];
  var idxOffset  = 0;

  for (var i = 0; i < orientations.length; i++) {
    var orient = orientations[i];
    self.postMessage({
      type:   'PROGRESS',
      phase:  'Matching orientation ' + (i + 1) + '/' + orientations.length,
      detail: orient.label,
    });
    var hits = runOrientationPass(
      cvLib, srcGray, templGray,
      orient, threshold, idxOffset,
      origTemplW, origTemplH, srcW, srcH,
    );
    for (var h = 0; h < hits.length; h++) allResults.push(hits[h]);
    idxOffset += srcW * srcH;
  }

  templGray.delete();
  srcGray.delete();

  self.postMessage({ type: 'PROGRESS', phase: 'Non-maximum suppression' });
  var deduped = nms(allResults);
  deduped.sort(function(a, b) { return b.score - a.score; });
  return deduped;
}

self.onmessage = async function(e) {
  var msg = e.data;

  if (msg.type === 'LOAD') {
    try {
      self.postMessage({ type: 'PROGRESS', phase: 'Loading OpenCV.js…' });
      await loadCV();
      self.postMessage({ type: 'READY' });
    } catch(err) {
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
      var matches = await doFindMatches(msg);
      self.postMessage({ type: 'RESULTS', matches: matches });
    } catch(err) {
      self.postMessage({ type: 'ERROR', message: err.message });
    }
    return;
  }
};
`;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useOpenCVMatcher(): UseOpenCVMatcherReturn {
  const [isReady,          setIsReady]          = useState(false);
  const [isSearching,      setIsSearching]      = useState(false);
  const [workerPhase,      setWorkerPhase]      = useState('');
  const [workerDetail,     setWorkerDetail]     = useState('');
  const [matches,          setMatches]          = useState<CVMatchResult[]>([]);
  const [rawTemplateCrop,  setRawTemplateCrop]  = useState<ImageData | null>(null);
  const [templateCrop,     setTemplateCrop]     = useState<ImageData | null>(null);

  const workerRef   = useRef<Worker | null>(null);
  const blobUrlRef  = useRef('');
  const templateRef = useRef<ImageData | null>(null);

  // Pending promise resolution for the current findMatches call
  const resolveRef = useRef<(() => void) | null>(null);
  const rejectRef  = useRef<((e: Error) => void) | null>(null);

  // ── Spin up worker once ─────────────────────────────────────────────────────
  useEffect(() => {
    const src  = getOpenCVWorkerSource();
    const blob = new Blob([src], { type: 'application/javascript' });
    const url  = URL.createObjectURL(blob);
    blobUrlRef.current = url;

    const worker = new Worker(url);
    workerRef.current = worker;

    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data;

      switch (msg.type) {

        case 'READY':
          setIsReady(true);
          setWorkerPhase('OpenCV ready');
          setWorkerDetail('');
          break;

        case 'PROGRESS':
          setWorkerPhase(msg.phase ?? '');
          setWorkerDetail(msg.detail ?? '');
          break;

        // ── Worker finished text removal on the template and sent back
        //    the cleaned pixels so the preview reflects what was matched.
        case 'TEMPLATE_CLEANED': {
          const cleaned = new ImageData(
            msg.data as Uint8ClampedArray,  // transferred buffer — already in main thread
            msg.width  as number,
            msg.height as number,
          );
          // Update the live preview to the cleaned version.
          // rawTemplateCrop keeps the original for before/after comparison.
          setTemplateCrop(cleaned);
          break;
        }

        case 'RESULTS':
          setMatches(msg.matches ?? []);
          setIsSearching(false);
          setWorkerPhase(`Done — ${msg.matches?.length ?? 0} match${msg.matches?.length !== 1 ? 'es' : ''}`);
          setWorkerDetail('');
          resolveRef.current?.();
          resolveRef.current = null;
          rejectRef.current  = null;
          break;

        case 'ERROR':
          console.error('[CVWorker]', msg.message);
          setIsSearching(false);
          setWorkerPhase(`Error: ${msg.message}`);
          setWorkerDetail('');
          rejectRef.current?.(new Error(msg.message));
          resolveRef.current = null;
          rejectRef.current  = null;
          break;
      }
    };

    worker.onerror = (e) => {
      console.error('[CVWorker] uncaught', e);
      setIsSearching(false);
      setWorkerPhase('Worker crashed');
      rejectRef.current?.(new Error(e.message));
      resolveRef.current = null;
      rejectRef.current  = null;
    };

    // Kick off OpenCV load in background immediately
    worker.postMessage({ type: 'LOAD' });
    setWorkerPhase('Loading OpenCV.js…');

    return () => {
      worker.terminate();
      URL.revokeObjectURL(url);
      workerRef.current = null;
    };
  }, []);

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
    // Both raw and live preview start as the original crop.
    // templateCrop will be replaced by TEMPLATE_CLEANED once the worker
    // finishes text removal — that is what the matcher actually used.
    setRawTemplateCrop(crop);
    setTemplateCrop(crop);
    setMatches([]);
  }, []);

  // ── findMatches ─────────────────────────────────────────────────────────────
  const findMatches = useCallback(async (
    canvas:     HTMLCanvasElement,
    threshold   = 0.60,
    rotations   = [0, 90, 180, 270],
    flips       = [false, true],
    removeText  = true,
  ): Promise<void> => {
    const tmpl   = templateRef.current;
    const worker = workerRef.current;
    if (!tmpl || !worker) return;

    setIsSearching(true);
    setMatches([]);
    setWorkerDetail('');

    // Grab the full source image from the canvas
    const srcCtx       = canvas.getContext('2d')!;
    const srcImageData = srcCtx.getImageData(0, 0, canvas.width, canvas.height);

    // Copy the template buffer before transferring so templateRef.current
    // (and rawTemplateCrop) remain valid after the transfer detaches the copy.
    const tmplDataCopy  = new Uint8ClampedArray(tmpl.data);
    const tmplImageData = {
      data:   tmplDataCopy,
      width:  tmpl.width,
      height: tmpl.height,
    };

    // Source is single-use in the worker — safe to transfer directly.
    const srcData = {
      data:   srcImageData.data,
      width:  srcImageData.width,
      height: srcImageData.height,
    };

    return new Promise<void>((resolve, reject) => {
      resolveRef.current = resolve;
      rejectRef.current  = reject;

      worker.postMessage(
        {
          type:          'FIND_MATCHES',
          srcImageData:  srcData,
          tmplImageData: tmplImageData,
          threshold,
          rotations,
          flips,
          removeText,
        },
        // Transfer only the copy's buffer + source buffer. Original tmpl.data untouched.
        [srcData.data.buffer, tmplDataCopy.buffer],
      );
    });
  }, []);

  // ── clearAll ────────────────────────────────────────────────────────────────
  const clearAll = useCallback(() => {
    templateRef.current = null;
    setRawTemplateCrop(null);
    setTemplateCrop(null);
    setMatches([]);
    setWorkerPhase(isReady ? 'OpenCV ready' : 'Loading OpenCV.js…');
    setWorkerDetail('');
  }, [isReady]);

  return {
    isReady,
    isSearching,
    workerPhase,
    workerDetail,
    matches,
    rawTemplateCrop,
    templateCrop,
    buildTemplate,
    findMatches,
    clearAll,
  };
}