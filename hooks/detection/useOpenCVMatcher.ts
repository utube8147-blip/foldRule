/**
 * useOpenCVMatcher.ts  v4.0
 * ──────────────────────────
 * Multi-scale template matching via Web Worker.
 *
 * v4.0 changes over v3.0:
 *  ─ ALL transforms (rotation, flip, scale) are applied to the TEMPLATE only.
 *    The source (PDF canvas) is NEVER transformed. This means:
 *      • 180° now genuinely finds upside-down symbols in the PDF, not duplicates of 0°.
 *      • Flip finds mirror-image symbols in the PDF, not a re-scan of the same area.
 *      • No coordinate remapping needed — matchTemplate hits are already in source space.
 *  ─ prepareSourceMat and remapToOriginal removed (no longer needed).
 *  ─ runPass simplified: always matchTemplate(srcGray, rotatedFlippedScaledTemplate).
 *  ─ All v3.0 features retained (multi-scale, NMS, text removal, TEMPLATE_CLEANED).
 */

import { useState, useCallback, useRef, useEffect } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CVMatchResult {
  id:               string;
  score:            number;
  rotation:         number;
  flipped:          boolean;
  scale:            number;
  orientationLabel: string;
  bbox: { x: number; y: number; w: number; h: number };
  rotatedW:         number;
  rotatedH:         number;
  snapPoints: Array<{ x: number; y: number; type: 'endpoint' | 'midpoint' | 'centroid' }>;
}

export interface UseOpenCVMatcherReturn {
  isReady:         boolean;
  isSearching:     boolean;
  workerPhase:     string;
  workerDetail:    string;
  matches:         CVMatchResult[];
  rawTemplateCrop: ImageData | null;
  templateCrop:    ImageData | null;
  buildTemplate: (
    canvas: HTMLCanvasElement,
    vpBox:  { x: number; y: number; w: number; h: number },
    zoom:   number,
    pan:    { x: number; y: number },
  ) => void;
  findMatches: (
    canvas:      HTMLCanvasElement,
    threshold?:  number,
    rotations?:  number[],
    flips?:      boolean[],
    removeText?: boolean,
    scales?:     number[],
  ) => Promise<void>;
  clearAll: () => void;
}

// ─── Inlined worker source ────────────────────────────────────────────────────

function getOpenCVWorkerSource(): string {
  return `
'use strict';
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

// ── Snap helpers ──────────────────────────────────────────────────────────────

function snapPointsForBBox(x, y, w, h) {
  return [
    { x: x + w / 2, y: y + h / 2, type: 'centroid'  },
    { x: x,         y: y,         type: 'endpoint'  },
    { x: x + w,     y: y,         type: 'endpoint'  },
    { x: x + w,     y: y + h,     type: 'endpoint'  },
    { x: x,         y: y + h,     type: 'endpoint'  },
    { x: x + w / 2, y: y,         type: 'midpoint'  },
    { x: x + w / 2, y: y + h,     type: 'midpoint'  },
    { x: x,         y: y + h / 2, type: 'midpoint'  },
    { x: x + w,     y: y + h / 2, type: 'midpoint'  },
  ];
}

// ── IoU / NMS ─────────────────────────────────────────────────────────────────

function iou(a, b) {
  var ix    = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  var iy    = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  var inter = ix * iy;
  if (inter === 0) return 0;
  return inter / (a.w * a.h + b.w * b.h - inter);
}

function nms(results, iouThresh) {
  var thresh = iouThresh !== undefined ? iouThresh : 0.30;
  var sorted = results.slice().sort(function(a, b) { return b.score - a.score; });
  var kept   = [];
  for (var i = 0; i < sorted.length; i++) {
    var r = sorted[i];
    if (!kept.some(function(k) { return iou(k.bbox, r.bbox) > thresh; })) kept.push(r);
  }
  return kept;
}

// ── Text removal ──────────────────────────────────────────────────────────────

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

function grayMatToRGBA(mat) {
  var gd  = mat.data;
  var len = gd.length;
  var out = new Uint8ClampedArray(len * 4);
  for (var i = 0; i < len; i++) {
    var base = i * 4;
    out[base] = out[base+1] = out[base+2] = gd[i];
    out[base+3] = 255;
  }
  return out;
}

// ── Template rotation ─────────────────────────────────────────────────────────
// Always rotates the TEMPLATE. Source is never touched.

function rotateMat(cv, src, deg) {
  var d = ((deg % 360) + 360) % 360;
  if (d === 0)   return src.clone();
  if (d === 90)  { var t1=new cv.Mat(); cv.transpose(src,t1); var r1=new cv.Mat(); cv.flip(t1,r1,1);  t1.delete(); return r1; }
  if (d === 180) { var r2=new cv.Mat(); cv.flip(src,r2,-1); return r2; }
  if (d === 270) { var t3=new cv.Mat(); cv.transpose(src,t3); var r3=new cv.Mat(); cv.flip(t3,r3,0);  t3.delete(); return r3; }

  // Arbitrary angle via warpAffine
  var cx  = src.cols / 2;
  var cy  = src.rows / 2;
  var M   = cv.getRotationMatrix2D(new cv.Point(cx, cy), -d, 1.0);
  var rad = d * Math.PI / 180;
  var cosA = Math.abs(Math.cos(rad));
  var sinA = Math.abs(Math.sin(rad));
  var nW  = Math.round(src.cols * cosA + src.rows * sinA);
  var nH  = Math.round(src.cols * sinA + src.rows * cosA);
  M.data64F[2] += (nW - src.cols) / 2;
  M.data64F[5] += (nH - src.rows) / 2;
  var dst   = new cv.Mat();
  var dsize = new cv.Size(nW, nH);
  cv.warpAffine(src, dst, M, dsize, cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255,255,255,255));
  M.delete();
  return dst;
}

// ── Image data → Mat ──────────────────────────────────────────────────────────

function imageDataToMat(cv, imgData) {
  var mat = new cv.Mat(imgData.height, imgData.width, cv.CV_8UC4);
  mat.data.set(imgData.data);
  return mat;
}

// ── Single orientation + scale pass ──────────────────────────────────────────
//
// KEY ARCHITECTURE (v4.0):
//   - srcGray is NEVER modified — it always represents the original PDF canvas.
//   - ALL transforms (scale → flip → rotate) are applied to the template.
//   - matchTemplate(srcGray, transformedTemplate) → hits are in source coordinates.
//   - No remapToOriginal needed.

function runPass(cv, srcGray, templGrayOrig, orient, scale, threshold, idxOffset, origTemplW, origTemplH) {
  var deg     = orient.deg;
  var flipped = orient.flipped;
  var label   = orient.label;

  // 1. Scale the template
  var scaledW = Math.max(4, Math.round(origTemplW * scale));
  var scaledH = Math.max(4, Math.round(origTemplH * scale));
  var templScaled;
  if (Math.abs(scale - 1.0) < 0.005) {
    templScaled = templGrayOrig.clone();
  } else {
    templScaled = new cv.Mat();
    cv.resize(templGrayOrig, templScaled, new cv.Size(scaledW, scaledH), 0, 0, cv.INTER_LINEAR);
  }

  // 2. Flip the template horizontally if requested
  var templFlipped;
  if (flipped) {
    templFlipped = new cv.Mat();
    cv.flip(templScaled, templFlipped, 1);
    templScaled.delete();
  } else {
    templFlipped = templScaled;
  }

  // 3. Rotate the template
  var templReady = rotateMat(cv, templFlipped, deg);
  templFlipped.delete();

  var tmplW = templReady.cols;
  var tmplH = templReady.rows;

  var results = [];

  if (tmplW <= srcGray.cols && tmplH <= srcGray.rows && tmplW >= 2 && tmplH >= 2) {
    var result = new cv.Mat();
    cv.matchTemplate(srcGray, templReady, result, cv.TM_CCOEFF_NORMED);

    var data  = result.data32F;
    var rCols = result.cols;
    var rRows = result.rows;

    for (var r = 0; r < rRows; r++) {
      for (var c = 0; c < rCols; c++) {
        var score = data[r * rCols + c];
        if (score < threshold) continue;

        // c, r are already source-space coordinates — no remapping needed
        results.push({
          id:               'cv-' + label + '-s' + scale.toFixed(2) + '-' + (idxOffset + r * rCols + c),
          score:            score,
          rotation:         deg,
          flipped:          flipped,
          scale:            scale,
          orientationLabel: label + ' x' + scale.toFixed(2),
          // bbox uses original (unrotated) template dims for display consistency;
          // rotatedW/H carry the actual matched footprint for the polygon overlay
          bbox:             { x: c, y: r, w: scaledW, h: scaledH },
          rotatedW:         tmplW,
          rotatedH:         tmplH,
          snapPoints:       snapPointsForBBox(c, r, scaledW, scaledH),
        });
      }
    }
    result.delete();
  }

  templReady.delete();
  return results;
}

// ── Main matching function ────────────────────────────────────────────────────

async function doFindMatches(msg) {
  var cvLib         = self.cv;
  var srcImageData  = msg.srcImageData;
  var tmplImageData = msg.tmplImageData;
  var threshold     = msg.threshold;
  var rotations     = msg.rotations;
  var flips         = msg.flips;
  var removeText    = msg.removeText;
  var scales        = msg.scales && msg.scales.length > 0 ? msg.scales : [1.0];
  var origTemplW    = tmplImageData.width;
  var origTemplH    = tmplImageData.height;

  // ── Source — convert once, never transform ────────────────────────────────
  self.postMessage({ type: 'PROGRESS', phase: 'Converting source image' });
  var srcMat     = imageDataToMat(cvLib, srcImageData);
  var srcGrayRaw = new cvLib.Mat();
  cvLib.cvtColor(srcMat, srcGrayRaw, cvLib.COLOR_RGBA2GRAY);
  srcMat.delete();

  var srcGray;
  if (removeText) {
    self.postMessage({ type: 'PROGRESS', phase: 'Removing text from source', detail: 'Erasing text blobs...' });
    srcGray = matWithoutText(cvLib, srcGrayRaw);
    srcGrayRaw.delete();
  } else {
    srcGray = srcGrayRaw;
  }

  // ── Template — convert once, transforms applied per-pass ──────────────────
  self.postMessage({ type: 'PROGRESS', phase: 'Converting template' });
  var templMat     = imageDataToMat(cvLib, tmplImageData);
  var templGrayRaw = new cvLib.Mat();
  cvLib.cvtColor(templMat, templGrayRaw, cvLib.COLOR_RGBA2GRAY);
  templMat.delete();

  var templGray;
  if (removeText) {
    self.postMessage({ type: 'PROGRESS', phase: 'Removing text from template', detail: 'Erasing text blobs...' });
    templGray = matWithoutText(cvLib, templGrayRaw);
    templGrayRaw.delete();

    var cleanedRGBA = grayMatToRGBA(templGray);
    self.postMessage(
      { type: 'TEMPLATE_CLEANED', data: cleanedRGBA, width: templGray.cols, height: templGray.rows },
      [cleanedRGBA.buffer],
    );
  } else {
    templGray = templGrayRaw;
  }

  // ── Build orientation list ────────────────────────────────────────────────
  var orientations = [];
  for (var ri = 0; ri < rotations.length; ri++) {
    for (var fi = 0; fi < flips.length; fi++) {
      var deg     = rotations[ri];
      var flipped = flips[fi];
      orientations.push({
        deg:     deg,
        flipped: flipped,
        label:   flipped ? deg + 'f' : deg + '',
      });
    }
  }

  var totalPasses = orientations.length * scales.length;
  var passIndex   = 0;
  var allResults  = [];
  var idxOffset   = 0;

  // ── Multi-scale × multi-orientation loop ──────────────────────────────────
  for (var si = 0; si < scales.length; si++) {
    var scale = scales[si];
    for (var oi = 0; oi < orientations.length; oi++) {
      var orient = orientations[oi];
      passIndex++;
      self.postMessage({
        type:   'PROGRESS',
        phase:  'Matching ' + passIndex + '/' + totalPasses,
        detail: orient.label + (scales.length > 1 ? ' · scale x' + scale.toFixed(2) : ''),
      });

      var hits = runPass(
        cvLib, srcGray, templGray,
        orient, scale, threshold,
        idxOffset, origTemplW, origTemplH,
      );
      for (var h = 0; h < hits.length; h++) allResults.push(hits[h]);
      idxOffset += srcGray.cols * srcGray.rows;
    }
  }

  templGray.delete();
  srcGray.delete();

  // ── Global NMS across all scales + orientations ───────────────────────────
  self.postMessage({ type: 'PROGRESS', phase: 'Non-maximum suppression', detail: allResults.length + ' raw hits' });
  var deduped = nms(allResults, 0.30);
  deduped.sort(function(a, b) { return b.score - a.score; });
  return deduped;
}

// ── Message handler ───────────────────────────────────────────────────────────

self.onmessage = async function(e) {
  var msg = e.data;

  if (msg.type === 'LOAD') {
    try {
      self.postMessage({ type: 'PROGRESS', phase: 'Loading OpenCV.js...' });
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
        self.postMessage({ type: 'PROGRESS', phase: 'Waiting for OpenCV...' });
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
  const [isReady,         setIsReady]         = useState(false);
  const [isSearching,     setIsSearching]     = useState(false);
  const [workerPhase,     setWorkerPhase]     = useState('');
  const [workerDetail,    setWorkerDetail]    = useState('');
  const [matches,         setMatches]         = useState<CVMatchResult[]>([]);
  const [rawTemplateCrop, setRawTemplateCrop] = useState<ImageData | null>(null);
  const [templateCrop,    setTemplateCrop]    = useState<ImageData | null>(null);

  const workerRef   = useRef<Worker | null>(null);
  const blobUrlRef  = useRef('');
  const templateRef = useRef<ImageData | null>(null);
  const resolveRef  = useRef<(() => void) | null>(null);
  const rejectRef   = useRef<((e: Error) => void) | null>(null);

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
        case 'TEMPLATE_CLEANED': {
          const cleaned = new ImageData(
            msg.data as Uint8ClampedArray,
            msg.width  as number,
            msg.height as number,
          );
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
    const cx       = (vpBox.x - pan.x) / zoom;
    const cy       = (vpBox.y - pan.y) / zoom;
    const cw       = vpBox.w / zoom;
    const ch       = vpBox.h / zoom;
    const clampedX = Math.max(0, Math.round(cx));
    const clampedY = Math.max(0, Math.round(cy));
    const clampedW = Math.min(canvas.width  - clampedX, Math.round(cw));
    const clampedH = Math.min(canvas.height - clampedY, Math.round(ch));
    if (clampedW < 4 || clampedH < 4) return;
    const crop = canvas.getContext('2d')!.getImageData(clampedX, clampedY, clampedW, clampedH);
    templateRef.current = crop;
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
    removeText  = false,
    scales      = [1.0],
  ): Promise<void> => {
    const tmpl   = templateRef.current;
    const worker = workerRef.current;
    if (!tmpl || !worker) return;

    setIsSearching(true);
    setMatches([]);
    setWorkerDetail('');

    const srcCtx       = canvas.getContext('2d')!;
    const srcImageData = srcCtx.getImageData(0, 0, canvas.width, canvas.height);

    const tmplDataCopy  = new Uint8ClampedArray(tmpl.data);
    const tmplImageData = { data: tmplDataCopy, width: tmpl.width, height: tmpl.height };
    const srcData       = { data: srcImageData.data, width: srcImageData.width, height: srcImageData.height };

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
          scales,
        },
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