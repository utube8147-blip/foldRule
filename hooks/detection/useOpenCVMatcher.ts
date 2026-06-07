/**
 * useOpenCVMatcher.ts  v4.0
 * ──────────────────────────
 * Multi-scale template matching via Web Worker — now with contour-based
 * shape extraction and Hu-moment post-filtering.
 *
 * v4.0 changes over v3.0:
 *  ─ BUILD_TEMPLATE message: worker now extracts the dominant contour from
 *    the cropped region, computes Hu moments + shape descriptors (solidity,
 *    extent, aspect ratio), and sends them back so they can be used as a
 *    shape fingerprint for filtering.
 *  ─ FIND_MATCHES: after each matchTemplate pass, candidate hits are
 *    shape-filtered by comparing their extracted contour descriptors to the
 *    template's fingerprint. Hits that fail are dropped before NMS.
 *  ─ ShapeDescriptor type exported for overlay / debug use.
 *  ─ templateShape state exposed on the hook return value.
 *  ─ shapeFilterStrength parameter on findMatches() (0 = off, 1 = strict).
 *  ─ All v3.0 features retained (multi-scale, multi-rotation, NMS, text
 *    removal, TEMPLATE_CLEANED message, rotatedW/rotatedH on results).
 */

import { useState, useCallback, useRef, useEffect } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ShapeDescriptor {
  /** Hu moments [h1..h7] — log-scaled, sign-preserved */
  hu:          number[];
  /** contour area / convex-hull area  (0–1, 1 = convex) */
  solidity:    number;
  /** contour area / bounding-rect area (0–1) */
  extent:      number;
  /** bounding-rect width / height */
  aspectRatio: number;
  /** contour pixel area */
  area:        number;
}

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
  /** Shape similarity score vs template (0–1, 1 = identical). undefined when filter disabled. */
  shapeScore?:      number;
}

export interface UseOpenCVMatcherReturn {
  isReady:         boolean;
  isSearching:     boolean;
  workerPhase:     string;
  workerDetail:    string;
  matches:         CVMatchResult[];
  rawTemplateCrop: ImageData | null;
  templateCrop:    ImageData | null;
  templateShape:   ShapeDescriptor | null;   // NEW: exposed shape fingerprint
  buildTemplate: (
    canvas: HTMLCanvasElement,
    vpBox:  { x: number; y: number; w: number; h: number },
    zoom:   number,
    pan:    { x: number; y: number },
  ) => void;
  findMatches: (
    canvas:               HTMLCanvasElement,
    threshold?:           number,
    rotations?:           number[],
    flips?:               boolean[],
    removeText?:          boolean,
    scales?:              number[],
    shapeFilterStrength?: number,   // NEW: 0 = off, 0.5 = moderate, 1 = strict
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

// ── Shape / contour helpers ───────────────────────────────────────────────────

/**
 * Extract a ShapeDescriptor from a grayscale Mat.
 * Uses Otsu threshold → largest external contour → moments + hull.
 * Returns null if no usable contour found.
 */
function extractShapeDescriptor(cvLib, grayMat) {
  var binary  = new cvLib.Mat();
  var contours= new cvLib.MatVector();
  var hier    = new cvLib.Mat();

  // Otsu binarise (assume light background, dark symbol lines)
  cvLib.threshold(grayMat, binary, 0, 255, cvLib.THRESH_BINARY_INV + cvLib.THRESH_OTSU);

  // Optional: dilate slightly to close gaps in line art
  var kernel = cvLib.getStructuringElement(cvLib.MORPH_RECT, new cvLib.Size(3, 3));
  cvLib.dilate(binary, binary, kernel);
  kernel.delete();

  cvLib.findContours(binary, contours, hier, cvLib.RETR_EXTERNAL, cvLib.CHAIN_APPROX_SIMPLE);

  binary.delete(); hier.delete();

  if (contours.size() === 0) { contours.delete(); return null; }

  // Pick the largest contour by area
  var bestIdx  = 0;
  var bestArea = 0;
  for (var i = 0; i < contours.size(); i++) {
    var a = cvLib.contourArea(contours.get(i));
    if (a > bestArea) { bestArea = a; bestIdx = i; }
  }

  if (bestArea < 16) { contours.delete(); return null; }

  var contour = contours.get(bestIdx);

  // Moments → Hu moments
  var M   = cvLib.moments(contour, false);
  var huMat = new cvLib.Mat();
  cvLib.HuMoments(M, huMat);

  // Log-scale Hu moments (sign-preserved)
  var hu = [];
  for (var j = 0; j < 7; j++) {
    var v = huMat.data64F[j];
    hu.push(v === 0 ? 0 : -Math.sign(v) * Math.log10(Math.abs(v)));
  }
  huMat.delete();

  // Bounding rect
  var br = cvLib.boundingRect(contour);
  var brArea = br.width * br.height;
  var aspectRatio = br.width / Math.max(br.height, 1);
  var extent      = brArea > 0 ? bestArea / brArea : 0;

  // Convex hull area → solidity
  var hull    = new cvLib.Mat();
  cvLib.convexHull(contour, hull, false, true);  // returnPoints=true
  // Re-wrap hull as contour to get area
  var hullVec = new cvLib.MatVector();
  hullVec.push_back(hull);
  var hullArea = cvLib.contourArea(hull);
  hull.delete(); hullVec.delete();
  var solidity = hullArea > 0 ? bestArea / hullArea : 0;

  contours.delete();

  return {
    hu:          hu,
    solidity:    solidity,
    extent:      extent,
    aspectRatio: aspectRatio,
    area:        bestArea,
  };
}

/**
 * Compare two ShapeDescriptors.
 * Returns a similarity score 0–1 (1 = identical).
 * strength: 0 = very lenient, 1 = strict
 */
function shapeMatch(a, b, strength) {
  if (!a || !b) return 1; // no descriptor → pass through

  // ── Hu moment distance (use first 5; 6-7 are very sensitive to noise) ──
  var huDist = 0;
  for (var i = 0; i < 5; i++) {
    var diff = a.hu[i] - b.hu[i];
    huDist += diff * diff;
  }
  huDist = Math.sqrt(huDist);
  // Normalise: typical good matches < 0.5, bad > 2.0
  var huScore = Math.max(0, 1 - huDist / (0.5 + 1.5 * (1 - strength)));

  // ── Aspect ratio similarity ──
  var arDiff   = Math.abs(a.aspectRatio - b.aspectRatio) / Math.max(a.aspectRatio, b.aspectRatio, 0.01);
  var arScore  = Math.max(0, 1 - arDiff / (0.15 + 0.35 * (1 - strength)));

  // ── Solidity similarity ──
  var solDiff  = Math.abs(a.solidity - b.solidity);
  var solScore = Math.max(0, 1 - solDiff / (0.10 + 0.20 * (1 - strength)));

  // ── Extent similarity ──
  var extDiff  = Math.abs(a.extent - b.extent);
  var extScore = Math.max(0, 1 - extDiff / (0.10 + 0.20 * (1 - strength)));

  // Weighted combination (Hu moments carry most weight)
  return huScore * 0.50 + arScore * 0.25 + solScore * 0.125 + extScore * 0.125;
}

/**
 * Extract a ShapeDescriptor from a hit region in the source image.
 * x, y, w, h are in source-image pixel coordinates.
 */
function extractHitDescriptor(cvLib, srcGray, x, y, w, h) {
  var cx = Math.max(0, Math.round(x));
  var cy = Math.max(0, Math.round(y));
  var cw = Math.min(srcGray.cols - cx, Math.round(w));
  var ch = Math.min(srcGray.rows - cy, Math.round(h));
  if (cw < 4 || ch < 4) return null;

  var roi  = srcGray.roi(new cvLib.Rect(cx, cy, cw, ch));
  var desc = extractShapeDescriptor(cvLib, roi);
  roi.delete();
  return desc;
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

function rotateMat(cv, src, deg) {
  if (deg === 0)   return src.clone();
  if (deg === 90)  { var t1=new cv.Mat(); cv.transpose(src,t1); var r1=new cv.Mat(); cv.flip(t1,r1,1);  t1.delete(); return r1; }
  if (deg === 180) { var r2=new cv.Mat(); cv.flip(src,r2,-1); return r2; }
  if (deg === 270) { var t3=new cv.Mat(); cv.transpose(src,t3); var r3=new cv.Mat(); cv.flip(t3,r3,0);  t3.delete(); return r3; }
  var cx = src.cols / 2;
  var cy = src.rows / 2;
  var M  = cv.getRotationMatrix2D(new cv.Point(cx, cy), -deg, 1.0);
  var rad  = deg * Math.PI / 180;
  var cosA = Math.abs(Math.cos(rad));
  var sinA = Math.abs(Math.sin(rad));
  var nW   = Math.round(src.cols * cosA + src.rows * sinA);
  var nH   = Math.round(src.cols * sinA + src.rows * cosA);
  M.data64F[2] += (nW - src.cols) / 2;
  M.data64F[5] += (nH - src.rows) / 2;
  var dst  = new cv.Mat();
  var dsize = new cv.Size(nW, nH);
  cv.warpAffine(src, dst, M, dsize, cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255,255,255,255));
  M.delete();
  return dst;
}

function remapToOriginal(hitX, hitY, deg, flipped, srcW, srcH, tmplW, tmplH) {
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
  var origCx2 = hitX + tmplW / 2;
  var origCy2 = hitY + tmplH / 2;
  return { x: Math.round(origCx2 - tmplW / 2), y: Math.round(origCy2 - tmplH / 2) };
}

// ── Single orientation+scale pass ─────────────────────────────────────────────

function runPass(cv, srcGray, templGrayOrig, orient, scale, threshold,
                 idxOffset, origTemplW, origTemplH, srcW, srcH,
                 tmplShape, shapeFilterStrength) {

  var deg     = orient.deg;
  var flipped = orient.flipped;
  var label   = orient.label;
  var isCard  = (deg === 0 || deg === 90 || deg === 180 || deg === 270);

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

  var templReady;
  if (flipped) {
    templReady = new cv.Mat();
    cv.flip(templScaled, templReady, 1);
    templScaled.delete();
  } else {
    templReady = templScaled;
  }

  var results = [];
  var useShapeFilter = tmplShape !== null && shapeFilterStrength > 0;
  // Accept threshold for shape filter (lower strength = more lenient)
  var shapeAcceptThresh = 0.30 + shapeFilterStrength * 0.40; // 0.30–0.70

  if (isCard) {
    var preparedSrc = prepareSourceMat(cv, srcGray, deg, false);
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

          var bboxW = tmplW;
          var bboxH = tmplH;
          var orig  = remapToOriginal(c, r, deg, flipped, srcW, srcH, bboxW, bboxH);

          // ── Shape filter ──────────────────────────────────────────────────
          var shapeScore;
          if (useShapeFilter) {
            var hitDesc = extractHitDescriptor(cv, srcGray, orig.x, orig.y, scaledW, scaledH);
            shapeScore  = shapeMatch(tmplShape, hitDesc, shapeFilterStrength);
            if (shapeScore < shapeAcceptThresh) continue;
          }

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
            shapeScore:       shapeScore,
          });
        }
      }
      result.delete();
    }
    preparedSrc.delete();

  } else {
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

          var shapeScore2;
          if (useShapeFilter) {
            var hitDesc2 = extractHitDescriptor(cv, srcGray, c2, r2, scaledW, scaledH);
            shapeScore2  = shapeMatch(tmplShape, hitDesc2, shapeFilterStrength);
            if (shapeScore2 < shapeAcceptThresh) continue;
          }

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
            shapeScore:       shapeScore2,
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

// ── BUILD_TEMPLATE handler ────────────────────────────────────────────────────

function doBuildTemplate(msg) {
  var cvLib        = self.cv;
  var tmplImageData= msg.tmplImageData;

  self.postMessage({ type: 'PROGRESS', phase: 'Extracting template shape…' });

  var templMat  = imageDataToMat(cvLib, tmplImageData);
  var templGray = new cvLib.Mat();
  cvLib.cvtColor(templMat, templGray, cvLib.COLOR_RGBA2GRAY);
  templMat.delete();

  var shape = extractShapeDescriptor(cvLib, templGray);
  templGray.delete();

  self.postMessage({ type: 'TEMPLATE_SHAPE', shape: shape });
}

// ── Main matching function ────────────────────────────────────────────────────

async function doFindMatches(msg) {
  var cvLib               = self.cv;
  var srcImageData        = msg.srcImageData;
  var tmplImageData       = msg.tmplImageData;
  var threshold           = msg.threshold;
  var rotations           = msg.rotations;
  var flips               = msg.flips;
  var removeText          = msg.removeText;
  var scales              = msg.scales && msg.scales.length > 0 ? msg.scales : [1.0];
  var shapeFilterStrength = typeof msg.shapeFilterStrength === 'number' ? msg.shapeFilterStrength : 0.6;
  var tmplShape           = msg.tmplShape || null;   // pre-computed on hook side
  var origTemplW          = tmplImageData.width;
  var origTemplH          = tmplImageData.height;

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

  // ── If no pre-computed shape, extract now ─────────────────────────────────
  if (!tmplShape && shapeFilterStrength > 0) {
    self.postMessage({ type: 'PROGRESS', phase: 'Extracting template shape fingerprint…' });
    tmplShape = extractShapeDescriptor(cvLib, templGray);
    if (tmplShape) {
      self.postMessage({ type: 'TEMPLATE_SHAPE', shape: tmplShape });
    }
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
        detail: orient.label + (scales.length > 1 ? ' · scale ×' + scale.toFixed(2) : '')
                + (shapeFilterStrength > 0 ? ' · shape filter ' + Math.round(shapeFilterStrength*100) + '%' : ''),
      });

      var hits = runPass(
        cvLib, srcGray, templGray,
        orient, scale, threshold,
        idxOffset, origTemplW, origTemplH, srcW, srcH,
        tmplShape, shapeFilterStrength,
      );
      for (var h = 0; h < hits.length; h++) allResults.push(hits[h]);
      idxOffset += srcW * srcH;
    }
  }

  templGray.delete();
  srcGray.delete();

  // ── Global NMS across all scales + orientations ───────────────────────────
  self.postMessage({ type: 'PROGRESS', phase: 'Non-maximum suppression', detail: allResults.length + ' raw hits' });
  var deduped = nms(allResults, msg.nmsIou !== undefined ? msg.nmsIou : 0.30);
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

  if (msg.type === 'BUILD_TEMPLATE') {
    try {
      if (!cvReady) { await loadCV(); self.postMessage({ type: 'READY' }); }
      doBuildTemplate(msg);
    } catch(err) {
      self.postMessage({ type: 'ERROR', message: err.message });
    }
    return;
  }

  if (msg.type === 'FIND_MATCHES') {
    try {
      if (!cvReady) { await loadCV(); self.postMessage({ type: 'READY' }); }
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
  const [templateShape,   setTemplateShape]   = useState<ShapeDescriptor | null>(null);

  const workerRef   = useRef<Worker | null>(null);
  const blobUrlRef  = useRef('');
  const templateRef = useRef<ImageData | null>(null);
  const shapeRef    = useRef<ShapeDescriptor | null>(null);
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
        case 'TEMPLATE_SHAPE': {
          const shape = msg.shape as ShapeDescriptor | null;
          shapeRef.current = shape;
          setTemplateShape(shape);
          break;
        }
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
  // Now also sends BUILD_TEMPLATE to worker so shape fingerprint is computed
  // as soon as the box is drawn — before findMatches is called.
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
    shapeRef.current    = null;
    setRawTemplateCrop(crop);
    setTemplateCrop(crop);
    setTemplateShape(null);
    setMatches([]);

    // Send to worker for shape extraction (async, result comes back as TEMPLATE_SHAPE)
    const worker = workerRef.current;
    if (worker) {
      const tmplCopy = new Uint8ClampedArray(crop.data);
      worker.postMessage(
        {
          type:          'BUILD_TEMPLATE',
          tmplImageData: { data: tmplCopy, width: crop.width, height: crop.height },
        },
        [tmplCopy.buffer],
      );
    }
  }, []);

  // ── findMatches ─────────────────────────────────────────────────────────────
  const findMatches = useCallback(async (
    canvas:               HTMLCanvasElement,
    threshold             = 0.60,
    rotations             = [0, 90, 180, 270],
    flips                 = [false, true],
    removeText            = false,
    scales                = [0.9, 1.0, 1.1],
    shapeFilterStrength   = 0.6,   // 0 = off, 0.5 = moderate, 1 = strict
    nmsIou                = 0.30,
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
          type:                 'FIND_MATCHES',
          srcImageData:         srcData,
          tmplImageData:        tmplImageData,
          threshold,
          rotations,
          flips,
          removeText,
          scales,
          shapeFilterStrength,
          nmsIou,
          tmplShape:            shapeRef.current,  // pass pre-computed shape if available
        },
        [srcData.data.buffer, tmplDataCopy.buffer],
      );
    });
  }, []);

  // ── clearAll ────────────────────────────────────────────────────────────────
  const clearAll = useCallback(() => {
    templateRef.current = null;
    shapeRef.current    = null;
    setRawTemplateCrop(null);
    setTemplateCrop(null);
    setTemplateShape(null);
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
    templateShape,
    buildTemplate,
    findMatches,
    clearAll,
  };
}