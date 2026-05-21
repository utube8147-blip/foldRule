/**
 * useTemplateMatcher.ts  v1.0
 * ────────────────────────────
 * Rotation-invariant, same-scale template matching against SVG path clusters.
 *
 * Pipeline:
 *  1. extractSignature(paths, svgEl)
 *       - fingerprints each SVGElement (angles, curve ratios, compactness…)
 *       - builds a rotation-normalised angle histogram (16 bins, 0–180°)
 *       - records relative path positions inside the cluster bbox
 *  2. findMatches(signature, svgEl, threshold)
 *       - clusters ALL paths in the SVG by proximity (same algorithm as useShapeDetector)
 *       - scores each cluster against the signature
 *       - returns clusters whose score ≥ threshold, with bounding boxes + snap points
 *
 * Rotation invariance: achieved by circularly-shifting the angle histogram so
 * the dominant bin is always at index 0 before comparing. This handles the same
 * symbol drawn at any orientation without requiring explicit angle enumeration.
 *
 * Scale: NOT normalised — caller is responsible for same-scale assumption.
 */

import { useState, useCallback, useRef } from 'react';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface TemplatePath {
  el:      SVGElement;
  svgBBox: DOMRect;         // getBBox() result
  toggled: boolean;         // user-selected for template
}

export interface SnapPointResult {
  x: number; y: number;
  type: 'endpoint' | 'midpoint' | 'centroid';
}

export interface MatchResult {
  id:         string;
  score:      number;        // 0–1
  bbox:       { x: number; y: number; w: number; h: number };
  snapPoints: SnapPointResult[];
  pathCount:  number;
}

export interface TemplateSignature {
  /** Rotation-normalised 16-bin angle histogram (values sum to 1). */
  angleHist:     number[];
  /** Fraction of paths that are curves (have bezier segments). */
  curveFraction: number;
  /** Fraction of paths that are closed. */
  closedFraction: number;
  /** Mean aspect ratio of individual paths in the cluster. */
  meanAspect:    number;
  /** Cluster bbox aspect ratio (w/h). */
  clusterAspect: number;
  /** Mean compactness of individual paths. */
  meanCompact:   number;
  /** Number of paths in the template cluster. */
  pathCount:     number;
  /** Relative centroid positions inside cluster bbox [0-1], sorted by (cy,cx). */
  relCentroids:  Array<{ rx: number; ry: number }>;
  /** Cluster bbox dimensions — used for scale-match gating. */
  bboxW:         number;
  bboxH:         number;
}

// ─── Internal fingerprint ─────────────────────────────────────────────────────

interface PathFP {
  el:          SVGElement;
  bbox:        DOMRect;
  cx:          number;
  cy:          number;
  aspect:      number;
  compactness: number;
  curveCount:  number;
  lineCount:   number;
  isClosed:    boolean;
  /** Dominant stroke angle in degrees [0, 180). */
  strokeAngle: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clamp01(v: number) { return Math.max(0, Math.min(1, v)); }

function mean(arr: number[]) {
  return arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length;
}

/** Parse an SVG path `d` attribute and return approximate dominant angle (deg, 0-180). */
function dominantAngle(d: string): number {
  // Extract all absolute LineTo segments and approximate curves with chord
  const angles: number[] = [];
  const re = /([MLCQlcqm])\s*([-\d. ,eE]+)/g;
  let m: RegExpExecArray | null;
  let cx = 0, cy = 0;
  while ((m = re.exec(d)) !== null) {
    const cmd  = m[1];
    const nums = m[2].trim().split(/[\s,]+/).map(parseFloat).filter(n => !isNaN(n));
    if (cmd === 'L' && nums.length >= 2) {
      const dx = nums[0] - cx, dy = nums[1] - cy;
      if (Math.hypot(dx, dy) > 0.5) angles.push(Math.atan2(dy, dx));
      cx = nums[0]; cy = nums[1];
    } else if (cmd === 'C' && nums.length >= 6) {
      const dx = nums[4] - cx, dy = nums[5] - cy;
      if (Math.hypot(dx, dy) > 0.5) angles.push(Math.atan2(dy, dx));
      cx = nums[4]; cy = nums[5];
    } else if (cmd === 'M' && nums.length >= 2) {
      cx = nums[0]; cy = nums[1];
    }
  }
  if (angles.length === 0) return 0;
  // Convert to [0,180) half-circle (undirected angle)
  const half = angles.map(a => {
    let deg = (a * 180) / Math.PI;
    while (deg < 0)   deg += 180;
    while (deg >= 180) deg -= 180;
    return deg;
  });
  return mean(half);
}

function fingerprintPath(el: SVGElement): PathFP | null {
  try {
    const bbox = (el as SVGGraphicsElement).getBBox?.();
    if (!bbox || bbox.width < 0.5 || bbox.height < 0.5) return null;
    const d           = el.getAttribute('d') || '';
    const curveCount  = (d.match(/[Cc]/g) || []).length;
    const lineCount   = (d.match(/[LlHhVv]/g) || []).length;
    const isClosed    = /[Zz]\s*$/.test(d.trim());
    const area        = bbox.width * bbox.height;
    const perimeter   = 2 * (bbox.width + bbox.height);
    const compactness = perimeter > 0 ? clamp01((4 * Math.PI * area) / (perimeter * perimeter)) : 0;
    const aspect      = bbox.width / Math.max(bbox.height, 0.1);
    const strokeAngle = dominantAngle(d);
    return {
      el, bbox,
      cx: bbox.x + bbox.width  / 2,
      cy: bbox.y + bbox.height / 2,
      aspect, compactness, curveCount, lineCount, isClosed, strokeAngle,
    };
  } catch {
    return null;
  }
}

// ─── Angle histogram ──────────────────────────────────────────────────────────

const HIST_BINS = 16;

function buildAngleHist(fps: PathFP[]): number[] {
  const hist = new Array(HIST_BINS).fill(0);
  for (const fp of fps) {
    const bin = Math.min(HIST_BINS - 1, Math.floor((fp.strokeAngle / 180) * HIST_BINS));
    hist[bin] += 1;
  }
  const total = hist.reduce((a, b) => a + b, 0) || 1;
  return hist.map(v => v / total);
}

/** Circularly shift histogram so the dominant bin is at index 0 (rotation normalisation). */
function normaliseHist(hist: number[]): number[] {
  let maxIdx = 0;
  for (let i = 1; i < hist.length; i++) if (hist[i] > hist[maxIdx]) maxIdx = i;
  return [...hist.slice(maxIdx), ...hist.slice(0, maxIdx)];
}

/** Chi-squared-like distance between two normalised histograms (lower = more similar). */
function histSimilarity(a: number[], b: number[]): number {
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    const denom = a[i] + b[i];
    if (denom > 0) dist += (diff * diff) / denom;
  }
  // Convert distance [0, ∞) → similarity [0, 1]
  return Math.exp(-dist * 4);
}

// ─── Clustering ───────────────────────────────────────────────────────────────

function clusterByProximity(fps: PathFP[], maxDist: number): PathFP[][] {
  const used     = new Array(fps.length).fill(false);
  const clusters: PathFP[][] = [];
  for (let i = 0; i < fps.length; i++) {
    if (used[i]) continue;
    const cluster = [fps[i]];
    used[i] = true;
    let added = true;
    while (added) {
      added = false;
      for (let j = 0; j < fps.length; j++) {
        if (used[j]) continue;
        const inRange = cluster.some(p => {
          const dx = p.cx - fps[j].cx, dy = p.cy - fps[j].cy;
          return Math.sqrt(dx * dx + dy * dy) < maxDist;
        });
        if (inRange) { cluster.push(fps[j]); used[j] = true; added = true; }
      }
    }
    clusters.push(cluster);
  }
  return clusters;
}

function clusterBBox(fps: PathFP[]) {
  const x0 = Math.min(...fps.map(p => p.bbox.x));
  const y0 = Math.min(...fps.map(p => p.bbox.y));
  const x1 = Math.max(...fps.map(p => p.bbox.x + p.bbox.width));
  const y1 = Math.max(...fps.map(p => p.bbox.y + p.bbox.height));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// ─── Snap point extraction ────────────────────────────────────────────────────

function extractSnapPoints(fps: PathFP[], bbox: ReturnType<typeof clusterBBox>): SnapPointResult[] {
  const pts: SnapPointResult[] = [];

  // Centroid of whole cluster
  pts.push({
    x: bbox.x + bbox.w / 2,
    y: bbox.y + bbox.h / 2,
    type: 'centroid',
  });

  // Corners of each path bbox as endpoints
  for (const fp of fps) {
    const b = fp.bbox;
    const corners = [
      { x: b.x,           y: b.y            },
      { x: b.x + b.width, y: b.y            },
      { x: b.x + b.width, y: b.y + b.height },
      { x: b.x,           y: b.y + b.height },
    ];
    for (const c of corners) pts.push({ ...c, type: 'endpoint' });
    // Midpoints of each edge
    pts.push({ x: b.x + b.width / 2, y: b.y,            type: 'midpoint' });
    pts.push({ x: b.x + b.width / 2, y: b.y + b.height, type: 'midpoint' });
    pts.push({ x: b.x,               y: b.y + b.height / 2, type: 'midpoint' });
    pts.push({ x: b.x + b.width,     y: b.y + b.height / 2, type: 'midpoint' });
  }

  // Deduplicate within 2px
  const deduped: SnapPointResult[] = [];
  for (const pt of pts) {
    const dup = deduped.some(p => Math.hypot(p.x - pt.x, p.y - pt.y) < 2);
    if (!dup) deduped.push(pt);
  }
  return deduped;
}

// ─── Signature builder ────────────────────────────────────────────────────────

export function extractSignature(
  els:   SVGElement[],
  svgEl: SVGSVGElement,
): TemplateSignature | null {
  const fps = els.map(fingerprintPath).filter(Boolean) as PathFP[];
  if (fps.length === 0) return null;

  const bbox    = clusterBBox(fps);
  const hist    = normaliseHist(buildAngleHist(fps));
  const aspects = fps.map(f => f.aspect);
  const compacts = fps.map(f => f.compactness);

  // Relative centroid positions, sorted top-left → bottom-right
  const relCentroids = fps
    .map(f => ({
      rx: bbox.w > 0 ? (f.cx - bbox.x) / bbox.w : 0,
      ry: bbox.h > 0 ? (f.cy - bbox.y) / bbox.h : 0,
    }))
    .sort((a, b) => a.ry - b.ry || a.rx - b.rx);

  return {
    angleHist:      hist,
    curveFraction:  fps.filter(f => f.curveCount > 0).length / fps.length,
    closedFraction: fps.filter(f => f.isClosed).length / fps.length,
    meanAspect:     mean(aspects),
    clusterAspect:  bbox.h > 0 ? bbox.w / bbox.h : 1,
    meanCompact:    mean(compacts),
    pathCount:      fps.length,
    relCentroids,
    bboxW:          bbox.w,
    bboxH:          bbox.h,
  };
}

// ─── Scorer ───────────────────────────────────────────────────────────────────

/**
 * Scale gate: reject candidates whose bbox dimensions differ by more than
 * SCALE_TOLERANCE (fraction) from the template.
 */
const SCALE_TOLERANCE = 0.30;

function scoreCluster(fps: PathFP[], sig: TemplateSignature): number {
  if (fps.length === 0) return 0;

  const bbox = clusterBBox(fps);

  // ── Scale gate ────────────────────────────────────────────────────────────
  const wRatio = Math.abs(bbox.w - sig.bboxW) / Math.max(sig.bboxW, 1);
  const hRatio = Math.abs(bbox.h - sig.bboxH) / Math.max(sig.bboxH, 1);
  if (wRatio > SCALE_TOLERANCE || hRatio > SCALE_TOLERANCE) return 0;

  // ── Path-count proximity ─────────────────────────────────────────────────
  const countScore = clamp01(
    1 - Math.abs(fps.length - sig.pathCount) / Math.max(sig.pathCount, 1)
  );

  // ── Angle histogram similarity (rotation-invariant) ───────────────────────
  const candHist  = normaliseHist(buildAngleHist(fps));
  const histScore = histSimilarity(candHist, sig.angleHist);

  // ── Curve / closed fractions ──────────────────────────────────────────────
  const curveFrac  = fps.filter(f => f.curveCount > 0).length / fps.length;
  const closedFrac = fps.filter(f => f.isClosed).length / fps.length;
  const curveScore  = 1 - Math.abs(curveFrac  - sig.curveFraction);
  const closedScore = 1 - Math.abs(closedFrac - sig.closedFraction);

  // ── Aspect ratios ─────────────────────────────────────────────────────────
  const aspects     = fps.map(f => f.aspect);
  const candAspect  = mean(aspects);
  const aspectScore = clamp01(1 - Math.abs(candAspect - sig.meanAspect) / Math.max(sig.meanAspect, 0.1));
  const clusterAsp  = bbox.h > 0 ? bbox.w / bbox.h : 1;
  const clusterAspScore = clamp01(1 - Math.abs(clusterAsp - sig.clusterAspect) / Math.max(sig.clusterAspect, 0.1));

  // ── Compactness ───────────────────────────────────────────────────────────
  const compacts    = fps.map(f => f.compactness);
  const candCompact = mean(compacts);
  const compactScore = clamp01(1 - Math.abs(candCompact - sig.meanCompact));

  // ── Relative centroid layout ──────────────────────────────────────────────
  let centroidScore = 1;
  if (sig.relCentroids.length > 1 && fps.length > 1) {
    const candRel = fps
      .map(f => ({
        rx: bbox.w > 0 ? (f.cx - bbox.x) / bbox.w : 0,
        ry: bbox.h > 0 ? (f.cy - bbox.y) / bbox.h : 0,
      }))
      .sort((a, b) => a.ry - b.ry || a.rx - b.rx);

    const n    = Math.min(candRel.length, sig.relCentroids.length);
    let   dist = 0;
    for (let i = 0; i < n; i++) {
      dist += Math.hypot(
        candRel[i].rx - sig.relCentroids[i].rx,
        candRel[i].ry - sig.relCentroids[i].ry,
      );
    }
    centroidScore = clamp01(1 - dist / n);
  }

  // ── Weighted composite ────────────────────────────────────────────────────
  return (
    histScore      * 0.28 +
    centroidScore  * 0.22 +
    curveScore     * 0.12 +
    closedScore    * 0.10 +
    countScore     * 0.10 +
    aspectScore    * 0.08 +
    clusterAspScore * 0.06 +
    compactScore   * 0.04
  );
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export interface UseTemplateMatcherReturn {
  signature:     TemplateSignature | null;
  matches:       MatchResult[];
  isSearching:   boolean;
  /** Call with the confirmed template SVGElements and the live SVG root. */
  buildSignature: (els: SVGElement[], svgEl: SVGSVGElement) => void;
  /** Run the search against the full SVG. */
  findMatches:    (svgEl: SVGSVGElement, threshold?: number) => Promise<void>;
  clearAll:       () => void;
}

export function useTemplateMatcher(): UseTemplateMatcherReturn {
  const [signature,   setSignature]   = useState<TemplateSignature | null>(null);
  const [matches,     setMatches]     = useState<MatchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const sigRef = useRef<TemplateSignature | null>(null);

  const buildSignature = useCallback((els: SVGElement[], svgEl: SVGSVGElement) => {
    const sig = extractSignature(els, svgEl);
    sigRef.current = sig;
    setSignature(sig);
    setMatches([]);
  }, []);

  const findMatches = useCallback(async (svgEl: SVGSVGElement, threshold = 0.95) => {
    const sig = sigRef.current;
    if (!sig) return;

    setIsSearching(true);
    await new Promise<void>(r => requestAnimationFrame(() => r()));

    const els = Array.from(
      svgEl.querySelectorAll('path, rect, circle, ellipse, line, polyline, polygon')
    ) as SVGElement[];

    const fps = els.map(fingerprintPath).filter(Boolean) as PathFP[];

    // Use proximity cluster distance proportional to template bbox
    const clusterDist = Math.max(sig.bboxW, sig.bboxH) * 0.6;
    const clusters    = clusterByProximity(fps, Math.max(clusterDist, 40));

    const results: MatchResult[] = [];
    for (let i = 0; i < clusters.length; i++) {
      const cluster = clusters[i];
      const score   = scoreCluster(cluster, sig);
      if (score < threshold) continue;

      const bbox      = clusterBBox(cluster);
      const snapPts   = extractSnapPoints(cluster, bbox);
      results.push({
        id:         `match-${i}`,
        score,
        bbox,
        snapPoints: snapPts,
        pathCount:  cluster.length,
      });
    }

    results.sort((a, b) => b.score - a.score);
    setMatches(results);
    setIsSearching(false);
  }, []);

  const clearAll = useCallback(() => {
    sigRef.current = null;
    setSignature(null);
    setMatches([]);
  }, []);

  return { signature, matches, isSearching, buildSignature, findMatches, clearAll };
}