/**
 * usePatternPainter.ts  v2.0
 * ──────────────────────────
 * Manages a list of named patterns. Each pattern has:
 *   - A sampled ImageData template
 *   - An auto-assigned color
 *   - CV match results (bbox + snap points)
 *   - A visibility toggle
 *   - Its own threshold
 *   - A detectedMode: 'template' | 'hatch'
 *
 * HATCH MODE: when the sampled template is detected as a diagonal-line fill,
 * the worker switches from matchTemplate to a HoughLines + connected-component
 * region finder that returns one bbox per connected hatch region.
 *
 * All OpenCV work is delegated to a shared Web Worker.
 */

import { useState, useCallback, useRef, useEffect } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PaintMatch {
  id:               string;
  score:            number;
  rotation:         number;
  flipped:          boolean;
  orientationLabel: string;
  bbox: { x: number; y: number; w: number; h: number };
  snapPoints: Array<{ x: number; y: number; type: 'endpoint' | 'midpoint' | 'centroid' }>;
}

export type PatternMode = 'template' | 'hatch';

export interface Pattern {
  id:           string;
  name:         string;
  color:        string;
  template:     ImageData;
  rawTemplate:  ImageData;
  matches:      PaintMatch[];
  visible:      boolean;
  threshold:    number;
  isRunning:    boolean;
  detectedMode: PatternMode;
}

export interface UsePatternPainterReturn {
  patterns:        Pattern[];
  workerReady:     boolean;
  workerPhase:     string;
  workerDetail:    string;
  activePatternId: string | null;

  addPattern: (
    name:     string,
    canvas:   HTMLCanvasElement,
    vpBox:    { x: number; y: number; w: number; h: number },
    zoom:     number,
    pan:      { x: number; y: number },
    options?: { threshold?: number; rotations?: number[]; flips?: boolean[]; removeText?: boolean }
  ) => Promise<void>;

  rematchPattern: (
    id:      string,
    canvas:  HTMLCanvasElement,
    options?: { rotations?: number[]; flips?: boolean[]; removeText?: boolean }
  ) => Promise<void>;

  rematchAll: (
    canvas:  HTMLCanvasElement,
    options?: { rotations?: number[]; flips?: boolean[]; removeText?: boolean }
  ) => Promise<void>;

  updatePatternName:      (id: string, name: string)      => void;
  updatePatternColor:     (id: string, color: string)     => void;
  updatePatternThreshold: (id: string, threshold: number) => void;
  togglePatternVisible:   (id: string)                    => void;
  removePattern:          (id: string)                    => void;
  clearAll:               ()                              => void;
}

// ─── Colour palette ───────────────────────────────────────────────────────────

const PALETTE = [
  '#f43f5e', '#f59e0b', '#10b981', '#38bdf8',
  '#a78bfa', '#fb923c', '#34d399', '#e879f9',
  '#facc15', '#4ade80', '#60a5fa', '#f472b6',
];

function nextColor(existing: Pattern[]): string {
  const used = new Set(existing.map(p => p.color));
  return PALETTE.find(c => !used.has(c)) ?? PALETTE[existing.length % PALETTE.length];
}

// ─── Worker source ────────────────────────────────────────────────────────────

function getWorkerSource(): string {
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
    { x: x + w/2, y: y + h/2, type: 'centroid' },
    { x: x,       y: y,       type: 'endpoint' },
    { x: x+w,     y: y,       type: 'endpoint' },
    { x: x+w,     y: y+h,     type: 'endpoint' },
    { x: x,       y: y+h,     type: 'endpoint' },
    { x: x+w/2,   y: y,       type: 'midpoint' },
    { x: x+w/2,   y: y+h,     type: 'midpoint' },
    { x: x,       y: y+h/2,   type: 'midpoint' },
    { x: x+w,     y: y+h/2,   type: 'midpoint' },
  ];
}

function iou(a, b) {
  var ix = Math.max(0, Math.min(a.x+a.w, b.x+b.w) - Math.max(a.x, b.x));
  var iy = Math.max(0, Math.min(a.y+a.h, b.y+b.h) - Math.max(a.y, b.y));
  var inter = ix * iy;
  if (inter === 0) return 0;
  return inter / (a.w*a.h + b.w*b.h - inter);
}

function nms(results) {
  var sorted = results.slice().sort(function(a,b){ return b.score - a.score; });
  var kept = [];
  for (var i = 0; i < sorted.length; i++) {
    var r = sorted[i];
    if (!kept.some(function(k){ return iou(k.bbox, r.bbox) > 0.45; })) kept.push(r);
  }
  return kept;
}

function imageDataToMat(cv, imgData) {
  return cv.matFromArray(imgData.height, imgData.width, cv.CV_8UC4, Array.from(imgData.data));
}

function matWithoutText(cv, gray) {
  var binary = new cv.Mat();
  var labels = new cv.Mat(); var stats = new cv.Mat(); var centroids = new cv.Mat();
  cv.threshold(gray, binary, 180, 255, cv.THRESH_BINARY_INV);
  var numLabels = cv.connectedComponentsWithStats(binary, labels, stats, centroids, 8, cv.CV_32S);
  var out = gray.clone();
  for (var i = 1; i < numLabels; i++) {
    var x = stats.intAt(i, cv.CC_STAT_LEFT);   var y = stats.intAt(i, cv.CC_STAT_TOP);
    var w = stats.intAt(i, cv.CC_STAT_WIDTH);  var h = stats.intAt(i, cv.CC_STAT_HEIGHT);
    var ar = w / Math.max(h,1); var area = stats.intAt(i, cv.CC_STAT_AREA);
    if (w<30 && h<40 && ar>=0.2 && ar<=5.0 && area>=4 && area<=600) {
      var roi = out.roi(new cv.Rect(x, y, w, h)); roi.setTo(new cv.Scalar(255)); roi.delete();
    }
  }
  binary.delete(); labels.delete(); stats.delete(); centroids.delete();
  return out;
}

// ─── HATCH DETECTION ──────────────────────────────────────────────────────────

/**
 * detectHatch: returns true if the template ImageData looks like a diagonal
 * line / hatch fill pattern.
 *
 * Strategy:
 *  1. Convert to grayscale, threshold to binary
 *  2. Run HoughLinesP
 *  3. Measure what fraction of detected lines are near-diagonal (30°–60° or 120°–150°)
 *  4. Also check line density (lines per pixel area)
 *  5. If >60% diagonal AND density > threshold → hatch
 */
function detectHatch(cvLib, tmplImageData) {
  var mat = imageDataToMat(cvLib, tmplImageData);
  var gray = new cvLib.Mat();
  cvLib.cvtColor(mat, gray, cvLib.COLOR_RGBA2GRAY);
  mat.delete();

  var binary = new cvLib.Mat();
  cvLib.threshold(gray, binary, 128, 255, cvLib.THRESH_BINARY_INV);
  gray.delete();

  var edges = new cvLib.Mat();
  cvLib.Canny(binary, edges, 50, 150);
  binary.delete();

  var lines = new cvLib.Mat();
  // minLineLength = 20% of shorter dimension, maxGap = 8px
  var minDim = Math.min(tmplImageData.width, tmplImageData.height);
  var minLen = Math.max(8, minDim * 0.15);
  cvLib.HoughLinesP(edges, lines, 1, Math.PI/180, 10, minLen, 8);
  edges.delete();

  if (lines.rows === 0) { lines.delete(); return false; }

  var totalLines = lines.rows;
  var diagLines = 0;

  for (var i = 0; i < totalLines; i++) {
    var x1 = lines.data32S[i*4];
    var y1 = lines.data32S[i*4+1];
    var x2 = lines.data32S[i*4+2];
    var y2 = lines.data32S[i*4+3];
    var dx = x2 - x1, dy = y2 - y1;
    if (dx === 0 && dy === 0) continue;
    // angle in degrees 0..180
    var ang = Math.abs(Math.atan2(dy, dx) * 180 / Math.PI);
    if (ang > 90) ang = 180 - ang;
    // diagonal = 30..60 degrees
    if (ang >= 28 && ang <= 62) diagLines++;
  }

  lines.delete();

  var diagFrac = diagLines / totalLines;
  // density: at least 1 line per 400 sq px
  var area = tmplImageData.width * tmplImageData.height;
  var density = totalLines / area;

  return diagFrac >= 0.55 && density >= (1 / 600);
}

/**
 * findHatchRegions: given the source image and a hatch template, find all
 * connected regions on the SOURCE that match the hatch texture.
 *
 * Pipeline:
 *  1. Detect dominant hatch angle from template via HoughLinesP
 *  2. On the source, extract a "diagonal line mask" at that angle ±10°
 *     using morphological operations + Canny + HoughLinesP
 *  3. Dilate the mask to close gaps within hatch regions
 *  4. Connected components → one bbox per component (filter by min area)
 *  5. Return as PaintMatch array (score = fill density, rotation = angle)
 */
function findHatchRegions(cvLib, srcImageData, tmplImageData, patternId) {
  self.postMessage({ type:'PROGRESS', phase:'Detecting hatch angle', patternId });

  // ── Step 1: get dominant angle from template ──
  var tmplMat = imageDataToMat(cvLib, tmplImageData);
  var tmplGray = new cvLib.Mat();
  cvLib.cvtColor(tmplMat, tmplGray, cvLib.COLOR_RGBA2GRAY);
  tmplMat.delete();

  var tmplBin = new cvLib.Mat();
  cvLib.threshold(tmplGray, tmplBin, 128, 255, cvLib.THRESH_BINARY_INV);
  tmplGray.delete();

  var tmplEdges = new cvLib.Mat();
  cvLib.Canny(tmplBin, tmplEdges, 50, 150);
  tmplBin.delete();

  var tmplLines = new cvLib.Mat();
  cvLib.HoughLinesP(tmplEdges, tmplLines, 1, Math.PI/180, 5,
    Math.max(6, Math.min(tmplImageData.width, tmplImageData.height)*0.12), 6);
  tmplEdges.delete();

  // collect angles
  var angles = [];
  for (var i = 0; i < tmplLines.rows; i++) {
    var x1=tmplLines.data32S[i*4], y1=tmplLines.data32S[i*4+1];
    var x2=tmplLines.data32S[i*4+2], y2=tmplLines.data32S[i*4+3];
    var dx=x2-x1, dy=y2-y1;
    if (Math.hypot(dx,dy) < 4) continue;
    var a = Math.atan2(dy, dx) * 180 / Math.PI;
    if (a < 0) a += 180;
    angles.push(a);
  }
  tmplLines.delete();

  // median angle
  var dominantAngle = 45; // fallback
  if (angles.length > 0) {
    angles.sort(function(a,b){ return a-b; });
    dominantAngle = angles[Math.floor(angles.length/2)];
  }

  self.postMessage({ type:'PROGRESS', phase:'Building hatch mask on source', detail: Math.round(dominantAngle)+'°', patternId });

  // ── Step 2: process source ──
  var srcMat = imageDataToMat(cvLib, srcImageData);
  var srcGray = new cvLib.Mat();
  cvLib.cvtColor(srcMat, srcGray, cvLib.COLOR_RGBA2GRAY);
  srcMat.delete();

  var srcBin = new cvLib.Mat();
  cvLib.threshold(srcGray, srcBin, 128, 255, cvLib.THRESH_BINARY_INV);
  srcGray.delete();

  var srcEdges = new cvLib.Mat();
  cvLib.Canny(srcBin, srcEdges, 30, 100);
  srcBin.delete();

  // Detect lines on source
  var srcLines = new cvLib.Mat();
  cvLib.HoughLinesP(srcEdges, srcLines, 1, Math.PI/180, 12, 15, 10);
  srcEdges.delete();

  self.postMessage({ type:'PROGRESS', phase:'Filtering diagonal lines', patternId });

  // ── Step 3: build angle-filtered mask ──
  var mask = new cvLib.Mat(srcImageData.height, srcImageData.width, cvLib.CV_8UC1, new cvLib.Scalar(0));
  var angleTol = 15; // degrees tolerance

  for (var i = 0; i < srcLines.rows; i++) {
    var x1=srcLines.data32S[i*4], y1=srcLines.data32S[i*4+1];
    var x2=srcLines.data32S[i*4+2], y2=srcLines.data32S[i*4+3];
    var dx=x2-x1, dy=y2-y1;
    if (Math.hypot(dx,dy) < 8) continue;

    var lineAngle = Math.atan2(dy, dx) * 180 / Math.PI;
    if (lineAngle < 0) lineAngle += 180;

    // angular distance (mod 180)
    var diff = Math.abs(lineAngle - dominantAngle);
    if (diff > 90) diff = 180 - diff;

    if (diff <= angleTol) {
      cvLib.line(mask,
        new cvLib.Point(x1, y1),
        new cvLib.Point(x2, y2),
        new cvLib.Scalar(255), 3
      );
    }
  }
  srcLines.delete();

  // ── Step 4: dilate to join nearby lines into filled regions ──
  self.postMessage({ type:'PROGRESS', phase:'Merging hatch regions', patternId });

  var kernel = cvLib.getStructuringElement(
    cvLib.MORPH_RECT,
    new cvLib.Size(28, 28)
  );
  var dilated = new cvLib.Mat();
  cvLib.dilate(mask, dilated, kernel);
  kernel.delete();
  mask.delete();

  // close gaps
  var kernel2 = cvLib.getStructuringElement(cvLib.MORPH_RECT, new cvLib.Size(12, 12));
  var closed = new cvLib.Mat();
  cvLib.morphologyEx(dilated, closed, cvLib.MORPH_CLOSE, kernel2);
  kernel2.delete();
  dilated.delete();

  // ── Step 5: connected components ──
  self.postMessage({ type:'PROGRESS', phase:'Extracting region bboxes', patternId });

  var labels = new cvLib.Mat();
  var stats  = new cvLib.Mat();
  var cents  = new cvLib.Mat();
  var numLabels = cvLib.connectedComponentsWithStats(closed, labels, stats, cents, 8, cvLib.CV_32S);
  closed.delete();

  var minArea = 1200; // ignore tiny blobs
  var results = [];
  var srcArea = srcImageData.width * srcImageData.height;

  for (var i = 1; i < numLabels; i++) {
    var bx = stats.intAt(i, cvLib.CC_STAT_LEFT);
    var by = stats.intAt(i, cvLib.CC_STAT_TOP);
    var bw = stats.intAt(i, cvLib.CC_STAT_WIDTH);
    var bh = stats.intAt(i, cvLib.CC_STAT_HEIGHT);
    var area = stats.intAt(i, cvLib.CC_STAT_AREA);

    if (area < minArea) continue;
    // skip blobs that cover almost the entire image (false positive)
    if (area > srcArea * 0.85) continue;

    // score = fill density of this component
    var bboxArea = bw * bh;
    var score = Math.min(0.99, area / Math.max(bboxArea, 1));

    results.push({
      id: 'hatch-'+i+'-'+Date.now(),
      score: score,
      rotation: Math.round(dominantAngle),
      flipped: false,
      orientationLabel: Math.round(dominantAngle)+'°',
      bbox: { x: bx, y: by, w: bw, h: bh },
      snapPoints: snapPointsForBBox(bx, by, bw, bh),
    });
  }

  labels.delete(); stats.delete(); cents.delete();

  // Sort by area descending
  results.sort(function(a,b){ return (b.bbox.w*b.bbox.h) - (a.bbox.w*a.bbox.h); });

  // Light NMS to remove heavily overlapping regions
  var kept = [];
  for (var i = 0; i < results.length; i++) {
    var r = results[i];
    if (!kept.some(function(k){ return iou(k.bbox, r.bbox) > 0.35; })) kept.push(r);
  }

  return kept;
}

// ─── TEMPLATE MATCHING (original) ────────────────────────────────────────────

function prepareSourceMat(cv, srcGray, deg, flipped) {
  var rotated;
  if (deg === 0) { rotated = srcGray.clone(); }
  else if (deg === 180) { rotated = new cv.Mat(); cv.flip(srcGray, rotated, -1); }
  else {
    var t = new cv.Mat(); cv.transpose(srcGray, t); rotated = new cv.Mat();
    if (deg === 90) cv.flip(t, rotated, 1); else cv.flip(t, rotated, 0);
    t.delete();
  }
  if (flipped) { var fm = new cv.Mat(); cv.flip(rotated, fm, 1); rotated.delete(); return fm; }
  return rotated;
}

function remapToOriginal(hitX, hitY, deg, flipped, srcW, srcH, bboxW, bboxH) {
  var rotW = (deg===90||deg===270) ? srcH : srcW;
  var tmplInPrepW = (deg===90||deg===270) ? bboxH : bboxW;
  var cx = hitX + tmplInPrepW/2;
  var cy = hitY + ((deg===90||deg===270) ? bboxW : bboxH)/2;
  if (flipped) cx = rotW - 1 - cx;
  var origCx, origCy;
  switch(deg) {
    case 0:   origCx=cx;           origCy=cy;           break;
    case 90:  origCx=cy;           origCy=srcH-1-cx;    break;
    case 180: origCx=srcW-1-cx;    origCy=srcH-1-cy;    break;
    case 270: origCx=srcW-1-cy;    origCy=cx;           break;
    default:  origCx=cx;           origCy=cy;
  }
  return { x: Math.round(origCx - bboxW/2), y: Math.round(origCy - bboxH/2) };
}

function runOrientationPass(cv, srcGray, templGray, orient, threshold, idxOffset, origTemplW, origTemplH, srcW, srcH) {
  var deg=orient.deg, flipped=orient.flipped, label=orient.label;
  var preparedSrc = prepareSourceMat(cv, srcGray, deg, flipped);
  if (origTemplW > preparedSrc.cols || origTemplH > preparedSrc.rows) { preparedSrc.delete(); return []; }
  var result = new cv.Mat();
  cv.matchTemplate(preparedSrc, templGray, result, cv.TM_CCOEFF_NORMED);
  preparedSrc.delete();
  var data=result.data32F, rCols=result.cols, rRows=result.rows, matches=[];
  for (var r=0; r<rRows; r++) {
    for (var c=0; c<rCols; c++) {
      var score=data[r*rCols+c];
      if (score < threshold) continue;
      var bboxW=(deg===90||deg===270)?origTemplH:origTemplW;
      var bboxH=(deg===90||deg===270)?origTemplW:origTemplH;
      var orig=remapToOriginal(c,r,deg,flipped,srcW,srcH,bboxW,bboxH);
      matches.push({
        id: 'pp-'+label+'-'+(idxOffset+r*rCols+c),
        score, rotation:deg, flipped, orientationLabel:label,
        bbox:{x:orig.x,y:orig.y,w:bboxW,h:bboxH},
        snapPoints:snapPointsForBBox(orig.x,orig.y,bboxW,bboxH),
      });
    }
  }
  result.delete();
  return matches;
}

async function doFindMatches(msg) {
  var cvLib=self.cv;
  var srcImageData=msg.srcImageData, tmplImageData=msg.tmplImageData;
  var threshold=msg.threshold, rotations=msg.rotations, flips=msg.flips, removeText=msg.removeText;
  var origTemplW=tmplImageData.width, origTemplH=tmplImageData.height;

  // ── Hatch detection ──
  self.postMessage({ type:'PROGRESS', phase:'Analysing template type', patternId:msg.patternId });
  var isHatch = detectHatch(cvLib, tmplImageData);

  if (isHatch) {
    self.postMessage({ type:'PROGRESS', phase:'Hatch pattern detected — finding regions', patternId:msg.patternId });
    var regions = findHatchRegions(cvLib, srcImageData, tmplImageData, msg.patternId);
    self.postMessage({ type:'RESULTS', matches:regions, patternId:msg.patternId, detectedMode:'hatch' });
    return;
  }

  // ── Normal template matching ──
  self.postMessage({ type:'PROGRESS', phase:'Converting source image', patternId:msg.patternId });
  var srcMat=imageDataToMat(cvLib,srcImageData);
  var srcGrayRaw=new cvLib.Mat();
  cvLib.cvtColor(srcMat, srcGrayRaw, cvLib.COLOR_RGBA2GRAY);
  srcMat.delete();

  var srcGray;
  if (removeText) {
    self.postMessage({ type:'PROGRESS', phase:'Removing text from source', patternId:msg.patternId });
    srcGray=matWithoutText(cvLib, srcGrayRaw); srcGrayRaw.delete();
  } else { srcGray=srcGrayRaw; }

  var srcW=srcGray.cols, srcH=srcGray.rows;

  self.postMessage({ type:'PROGRESS', phase:'Converting template', patternId:msg.patternId });
  var templMat=imageDataToMat(cvLib,tmplImageData);
  var templGrayRaw=new cvLib.Mat();
  cvLib.cvtColor(templMat, templGrayRaw, cvLib.COLOR_RGBA2GRAY);
  templMat.delete();

  var templGray;
  if (removeText) {
    self.postMessage({ type:'PROGRESS', phase:'Removing text from template', patternId:msg.patternId });
    templGray=matWithoutText(cvLib,templGrayRaw); templGrayRaw.delete();
  } else { templGray=templGrayRaw; }

  var orientations=[];
  for (var ri=0;ri<rotations.length;ri++) {
    for (var fi=0;fi<flips.length;fi++) {
      var deg=rotations[ri], flipped=flips[fi];
      orientations.push({ deg, flipped, label: flipped ? deg+'°↔' : deg+'°' });
    }
  }

  var allResults=[], idxOffset=0;
  for (var i=0;i<orientations.length;i++) {
    var orient=orientations[i];
    self.postMessage({ type:'PROGRESS', phase:'Matching '+(i+1)+'/'+orientations.length, detail:orient.label, patternId:msg.patternId });
    var hits=runOrientationPass(cvLib,srcGray,templGray,orient,threshold,idxOffset,origTemplW,origTemplH,srcW,srcH);
    for (var h=0;h<hits.length;h++) allResults.push(hits[h]);
    idxOffset += srcW*srcH;
  }

  templGray.delete(); srcGray.delete();
  self.postMessage({ type:'PROGRESS', phase:'NMS', patternId:msg.patternId });
  var deduped=nms(allResults);
  deduped.sort(function(a,b){ return b.score-a.score; });
  self.postMessage({ type:'RESULTS', matches:deduped, patternId:msg.patternId, detectedMode:'template' });
}

self.onmessage = async function(e) {
  var msg=e.data;
  if (msg.type==='LOAD') {
    try {
      self.postMessage({ type:'PROGRESS', phase:'Loading OpenCV.js…' });
      await loadCV();
      self.postMessage({ type:'READY' });
    } catch(err) { self.postMessage({ type:'ERROR', message:err.message }); }
    return;
  }
  if (msg.type==='FIND_MATCHES') {
    try {
      if (!cvReady) { await loadCV(); self.postMessage({ type:'READY' }); }
      await doFindMatches(msg);
    } catch(err) { self.postMessage({ type:'ERROR', message:err.message, patternId:msg.patternId }); }
    return;
  }
};
`;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

let patternCounter = 0;

export function usePatternPainter(): UsePatternPainterReturn {
  const [patterns,        setPatterns]        = useState<Pattern[]>([]);
  const [workerReady,     setWorkerReady]     = useState(false);
  const [workerPhase,     setWorkerPhase]     = useState('');
  const [workerDetail,    setWorkerDetail]    = useState('');
  const [activePatternId, setActivePatternId] = useState<string | null>(null);

  const workerRef  = useRef<Worker | null>(null);
  const blobUrlRef = useRef('');

  const resolveRef = useRef<(() => void) | null>(null);
  const rejectRef  = useRef<((e: Error) => void) | null>(null);

  // ── Worker lifecycle ────────────────────────────────────────────────────────
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
          setWorkerReady(true);
          setWorkerPhase('OpenCV ready');
          setWorkerDetail('');
          break;
        case 'PROGRESS':
          setWorkerPhase(msg.phase ?? '');
          setWorkerDetail(msg.detail ?? '');
          break;
        case 'RESULTS': {
          const pid          = msg.patternId as string;
          const detectedMode = (msg.detectedMode ?? 'template') as PatternMode;
          setPatterns(prev => prev.map(p =>
            p.id === pid
              ? { ...p, matches: msg.matches ?? [], isRunning: false, detectedMode }
              : p
          ));
          setActivePatternId(null);
          const count = msg.matches?.length ?? 0;
          const modeLabel = detectedMode === 'hatch' ? 'hatch region' : 'match';
          setWorkerPhase(`Done — ${count} ${modeLabel}${count !== 1 ? 'es' : ''}`);
          setWorkerDetail('');
          resolveRef.current?.();
          resolveRef.current = null;
          rejectRef.current  = null;
          break;
        }
        case 'ERROR': {
          const pid = msg.patternId as string | undefined;
          if (pid) setPatterns(prev => prev.map(p => p.id === pid ? { ...p, isRunning: false } : p));
          setActivePatternId(null);
          setWorkerPhase(`Error: ${msg.message}`);
          setWorkerDetail('');
          rejectRef.current?.(new Error(msg.message));
          resolveRef.current = null;
          rejectRef.current  = null;
          break;
        }
      }
    };

    worker.onerror = (e) => {
      console.error('[PatternWorker]', e);
      setWorkerPhase('Worker crashed');
      rejectRef.current?.(new Error(e.message));
      resolveRef.current = null;
      rejectRef.current  = null;
    };

    worker.postMessage({ type: 'LOAD' });
    setWorkerPhase('Loading OpenCV.js…');

    return () => { worker.terminate(); URL.revokeObjectURL(url); };
  }, []);

  // ── Internal: run one match job ─────────────────────────────────────────────
  const runMatch = useCallback(async (
    pattern:    Pattern,
    canvas:     HTMLCanvasElement,
    rotations:  number[],
    flips:      boolean[],
    removeText: boolean,
  ): Promise<void> => {
    const worker = workerRef.current;
    if (!worker) return;

    setActivePatternId(pattern.id);
    setPatterns(prev => prev.map(p => p.id === pattern.id ? { ...p, isRunning: true } : p));

    const srcCtx       = canvas.getContext('2d')!;
    const srcImageData = srcCtx.getImageData(0, 0, canvas.width, canvas.height);
    const tmplCopy     = new Uint8ClampedArray(pattern.template.data);

    return new Promise<void>((resolve, reject) => {
      resolveRef.current = resolve;
      rejectRef.current  = reject;

      worker.postMessage(
        {
          type:          'FIND_MATCHES',
          patternId:     pattern.id,
          srcImageData:  { data: srcImageData.data, width: srcImageData.width,  height: srcImageData.height  },
          tmplImageData: { data: tmplCopy,          width: pattern.template.width, height: pattern.template.height },
          threshold:     pattern.threshold,
          rotations,
          flips,
          removeText,
        },
        [srcImageData.data.buffer, tmplCopy.buffer],
      );
    });
  }, []);

  // ── addPattern ──────────────────────────────────────────────────────────────
  const addPattern = useCallback(async (
    name:    string,
    canvas:  HTMLCanvasElement,
    vpBox:   { x: number; y: number; w: number; h: number },
    zoom:    number,
    pan:     { x: number; y: number },
    options: { threshold?: number; rotations?: number[]; flips?: boolean[]; removeText?: boolean } = {},
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
    const id   = `pattern-${++patternCounter}-${Date.now()}`;

    const newPattern: Pattern = {
      id,
      name:         name || `Pattern ${patternCounter}`,
      color:        nextColor([]),
      template:     crop,
      rawTemplate:  crop,
      matches:      [],
      visible:      true,
      threshold:    options.threshold ?? 0.60,
      isRunning:    false,
      detectedMode: 'template',
    };

    setPatterns(prev => {
      const color = nextColor(prev);
      return [...prev, { ...newPattern, color }];
    });

    const patternForRun = { ...newPattern, color: nextColor([]) };
    await new Promise<void>(r => setTimeout(r, 0));

    await runMatch(
      patternForRun,
      canvas,
      options.rotations  ?? [0, 90, 180, 270],
      options.flips      ?? [false, true],
      options.removeText ?? false,
    );
  }, [runMatch]);

  // ── rematchPattern ──────────────────────────────────────────────────────────
  const rematchPattern = useCallback(async (
    id:      string,
    canvas:  HTMLCanvasElement,
    options: { rotations?: number[]; flips?: boolean[]; removeText?: boolean } = {},
  ) => {
    setPatterns(prev => {
      const pattern = prev.find(p => p.id === id);
      if (!pattern) return prev;
      runMatch(
        pattern, canvas,
        options.rotations  ?? [0, 90, 180, 270],
        options.flips      ?? [false, true],
        options.removeText ?? false,
      );
      return prev;
    });
  }, [runMatch]);

  // ── rematchAll ──────────────────────────────────────────────────────────────
  const rematchAll = useCallback(async (
    canvas:  HTMLCanvasElement,
    options: { rotations?: number[]; flips?: boolean[]; removeText?: boolean } = {},
  ) => {
    setPatterns(prev => {
      (async () => {
        for (const p of prev) {
          await runMatch(
            p, canvas,
            options.rotations  ?? [0, 90, 180, 270],
            options.flips      ?? [false, true],
            options.removeText ?? false,
          );
        }
      })();
      return prev;
    });
  }, [runMatch]);

  // ── Mutators ────────────────────────────────────────────────────────────────
  const updatePatternName      = useCallback((id: string, name: string)      => setPatterns(p => p.map(x => x.id === id ? { ...x, name }      : x)), []);
  const updatePatternColor     = useCallback((id: string, color: string)     => setPatterns(p => p.map(x => x.id === id ? { ...x, color }     : x)), []);
  const updatePatternThreshold = useCallback((id: string, threshold: number) => setPatterns(p => p.map(x => x.id === id ? { ...x, threshold } : x)), []);
  const togglePatternVisible   = useCallback((id: string)                    => setPatterns(p => p.map(x => x.id === id ? { ...x, visible: !x.visible } : x)), []);
  const removePattern          = useCallback((id: string)                    => setPatterns(p => p.filter(x => x.id !== id)), []);
  const clearAll               = useCallback(() => {
    setPatterns([]);
    setActivePatternId(null);
    setWorkerPhase(workerReady ? 'OpenCV ready' : 'Loading…');
  }, [workerReady]);

  return {
    patterns,
    workerReady,
    workerPhase,
    workerDetail,
    activePatternId,
    addPattern,
    rematchPattern,
    rematchAll,
    updatePatternName,
    updatePatternColor,
    updatePatternThreshold,
    togglePatternVisible,
    removePattern,
    clearAll,
  };
}