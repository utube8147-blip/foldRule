/**
 * useOpenCVMatcher.ts  v9.0
 * ──────────────────────────
 * Two-stage coarse→fine rotation matching via cv.matchTemplate.
 *
 * STAGE 1 — Coarse sweep (caller-supplied rotation list, e.g. every 45°)
 *   For each coarse angle: rotate template (same-size), matchTemplate on full source.
 *   Collect ALL candidate regions above a LOWERED coarse threshold (threshold - 0.15).
 *   Each candidate carries its best coarse angle and a small ROI rect.
 *
 * STAGE 2 — Fine sweep (per candidate ROI, ±coarseStep/2 in fineStep increments)
 *   For each coarse candidate: extract a padded ROI from the source.
 *   Sweep fine angles around the coarse hit (e.g. ±22° in 3° steps).
 *   matchTemplate on the tiny ROI — very fast.
 *   Keep the best fine angle that beats the real threshold.
 *
 * Result: arbitrary-angle detection with cost proportional to
 *   (coarse passes × full image) + (candidates × fine passes × small ROI)
 *   instead of (360 passes × full image).
 *
 * Typical floor plan (3000×2000 px, 8 coarse angles, 15 fine angles per candidate):
 *   ~8 full passes + ~N×15 tiny ROI passes  →  well under 5 s even with 20 candidates.
 */

import { useState, useCallback, useRef, useEffect } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CVMatchResult {
  id:               string;
  score:            number;
  rotation:         number;       // final fine rotation in degrees
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
    canvas:       HTMLCanvasElement,
    threshold?:   number,
    rotations?:   number[],
    flips?:       boolean[],
    removeText?:  boolean,
    scales?:      number[],
    fineStep?:    number,    // NEW: fine-sweep angular step in degrees (default 3)
  ) => Promise<void>;
  clearAll: () => void;
}

// ─── Worker source ────────────────────────────────────────────────────────────

function getWorkerSource(): string {
  return `
'use strict';

// ── OpenCV loader ─────────────────────────────────────────────────────────────

const OPENCV_URL = 'https://docs.opencv.org/4.x/opencv.js';
let cvReady = false;
let cvLoadPromise = null;

function loadCV() {
  if (cvReady) return Promise.resolve();
  if (cvLoadPromise) return cvLoadPromise;
  cvLoadPromise = new Promise(function(resolve, reject) {
    try { importScripts(OPENCV_URL); } catch(e) {
      reject(new Error('importScripts failed: ' + e)); return;
    }
    var poll = setInterval(function() {
      if (typeof cv !== 'undefined' && cv && typeof cv.matchTemplate === 'function') {
        clearInterval(poll); cvReady = true; resolve();
      }
    }, 80);
    setTimeout(function() {
      clearInterval(poll); reject(new Error('OpenCV load timeout'));
    }, 30000);
  });
  return cvLoadPromise;
}

// ── Snap points ───────────────────────────────────────────────────────────────

function snapPointsForBBox(x, y, w, h) {
  return [
    { x: x + w/2, y: y + h/2, type: 'centroid' },
    { x: x,       y: y,       type: 'endpoint' },
    { x: x + w,   y: y,       type: 'endpoint' },
    { x: x + w,   y: y + h,   type: 'endpoint' },
    { x: x,       y: y + h,   type: 'endpoint' },
    { x: x + w/2, y: y,       type: 'midpoint' },
    { x: x + w/2, y: y + h,   type: 'midpoint' },
    { x: x,       y: y + h/2, type: 'midpoint' },
    { x: x + w,   y: y + h/2, type: 'midpoint' },
  ];
}

// ── IoU / NMS ─────────────────────────────────────────────────────────────────

function iou(a, b) {
  var ix    = Math.max(0, Math.min(a.x+a.w, b.x+b.w) - Math.max(a.x, b.x));
  var iy    = Math.max(0, Math.min(a.y+a.h, b.y+b.h) - Math.max(a.y, b.y));
  var inter = ix * iy;
  if (!inter) return 0;
  return inter / (a.w*a.h + b.w*b.h - inter);
}

function nms(results, iouThresh) {
  var sorted = results.slice().sort(function(a,b){ return b.score - a.score; });
  var kept   = [];
  for (var i = 0; i < sorted.length; i++) {
    var r = sorted[i];
    if (!kept.some(function(k){ return iou(k.bbox, r.bbox) > iouThresh; }))
      kept.push(r);
  }
  return kept;
}

// ── Mat helpers ───────────────────────────────────────────────────────────────

function imageDataToMat(cv, imgData) {
  var mat = new cv.Mat(imgData.height, imgData.width, cv.CV_8UC4);
  mat.data.set(imgData.data);
  return mat;
}

function grayToRGBA(mat) {
  var d   = mat.data;
  var len = d.length;
  var out = new Uint8ClampedArray(len * 4);
  for (var i = 0; i < len; i++) {
    var b = i * 4;
    out[b] = out[b+1] = out[b+2] = d[i];
    out[b+3] = 255;
  }
  return out;
}

// ── Text removal ──────────────────────────────────────────────────────────────

function matWithoutText(cv, gray) {
  var binary    = new cv.Mat();
  var labels    = new cv.Mat();
  var stats     = new cv.Mat();
  var centroids = new cv.Mat();
  cv.threshold(gray, binary, 180, 255, cv.THRESH_BINARY_INV);
  var n   = cv.connectedComponentsWithStats(binary, labels, stats, centroids, 8, cv.CV_32S);
  var out = gray.clone();
  for (var i = 1; i < n; i++) {
    var x  = stats.intAt(i, cv.CC_STAT_LEFT);
    var y  = stats.intAt(i, cv.CC_STAT_TOP);
    var w  = stats.intAt(i, cv.CC_STAT_WIDTH);
    var h  = stats.intAt(i, cv.CC_STAT_HEIGHT);
    var ar = w / Math.max(h, 1);
    var a  = stats.intAt(i, cv.CC_STAT_AREA);
    if (w < 30 && h < 40 && ar >= 0.2 && ar <= 5.0 && a >= 4 && a <= 600) {
      var roi = out.roi(new cv.Rect(x, y, w, h));
      roi.setTo(new cv.Scalar(255));
      roi.delete();
    }
  }
  binary.delete(); labels.delete(); stats.delete(); centroids.delete();
  return out;
}

// ── Rotate Mat — SAME SIZE output (white-fill corners) ───────────────────────
//
//  Critical: output is always src.cols × src.rows so the rotated template
//  has identical dimensions to the original, enabling pixel-accurate matching
//  against same-size regions in the source image.

function rotateMat(cv, src, angleDeg) {
  if (angleDeg === 0) return src.clone();
  var cx = src.cols / 2.0;
  var cy = src.rows / 2.0;
  var M  = cv.getRotationMatrix2D(new cv.Point(cx, cy), -angleDeg, 1.0);
  var dst = new cv.Mat();
  cv.warpAffine(
    src, dst, M,
    new cv.Size(src.cols, src.rows),
    cv.INTER_LINEAR,
    cv.BORDER_CONSTANT,
    new cv.Scalar(255, 255, 255, 255)
  );
  M.delete();
  return dst;
}

// ── Single matchTemplate pass returning best score in a result mat ────────────

function bestScoreInResult(resultMat) {
  var data  = resultMat.data32F;
  var best  = -Infinity;
  for (var i = 0; i < data.length; i++)
    if (data[i] > best) best = data[i];
  return best;
}

// ── Collect peaks above threshold from a matchTemplate result ─────────────────
//
//  offsetX/offsetY: add to rx/ry when the result came from an ROI crop
//  (so coordinates are always in full-source space).

function collectPeaks(resultMat, tmplW, tmplH, threshold, rotation, flipped, scale, offsetX, offsetY) {
  if (offsetX === undefined) offsetX = 0;
  if (offsetY === undefined) offsetY = 0;

  var data  = resultMat.data32F;
  var rCols = resultMat.cols;
  var rRows = resultMat.rows;
  var hits  = [];

  var supW = Math.max(1, Math.floor(tmplW * 0.5));
  var supH = Math.max(1, Math.floor(tmplH * 0.5));
  var buf  = new Float32Array(data);

  for (var ry = 0; ry < rRows; ry++) {
    for (var rx = 0; rx < rCols; rx++) {
      var idx   = ry * rCols + rx;
      var score = buf[idx];
      if (score < threshold) continue;

      var sx = rx + offsetX;
      var sy = ry + offsetY;

      hits.push({
        id:               'cv-' + rotation.toFixed(1) + '-' + (flipped?'f':'n') + '-' + sx + '-' + sy,
        score:            score,
        rotation:         rotation,
        flipped:          flipped,
        scale:            scale,
        orientationLabel: rotation.toFixed(1) + (flipped ? '°↔' : '°'),
        bbox:             { x: sx, y: sy, w: tmplW, h: tmplH },
        rotatedW:         tmplW,
        rotatedH:         tmplH,
        snapPoints:       snapPointsForBBox(sx, sy, tmplW, tmplH),
      });

      // Suppress neighbourhood
      var x0 = Math.max(0, rx - supW), x1 = Math.min(rCols-1, rx + supW);
      var y0 = Math.max(0, ry - supH), y1 = Math.min(rRows-1, ry + supH);
      for (var ny = y0; ny <= y1; ny++)
        for (var nx = x0; nx <= x1; nx++)
          buf[ny * rCols + nx] = 0;
    }
  }
  return hits;
}

// ── STAGE 1: Coarse full-image pass ──────────────────────────────────────────
//
//  Runs matchTemplate on the FULL source at a single coarse rotation.
//  Uses a LOWERED threshold (coarseThresh) to catch all plausible regions.
//  Returns raw candidate list (will be refined in stage 2).

function coarsePass(cv, srcGray, tmplBase, angleDeg, doFlip, scale, coarseThresh, origW, origH) {
  // Scale
  var tmplScaled;
  if (Math.abs(scale - 1.0) > 0.01) {
    tmplScaled = new cv.Mat();
    cv.resize(tmplBase, tmplScaled,
      new cv.Size(Math.round(tmplBase.cols * scale), Math.round(tmplBase.rows * scale)),
      0, 0, cv.INTER_LINEAR);
  } else {
    tmplScaled = tmplBase.clone();
  }

  // Rotate (same-size)
  var tmplRot = rotateMat(cv, tmplScaled, angleDeg);
  tmplScaled.delete();

  // Flip
  var tmplFinal;
  if (doFlip) {
    tmplFinal = new cv.Mat();
    cv.flip(tmplRot, tmplFinal, 1);
    tmplRot.delete();
  } else {
    tmplFinal = tmplRot;
  }

  if (tmplFinal.cols >= srcGray.cols || tmplFinal.rows >= srcGray.rows) {
    tmplFinal.delete(); return [];
  }

  var result = new cv.Mat();
  cv.matchTemplate(srcGray, tmplFinal, result, cv.TM_CCOEFF_NORMED);

  var bboxW = Math.round(origW * scale);
  var bboxH = Math.round(origH * scale);
  var hits  = collectPeaks(result, bboxW, bboxH, coarseThresh, angleDeg, doFlip, scale, 0, 0);

  result.delete();
  tmplFinal.delete();
  return hits;
}

// ── STAGE 2: Fine ROI pass ────────────────────────────────────────────────────
//
//  Given a coarse candidate (cx, cy, w, h) in source space:
//    1. Extract a padded ROI from srcGray.
//    2. Sweep fine angles in range [coarseAngle - halfRange, coarseAngle + halfRange].
//    3. Run matchTemplate on the tiny ROI for each fine angle.
//    4. Return the best hit that beats the real threshold.
//
//  ROI padding = half template size on each side so the template can slide
//  across the candidate area even at the extremes of the fine range.

function finePass(cv, srcGray, tmplBase, candidate, fineStep, halfRange, threshold, origW, origH) {
  var pad  = Math.round(Math.max(origW, origH) * 0.6);
  var rx0  = Math.max(0, candidate.bbox.x - pad);
  var ry0  = Math.max(0, candidate.bbox.y - pad);
  var rx1  = Math.min(srcGray.cols - 1, candidate.bbox.x + candidate.bbox.w + pad);
  var ry1  = Math.min(srcGray.rows - 1, candidate.bbox.y + candidate.bbox.h + pad);
  var roiW = rx1 - rx0;
  var roiH = ry1 - ry0;
  if (roiW <= 0 || roiH <= 0) return null;

  var roiRect = new cv.Rect(rx0, ry0, roiW, roiH);
  var roiMat  = srcGray.roi(roiRect);

  var coarseAngle = candidate.rotation;
  var doFlip      = candidate.flipped;
  var scale       = candidate.scale;

  // Build fine angle list: coarseAngle ± halfRange in fineStep increments
  // We skip the coarse angle itself since we already have it from stage 1.
  var fineAngles = [];
  for (var a = coarseAngle - halfRange; a <= coarseAngle + halfRange + 0.001; a += fineStep) {
    var norm = ((a % 360) + 360) % 360;
    fineAngles.push(parseFloat(norm.toFixed(2)));
  }
  // Deduplicate
  fineAngles = fineAngles.filter(function(v, i, arr) { return arr.indexOf(v) === i; });

  var bestHit = null;

  for (var fi = 0; fi < fineAngles.length; fi++) {
    var angle = fineAngles[fi];

    // Scale template
    var tmplScaled;
    if (Math.abs(scale - 1.0) > 0.01) {
      tmplScaled = new cv.Mat();
      cv.resize(tmplBase, tmplScaled,
        new cv.Size(Math.round(tmplBase.cols * scale), Math.round(tmplBase.rows * scale)),
        0, 0, cv.INTER_LINEAR);
    } else {
      tmplScaled = tmplBase.clone();
    }

    var tmplRot = rotateMat(cv, tmplScaled, angle);
    tmplScaled.delete();

    var tmplFinal;
    if (doFlip) {
      tmplFinal = new cv.Mat();
      cv.flip(tmplRot, tmplFinal, 1);
      tmplRot.delete();
    } else {
      tmplFinal = tmplRot;
    }

    if (tmplFinal.cols >= roiMat.cols || tmplFinal.rows >= roiMat.rows) {
      tmplFinal.delete(); continue;
    }

    var result = new cv.Mat();
    cv.matchTemplate(roiMat, tmplFinal, result, cv.TM_CCOEFF_NORMED);

    var bboxW = Math.round(origW * scale);
    var bboxH = Math.round(origH * scale);

    // Only collect peak at threshold (not lowered coarse threshold)
    var hits = collectPeaks(result, bboxW, bboxH, threshold, angle, doFlip, scale, rx0, ry0);

    result.delete();
    tmplFinal.delete();

    // Keep best hit across all fine angles for this candidate
    for (var hi = 0; hi < hits.length; hi++) {
      if (!bestHit || hits[hi].score > bestHit.score)
        bestHit = hits[hi];
    }
  }

  roiMat.delete();
  return bestHit;
}

// ── Main match function ───────────────────────────────────────────────────────

async function doFindMatches(msg) {
  var cvLib      = self.cv;
  var threshold  = msg.threshold;
  var rotations  = msg.rotations;   // coarse rotation list
  var flips      = msg.flips;
  var scales     = msg.scales;
  var removeText = msg.removeText;
  var fineStep   = msg.fineStep || 3;   // fine sweep step in degrees
  var origW      = msg.tmplImageData.width;
  var origH      = msg.tmplImageData.height;

  // Coarse threshold is lower so we don't miss anything in stage 1
  var coarseThresh = Math.max(0.30, threshold - 0.18);

  // Half-range for fine sweep = half the coarse angular step
  // e.g. coarse every 45° → halfRange = 22.5°
  var coarseAngles = rotations.slice().sort(function(a,b){return a-b;});
  var coarseStep   = coarseAngles.length > 1
    ? (coarseAngles[1] - coarseAngles[0])
    : 45;
  var halfRange = coarseStep / 2;

  // ── Source → grayscale ────────────────────────────────────────────────────
  self.postMessage({ type: 'PROGRESS', phase: 'Converting source image' });
  var srcMat     = imageDataToMat(cvLib, msg.srcImageData);
  var srcGrayRaw = new cvLib.Mat();
  cvLib.cvtColor(srcMat, srcGrayRaw, cvLib.COLOR_RGBA2GRAY);
  srcMat.delete();

  var srcGray;
  if (removeText) {
    self.postMessage({ type: 'PROGRESS', phase: 'Stripping text from source' });
    srcGray = matWithoutText(cvLib, srcGrayRaw);
    srcGrayRaw.delete();
  } else {
    srcGray = srcGrayRaw;
  }

  // ── Template → grayscale ──────────────────────────────────────────────────
  self.postMessage({ type: 'PROGRESS', phase: 'Converting template' });
  var tmplMat     = imageDataToMat(cvLib, msg.tmplImageData);
  var tmplGrayRaw = new cvLib.Mat();
  cvLib.cvtColor(tmplMat, tmplGrayRaw, cvLib.COLOR_RGBA2GRAY);
  tmplMat.delete();

  var tmplBase;
  if (removeText) {
    self.postMessage({ type: 'PROGRESS', phase: 'Stripping text from template' });
    tmplBase = matWithoutText(cvLib, tmplGrayRaw);
    tmplGrayRaw.delete();
    var rgba = grayToRGBA(tmplBase);
    self.postMessage(
      { type: 'TEMPLATE_CLEANED', data: rgba, width: tmplBase.cols, height: tmplBase.rows },
      [rgba.buffer]
    );
  } else {
    tmplBase = tmplGrayRaw;
  }

  // ── STAGE 1: Coarse sweep over full image ─────────────────────────────────

  // Build coarse pass list
  var coarsePasses = [];
  for (var ri = 0; ri < rotations.length; ri++)
    for (var fi = 0; fi < flips.length; fi++)
      for (var si = 0; si < scales.length; si++)
        coarsePasses.push({ rot: rotations[ri], flip: flips[fi], scale: scales[si] });

  var totalCoarse  = coarsePasses.length;
  var coarseCandidates = [];

  self.postMessage({
    type:   'PROGRESS',
    phase:  'Stage 1 — Coarse sweep',
    detail: totalCoarse + ' passes · thresh ' + (coarseThresh * 100).toFixed(0) + '%',
  });

  for (var pi = 0; pi < coarsePasses.length; pi++) {
    var p = coarsePasses[pi];

    self.postMessage({
      type:   'PROGRESS',
      phase:  'Coarse ' + (pi+1) + '/' + totalCoarse,
      detail: p.rot + '°' + (p.flip ? '↔' : '') +
              (Math.abs(p.scale-1)>0.01 ? ' ×'+p.scale.toFixed(1) : ''),
    });

    var hits = coarsePass(
      cvLib, srcGray, tmplBase,
      p.rot, p.flip, p.scale,
      coarseThresh, origW, origH
    );
    coarseCandidates = coarseCandidates.concat(hits);

    await new Promise(function(r){ setTimeout(r, 0); });
  }

  // NMS the coarse candidates so we don't fine-sweep duplicates
  self.postMessage({
    type:   'PROGRESS',
    phase:  'Stage 1 done',
    detail: coarseCandidates.length + ' raw candidates',
  });
  var nmsCoarse = nms(coarseCandidates, 0.20);

  self.postMessage({
    type:   'PROGRESS',
    phase:  'Stage 2 — Fine sweep',
    detail: nmsCoarse.length + ' candidates · ±' + halfRange + '° in ' + fineStep + '° steps',
  });

  // ── STAGE 2: Fine sweep per candidate ROI ─────────────────────────────────

  var finalHits = [];
  var fineAnglesPerCandidate = Math.round(halfRange * 2 / fineStep) + 1;

  for (var ci = 0; ci < nmsCoarse.length; ci++) {
    var cand = nmsCoarse[ci];

    self.postMessage({
      type:   'PROGRESS',
      phase:  'Fine ' + (ci+1) + '/' + nmsCoarse.length,
      detail: 'around ' + cand.rotation + '° · ' + fineAnglesPerCandidate + ' angles',
    });

    var bestHit = finePass(
      cvLib, srcGray, tmplBase,
      cand, fineStep, halfRange,
      threshold, origW, origH
    );

    // If fine sweep found a good hit, use it; otherwise fall back to coarse
    // hit only if it already beats the real threshold.
    if (bestHit) {
      finalHits.push(bestHit);
    } else if (cand.score >= threshold) {
      finalHits.push(cand);
    }

    await new Promise(function(r){ setTimeout(r, 0); });
  }

  tmplBase.delete();
  srcGray.delete();

  // ── Global NMS on final hits ──────────────────────────────────────────────
  self.postMessage({ type: 'PROGRESS', phase: 'NMS', detail: finalHits.length + ' hits' });
  var deduped = nms(finalHits, 0.30);
  deduped.sort(function(a,b){ return b.score - a.score; });

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

// ─── React hook ───────────────────────────────────────────────────────────────

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

  // ── Spin up worker ──────────────────────────────────────────────────────────
  useEffect(() => {
    const src  = getWorkerSource();
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
    canvas:      HTMLCanvasElement,
    threshold    = 0.70,
    rotations    = [0],
    flips        = [false],
    removeText   = false,
    scales       = [1.0],
    fineStep     = 3,        // fine sweep step in degrees
  ): Promise<void> => {
    const tmpl   = templateRef.current;
    const worker = workerRef.current;
    if (!tmpl || !worker) return;

    setIsSearching(true);
    setMatches([]);
    setWorkerDetail('');

    await new Promise<void>(r => requestAnimationFrame(() => r()));

    const srcCtx       = canvas.getContext('2d')!;
    const srcImageData = srcCtx.getImageData(0, 0, canvas.width, canvas.height);
    const tmplCopy     = new Uint8ClampedArray(tmpl.data);

    const srcData  = { data: srcImageData.data, width: srcImageData.width,  height: srcImageData.height };
    const tmplData = { data: tmplCopy,           width: tmpl.width,          height: tmpl.height         };

    return new Promise<void>((resolve, reject) => {
      resolveRef.current = resolve;
      rejectRef.current  = reject;
      worker.postMessage(
        {
          type:          'FIND_MATCHES',
          srcImageData:  srcData,
          tmplImageData: tmplData,
          threshold,
          rotations,
          flips,
          scales,
          removeText,
          fineStep,
        },
        [srcData.data.buffer, tmplCopy.buffer],
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