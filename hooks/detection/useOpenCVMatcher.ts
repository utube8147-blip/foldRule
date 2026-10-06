/**
 * useOpenCVMatcher.ts  v10.1
 * ──────────────────────────
 * Identical to v10.0 except buildTemplate now accepts an optional
 * `lassoImageData` parameter.
 *
 * When the caller supplies a pre-masked ImageData (produced by
 * CVLasso.lassoToImageData), buildTemplate uses it directly instead of
 * cropping a plain rectangle from the canvas.  Everything downstream
 * (worker, matching, NMS) is completely unchanged.
 *
 * CHANGED SIGNATURE:
 *   buildTemplate(
 *     canvas,
 *     vpBox,          ← still required (used as fallback / label size)
 *     zoom,
 *     pan,
 *     label?,
 *     lassoImageData? ← NEW — pass the masked ImageData from lassoToImageData()
 *   ): number
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
  templateIndex:    number;

  cx: number;
  cy: number;
  tmplW: number;
  tmplH: number;

  bbox: { x: number; y: number; w: number; h: number };

  snapPoints: Array<{ x: number; y: number; type: 'endpoint' | 'midpoint' | 'centroid' }>;
}

export interface TemplateEntry {
  imageData: ImageData;
  label:     string;
  /** true when the template was created from a lasso (masked) selection */
  isLasso?:  boolean;
}

export interface UseOpenCVMatcherReturn {
  isReady:         boolean;
  isSearching:     boolean;
  workerPhase:     string;
  workerDetail:    string;
  matches:         CVMatchResult[];
  templates:       TemplateEntry[];
  buildTemplate: (
    canvas:          HTMLCanvasElement,
    vpBox:           { x: number; y: number; w: number; h: number },
    zoom:            number,
    pan:             { x: number; y: number },
    label?:          string,
    lassoImageData?: ImageData,
  ) => number;
  removeTemplate:  (index: number) => void;
  findMatches: (
    canvas:      HTMLCanvasElement,
    threshold?:  number,
    rotations?:  number[],
    flips?:      boolean[],
    removeText?: boolean,
    scales?:     number[],
    fineStep?:   number,
  ) => Promise<void>;
  /**
   * Run matching for ONE template (by index) and MERGE the new hits with
   * the existing matches from other templates — existing results are kept,
   * only the new template is searched, then global NMS is applied.
   */
  findMatchesForTemplate: (
    canvas:         HTMLCanvasElement,
    templateIndex:  number,
    threshold?:     number,
    rotations?:     number[],
    flips?:         boolean[],
    removeText?:    boolean,
    scales?:        number[],
    fineStep?:      number,
  ) => Promise<void>;
  clearAll: () => void;
  refindMatches: (
    canvas:      HTMLCanvasElement,
    threshold:   number,
    rotations:   number[],
    flips:       boolean[],
    removeText:  boolean,
    scales:      number[],
    fineStep:    number,
  ) => Promise<void>;
}

// ─── Worker source (unchanged from v10.0) ────────────────────────────────────

function getWorkerSource(): string {
  return `
'use strict';

// The copy shipped with the app is tried first (works offline); the public
// copy is only a fallback.
var OPENCV_URLS = ['https://docs.opencv.org/4.x/opencv.js'];
let cvReady = false;
let cvLoadPromise = null;

function loadCV() {
  if (cvReady) return Promise.resolve();
  if (cvLoadPromise) return cvLoadPromise;
  cvLoadPromise = new Promise(function(resolve, reject) {
    var loaded = false, lastErr = null;
    for (var u = 0; u < OPENCV_URLS.length && !loaded; u++) {
      try { importScripts(OPENCV_URLS[u]); loaded = true; } catch(e) { lastErr = e; }
    }
    if (!loaded) { reject(new Error('importScripts failed: ' + lastErr)); return; }
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

function snapPointsForRotatedBBox(cx, cy, w, h, angleDeg) {
  var rad = angleDeg * Math.PI / 180;
  var cos = Math.cos(rad), sin = Math.sin(rad);
  function rot(dx, dy) {
    return { x: cx + dx * cos - dy * sin,
             y: cy + dx * sin + dy * cos };
  }
  var hw = w / 2, hh = h / 2;
  return [
    Object.assign(rot(  0,   0), { type: 'centroid'  }),
    Object.assign(rot(-hw, -hh), { type: 'endpoint'  }),
    Object.assign(rot( hw, -hh), { type: 'endpoint'  }),
    Object.assign(rot( hw,  hh), { type: 'endpoint'  }),
    Object.assign(rot(-hw,  hh), { type: 'endpoint'  }),
    Object.assign(rot(  0, -hh), { type: 'midpoint'  }),
    Object.assign(rot(  0,  hh), { type: 'midpoint'  }),
    Object.assign(rot(-hw,   0), { type: 'midpoint'  }),
    Object.assign(rot( hw,   0), { type: 'midpoint'  }),
  ];
}

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

function collectPeaks(resultMat, origW, origH, bboxW, bboxH, threshold,
                       rotation, flipped, scale, templateIndex,
                       offsetX, offsetY) {
  if (offsetX === undefined) offsetX = 0;
  if (offsetY === undefined) offsetY = 0;

  var data  = resultMat.data32F;
  var rCols = resultMat.cols;
  var rRows = resultMat.rows;
  var hits  = [];

  var supW = Math.max(1, Math.floor(bboxW * 0.5));
  var supH = Math.max(1, Math.floor(bboxH * 0.5));
  var buf  = new Float32Array(data);

  // Strongest first: take each peak at its true maximum, then blank its
  // neighbourhood. (Scanning in reading order took the first pixel that
  // crossed the threshold — the shoulder of a peak — which gave scores stuck
  // just above the threshold and boxes shifted off the symbol.)
  var above = [];
  for (var i0 = 0; i0 < buf.length; i0++) if (buf[i0] >= threshold) above.push(i0);
  above.sort(function(p, q) { return buf[q] - buf[p]; });
  if (above.length > 400000) above.length = 400000;

  for (var ai = 0; ai < above.length; ai++) {
    {
      var idx   = above[ai];
      var score = buf[idx];
      if (score < threshold) continue;          // already blanked by a stronger peak
      var ry = Math.floor(idx / rCols), rx = idx - ry * rCols;

      var sx = rx + offsetX;
      var sy = ry + offsetY;

      var matchCx = sx + bboxW / 2;
      var matchCy = sy + bboxH / 2;

      var snap = snapPointsForRotatedBBox(matchCx, matchCy, origW * scale, origH * scale, rotation);

      hits.push({
        id:               'cv-' + templateIndex + '-' + rotation.toFixed(1) +
                          '-' + (flipped?'f':'n') + '-' + sx + '-' + sy,
        score:            score,
        rotation:         rotation,
        flipped:          flipped,
        scale:            scale,
        templateIndex:    templateIndex,
        orientationLabel: rotation.toFixed(1) + (flipped ? 'deg flip' : 'deg'),
        cx:               matchCx,
        cy:               matchCy,
        tmplW:            origW,
        tmplH:            origH,
        bbox:             { x: sx, y: sy, w: bboxW, h: bboxH },
        snapPoints:       snap,
      });

      var x0 = Math.max(0, rx - supW), x1 = Math.min(rCols-1, rx + supW);
      var y0 = Math.max(0, ry - supH), y1 = Math.min(rRows-1, ry + supH);
      for (var ny = y0; ny <= y1; ny++)
        for (var nx = x0; nx <= x1; nx++)
          buf[ny * rCols + nx] = 0;
    }
  }
  return hits;
}

function coarsePass(cv, srcGray, tmplBase, angleDeg, doFlip, scale,
                     coarseThresh, origW, origH, templateIndex) {
  var bboxW = Math.round(origW * scale);
  var bboxH = Math.round(origH * scale);

  var tmplScaled;
  if (Math.abs(scale - 1.0) > 0.01) {
    tmplScaled = new cv.Mat();
    cv.resize(tmplBase, tmplScaled,
      new cv.Size(Math.round(tmplBase.cols * scale), Math.round(tmplBase.rows * scale)),
      0, 0, cv.INTER_LINEAR);
  } else {
    tmplScaled = tmplBase.clone();
  }

  var tmplRot = rotateMat(cv, tmplScaled, angleDeg);
  tmplScaled.delete();

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

  // Box = the template actually matched (a turned template is bigger than
  // the sample), so the centre lands on the symbol.
  var hits = collectPeaks(result, origW, origH, tmplFinal.cols, tmplFinal.rows,
                           coarseThresh, angleDeg, doFlip, scale,
                           templateIndex, 0, 0);
  result.delete();
  tmplFinal.delete();
  return hits;
}

function finePass(cv, srcGray, tmplBase, candidate, fineStep, halfRange,
                   threshold, origW, origH) {
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
  var tmplIdx     = candidate.templateIndex;

  var fineAngles = [];
  for (var a = coarseAngle - halfRange; a <= coarseAngle + halfRange + 0.001; a += fineStep) {
    var norm = ((a % 360) + 360) % 360;
    fineAngles.push(parseFloat(norm.toFixed(2)));
  }
  fineAngles = fineAngles.filter(function(v, i, arr) { return arr.indexOf(v) === i; });

  var bestHit = null;
  var bboxW   = Math.round(origW * scale);
  var bboxH   = Math.round(origH * scale);

  for (var fi = 0; fi < fineAngles.length; fi++) {
    var angle = fineAngles[fi];

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

    var hits = collectPeaks(result, origW, origH, tmplFinal.cols, tmplFinal.rows,
                             threshold, angle, doFlip, scale,
                             tmplIdx, rx0, ry0);
    result.delete();
    tmplFinal.delete();

    for (var hi = 0; hi < hits.length; hi++) {
      if (!bestHit || hits[hi].score > bestHit.score)
        bestHit = hits[hi];
    }
  }

  roiMat.delete();
  return bestHit;
}

async function doFindMatchesForTemplate(msg, tmplImageData, templateIndex, srcGray) {
  var cvLib      = self.cv;
  var threshold  = msg.threshold;
  var rotations  = msg.rotations;
  var flips      = msg.flips;
  var scales     = msg.scales;
  var removeText = msg.removeText;
  var fineStep   = msg.fineStep || 3;
  var origW      = tmplImageData.width;
  var origH      = tmplImageData.height;

  var coarseThresh = Math.max(0.30, threshold - 0.18);
  var coarseAngles = rotations.slice().sort(function(a,b){return a-b;});
  var coarseStep   = coarseAngles.length > 1 ? (coarseAngles[1] - coarseAngles[0]) : 45;
  var halfRange    = coarseStep / 2;

  self.postMessage({ type: 'PROGRESS',
    phase: 'T' + (templateIndex+1) + ' Converting template' });
  var tmplMat     = imageDataToMat(cvLib, tmplImageData);
  var tmplGrayRaw = new cvLib.Mat();
  cvLib.cvtColor(tmplMat, tmplGrayRaw, cvLib.COLOR_RGBA2GRAY);
  tmplMat.delete();

  var tmplBase;
  if (removeText) {
    self.postMessage({ type: 'PROGRESS',
      phase: 'T' + (templateIndex+1) + ' Stripping text' });
    tmplBase = matWithoutText(cvLib, tmplGrayRaw);
    tmplGrayRaw.delete();
    var rgba = grayToRGBA(tmplBase);
    self.postMessage(
      { type: 'TEMPLATE_CLEANED', templateIndex: templateIndex,
        data: rgba, width: tmplBase.cols, height: tmplBase.rows },
      [rgba.buffer]
    );
  } else {
    tmplBase = tmplGrayRaw;
  }

  // First sweep on a smaller copy of the page (4× or 9× fewer pixels), as
  // long as the sample stays big enough to be recognisable.
  var minSide = Math.min(origW, origH);
  var shrink  = minSide >= 72 ? 1 / 3 : minSide >= 36 ? 0.5 : 1;
  var coarseSrc = srcGray, coarseTmpl = tmplBase;
  if (shrink < 1) {
    coarseSrc = new cvLib.Mat(); coarseTmpl = new cvLib.Mat();
    cvLib.resize(srcGray, coarseSrc, new cvLib.Size(Math.round(srcGray.cols * shrink), Math.round(srcGray.rows * shrink)), 0, 0, cvLib.INTER_AREA);
    cvLib.resize(tmplBase, coarseTmpl, new cvLib.Size(Math.max(8, Math.round(tmplBase.cols * shrink)), Math.max(8, Math.round(tmplBase.rows * shrink))), 0, 0, cvLib.INTER_AREA);
  }

  var coarsePasses = [];
  for (var ri = 0; ri < rotations.length; ri++)
    for (var fi2 = 0; fi2 < flips.length; fi2++)
      for (var si = 0; si < scales.length; si++)
        coarsePasses.push({ rot: rotations[ri], flip: flips[fi2], scale: scales[si] });

  var totalCoarse      = coarsePasses.length;
  var coarseCandidates = [];

  self.postMessage({
    type: 'PROGRESS',
    phase: 'T' + (templateIndex+1) + ' Coarse sweep',
    detail: totalCoarse + ' passes',
  });

  for (var pi = 0; pi < coarsePasses.length; pi++) {
    var p = coarsePasses[pi];
    self.postMessage({
      type:   'PROGRESS',
      phase:  'T' + (templateIndex+1) + ' Coarse ' + (pi+1) + '/' + totalCoarse,
      detail: p.rot + 'deg' + (p.flip ? ' flip' : '') +
              (Math.abs(p.scale-1)>0.01 ? ' x'+p.scale.toFixed(1) : ''),
    });
    var hits = coarsePass(cvLib, coarseSrc, coarseTmpl, p.rot, p.flip, p.scale,
                           coarseThresh - (shrink < 1 ? 0.05 : 0), origW * shrink, origH * shrink, templateIndex);
    if (shrink < 1) {
      // Back to full-size coordinates; the fine pass re-checks each spot at full size.
      for (var hk = 0; hk < hits.length; hk++) {
        var hh = hits[hk];
        hh.cx /= shrink; hh.cy /= shrink; hh.tmplW = origW; hh.tmplH = origH;
        hh.bbox = { x: Math.round(hh.bbox.x / shrink), y: Math.round(hh.bbox.y / shrink),
                    w: Math.round(hh.bbox.w / shrink), h: Math.round(hh.bbox.h / shrink) };
        hh.coarseOnly = true;   // a small-copy score is only a hint — never accepted without the fine pass
      }
    }
    coarseCandidates = coarseCandidates.concat(hits);
    await new Promise(function(r){ setTimeout(r, 0); });
  }

  if (shrink < 1) { coarseSrc.delete(); coarseTmpl.delete(); }
  var nmsCoarse    = nms(coarseCandidates, 0.20);
  var finePerCand  = Math.round(halfRange * 2 / fineStep) + 1;

  self.postMessage({
    type:   'PROGRESS',
    phase:  'T' + (templateIndex+1) + ' Fine sweep',
    detail: nmsCoarse.length + ' candidates',
  });

  var finalHits = [];
  for (var ci = 0; ci < nmsCoarse.length; ci++) {
    var cand = nmsCoarse[ci];
    self.postMessage({
      type:   'PROGRESS',
      phase:  'T' + (templateIndex+1) + ' Fine ' + (ci+1) + '/' + nmsCoarse.length,
      detail: 'around ' + cand.rotation + 'deg',
    });
    var bestHit = finePass(cvLib, srcGray, tmplBase, cand, fineStep, halfRange,
                            threshold, origW, origH);
    if (bestHit) {
      finalHits.push(bestHit);
    } else if (!cand.coarseOnly && cand.score >= threshold) {
      finalHits.push(cand);
    }
    await new Promise(function(r){ setTimeout(r, 0); });
  }

  tmplBase.delete();

  return nms(finalHits, 0.30);
}

async function doFindMatches(msg) {
  var cvLib      = self.cv;
  var removeText = msg.removeText;

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

  var allHits = [];
  var templates = msg.templates;

  for (var ti = 0; ti < templates.length; ti++) {
    self.postMessage({
      type:   'PROGRESS',
      phase:  'Template ' + (ti+1) + ' / ' + templates.length,
      detail: templates[ti].width + 'x' + templates[ti].height,
    });
    var tmplImageData = templates[ti];
    var hits = await doFindMatchesForTemplate(msg, tmplImageData, ti, srcGray);
    allHits = allHits.concat(hits);
  }

  srcGray.delete();

  self.postMessage({ type: 'PROGRESS', phase: 'Global NMS',
    detail: allHits.length + ' total hits' });
  var deduped = nms(allHits, 0.30);
  deduped.sort(function(a,b){ return b.score - a.score; });
  return deduped;
}

self.onmessage = async function(e) {
  var msg = e.data;

  if (msg.type === 'LOAD') {
    try {
      if (msg.localUrl && OPENCV_URLS.indexOf(msg.localUrl) < 0) OPENCV_URLS.unshift(msg.localUrl);
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

// ─── Palette ──────────────────────────────────────────────────────────────────

export const TEMPLATE_PALETTE = [
  '#f43f5e',
  '#38bdf8',
  '#a78bfa',
  '#34d399',
  '#fb923c',
  '#e879f9',
];

export function templateColor(index: number): string {
  return TEMPLATE_PALETTE[index % TEMPLATE_PALETTE.length];
}


// ─── Client-side NMS (mirrors worker NMS for merge step) ─────────────────────

function clientNMS(results: CVMatchResult[], iouThresh: number): CVMatchResult[] {
  const sorted = results.slice().sort((a, b) => b.score - a.score);
  const kept: CVMatchResult[] = [];
  for (const r of sorted) {
    const overlaps = kept.some(k => {
      const ix = Math.max(0, Math.min(k.bbox.x+k.bbox.w, r.bbox.x+r.bbox.w) - Math.max(k.bbox.x, r.bbox.x));
      const iy = Math.max(0, Math.min(k.bbox.y+k.bbox.h, r.bbox.y+r.bbox.h) - Math.max(k.bbox.y, r.bbox.y));
      const inter = ix * iy;
      if (!inter) return false;
      return inter / (k.bbox.w*k.bbox.h + r.bbox.w*r.bbox.h - inter) > iouThresh;
    });
    if (!overlaps) kept.push(r);
  }
  return kept;
}

// ─── React hook ───────────────────────────────────────────────────────────────

export function useOpenCVMatcher(): UseOpenCVMatcherReturn {
  const [isReady,      setIsReady]      = useState(false);
  const [isSearching,  setIsSearching]  = useState(false);
  const [workerPhase,  setWorkerPhase]  = useState('');
  const [workerDetail, setWorkerDetail] = useState('');
  const [matches,      setMatches]      = useState<CVMatchResult[]>([]);
  const [templates,    setTemplates]    = useState<TemplateEntry[]>([]);

  const workerRef    = useRef<Worker | null>(null);
  const blobUrlRef   = useRef('');
  const templatesRef = useRef<ImageData[]>([]);
  const resolveRef   = useRef<(() => void) | null>(null);
  const rejectRef    = useRef<((e: Error) => void) | null>(null);
  const matchesRef   = useRef<CVMatchResult[]>([]);   // mirror of matches state — used for merge in findMatchesForTemplate

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
        case 'TEMPLATE_CLEANED':
          break;
        case 'RESULTS':
          matchesRef.current = msg.matches ?? [];
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

    worker.postMessage({ type: 'LOAD', localUrl: `${window.location.origin}/vendor/opencv.js` });
    setWorkerPhase('Loading OpenCV.js…');

    return () => {
      worker.terminate();
      URL.revokeObjectURL(url);
      workerRef.current = null;
    };
  }, []);

  // ── buildTemplate ───────────────────────────────────────────────────────────
  //
  //  When lassoImageData is supplied it is used directly (it has already been
  //  masked by lassoToImageData in CVLasso.tsx).  Otherwise the plain rect
  //  crop path is used — identical to v10.0.

  const buildTemplate = useCallback((
    canvas:          HTMLCanvasElement,
    vpBox:           { x: number; y: number; w: number; h: number },
    zoom:            number,
    pan:             { x: number; y: number },
    label?:          string,
    lassoImageData?: ImageData,
  ): number => {
    let crop: ImageData;

    if (lassoImageData) {
      // Caller already produced a masked ImageData — use it directly
      crop = lassoImageData;
    } else {
      // Legacy rect crop
      const cx       = (vpBox.x - pan.x) / zoom;
      const cy       = (vpBox.y - pan.y) / zoom;
      const cw       = vpBox.w / zoom;
      const ch       = vpBox.h / zoom;
      const clampedX = Math.max(0, Math.round(cx));
      const clampedY = Math.max(0, Math.round(cy));
      const clampedW = Math.min(canvas.width  - clampedX, Math.round(cw));
      const clampedH = Math.min(canvas.height - clampedY, Math.round(ch));
      if (clampedW < 4 || clampedH < 4) return -1;
      crop = canvas.getContext('2d')!.getImageData(clampedX, clampedY, clampedW, clampedH);
    }

    const idx = templatesRef.current.length;
    templatesRef.current = [...templatesRef.current, crop];

    const entry: TemplateEntry = {
      imageData: crop,
      label:     label ?? (idx === 0 ? 'Primary' : `Variation ${idx}`),
      isLasso:   !!lassoImageData,
    };
    setTemplates(prev => [...prev, entry]);
    setMatches([]);
    return idx;
  }, []);

  // ── removeTemplate ──────────────────────────────────────────────────────────
  const removeTemplate = useCallback((index: number) => {
    templatesRef.current = templatesRef.current.filter((_, i) => i !== index);
    setTemplates(prev => prev.filter((_, i) => i !== index));
    setMatches([]);
  }, []);

  // ── Internal findMatches ────────────────────────────────────────────────────
  const _findMatches = useCallback(async (
    canvas:     HTMLCanvasElement,
    threshold   = 0.70,
    rotations   = [0],
    flips       = [false],
    removeText  = false,
    scales      = [1.0],
    fineStep    = 3,
    tmplList:   ImageData[],
  ): Promise<void> => {
    const worker = workerRef.current;
    if (!worker || tmplList.length === 0) return;

    setIsSearching(true);
    setMatches([]);
    setWorkerDetail('');

    await new Promise<void>(r => requestAnimationFrame(() => r()));

    const srcCtx       = canvas.getContext('2d')!;
    const srcImageData = srcCtx.getImageData(0, 0, canvas.width, canvas.height);
    const srcData      = { data: srcImageData.data, width: srcImageData.width, height: srcImageData.height };

    const serialisedTemplates = tmplList.map(t => ({
      data:   new Uint8ClampedArray(t.data),
      width:  t.width,
      height: t.height,
    }));

    const transferables: Transferable[] = [srcData.data.buffer];
    serialisedTemplates.forEach(t => transferables.push(t.data.buffer));

    return new Promise<void>((resolve, reject) => {
      resolveRef.current = resolve;
      rejectRef.current  = reject;
      worker.postMessage(
        {
          type:         'FIND_MATCHES',
          srcImageData: srcData,
          templates:    serialisedTemplates,
          threshold,
          rotations,
          flips,
          scales,
          removeText,
          fineStep,
        },
        transferables,
      );
    });
  }, []);


  const findMatches = useCallback(async (
    canvas:     HTMLCanvasElement,
    threshold   = 0.70,
    rotations   = [0],
    flips       = [false],
    removeText  = false,
    scales      = [1.0],
    fineStep    = 3,
  ): Promise<void> => {
    // Full run — clears and replaces ALL matches
    const result = await _findMatches(
      canvas, threshold, rotations, flips, removeText, scales, fineStep,
      templatesRef.current,
    );
    matchesRef.current = [];   // will be repopulated via setMatches in _findMatches handler
    return result;
  }, [_findMatches]);

  // ── findMatchesForTemplate ──────────────────────────────────────────────────
  //
  //  Runs the worker for ONE template only, then MERGES the new hits with
  //  existing results from all other templates. No re-running of old templates.

  const findMatchesForTemplate = useCallback(async (
    canvas:        HTMLCanvasElement,
    templateIndex: number,
    threshold      = 0.70,
    rotations      = [0],
    flips          = [false],
    removeText     = false,
    scales         = [1.0],
    fineStep       = 3,
  ): Promise<void> => {
    const tmpl = templatesRef.current[templateIndex];
    if (!tmpl) return;

    const worker = workerRef.current;
    if (!worker) return;

    setIsSearching(true);
    setWorkerDetail('');

    await new Promise<void>(r => requestAnimationFrame(() => r()));

    const srcCtx  = canvas.getContext('2d')!;
    const srcData = srcCtx.getImageData(0, 0, canvas.width, canvas.height);
    const srcMsg  = { data: srcData.data, width: srcData.width, height: srcData.height };

    const tplMsg  = {
      data:   new Uint8ClampedArray(tmpl.data),
      width:  tmpl.width,
      height: tmpl.height,
    };

    // Snapshot existing results from OTHER templates before worker runs
    const existingOther = matchesRef.current.filter(
      m => m.templateIndex !== templateIndex,
    );

    // Temporarily override onmessage for merge behaviour
    const savedHandler = worker.onmessage;

    return new Promise<void>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent) => {
        const msg = e.data;

        if (msg.type === 'PROGRESS') {
          setWorkerPhase(msg.phase ?? '');
          setWorkerDetail(msg.detail ?? '');
          return;
        }

        if (msg.type === 'RESULTS') {
          worker.onmessage = savedHandler;

          // templateIndex in worker results is always 0 (single-template run)
          // Re-stamp with the real index so overlay colours stay correct
          const newHits: CVMatchResult[] = (msg.matches ?? []).map(
            (m: CVMatchResult) => ({ ...m, templateIndex }),
          );

          const combined = clientNMS([...existingOther, ...newHits], 0.30);
          combined.sort((a, b) => b.score - a.score);

          matchesRef.current = combined;
          setMatches(combined);
          setIsSearching(false);
          setWorkerPhase(
            `Done — ${combined.length} match${combined.length !== 1 ? 'es' : ''}`,
          );
          setWorkerDetail('');
          resolve();
          return;
        }

        if (msg.type === 'ERROR') {
          worker.onmessage = savedHandler;
          setIsSearching(false);
          setWorkerPhase(`Error: ${msg.message}`);
          setWorkerDetail('');
          reject(new Error(msg.message));
          return;
        }
      };

      worker.postMessage(
        {
          type:         'FIND_MATCHES',
          srcImageData: srcMsg,
          templates:    [tplMsg],
          threshold,
          rotations,
          flips,
          scales,
          removeText,
          fineStep,
        },
        [srcMsg.data.buffer, tplMsg.data.buffer],
      );
    });
  }, []);   // no deps — uses refs only

  const refindMatches = useCallback(async (
    canvas:     HTMLCanvasElement,
    threshold:  number,
    rotations:  number[],
    flips:      boolean[],
    removeText: boolean,
    scales:     number[],
    fineStep:   number,
  ): Promise<void> => {
    return _findMatches(canvas, threshold, rotations, flips, removeText, scales, fineStep, templatesRef.current);
  }, [_findMatches]);

  const clearAll = useCallback(() => {
    templatesRef.current = [];
    matchesRef.current   = [];
    setTemplates([]);
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
    templates,
    buildTemplate,
    removeTemplate,
    findMatches,
    findMatchesForTemplate,
    refindMatches,
    clearAll,
  };
}