/**
 * useShapeDetector.ts  v2.1  (infinite-loop fix)
 * ─────────────────────────────────────────────────
 * Detects architectural shapes from a live SVG DOM ref.
 *
 * Fixes vs v2.0:
 *  - DEFAULT_SHAPES moved to module level → stable reference across renders,
 *    preventing the scan useCallback from being recreated every render and
 *    triggering the infinite setState → re-render → new dep → re-effect loop.
 *  - MutationObserver debounce timer is now correctly tracked and cancelled
 *    on cleanup (clearTimeout(0) was a no-op before).
 */

import { useState, useEffect, useCallback, useRef } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ShapeLabel =
  | 'text'
  | 'door'
  | 'window'
  | 'toilet'
  | 'sink'
  | 'bathtub'
  | 'stair'
  | 'table'
  | 'chair'
  | 'fixture'
  | 'unknown';

/** Stable module-level array — never recreated on render. */
export const SHAPE_LABELS: ShapeLabel[] = [
  'text', 'door', 'window', 'toilet', 'sink',
  'bathtub', 'stair', 'table', 'chair', 'fixture', 'unknown',
];

export interface BBox {
  x:    number;
  y:    number;
  w:    number;
  h:    number;
  area: number;
}

export interface DetectedRegion {
  id:         string;
  label:      ShapeLabel;
  confidence: number;
  bbox:       BBox;
  pathCount:  number;
  color:      string;
  normX:      number;
  normY:      number;
  normW:      number;
  normH:      number;
}

export interface ShapeDetectorOptions {
  threshold?: number;
  enabled?:   boolean;
  /** Pass a stable reference (module-level const or useMemo) to avoid re-render loops. */
  shapes?:    ShapeLabel[];
  debug?:     boolean;
}

// ─── Geometric fingerprint ────────────────────────────────────────────────────

interface PathFingerprint {
  el:          SVGElement;
  bbox:        DOMRect;
  area:        number;
  aspect:      number;
  hasFill:     boolean;
  fillDark:    boolean;
  fillLight:   boolean;
  hasStroke:   boolean;
  strokeWidth: number;
  curveCount:  number;
  lineCount:   number;
  isClosed:    boolean;
  isRect:      boolean;
  isCircle:    boolean;
  perimeter:   number;
  compactness: number;
  cx:          number;
  cy:          number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const clamp = (v: number) => Math.max(0, Math.min(1, v));

const frac = (cluster: PathFingerprint[], pred: (p: PathFingerprint) => boolean) =>
  cluster.length === 0 ? 0 : cluster.filter(pred).length / cluster.length;

const mean = (vals: number[]) =>
  vals.length === 0 ? 0 : vals.reduce((a, b) => a + b, 0) / vals.length;

// ─── Shape templates ──────────────────────────────────────────────────────────

type ScoreFn = (cluster: PathFingerprint[], bbox: BBox) => number;

interface ShapeTemplate {
  label:    ShapeLabel;
  color:    string;
  minPaths: number;
  maxPaths: number;
  score:    ScoreFn;
}

const TEMPLATES: ShapeTemplate[] = [
  {
    label: 'text', color: '#ff6b6b', minPaths: 3, maxPaths: 400,
    score(cluster, bbox) {
      const smallFilled   = frac(cluster, p => p.hasFill && p.fillDark && p.area < 300);
      const aspect        = clamp(bbox.w / Math.max(bbox.h, 1) / 3);
      const noStroke      = frac(cluster, p => !p.hasStroke || p.strokeWidth < 0.5);
      const curvy         = clamp(mean(cluster.map(p => p.curveCount)) / 4);
      const compactSpread = clamp(
        Math.max(...cluster.map(p => p.compactness)) -
        Math.min(...cluster.map(p => p.compactness))
      );
      return smallFilled * 0.35 + noStroke * 0.20 + curvy * 0.20 + aspect * 0.15 + compactSpread * 0.10;
    },
  },
  {
    label: 'door', color: '#4ecdc4', minPaths: 1, maxPaths: 6,
    score(cluster, bbox) {
      const hasArc   = cluster.some(p => p.curveCount > 0 && p.lineCount === 0);
      const hasLine  = cluster.some(p => p.lineCount > 0 && p.curveCount === 0);
      const smallBox = clamp(1 - bbox.area / 10000);
      const squarish = clamp(1 - Math.abs(bbox.w / Math.max(bbox.h, 1) - 1));
      const noFill   = frac(cluster, p => !p.hasFill || p.fillLight);
      if (!hasArc) return 0;
      return (hasArc ? 0.40 : 0) + (hasLine ? 0.20 : 0) + smallBox * 0.15 + squarish * 0.15 + noFill * 0.10;
    },
  },
  {
    label: 'window', color: '#45b7d1', minPaths: 2, maxPaths: 10,
    score(cluster, bbox) {
      const allLines  = frac(cluster, p => p.lineCount > 0 && p.curveCount === 0);
      const elongated = clamp(Math.max(bbox.w, bbox.h) / Math.max(Math.min(bbox.w, bbox.h), 1) / 5);
      const noFill    = frac(cluster, p => !p.hasFill || p.fillLight);
      const aspects   = cluster.map(p => p.aspect);
      const aspectVar = aspects.length > 1 ? Math.max(...aspects) - Math.min(...aspects) : 0;
      const parallel  = clamp(1 - aspectVar / 2);
      return allLines * 0.35 + elongated * 0.25 + noFill * 0.20 + parallel * 0.20;
    },
  },
  {
    label: 'toilet', color: '#96ceb4', minPaths: 1, maxPaths: 12,
    score(cluster, bbox) {
      const hasOval   = cluster.some(p => p.isCircle || (p.curveCount >= 4 && p.isClosed));
      const squarish  = clamp(1 - Math.abs(bbox.w / Math.max(bbox.h, 1) - 0.8) * 2);
      const mediumBox = clamp(1 - Math.abs(Math.sqrt(bbox.area) - 60) / 60);
      const mixed     = (cluster.some(p => p.curveCount > 0) && cluster.some(p => p.lineCount > 0)) ? 1 : 0;
      const lightFill = frac(cluster, p => p.fillLight || !p.hasFill);
      return (hasOval ? 0.30 : 0) + squarish * 0.25 + mediumBox * 0.20 + mixed * 0.15 + lightFill * 0.10;
    },
  },
  {
    label: 'sink', color: '#ffeaa7', minPaths: 2, maxPaths: 10,
    score(cluster, bbox) {
      const hasRect    = cluster.some(p => p.isRect || (p.lineCount >= 4 && p.curveCount === 0));
      const hasCircles = cluster.filter(p => p.isCircle || (p.curveCount >= 4 && p.area < 200)).length >= 1;
      const aspect     = clamp(1 - Math.abs(bbox.w / Math.max(bbox.h, 1) - 1.2));
      const mediumBox  = clamp(1 - Math.abs(Math.sqrt(bbox.area) - 55) / 55);
      if (!hasRect) return 0;
      return (hasRect ? 0.35 : 0) + (hasCircles ? 0.30 : 0) + aspect * 0.20 + mediumBox * 0.15;
    },
  },
  {
    label: 'bathtub', color: '#dfe6e9', minPaths: 2, maxPaths: 15,
    score(cluster, bbox) {
      const hasLargeRect = cluster.some(p => (p.isRect || p.lineCount >= 3) && p.area > 500);
      const hasOval      = cluster.some(p => p.curveCount >= 4 && p.isClosed);
      const elongated    = clamp(Math.max(bbox.w, bbox.h) / Math.max(Math.min(bbox.w, bbox.h), 1) / 2 - 0.3);
      const largeBox     = clamp(Math.sqrt(bbox.area) / 100);
      return (hasLargeRect ? 0.35 : 0) + (hasOval ? 0.30 : 0) + elongated * 0.20 + largeBox * 0.15;
    },
  },
  {
    label: 'stair', color: '#fd79a8', minPaths: 4, maxPaths: 40,
    score(cluster, bbox) {
      const allLines = frac(cluster, p => p.lineCount > 0 && p.curveCount === 0);
      const cys      = cluster.map(p => p.cy).sort((a, b) => a - b);
      let spacingScore = 0;
      if (cys.length >= 3) {
        const gaps = cys.slice(1).map((v, i) => v - cys[i]);
        const avgG = mean(gaps);
        const varG = mean(gaps.map(g => Math.abs(g - avgG)));
        spacingScore = clamp(1 - varG / Math.max(avgG, 1));
      }
      const manyPaths = clamp(cluster.length / 10);
      const noFill    = frac(cluster, p => !p.hasFill || p.fillLight);
      return allLines * 0.35 + spacingScore * 0.35 + noFill * 0.15 + manyPaths * 0.15;
    },
  },
  {
    label: 'table', color: '#a29bfe', minPaths: 3, maxPaths: 30,
    score(cluster, bbox) {
      const hasRect   = cluster.some(p => p.isRect || (p.lineCount >= 3 && p.area > 200));
      const arcCount  = cluster.filter(p => p.curveCount > 0 && !p.isClosed && p.area < 500).length;
      const hasChairs = arcCount >= 2;
      const mediumBox = clamp(1 - Math.abs(Math.sqrt(bbox.area) - 120) / 120);
      return (hasRect ? 0.35 : 0) + (hasChairs ? 0.35 : 0) + mediumBox * 0.30;
    },
  },
  {
    label: 'chair', color: '#fdcb6e', minPaths: 1, maxPaths: 5,
    score(cluster, bbox) {
      const hasArc   = cluster.some(p => p.curveCount > 0);
      const smallBox = clamp(1 - Math.sqrt(bbox.area) / 80);
      const squarish = clamp(1 - Math.abs(bbox.w / Math.max(bbox.h, 1) - 1));
      const noFill   = frac(cluster, p => !p.hasFill || p.fillLight);
      if (!hasArc) return 0;
      return (hasArc ? 0.40 : 0) + smallBox * 0.30 + squarish * 0.20 + noFill * 0.10;
    },
  },
  {
    label: 'fixture', color: '#b2bec3', minPaths: 3, maxPaths: 50,
    score(cluster, bbox) {
      const curveHeavy = frac(cluster, p => p.curveCount > 2);
      const dense      = clamp(cluster.length / Math.max(bbox.area / 100, 1));
      const smallBox   = clamp(1 - Math.sqrt(bbox.area) / 200);
      return curveHeavy * 0.50 + dense * 0.30 + smallBox * 0.20;
    },
  },
];

/**
 * Module-level stable default — fixes the infinite re-render loop.
 * If this were inside the hook as `TEMPLATES.map(t => t.label)`, it would
 * produce a new array reference on every render, causing scan's useCallback
 * deps to change, which re-runs the useEffect, which calls setRegions, which
 * triggers another render — infinitely.
 */
const DEFAULT_SHAPES: ShapeLabel[] = TEMPLATES.map(t => t.label);

// ─── Fingerprint extractor ────────────────────────────────────────────────────

function parseCssColor(css: string): [number, number, number] | null {
  try {
    const m = css.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (m) return [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])];
    if (css.startsWith('#')) {
      const hex  = css.replace('#', '');
      const full = hex.length === 3
        ? hex.split('').map(c => c + c).join('')
        : hex;
      return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
    }
    if (css === 'black' || css === '#000' || css === '#000000') return [0, 0, 0];
    if (css === 'white' || css === '#fff' || css === '#ffffff') return [255, 255, 255];
  } catch (_) { /* ignore */ }
  return null;
}

function fingerprintElement(el: SVGElement): PathFingerprint | null {
  try {
    const bbox = (el as SVGGraphicsElement).getBBox?.();
    if (!bbox || bbox.width < 0.5 || bbox.height < 0.5) return null;

    const style       = window.getComputedStyle(el);
    const fill        = style.fill        || el.getAttribute('fill')         || 'none';
    const stroke      = style.stroke      || el.getAttribute('stroke')       || 'none';
    const swStr       = style.strokeWidth || el.getAttribute('stroke-width') || '0';
    const strokeWidth = parseFloat(swStr) || 0;

    const hasFill   = fill   !== 'none' && fill   !== '' && fill   !== 'transparent';
    const hasStroke = stroke !== 'none' && stroke !== '' && stroke !== 'transparent' && strokeWidth > 0.1;

    let fillDark = false, fillLight = false;
    if (hasFill) {
      const rgb = parseCssColor(fill);
      if (rgb) {
        const lum = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
        fillDark  = lum < 80;
        fillLight = lum > 180;
      }
    }

    const d          = el.getAttribute('d') || '';
    const curveCount = (d.match(/[Cc]/g) || []).length;
    const lineCount  = (d.match(/[LlHhVv]/g) || []).length;
    const isClosed   = /[Zz]\s*$/.test(d.trim());

    const tagName  = el.tagName.toLowerCase();
    const isRect   = tagName === 'rect' || (lineCount >= 3 && curveCount === 0 && isClosed);
    const isCircle = tagName === 'circle' || tagName === 'ellipse' ||
                     (curveCount >= 4 && lineCount === 0 && isClosed);

    const area        = bbox.width * bbox.height;
    const aspect      = bbox.width / Math.max(bbox.height, 0.1);
    const perimeter   = 2 * (bbox.width + bbox.height);
    const compactness = perimeter > 0
      ? clamp((4 * Math.PI * area) / (perimeter * perimeter))
      : 0;

    return {
      el, bbox, area, aspect,
      hasFill, fillDark, fillLight,
      hasStroke, strokeWidth,
      curveCount, lineCount, isClosed, isRect, isCircle,
      perimeter, compactness,
      cx: bbox.x + bbox.width  / 2,
      cy: bbox.y + bbox.height / 2,
    };
  } catch (_) {
    return null;
  }
}

// ─── Clustering ───────────────────────────────────────────────────────────────

function clusterByProximity(prints: PathFingerprint[], maxDist: number): PathFingerprint[][] {
  const used     = new Array(prints.length).fill(false);
  const clusters: PathFingerprint[][] = [];

  for (let i = 0; i < prints.length; i++) {
    if (used[i]) continue;
    const cluster = [prints[i]];
    used[i] = true;
    let added = true;
    while (added) {
      added = false;
      for (let j = 0; j < prints.length; j++) {
        if (used[j]) continue;
        const inRange = cluster.some(p => {
          const dx = p.cx - prints[j].cx;
          const dy = p.cy - prints[j].cy;
          return Math.sqrt(dx * dx + dy * dy) < maxDist;
        });
        if (inRange) { cluster.push(prints[j]); used[j] = true; added = true; }
      }
    }
    clusters.push(cluster);
  }
  return clusters;
}

function clusterBBox(cluster: PathFingerprint[]): BBox {
  const x0 = Math.min(...cluster.map(p => p.bbox.x));
  const y0 = Math.min(...cluster.map(p => p.bbox.y));
  const x1 = Math.max(...cluster.map(p => p.bbox.x + p.bbox.width));
  const y1 = Math.max(...cluster.map(p => p.bbox.y + p.bbox.height));
  const w  = x1 - x0, h = y1 - y0;
  return { x: x0, y: y0, w, h, area: w * h };
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useShapeDetector(
  svgRef:  React.RefObject<SVGSVGElement | null>,
  options: ShapeDetectorOptions = {},
) {
  const {
    threshold = 0.72,
    enabled   = true,
    shapes    = DEFAULT_SHAPES,   // ← stable module-level ref, no new array each render
    debug     = false,
  } = options;

  const [regions,    setRegions]    = useState<DetectedRegion[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const scanIdRef = useRef(0);

  const scan = useCallback(async () => {
    const svg = svgRef.current;
    if (!svg || !enabled) { setRegions([]); return; }

    setIsScanning(true);
    const scanId = ++scanIdRef.current;

    await new Promise<void>(r => setTimeout(r, 0));
    if (scanId !== scanIdRef.current) return;

    const vb   = svg.viewBox?.baseVal;
    const svgW = (vb && vb.width  > 0) ? vb.width  : svg.clientWidth  || 800;
    const svgH = (vb && vb.height > 0) ? vb.height : svg.clientHeight || 600;

    const els = Array.from(
      svg.querySelectorAll('path, rect, circle, ellipse, line, polyline, polygon')
    ) as SVGElement[];

    const prints: PathFingerprint[] = [];
    for (const el of els) {
      const fp = fingerprintElement(el);
      if (fp) prints.push(fp);
    }

    if (debug) console.log(`[ShapeDetector] ${prints.length} elements fingerprinted`);

    const clusters        = clusterByProximity(prints, 80);
    const activeTemplates = TEMPLATES.filter(t => shapes.includes(t.label));
    const detected: DetectedRegion[] = [];

    for (const cluster of clusters) {
      if (cluster.length === 0) continue;
      const bbox = clusterBBox(cluster);
      let bestScore = 0, bestTemplate: ShapeTemplate | null = null;

      for (const tmpl of activeTemplates) {
        if (cluster.length < tmpl.minPaths || cluster.length > tmpl.maxPaths) continue;
        const score = tmpl.score(cluster, bbox);
        if (debug && score > 0.4) console.log(`[ShapeDetector] ${tmpl.label}: ${(score * 100).toFixed(1)}%`, bbox);
        if (score > bestScore) { bestScore = score; bestTemplate = tmpl; }
      }

      if (bestScore >= threshold && bestTemplate) {
        detected.push({
          id:         `${bestTemplate.label}-${detected.length}`,
          label:      bestTemplate.label,
          confidence: bestScore,
          bbox,
          pathCount:  cluster.length,
          color:      bestTemplate.color,
          normX:      bbox.x / svgW,
          normY:      bbox.y / svgH,
          normW:      bbox.w / svgW,
          normH:      bbox.h / svgH,
        });
      }
    }

    if (scanId !== scanIdRef.current) return;
    detected.sort((a, b) => b.confidence - a.confidence);
    setRegions(detected);
    setIsScanning(false);
    if (debug) console.log(`[ShapeDetector] ${detected.length} regions detected`);
  }, [svgRef, enabled, threshold, shapes, debug]);

  useEffect(() => {
    if (!enabled) { setRegions([]); return; }
    const svg = svgRef.current;
    if (!svg) return;

    // Track debounce timer so it can be properly cancelled —
    // the original clearTimeout(0) was a no-op and leaked the timer.
    let debounce: ReturnType<typeof setTimeout>;

    const runScan = () => {
      clearTimeout(debounce);
      debounce = setTimeout(scan, 400);
    };

    runScan(); // initial scan on mount / when deps change

    const observer = new MutationObserver(runScan);
    observer.observe(svg, { childList: true, subtree: false });

    return () => {
      clearTimeout(debounce);
      observer.disconnect();
    };
  }, [svgRef, scan, enabled]);

  return { regions, isScanning, rescan: scan };
}