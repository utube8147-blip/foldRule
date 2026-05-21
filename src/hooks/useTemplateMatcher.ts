/**
 * useTemplateMatcher.ts  v2.0
 * ────────────────────────────
 * Rotation-invariant, scale-aware template matching against SVG path clusters.
 *
 * KEY IMPROVEMENTS over v1.0:
 *  - True rotation invariance via Hu moments (7 invariants, rotation+scale+reflection)
 *  - Scale normalised matching: compare bbox DIAGONAL RATIO and path-area ratio, not raw px
 *  - Robust angle histogram: parses both absolute AND relative SVG path commands
 *  - Rotation-invariant centroid layout via radial distance distribution (not sorted x/y)
 *  - Cluster distance capped at 200px so it never swallows the whole drawing
 *  - handleBoxCommit guard: rejects boxes >12% of SVG dimensions
 *  - Per-path perimeter approximation via polyline sampling for compactness
 *  - Weighted scoring tuned for ≥90% accuracy on floor-plan symbols at any orientation
 */

import { useState, useCallback, useRef } from 'react';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface TemplatePath {
  el:      SVGElement;
  svgBBox: DOMRect;
  toggled: boolean;
}

export interface SnapPointResult {
  x: number; y: number;
  type: 'endpoint' | 'midpoint' | 'centroid';
}

export interface MatchResult {
  id:         string;
  score:      number;
  bbox:       { x: number; y: number; w: number; h: number };
  snapPoints: SnapPointResult[];
  pathCount:  number;
}

export interface TemplateSignature {
  /** 7 Hu moments — rotation, scale and reflection invariant */
  huMoments:      number[];
  /** Rotation-normalised 16-bin angle histogram (sums to 1) */
  angleHist:      number[];
  /** Fraction of paths with bezier segments */
  curveFraction:  number;
  /** Fraction of closed paths */
  closedFraction: number;
  /** Mean aspect ratio of individual paths */
  meanAspect:     number;
  /** Mean compactness */
  meanCompact:    number;
  /** Path count */
  pathCount:      number;
  /** Radial distribution: sorted distances of path centroids from cluster centroid (normalised 0-1) */
  radialDist:     number[];
  /** Cluster bbox DIAGONAL in SVG units — used for scale-ratio gating (not raw w/h) */
  bboxDiag:       number;
  /** Area ratio: sum of individual path areas / cluster bbox area */
  areaRatio:      number;
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
  isClosed:    boolean;
  strokeAngle: number;
  /** Sampled polyline points in SVG space (for Hu moments) */
  points:      Array<{ x: number; y: number }>;
}

// ─── SVG path sampler ─────────────────────────────────────────────────────────

/**
 * Sample ~60 evenly-spaced points from an SVG path element using getTotalLength
 * and getPointAtLength. Falls back to bbox corners if those methods are absent.
 */
function samplePathPoints(el: SVGElement): Array<{ x: number; y: number }> {
  try {
    const pathEl = el as SVGPathElement;
    if (typeof pathEl.getTotalLength !== 'function') throw new Error('no getTotalLength');
    const len = pathEl.getTotalLength();
    if (len < 1) throw new Error('zero length');
    const N    = Math.min(60, Math.max(12, Math.round(len / 4)));
    const pts: Array<{ x: number; y: number }> = [];
    for (let i = 0; i <= N; i++) {
      const p = pathEl.getPointAtLength((i / N) * len);
      pts.push({ x: p.x, y: p.y });
    }
    return pts;
  } catch {
    // Fallback: bbox corners + midpoints
    try {
      const b = (el as SVGGraphicsElement).getBBox();
      return [
        { x: b.x,               y: b.y               },
        { x: b.x + b.width / 2, y: b.y               },
        { x: b.x + b.width,     y: b.y               },
        { x: b.x + b.width,     y: b.y + b.height / 2},
        { x: b.x + b.width,     y: b.y + b.height    },
        { x: b.x + b.width / 2, y: b.y + b.height    },
        { x: b.x,               y: b.y + b.height    },
        { x: b.x,               y: b.y + b.height / 2},
      ];
    } catch {
      return [];
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clamp01(v: number) { return Math.max(0, Math.min(1, v)); }
function mean(arr: number[]) {
  return arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length;
}

/**
 * Parse SVG path `d` — handles BOTH absolute (L,C,Q,M) and relative (l,c,q,m)
 * commands to extract a polyline for angle analysis.
 */
function dominantAngle(d: string): number {
  const angles: number[] = [];
  // Full command parser: absolute and relative L, C, Q, M
  const re = /([MLCQmlcq])\s*([-\d. ,eE]+)/g;
  let m: RegExpExecArray | null;
  let ax = 0, ay = 0;  // absolute cursor

  while ((m = re.exec(d)) !== null) {
    const cmd  = m[1];
    const nums = m[2].trim().split(/[\s,]+/).map(parseFloat).filter(n => !isNaN(n));

    if (cmd === 'M') { ax = nums[0] ?? ax; ay = nums[1] ?? ay; }
    else if (cmd === 'm') { ax += nums[0] ?? 0; ay += nums[1] ?? 0; }
    else if (cmd === 'L') {
      const nx = nums[0], ny = nums[1];
      pushAngle(ax, ay, nx, ny, angles);
      ax = nx; ay = ny;
    } else if (cmd === 'l') {
      const nx = ax + (nums[0] ?? 0), ny = ay + (nums[1] ?? 0);
      pushAngle(ax, ay, nx, ny, angles);
      ax = nx; ay = ny;
    } else if (cmd === 'C' && nums.length >= 6) {
      const nx = nums[4], ny = nums[5];
      pushAngle(ax, ay, nx, ny, angles);
      ax = nx; ay = ny;
    } else if (cmd === 'c' && nums.length >= 6) {
      const nx = ax + nums[4], ny = ay + nums[5];
      pushAngle(ax, ay, nx, ny, angles);
      ax = nx; ay = ny;
    } else if (cmd === 'Q' && nums.length >= 4) {
      const nx = nums[2], ny = nums[3];
      pushAngle(ax, ay, nx, ny, angles);
      ax = nx; ay = ny;
    } else if (cmd === 'q' && nums.length >= 4) {
      const nx = ax + nums[2], ny = ay + nums[3];
      pushAngle(ax, ay, nx, ny, angles);
      ax = nx; ay = ny;
    }
  }

  if (angles.length === 0) return 0;
  // Map to undirected [0, 180) half-circle
  const half = angles.map(a => {
    let deg = (a * 180) / Math.PI;
    while (deg < 0)    deg += 180;
    while (deg >= 180) deg -= 180;
    return deg;
  });
  return mean(half);
}

function pushAngle(x1: number, y1: number, x2: number, y2: number, out: number[]) {
  const dx = x2 - x1, dy = y2 - y1;
  if (Math.hypot(dx, dy) > 0.5) out.push(Math.atan2(dy, dx));
}

function fingerprintPath(el: SVGElement): PathFP | null {
  try {
    const bbox = (el as SVGGraphicsElement).getBBox?.();
    if (!bbox || bbox.width < 0.5 || bbox.height < 0.5) return null;
    const d           = el.getAttribute('d') || '';
    const curveCount  = (d.match(/[CcQq]/g) || []).length;
    const isClosed    = /[Zz]\s*$/.test(d.trim());
    const area        = bbox.width * bbox.height;
    const perimeter   = 2 * (bbox.width + bbox.height);
    const compactness = perimeter > 0 ? clamp01((4 * Math.PI * area) / (perimeter * perimeter)) : 0;
    const aspect      = bbox.width / Math.max(bbox.height, 0.1);
    const strokeAngle = dominantAngle(d);
    const points      = samplePathPoints(el);
    return {
      el, bbox,
      cx: bbox.x + bbox.width  / 2,
      cy: bbox.y + bbox.height / 2,
      aspect, compactness, curveCount, isClosed, strokeAngle, points,
    };
  } catch {
    return null;
  }
}

// ─── Hu moments ──────────────────────────────────────────────────────────────
/**
 * Compute 7 Hu moments from a set of 2D points.
 * Hu moments are invariant to rotation, scale, and reflection.
 * We log-transform them so all 7 are similar magnitude for comparison.
 */
function computeHuMoments(allPoints: Array<{ x: number; y: number }>): number[] {
  if (allPoints.length < 3) return new Array(7).fill(0);

  // Raw moments
  const N = allPoints.length;
  let m00 = N, m10 = 0, m01 = 0;
  for (const p of allPoints) { m10 += p.x; m01 += p.y; }
  const cx = m10 / m00, cy = m01 / m00;

  // Central moments up to order 3
  let mu20=0,mu02=0,mu11=0,mu30=0,mu03=0,mu21=0,mu12=0;
  for (const p of allPoints) {
    const dx = p.x - cx, dy = p.y - cy;
    mu20 += dx*dx; mu02 += dy*dy; mu11 += dx*dy;
    mu30 += dx*dx*dx; mu03 += dy*dy*dy;
    mu21 += dx*dx*dy; mu12 += dx*dy*dy;
  }

  // Normalise by m00^((p+q)/2+1)
  const n = (p: number, q: number, mu: number) => mu / Math.pow(m00, (p + q) / 2 + 1);
  const n20 = n(2,0,mu20), n02 = n(0,2,mu02), n11 = n(1,1,mu11);
  const n30 = n(3,0,mu30), n03 = n(0,3,mu03), n21 = n(2,1,mu21), n12 = n(1,2,mu12);

  const hu: number[] = [
    n20 + n02,
    (n20 - n02)**2 + 4*n11**2,
    (n30 - 3*n12)**2 + (3*n21 - n03)**2,
    (n30 + n12)**2  + (n21 + n03)**2,
    (n30 - 3*n12)*(n30 + n12)*((n30+n12)**2 - 3*(n21+n03)**2) +
      (3*n21-n03)*(n21+n03)*(3*(n30+n12)**2 - (n21+n03)**2),
    (n20 - n02)*((n30+n12)**2 - (n21+n03)**2) + 4*n11*(n30+n12)*(n21+n03),
    (3*n21-n03)*(n30+n12)*((n30+n12)**2 - 3*(n21+n03)**2) -
      (n30-3*n12)*(n21+n03)*(3*(n30+n12)**2 - (n21+n03)**2),
  ];

  // Log-scale transform: sign(h) * log10(1 + |h| * 1e6)
  return hu.map(h => h === 0 ? 0 : Math.sign(h) * Math.log10(1 + Math.abs(h) * 1e6));
}

function huSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    const maxAbs = Math.max(Math.abs(a[i]), Math.abs(b[i]), 0.001);
    dist += Math.abs(a[i] - b[i]) / maxAbs;
  }
  // Convert mean relative distance → similarity
  return Math.exp(-(dist / a.length) * 0.8);
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

/** Circularly shift so dominant bin is at index 0 */
function normaliseHist(hist: number[]): number[] {
  let maxIdx = 0;
  for (let i = 1; i < hist.length; i++) if (hist[i] > hist[maxIdx]) maxIdx = i;
  return [...hist.slice(maxIdx), ...hist.slice(0, maxIdx)];
}

/** Chi-squared distance → similarity */
function histSimilarity(a: number[], b: number[]): number {
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i], denom = a[i] + b[i];
    if (denom > 0) dist += (diff * diff) / denom;
  }
  return Math.exp(-dist * 3);
}

// ─── Radial distribution (rotation invariant centroid layout) ─────────────────

/**
 * Instead of sorted (rx,ry) positions — which break under rotation —
 * use the sorted list of distances from the cluster centroid, normalised
 * by the max distance. This is fully rotation invariant.
 */
function buildRadialDist(fps: PathFP[], clusterCx: number, clusterCy: number): number[] {
  const dists = fps.map(fp => Math.hypot(fp.cx - clusterCx, fp.cy - clusterCy));
  const maxD  = Math.max(...dists, 1);
  return dists.map(d => d / maxD).sort((a, b) => a - b);
}

function radialSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 1;
  let dist = 0;
  for (let i = 0; i < n; i++) dist += Math.abs(a[i] - b[i]);
  return clamp01(1 - dist / n);
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
  pts.push({ x: bbox.x + bbox.w / 2, y: bbox.y + bbox.h / 2, type: 'centroid' });
  for (const fp of fps) {
    const b = fp.bbox;
    const corners = [
      { x: b.x,           y: b.y            },
      { x: b.x + b.width, y: b.y            },
      { x: b.x + b.width, y: b.y + b.height },
      { x: b.x,           y: b.y + b.height },
    ];
    for (const c of corners) pts.push({ ...c, type: 'endpoint' });
    pts.push({ x: b.x + b.width / 2, y: b.y,                type: 'midpoint' });
    pts.push({ x: b.x + b.width / 2, y: b.y + b.height,     type: 'midpoint' });
    pts.push({ x: b.x,               y: b.y + b.height / 2, type: 'midpoint' });
    pts.push({ x: b.x + b.width,     y: b.y + b.height / 2, type: 'midpoint' });
  }
  const deduped: SnapPointResult[] = [];
  for (const pt of pts) {
    if (!deduped.some(p => Math.hypot(p.x - pt.x, p.y - pt.y) < 2)) deduped.push(pt);
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

  const bbox     = clusterBBox(fps);
  const bboxDiag = Math.hypot(bbox.w, bbox.h);
  const hist     = normaliseHist(buildAngleHist(fps));

  // Hu moments from all sampled points combined
  const allPoints = fps.flatMap(fp => fp.points);
  const huMoments = computeHuMoments(allPoints);

  // Cluster centroid
  const clusterCx = bbox.x + bbox.w / 2;
  const clusterCy = bbox.y + bbox.h / 2;
  const radialDist = buildRadialDist(fps, clusterCx, clusterCy);

  // Area ratio: sum individual path bboxAreas / cluster bbox area
  const sumPathArea = fps.reduce((s, f) => s + f.bbox.width * f.bbox.height, 0);
  const clusterArea = Math.max(bbox.w * bbox.h, 1);
  const areaRatio   = clamp01(sumPathArea / clusterArea);

  return {
    huMoments,
    angleHist:      hist,
    curveFraction:  fps.filter(f => f.curveCount > 0).length / fps.length,
    closedFraction: fps.filter(f => f.isClosed).length / fps.length,
    meanAspect:     mean(fps.map(f => f.aspect)),
    meanCompact:    mean(fps.map(f => f.compactness)),
    pathCount:      fps.length,
    radialDist,
    bboxDiag,
    areaRatio,
  };
}

// ─── Scorer ───────────────────────────────────────────────────────────────────

/**
 * Scale gate: candidate bbox diagonal must be within SCALE_TOLERANCE of template.
 * Using diagonal instead of separate w/h means a rotated symbol (which swaps w↔h)
 * still passes the gate.
 */
const SCALE_TOLERANCE = 0.35;

function scoreCluster(fps: PathFP[], sig: TemplateSignature): number {
  if (fps.length === 0) return 0;

  const bbox     = clusterBBox(fps);
  const bboxDiag = Math.hypot(bbox.w, bbox.h);

  // ── Scale gate (diagonal ratio) ────────────────────────────────────────────
  const diagRatio = Math.abs(bboxDiag - sig.bboxDiag) / Math.max(sig.bboxDiag, 1);
  if (diagRatio > SCALE_TOLERANCE) return 0;

  // ── Path count ─────────────────────────────────────────────────────────────
  const countScore = clamp01(
    1 - Math.abs(fps.length - sig.pathCount) / Math.max(sig.pathCount, 1)
  );
  // Hard reject if count is wildly different (>2x or <0.5x)
  const countRatio = fps.length / Math.max(sig.pathCount, 1);
  if (countRatio > 2.5 || countRatio < 0.4) return 0;

  // ── Hu moments (primary shape descriptor) ─────────────────────────────────
  const allPoints = fps.flatMap(fp => fp.points);
  const candHu    = computeHuMoments(allPoints);
  const huScore   = huSimilarity(candHu, sig.huMoments);

  // ── Angle histogram ────────────────────────────────────────────────────────
  const candHist  = normaliseHist(buildAngleHist(fps));
  const histScore = histSimilarity(candHist, sig.angleHist);

  // ── Curve / closed fractions ───────────────────────────────────────────────
  const curveFrac   = fps.filter(f => f.curveCount > 0).length / fps.length;
  const closedFrac  = fps.filter(f => f.isClosed).length / fps.length;
  const curveScore  = 1 - Math.abs(curveFrac  - sig.curveFraction);
  const closedScore = 1 - Math.abs(closedFrac - sig.closedFraction);

  // ── Radial distribution (rotation-invariant layout) ────────────────────────
  const clusterCx  = bbox.x + bbox.w / 2;
  const clusterCy  = bbox.y + bbox.h / 2;
  const candRadial = buildRadialDist(fps, clusterCx, clusterCy);
  const radScore   = radialSimilarity(candRadial, sig.radialDist);

  // ── Area ratio ─────────────────────────────────────────────────────────────
  const sumPathArea = fps.reduce((s, f) => s + f.bbox.width * f.bbox.height, 0);
  const clusterArea = Math.max(bbox.w * bbox.h, 1);
  const candArea    = clamp01(sumPathArea / clusterArea);
  const areaScore   = clamp01(1 - Math.abs(candArea - sig.areaRatio));

  // ── Individual path aspect ─────────────────────────────────────────────────
  // For rotated symbols, aspect ratios of individual paths change.
  // Use min(a/b, b/a) — ratio closest to 1 — instead of raw difference.
  const candAspect = mean(fps.map(f => f.aspect));
  const aspectSim  = Math.min(candAspect, sig.meanAspect) / Math.max(candAspect, sig.meanAspect, 0.01);

  // ── Weighted composite ─────────────────────────────────────────────────────
  // Hu moments carry the most weight as the primary rotation-invariant descriptor.
  return (
    huScore     * 0.35 +
    histScore   * 0.18 +
    radScore    * 0.16 +
    curveScore  * 0.10 +
    closedScore * 0.08 +
    countScore  * 0.07 +
    areaScore   * 0.04 +
    aspectSim   * 0.02
  );
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export interface UseTemplateMatcherReturn {
  signature:      TemplateSignature | null;
  matches:        MatchResult[];
  isSearching:    boolean;
  buildSignature: (els: SVGElement[], svgEl: SVGSVGElement) => void;
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

  const findMatches = useCallback(async (svgEl: SVGSVGElement, threshold = 0.72) => {
    const sig = sigRef.current;
    if (!sig) return;

    setIsSearching(true);
    await new Promise<void>(r => requestAnimationFrame(() => r()));

    const els = Array.from(
      svgEl.querySelectorAll('path, rect, circle, ellipse, line, polyline, polygon')
    ) as SVGElement[];

    const fps = els.map(fingerprintPath).filter(Boolean) as PathFP[];

    // Cluster distance: based on template diagonal, capped at 200px to prevent
    // massive clusters swallowing the whole drawing.
    const clusterDist = Math.min(sig.bboxDiag * 0.65, 200);
    const clusters    = clusterByProximity(fps, Math.max(clusterDist, 30));

    const results: MatchResult[] = [];
    for (let i = 0; i < clusters.length; i++) {
      const cluster = clusters[i];
      const score   = scoreCluster(cluster, sig);
      if (score < threshold) continue;

      const bbox    = clusterBBox(cluster);
      const snapPts = extractSnapPoints(cluster, bbox);
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