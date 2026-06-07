/**
 * useOpenCVMatcher.ts  v3.0
 * ──────────────────────────
 * Multi-scale template matching via Web Worker.
 *
 * v3.0 changes:
 *  ─ Multi-scale pyramid: searches at configurable scale factors
 *    (default 0.70 → 1.30 in steps of 0.10) so symbols that are
 *    slightly larger or smaller than the template are still found.
 *  ─ Each hit carries its matched scale so the bbox is reported at
 *    the correct size in source-canvas coordinates.
 *  ─ Global NMS across all scales + rotations prevents duplicate boxes.
 *  ─ TEMPLATE_CLEANED message retained from v2.2.
 *  ─ New `scales` parameter on findMatches(); default [0.7,0.8,0.9,1.0,1.1,1.2,1.3].
 *  ─ Worker progress reports include current scale.
 *  ─ rotatedW / rotatedH added to CVMatchResult for CVMatchOverlay v3.0.
 */

import { useState, useCallback, useRef, useEffect } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CVMatchResult {
  id:               string;
  score:            number;
  rotation:         number;
  flipped:          boolean;
  scale:            number;          // NEW: matched scale factor relative to template
  orientationLabel: string;
  bbox: { x: number; y: number; w: number; h: number };
  rotatedW:         number;          // NEW: actual rendered width  at matched rotation
  rotatedH:         number;          // NEW: actual rendered height at matched rotation
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
    scales?:     number[],           // NEW
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
  var thresh  = iouThresh !== undefined ? iouThresh : 0.30;
  var sorted  = results.slice().sort(function(a, b) { return b.score - a.score; });
  var kept    = [];
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

// ── Rotation / flip helpers ───────────────────────────────────────────────────

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

// Rotate a template Mat by an arbitrary angle (for non-cardinal rotations).
// Returns a new Mat; caller must delete it.
function rotateMat(cv, src, deg) {
  if (deg === 0)   return src.clone();
  if (deg === 90)  { var t1=new cv.Mat(); cv.transpose(src,t1); var r1=new cv.Mat(); cv.flip(t1,r1,1);  t1.delete(); return r1; }
  if (deg === 180) { var r2=new cv.Mat(); cv.flip(src,r2,-1); return r2; }
  if (deg === 270) { var t3=new cv.Mat(); cv.transpose(src,t3); var r3=new cv.Mat(); cv.flip(t3,r3,0);  t3.delete(); return r3; }
  // Arbitrary angle via warpAffine
  var cx = src.cols / 2;
  var cy = src.rows / 2;
  var M  = cv.getRotationMatrix2D(new cv.Point(cx, cy), -deg, 1.0);
  // Compute new bounding box
  var rad  = deg * Math.PI / 180;
  var cosA = Math.abs(Math.cos(rad));
  var sinA = Math.abs(Math.sin(rad));
  var nW   = Math.round(src.cols * cosA + src.rows * sinA);
  var nH   = Math.round(src.cols * sinA + src.rows * cosA);
  // Adjust translation
  M.data64F[2] += (nW - src.cols) / 2;
  M.data64F[5] += (nH - src.rows) / 2;
  var dst  = new cv.Mat();
  var dsize = new cv.Size(nW, nH);
  cv.warpAffine(src, dst, M, dsize, cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255,255,255,255));
  M.delete();
  return dst;
}

function remapToOriginal(hitX, hitY, deg, flipped, srcW, srcH, tmplW, tmplH) {
  // For cardinal rotations use the fast path
  var isCard = (deg === 0 || deg === 90 || deg === 180 || deg === 270);
  if (isCard) {
    var rotW = (deg === 90 || deg === 270) ? srcH : srcW;
    var cx   = hitX + tmplW / 2;
    var cy   = hitY + tmplH / 2;
    if (flipped) cx = rotW - 1 - cx;
    var origCx, origCy;
    switch (deg) {
      case 0:   origCx = cx;             origCy = cy;             break;
      case 90:  origCx = cy;             origCy = srcH - 1 - cx;  break;
      case 180: origCx = srcW - 1 - cx;  origCy = srcH - 1 - cy;  break;
      case 270: origCx = srcW - 1 - cy;  origCy = cx;             break;
      default:  origCx = cx;             origCy = cy;
    }
    return { x: Math.round(origCx - tmplW / 2), y: Math.round(origCy - tmplH / 2) };
  }
  // Arbitrary angle: the source was NOT transformed; template was rotated.
  // hitX/Y is in source space already — just compute centre.
  var origCx2 = hitX + tmplW / 2;
  var origCy2 = hitY + tmplH / 2;
  // The reported bbox is the rotated template bounding box positioned at hit.
  return { x: Math.round(origCx2 - tmplW / 2), y: Math.round(origCy2 - tmplH / 2) };
}

// ── Single orientation+scale pass ─────────────────────────────────────────────
// For cardinal rotations: rotate source, keep template.
// For arbitrary angles:   rotate template, keep source.

function runPass(cv, srcGray, templGrayOrig, orient, scale, threshold, idxOffset, origTemplW, origTemplH, srcW, srcH) {
  var deg     = orient.deg;
  var flipped = orient.flipped;
  var label   = orient.label;
  var isCard  = (deg === 0 || deg === 90 || deg === 180 || deg === 270);

  // Scale the template
  var scaledW = Math.max(4, Math.round(origTemplW * scale));
  var scaledH = Math.max(4, Math.round(origTemplH * scale));
  var templScaled;
  if (Math.abs(scale - 1.0) < 0.01) {
    templScaled = templGrayOrig.clone();
  } else {
    templScaled = new cv.Mat();
    var ssize   = new cv.Size(scaledW, scaledH);
    cv.resize(templGrayOrig, templScaled, ssize, 0, 0, cv.INTER_LINEAR);
  }

  // Apply flip to template
  var templReady;
  if (flipped) {
    templReady = new cv.Mat();
    cv.flip(templScaled, templReady, 1);
    templScaled.delete();
  } else {
    templReady = templScaled;
  }

  var results = [];

  if (isCard) {
    // Rotate source (fast path, avoids warpAffine border artefacts)
    var preparedSrc = prepareSourceMat(cv, srcGray, deg, false); // flip already on template
    var tmplW = (deg === 90 || deg === 270) ? scaledH : scaledW;
    var tmplH = (deg === 90 || deg === 270) ? scaledW : scaledH;

    if (tmplW <= preparedSrc.cols && tmplH <= preparedSrc.rows) {
      var result = new cv.Mat();
      cv.matchTemplate(preparedSrc, templReady, result, cv.TM_CCOEFF_NORMED);
      var data  = result.data32F;
      var rCols = result.cols;
      var rRows = result.rows;
      for (var r = 0; r < rRows; r++) {
        for (var c = 0; c < rCols; c++) {
          var score = data[r * rCols + c];
          if (score < threshold) continue;
          // rotated template footprint in source space (before flip-of-source)
          var bboxW = tmplW;
          var bboxH = tmplH;
          var orig  = remapToOriginal(c, r, deg, flipped, srcW, srcH, bboxW, bboxH);
          results.push({
            id:               'cv-' + label + '-s' + scale.toFixed(2) + '-' + (idxOffset + r * rCols + c),
            score:            score,
            rotation:         deg,
            flipped:          flipped,
            scale:            scale,
            orientationLabel: label + ' ×' + scale.toFixed(2),
            bbox:             { x: orig.x, y: orig.y, w: scaledW, h: scaledH },
            rotatedW:         bboxW,
            rotatedH:         bboxH,
            snapPoints:       snapPointsForBBox(orig.x, orig.y, scaledW, scaledH),
          });
        }
      }
      result.delete();
    }
    preparedSrc.delete();
  } else {
    // Arbitrary angle: rotate template, match against original source
    var templRot = rotateMat(cv, templReady, deg);
    var tmplW2   = templRot.cols;
    var tmplH2   = templRot.rows;

    if (tmplW2 <= srcGray.cols && tmplH2 <= srcGray.rows) {
      var result2 = new cv.Mat();
      cv.matchTemplate(srcGray, templRot, result2, cv.TM_CCOEFF_NORMED);
      var data2  = result2.data32F;
      var rCols2 = result2.cols;
      var rRows2 = result2.rows;
      for (var r2 = 0; r2 < rRows2; r2++) {
        for (var c2 = 0; c2 < rCols2; c2++) {
          var score2 = data2[r2 * rCols2 + c2];
          if (score2 < threshold) continue;
          results.push({
            id:               'cv-' + label + '-s' + scale.toFixed(2) + '-' + (idxOffset + r2 * rCols2 + c2),
            score:            score2,
            rotation:         deg,
            flipped:          flipped,
            scale:            scale,
            orientationLabel: label + ' ×' + scale.toFixed(2),
            bbox:             { x: c2, y: r2, w: scaledW, h: scaledH },
            rotatedW:         tmplW2,
            rotatedH:         tmplH2,
            snapPoints:       snapPointsForBBox(c2, r2, scaledW, scaledH),
          });
        }
      }
      result2.delete();
    }
    templRot.delete();
  }

  templReady.delete();
  return results;
}

// ── Image data → Mat ──────────────────────────────────────────────────────────

function imageDataToMat(cv, imgData) {
  var mat = cv.matFromArray(imgData.height, imgData.width, cv.CV_8UC4, Array.from(imgData.data));
  return mat;
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

  // ── Source ────────────────────────────────────────────────────────────────
  self.postMessage({ type: 'PROGRESS', phase: 'Converting source image' });
  var srcMat     = imageDataToMat(cvLib, srcImageData);
  var srcGrayRaw = new cvLib.Mat();
  cvLib.cvtColor(srcMat, srcGrayRaw, cvLib.COLOR_RGBA2GRAY);
  srcMat.delete();

  var srcGray;
  if (removeText) {
    self.postMessage({ type: 'PROGRESS', phase: 'Removing text from source', detail: 'Erasing text blobs…' });
    srcGray = matWithoutText(cvLib, srcGrayRaw);
    srcGrayRaw.delete();
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
    self.postMessage({ type: 'PROGRESS', phase: 'Removing text from template', detail: 'Erasing text blobs…' });
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
      orientations.push({ deg: deg, flipped: flipped, label: flipped ? deg + 'f' : deg + '' });
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
        detail: orient.label + (scales.length > 1 ? ' · scale ×' + scale.toFixed(2) : ''),
      });

      var hits = runPass(
        cvLib, srcGray, templGray,
        orient, scale, threshold,
        idxOffset, origTemplW, origTemplH, srcW, srcH,
      );
      for (var h = 0; h < hits.length; h++) allResults.push(hits[h]);
      idxOffset += srcW * srcH;
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
    removeText  = true,
    scales      = [0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3],
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