// lib/symbolFingerprint.ts
//
// Geometry-based fingerprinting for SVG areas.
// All inputs use NORMALIZED [0,1] coords (nx, ny).
// Output is a compact descriptor used by symbolClusterer.ts for grouping.

import type { SvgArea } from '@/hooks/snapEngine/useSnapEngine';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ShapeFingerprint {
  /** Bounding-box aspect ratio (width / height). Scale-invariant. */
  aspectRatio: number;

  /** Simplified vertex count after Ramer–Douglas–Peucker. */
  vertexCount: number;

  /**
   * Circularity = 4π·area / perimeter².
   * 1.0  = perfect circle
   * 0.785 = square
   * approaches 0 for very thin/spiky shapes
   */
  circularity: number;

  /**
   * True when the shape contains an arc-like curve.
   * Door symbols score high here; rectangular pillars do not.
   */
  hasArc: boolean;

  /**
   * Normalized area as fraction of total page area.
   * Used to separate tiny symbols from rooms.
   */
  areaN: number;

  /**
   * 7 Hu moments — rotation, translation, scale invariant.
   * Only the first 4 are used for distance to keep computation light.
   */
  huMoments: number[];

  /**
   * Convexity = area / convex-hull-area.
   * 1.0 = fully convex, <1 = concave notches (e.g. L-shape).
   */
  convexity: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

type Pt = { nx: number; ny: number };

function polygonArea(pts: Pt[]): number {
  let area = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += pts[i].nx * pts[j].ny - pts[j].nx * pts[i].ny;
  }
  return Math.abs(area) / 2;
}

function polygonPerimeter(pts: Pt[]): number {
  let p = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    p += Math.hypot(pts[j].nx - pts[i].nx, pts[j].ny - pts[i].ny);
  }
  return p;
}

function centroid(pts: Pt[]): { cx: number; cy: number } {
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p.nx; cy += p.ny; }
  return { cx: cx / pts.length, cy: cy / pts.length };
}

/** Ramer–Douglas–Peucker simplification (normalized epsilon). */
function rdp(pts: Pt[], eps: number): Pt[] {
  if (pts.length < 3) return pts;
  let maxDist = 0, maxIdx = 0;
  const line = pts[pts.length - 1];
  for (let i = 1; i < pts.length - 1; i++) {
    const d = perpendicularDist(pts[i], pts[0], line);
    if (d > maxDist) { maxDist = d; maxIdx = i; }
  }
  if (maxDist > eps) {
    return [
      ...rdp(pts.slice(0, maxIdx + 1), eps),
      ...rdp(pts.slice(maxIdx), eps).slice(1),
    ];
  }
  return [pts[0], pts[pts.length - 1]];
}

function perpendicularDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b.nx - a.nx, dy = b.ny - a.ny;
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(p.nx - a.nx, p.ny - a.ny);
  return Math.abs(dx * (a.ny - p.ny) - (a.nx - p.nx) * dy) / len;
}

/**
 * Detect if shape likely contains an arc.
 * Strategy: compare vertex count before and after aggressive simplification.
 * Shapes with smooth curves lose far fewer vertices than polygon-like shapes.
 */
function detectArc(pts: Pt[]): boolean {
  if (pts.length < 8) return false;
  const simplified = rdp(pts, 0.005);
  // If the original has >20 pts but simplifies to <8 it's curved
  return pts.length > 20 && simplified.length < 8;
}

/** Convex hull (Graham scan) on normalized points. */
function convexHull(pts: Pt[]): Pt[] {
  const sorted = [...pts].sort((a, b) => a.nx - b.nx || a.ny - b.ny);
  const cross = (o: Pt, a: Pt, b: Pt) =>
    (a.nx - o.nx) * (b.ny - o.ny) - (a.ny - o.ny) * (b.nx - o.nx);
  const lower: Pt[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0)
      lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0)
      upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** Compute first 7 Hu moments from normalized polygon points. */
function huMoments(pts: Pt[]): number[] {
  const { cx, cy } = centroid(pts);
  const n = pts.length;

  const mu = (p: number, q: number) => {
    let m = 0;
    for (const pt of pts) {
      m += Math.pow(pt.nx - cx, p) * Math.pow(pt.ny - cy, q);
    }
    return m / n;
  };

  const m00 = 1; // normalized
  const m20 = mu(2, 0), m02 = mu(0, 2), m11 = mu(1, 1);
  const m30 = mu(3, 0), m12 = mu(1, 2), m21 = mu(2, 1), m03 = mu(0, 3);

  const n20 = m20 / (m00 * m00);
  const n02 = m02 / (m00 * m00);
  const n11 = m11 / (m00 * m00);
  const n30 = m30 / Math.pow(m00, 2.5);
  const n03 = m03 / Math.pow(m00, 2.5);
  const n21 = m21 / Math.pow(m00, 2.5);
  const n12 = m12 / Math.pow(m00, 2.5);

  const h1 = n20 + n02;
  const h2 = (n20 - n02) ** 2 + 4 * n11 ** 2;
  const h3 = (n30 - 3 * n12) ** 2 + (3 * n21 - n03) ** 2;
  const h4 = (n30 + n12) ** 2 + (n21 + n03) ** 2;
  const h5 = (n30 - 3 * n12) * (n30 + n12) * ((n30 + n12) ** 2 - 3 * (n21 + n03) ** 2)
           + (3 * n21 - n03) * (n21 + n03) * (3 * (n30 + n12) ** 2 - (n21 + n03) ** 2);
  const h6 = (n20 - n02) * ((n30 + n12) ** 2 - (n21 + n03) ** 2)
           + 4 * n11 * (n30 + n12) * (n21 + n03);
  const h7 = (3 * n21 - n03) * (n30 + n12) * ((n30 + n12) ** 2 - 3 * (n21 + n03) ** 2)
           - (n30 - 3 * n12) * (n21 + n03) * (3 * (n30 + n12) ** 2 - (n21 + n03) ** 2);

  // Log-scale to handle large dynamic range
  const logScale = (v: number) => v === 0 ? 0 : Math.sign(v) * Math.log10(Math.abs(v) + 1e-10);
  return [h1, h2, h3, h4, h5, h6, h7].map(logScale);
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function fingerprintArea(area: SvgArea): ShapeFingerprint {
  const pts = area.points; // already normalized
  if (pts.length < 3) {
    return {
      aspectRatio: 1, vertexCount: pts.length, circularity: 0,
      hasArc: false, areaN: (area as any).areaN || 0, huMoments: new Array(7).fill(0), convexity: 1,
    };
  }

  const b = area.bounds;
  const bw = b.maxNX - b.minNX;
  const bh = b.maxNY - b.minNY;
  const aspectRatio = bh > 0 ? bw / bh : 1;

  const simplified  = rdp(pts, 0.003);
  const vertexCount = simplified.length;

  const area2  = polygonArea(pts);
  const perim  = polygonPerimeter(pts);
  const circularity = perim > 0 ? (4 * Math.PI * area2) / (perim * perim) : 0;

  const hasArc = detectArc(pts);

  const hull     = convexHull(pts);
  const hullArea = polygonArea(hull);
  const convexity = hullArea > 0 ? Math.min(1, area2 / hullArea) : 1;

  const hu = huMoments(pts);

  return {
    aspectRatio,
    vertexCount,
    circularity,
    hasArc,
    areaN: (area as any).areaN || 0,
    huMoments: hu,
    convexity,
  };
}

// ─── Distance metric ──────────────────────────────────────────────────────────

/**
 * Weighted distance between two fingerprints.
 * Returns a value in [0, ∞) — lower = more similar.
 * Threshold ~0.15 works well for same-symbol grouping.
 */
export function fingerprintDistance(a: ShapeFingerprint, b: ShapeFingerprint): number {
  const w = {
    aspectRatio:  2.0,
    vertexCount:  1.0,
    circularity:  2.5,
    hasArc:       3.0,
    convexity:    1.5,
    hu:           [1.5, 1.0, 0.5, 0.3], // only first 4 Hu moments
  };

  const dAspect = Math.abs(Math.log(a.aspectRatio + 0.01) - Math.log(b.aspectRatio + 0.01));
  const dVertex = Math.abs(a.vertexCount - b.vertexCount) / Math.max(a.vertexCount, b.vertexCount, 1);
  const dCirc   = Math.abs(a.circularity - b.circularity);
  const dArc    = a.hasArc !== b.hasArc ? 1 : 0;
  const dConvex = Math.abs(a.convexity - b.convexity);

  let dHu = 0;
  for (let i = 0; i < w.hu.length; i++) {
    dHu += w.hu[i] * Math.abs((a.huMoments[i] ?? 0) - (b.huMoments[i] ?? 0));
  }

  return (
    w.aspectRatio * dAspect +
    w.vertexCount * dVertex +
    w.circularity * dCirc   +
    w.hasArc      * dArc    +
    w.convexity   * dConvex +
    dHu
  );
}
