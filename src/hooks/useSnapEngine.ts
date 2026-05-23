// ─── hooks/useSnapEngine/useSnapEngine.tsx ────────────────────────────────────
//
// PERF FIXES vs previous version:
//
//  FIX A — getSvgPointCandidates result cached in a ref (candidatesCacheRef).
//           Previously it allocated a fresh array on every _actualRedraw call
//           (every pointer-move frame). Now rebuilt only when svgSnapPoints
//           prop changes.
//
//  FIX B — Spatial grid index (buildGrid / queryGrid) replaces the O(n) linear
//           scan over all candidates on every frame. Grid cells are sized to
//           2× the proximity radius so a lookup touches at most 9 cells
//           regardless of total candidate count.
//
//  FIX C — Early-exit when cursor is null: bezier curve loop, line loop, and
//           candidate loop are all skipped when there is no cursor. Previously
//           the full O(n) pass ran even with no cursor (e.g. right after zoom
//           ends before the user moves the mouse).
//
//  Everything else (visual style, snap logic, rAF throttle, zoom-pause) is
//  identical to the previous version.

import { useRef, useState, useCallback, useEffect } from 'react';
import type { SvgSnapPoint, SvgCurve } from '@/hooks/useSvgSnapPoints';
import type { SvgLine, SvgArea } from '@/hooks/useSvgInteraction';

type PdfDimensions        = { w: number; h: number };
type ExtractionResult     = any;
type PageExtractionState  = any;
type SnapFlash            = { x: number; y: number; id: number };
type SnapResult           = { point: { x: number; y: number }; snapped: boolean };

// ── Geometry helpers ──────────────────────────────────────────────────────────

function closestPointOnSegment(
  px: number, py: number,
  x1: number, y1: number,
  x2: number, y2: number,
): { x: number; y: number; t: number } {
  const ax = px - x1, ay = py - y1;
  const bx = x2 - x1, by = y2 - y1;
  const dot  = ax * bx + ay * by;
  const len2 = bx * bx + by * by;
  if (len2 === 0) return { x: x1, y: y1, t: 0 };
  const t = Math.max(0, Math.min(1, dot / len2));
  return { x: x1 + t * bx, y: y1 + t * by, t };
}

function closestPointOnPolygonEdge(
  x: number, y: number,
  points: Array<{ x: number; y: number }>,
): { x: number; y: number; dist: number } {
  let best = { x, y, dist: Infinity };
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    const c = closestPointOnSegment(x, y, points[i].x, points[i].y, points[j].x, points[j].y);
    const d = Math.hypot(c.x - x, c.y - y);
    if (d < best.dist) best = { x: c.x, y: c.y, dist: d };
  }
  return best;
}

function shapeIdIncludes(shapeId: string | undefined | null, term: string): boolean {
  return (shapeId ?? '').toLowerCase().includes(term);
}

// ── Bezier sampling ───────────────────────────────────────────────────────────

function cubicAt(t: number, p0x: number, p0y: number, p1x: number, p1y: number,
  p2x: number, p2y: number, p3x: number, p3y: number) {
  const u = 1 - t;
  return {
    x: u*u*u*p0x + 3*u*u*t*p1x + 3*u*t*t*p2x + t*t*t*p3x,
    y: u*u*u*p0y + 3*u*u*t*p1y + 3*u*t*t*p2y + t*t*t*p3y,
  };
}

function quadAt(t: number, p0x: number, p0y: number, p1x: number, p1y: number,
  p2x: number, p2y: number) {
  const u = 1 - t;
  return {
    x: u*u*p0x + 2*u*t*p1x + t*t*p2x,
    y: u*u*p0y + 2*u*t*p1y + t*t*p2y,
  };
}

export type { ExtractionResult, PageExtractionState, SnapFlash, SnapResult, PdfDimensions };

export interface LinearChainPoint {
  x: number; y: number; type: string; label?: string;
}

// ── Snap point colours ────────────────────────────────────────────────────────

const SVG_SNAP_COLOURS: Record<string, { dot: string; ring: string; fill: string }> = {
  endpoint:     { dot: 'rgba(245,158,11,0.85)',  ring: 'rgba(245,158,11,0.5)',  fill: '#f59e0b' },
  midpoint:     { dot: 'rgba(16,185,129,0.85)',  ring: 'rgba(16,185,129,0.5)',  fill: '#10b981' },
  centroid:     { dot: 'rgba(139,92,246,0.85)',  ring: 'rgba(139,92,246,0.5)',  fill: '#8b5cf6' },
  intersection: { dot: 'rgba(244,63,94,0.85)',   ring: 'rgba(244,63,94,0.5)',   fill: '#f43f5e' },
  'arc-center': { dot: 'rgba(34,211,238,0.90)',  ring: 'rgba(34,211,238,0.45)', fill: '#22d3ee' },
};

const SNAP_PRIORITY: Record<string, number> = {
  endpoint: 0, intersection: 1, midpoint: 2, centroid: 3,
};

const SNAP_SIZE: Record<string, number> = {
  intersection: 1.0, endpoint: 1.0, midpoint: 0.85, centroid: 0.85,
};

const LINE_COLOUR  = { base: 'rgba(56,189,248,{a})',   fill: '#38bdf8' };
const CURVE_COLOUR = { base: 'rgba(56,189,248,{a})',   fill: '#38bdf8' };
const AREA_COLOUR  = { stroke: 'rgba(251,146,60,{a})', fill: '#fb923c' };

function withAlpha(template: string, a: number): string {
  return template.replace('{a}', a.toFixed(2));
}

// ── FIX B: Spatial grid index ─────────────────────────────────────────────────
//
// Divides PDF-pixel space into cells of size `cellSize`.
// buildGrid  — O(n) to build, called only when candidates change.
// queryGrid  — O(1) to query, returns only candidates in the 3×3 neighbourhood
//              of the cursor cell. Eliminates the O(n) linear scan per frame.

interface Candidate {
  x: number; y: number;
  type: string;
  strokeWidth?: number;
  shapeId?: string;
}

interface SpatialGrid {
  cells:    Map<string, Candidate[]>;
  cellSize: number;
}

function buildGrid(candidates: Candidate[], cellSize: number): SpatialGrid {
  const cells = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const key = `${Math.floor(c.x / cellSize)},${Math.floor(c.y / cellSize)}`;
    let bucket = cells.get(key);
    if (!bucket) { bucket = []; cells.set(key, bucket); }
    bucket.push(c);
  }
  return { cells, cellSize };
}

function queryGrid(
  grid:   SpatialGrid,
  x:      number,
  y:      number,
  radius: number,
): Candidate[] {
  const { cells, cellSize } = grid;
  const r   = Math.ceil(radius / cellSize);
  const cx  = Math.floor(x / cellSize);
  const cy  = Math.floor(y / cellSize);
  const out: Candidate[] = [];
  for (let dx = -r; dx <= r; dx++) {
    for (let dy = -r; dy <= r; dy++) {
      const bucket = cells.get(`${cx + dx},${cy + dy}`);
      if (bucket) out.push(...bucket);
    }
  }
  return out;
}

// ── Hook params / return ──────────────────────────────────────────────────────

export interface UseSnapEngineParams {
  pinCanvasRef:     React.RefObject<HTMLCanvasElement | null>;
  pdfDimensionsRef: React.MutableRefObject<PdfDimensions | null>;
  pageNumberRef:    React.MutableRefObject<number>;
  scaleRef?:        React.MutableRefObject<number>;
  snapEnabled:      boolean;
  showPins:         boolean;
  snapThreshold:    number;
  confidenceFilter: number;
  svgSnapPoints?:   SvgSnapPoint[];
  svgLines?:        SvgLine[];
  svgAreas?:        SvgArea[];
  svgCurves?:       SvgCurve[];
  isZooming?:       boolean;
  activeTool?:      string;
  viewportRef:      React.RefObject<HTMLDivElement | null>;
  zoom:             number;
  pan:              { x: number; y: number };
  proximityRadius?: number;
}

export interface UseSnapEngineReturn {
  pageData:             Map<number, PageExtractionState>;
  analysisStatus:       'idle' | 'analyzing' | 'done';
  analysisPage:         { current: number; total: number } | null;
  snapFlashes:          SnapFlash[];
  startExtraction:      (pdf: any, file?: File) => void;
  getScaledCorners:     (pageIdx: number) => Array<{ x: number; y: number; confidence: number }>;
  getScaledWallCorners: (pageIdx: number) => Array<{ x: number; y: number; confidence: number; lineIndices: number[] }>;
  getScaledWallLines:   (pageIdx: number) => Array<{ x1: number; y1: number; x2: number; y2: number; angle: number; length: number }>;
  snapToCorner:         (rawX: number, rawY: number) => SnapResult;
  triggerSnapFlash:     (x: number, y: number) => void;
  redrawPinCanvas:      () => void;
  cursorPointRef:       React.MutableRefObject<{ x: number; y: number } | null>;
  linearChain:          LinearChainPoint[];
  addChainPoint:        (x: number, y: number, type: string) => void;
  undoChainPoint:       () => void;
  clearChain:           () => void;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useSnapEngine({
  pinCanvasRef,
  pdfDimensionsRef,
  pageNumberRef,
  scaleRef,
  snapEnabled,
  showPins,
  snapThreshold,
  confidenceFilter,
  svgSnapPoints = [],
  svgLines      = [],
  svgAreas      = [],
  svgCurves     = [],
  isZooming     = false,
  activeTool    = 'linear',
  viewportRef,
  zoom,
  pan,
  proximityRadius = 80,
}: UseSnapEngineParams): UseSnapEngineReturn {

  const snapEnabledRef    = useRef(snapEnabled);
  const showPinsRef       = useRef(showPins);
  const snapThresholdRef  = useRef(snapThreshold);
  const svgSnapPointsRef  = useRef<SvgSnapPoint[]>(svgSnapPoints);
  const svgLinesRef       = useRef<SvgLine[]>(svgLines);
  const svgAreasRef       = useRef<SvgArea[]>(svgAreas);
  const svgCurvesRef      = useRef<SvgCurve[]>(svgCurves);
  const isZoomingRef      = useRef(isZooming);
  const activeToolRef     = useRef(activeTool);
  const zoomRef           = useRef(zoom);
  const panRef            = useRef(pan);
  const proximityRef      = useRef(proximityRadius);

  useEffect(() => { snapEnabledRef.current   = snapEnabled;      }, [snapEnabled]);
  useEffect(() => { showPinsRef.current      = showPins;         }, [showPins]);
  useEffect(() => { snapThresholdRef.current = snapThreshold;    }, [snapThreshold]);
  useEffect(() => { svgSnapPointsRef.current = svgSnapPoints;    }, [svgSnapPoints]);
  useEffect(() => { svgLinesRef.current      = svgLines;         }, [svgLines]);
  useEffect(() => { svgAreasRef.current      = svgAreas;         }, [svgAreas]);
  useEffect(() => { svgCurvesRef.current     = svgCurves;        }, [svgCurves]);
  useEffect(() => { isZoomingRef.current     = isZooming;        }, [isZooming]);
  useEffect(() => { activeToolRef.current    = activeTool;       }, [activeTool]);
  useEffect(() => { zoomRef.current          = zoom;             }, [zoom]);
  useEffect(() => { panRef.current           = pan;              }, [pan]);
  useEffect(() => { proximityRef.current     = proximityRadius;  }, [proximityRadius]);

  // ── FIX A: candidate cache + FIX B: spatial grid ─────────────────────────
  // Rebuilt only when svgSnapPoints changes, not on every redraw frame.
  const candidatesCacheRef = useRef<Candidate[]>([]);
  const spatialGridRef     = useRef<SpatialGrid | null>(null);

  useEffect(() => {
    const dims = pdfDimensionsRef.current;
    if (!dims) {
      candidatesCacheRef.current = [];
      spatialGridRef.current     = null;
      return;
    }
    const candidates = svgSnapPoints.map(p => ({
      x: p.nx * dims.w, y: p.ny * dims.h,
      type: p.type, strokeWidth: p.strokeWidth, shapeId: p.shapeId,
    }));
    candidatesCacheRef.current = candidates;
    // Cell size = proximity radius so each query touches at most 3×3 = 9 cells
    spatialGridRef.current = buildGrid(candidates, proximityRadius);
  }, [svgSnapPoints, proximityRadius, pdfDimensionsRef]);

  // Also rebuild grid when pdfDimensions first becomes available
  useEffect(() => {
    const dims = pdfDimensionsRef.current;
    if (!dims || svgSnapPoints.length === 0) return;
    const candidates = svgSnapPoints.map(p => ({
      x: p.nx * dims.w, y: p.ny * dims.h,
      type: p.type, strokeWidth: p.strokeWidth, shapeId: p.shapeId,
    }));
    candidatesCacheRef.current = candidates;
    spatialGridRef.current = buildGrid(candidates, proximityRadius);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [pageData]       = useState<Map<number, PageExtractionState>>(new Map());
  const [analysisStatus] = useState<'idle' | 'analyzing' | 'done'>('done');
  const [analysisPage]   = useState<{ current: number; total: number } | null>(null);
  const [snapFlashes, setSnapFlashes] = useState<SnapFlash[]>([]);
  const [linearChain, setLinearChain] = useState<LinearChainPoint[]>([]);

  const cursorPointRef  = useRef<{ x: number; y: number } | null>(null);
  const flashIdRef      = useRef(0);
  const rafRef          = useRef<number | null>(null);
  const zoomEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const zoomClearedRef  = useRef(false);

  const startExtraction      = useCallback(() => {}, []);
  const getScaledCorners     = useCallback(() => [], []);
  const getScaledWallCorners = useCallback(() => [], []);
  const getScaledWallLines   = useCallback(() => [], []);

  const addChainPoint  = useCallback((x: number, y: number, type: string) => {
    setLinearChain(prev => [...prev, { x, y, type }]);
  }, []);
  const undoChainPoint = useCallback(() => setLinearChain(prev => prev.slice(0, -1)), []);
  const clearChain     = useCallback(() => setLinearChain([]), []);

  // ── getSvgPointCandidates now returns the cached array (O(1)) ─────────────
  const getSvgPointCandidates = useCallback(() => {
    return candidatesCacheRef.current;
  }, []);

  const getAreaPixelBounds = useCallback((area: SvgArea, dims: PdfDimensions) => ({
    minX: area.bounds.minNX * dims.w, minY: area.bounds.minNY * dims.h,
    maxX: area.bounds.maxNX * dims.w, maxY: area.bounds.maxNY * dims.h,
  }), []);

  const getAreaPixelPoints = useCallback((area: SvgArea, dims: PdfDimensions) =>
    area.points.map(p => ({ x: p.nx * dims.w, y: p.ny * dims.h })), []);

  const getLinePixels = useCallback((line: SvgLine, dims: PdfDimensions) => ({
    x1: line.nx1 * dims.w, y1: line.ny1 * dims.h,
    x2: line.nx2 * dims.w, y2: line.ny2 * dims.h,
  }), []);

  // ── snapToCorner — uses cached candidates (O(1) array access) ────────────
  const snapToCorner = useCallback((rawX: number, rawY: number): SnapResult => {
    if (!snapEnabledRef.current || !pdfDimensionsRef.current)
      return { point: { x: rawX, y: rawY }, snapped: false };

    const dims   = pdfDimensionsRef.current;
    const thresh = snapThresholdRef.current;
    let bestPoint: { x: number; y: number } | null = null;
    let bestDist = thresh;

    // FIX B: use spatial grid for O(1) candidate lookup
    const nearby = spatialGridRef.current
      ? queryGrid(spatialGridRef.current, rawX, rawY, thresh)
      : candidatesCacheRef.current;

    for (const c of nearby) {
      if (shapeIdIncludes(c.shapeId, 'door') || shapeIdIncludes(c.shapeId, 'swing')) continue;
      const dist = Math.hypot(rawX - c.x, rawY - c.y);
      if (dist < bestDist) { bestDist = dist; bestPoint = { x: c.x, y: c.y }; }
    }

    if (!bestPoint) {
      for (const line of svgLinesRef.current) {
        if (shapeIdIncludes((line as any).shapeId, 'door')) continue;
        const { x1, y1, x2, y2 } = getLinePixels(line, dims);
        const cp   = closestPointOnSegment(rawX, rawY, x1, y1, x2, y2);
        const dist = Math.hypot(rawX - cp.x, rawY - cp.y);
        if (dist < bestDist) { bestDist = dist; bestPoint = { x: cp.x, y: cp.y }; }
      }
    }

    if (!bestPoint) {
      for (const area of svgAreasRef.current) {
        if (area.label === 'door' || area.isDoor) continue;
        const b = getAreaPixelBounds(area, dims);
        if (rawX < b.minX - thresh || rawX > b.maxX + thresh ||
            rawY < b.minY - thresh || rawY > b.maxY + thresh) continue;
        const pts    = getAreaPixelPoints(area, dims);
        const onEdge = closestPointOnPolygonEdge(rawX, rawY, pts);
        if (onEdge.dist < bestDist) {
          bestDist  = onEdge.dist;
          bestPoint = { x: onEdge.x, y: onEdge.y };
        }
      }
    }

    return bestPoint
      ? { point: bestPoint, snapped: true }
      : { point: { x: rawX, y: rawY }, snapped: false };
  }, [getSvgPointCandidates, getAreaPixelBounds, getAreaPixelPoints, getLinePixels]);

  const triggerSnapFlash = useCallback((x: number, y: number) => {
    const id = ++flashIdRef.current;
    setSnapFlashes(prev => [...prev, { x, y, id }]);
    setTimeout(() => setSnapFlashes(prev => prev.filter(f => f.id !== id)), 700);
  }, []);

  // ── _actualRedraw ─────────────────────────────────────────────────────────
  const _actualRedraw = useCallback(() => {
    const canvas = pinCanvasRef.current;
    const vp     = viewportRef?.current;
    const dims   = pdfDimensionsRef.current;
    if (!canvas || !dims) return;

    const dpr  = window.devicePixelRatio || 1;
    const vpW  = vp ? vp.clientWidth  : canvas.clientWidth  || canvas.width;
    const vpH  = vp ? vp.clientHeight : canvas.clientHeight || canvas.height;
    const tgtW = Math.round(vpW * dpr);
    const tgtH = Math.round(vpH * dpr);

    if (canvas.width !== tgtW || canvas.height !== tgtH) {
      canvas.width        = tgtW;
      canvas.height       = tgtH;
      canvas.style.width  = `${vpW}px`;
      canvas.style.height = `${vpH}px`;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const tool = activeToolRef.current;
    if (!showPinsRef.current || tool === 'select') return;

    const currentZoom = zoomRef.current;
    const currentPan  = panRef.current;
    const prox        = proximityRef.current;

    const pdfToCanvas = (x: number, y: number) => ({
      x: (x * currentZoom + currentPan.x) * dpr,
      y: (y * currentZoom + currentPan.y) * dpr,
    });

    const cursorPdf = cursorPointRef.current;

    // FIX C: early-exit when no cursor — skip ALL O(n) loops
    if (!cursorPdf) return;

    const cursorVP = {
      x: cursorPdf.x * currentZoom + currentPan.x,
      y: cursorPdf.y * currentZoom + currentPan.y,
    };

    const thresh = snapThresholdRef.current;

    // ── 1. Bezier curves ──────────────────────────────────────────────────
    for (const curve of svgCurvesRef.current) {
      const p0 = pdfToCanvas(curve.nx1   * dims.w, curve.ny1   * dims.h);
      const p1 = pdfToCanvas(curve.ncp1x * dims.w, curve.ncp1y * dims.h);
      const p3 = pdfToCanvas(curve.nx2   * dims.w, curve.ny2   * dims.h);
      const p2 = (curve.type === 'cubic' && curve.ncp2x !== undefined)
        ? pdfToCanvas(curve.ncp2x * dims.w, curve.ncp2y! * dims.h) : null;

      let minDist = Infinity;
      const STEPS = 24;
      for (let i = 0; i <= STEPS; i++) {
        const t  = i / STEPS;
        const pt = curve.type === 'cubic' && p2
          ? cubicAt(t, p0.x, p0.y, p1.x, p1.y, p2.x, p2.y, p3.x, p3.y)
          : quadAt(t,  p0.x, p0.y, p1.x, p1.y,              p3.x, p3.y);
        const d = Math.hypot(cursorVP.x * dpr - pt.x, cursorVP.y * dpr - pt.y) / dpr;
        if (d < minDist) minDist = d;
      }
      if (minDist > prox) continue;

      const fade  = Math.max(0, 1 - minDist / prox);
      const alpha = 0.10 + fade * 0.60;

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      if (curve.type === 'cubic' && p2) ctx.bezierCurveTo(p1.x, p1.y, p2.x, p2.y, p3.x, p3.y);
      else                               ctx.quadraticCurveTo(p1.x, p1.y, p3.x, p3.y);
      ctx.strokeStyle = withAlpha(CURVE_COLOUR.base, alpha);
      ctx.lineWidth   = (0.5 + fade * 1.5) * dpr;
      ctx.stroke();
      ctx.restore();
    }

    // ── 2. SVG straight lines ─────────────────────────────────────────────
    const eligibleLines = svgLinesRef.current.filter(line =>
      !shapeIdIncludes((line as any).shapeId, 'door') &&
      !shapeIdIncludes((line as any).shapeId, 'swing')
    );

    let nearestLine:    typeof eligibleLines[0] | null = null;
    let nearestLineDist = prox;
    let nearestLineSnap = { x: 0, y: 0 };

    for (const line of eligibleLines) {
      const pp = getLinePixels(line, dims);
      const c1 = pdfToCanvas(pp.x1, pp.y1);
      const c2 = pdfToCanvas(pp.x2, pp.y2);
      const cp = closestPointOnSegment(
        cursorVP.x * dpr, cursorVP.y * dpr,
        c1.x, c1.y, c2.x, c2.y,
      );
      const dist = Math.hypot(cursorVP.x * dpr - cp.x, cursorVP.y * dpr - cp.y) / dpr;
      if (dist < nearestLineDist) {
        nearestLineDist = dist;
        nearestLine     = line;
        nearestLineSnap = { x: cp.x, y: cp.y };
      }
    }

    for (const line of eligibleLines) {
      const pp = getLinePixels(line, dims);
      const c1 = pdfToCanvas(pp.x1, pp.y1);
      const c2 = pdfToCanvas(pp.x2, pp.y2);
      const cp = closestPointOnSegment(
        cursorVP.x * dpr, cursorVP.y * dpr,
        c1.x, c1.y, c2.x, c2.y,
      );
      const dist = Math.hypot(cursorVP.x * dpr - cp.x, cursorVP.y * dpr - cp.y) / dpr;
      if (dist >= prox) continue;

      const isNearest  = line === nearestLine;
      const isSnapping = isNearest && dist < thresh;
      const rawAlpha   = 1 - dist / prox;
      const lineAlpha  = isNearest ? rawAlpha : rawAlpha * 0.25;
      const lineWidth  = isSnapping ? 2.0 : isNearest ? 1.2 : 0.6;

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(c1.x, c1.y);
      ctx.lineTo(c2.x, c2.y);
      ctx.strokeStyle = withAlpha(LINE_COLOUR.base, lineAlpha);
      ctx.lineWidth   = lineWidth * dpr;
      if (!isSnapping && isNearest) ctx.setLineDash([6 * dpr, 4 * dpr]);
      ctx.stroke();
      ctx.setLineDash([]);

      if (isSnapping) {
        ctx.beginPath();
        ctx.arc(nearestLineSnap.x, nearestLineSnap.y, 5 * dpr, 0, Math.PI * 2);
        ctx.fillStyle   = LINE_COLOUR.fill;
        ctx.fill();
        ctx.strokeStyle = 'white';
        ctx.lineWidth   = 1.5 * dpr;
        ctx.stroke();
      }
      ctx.restore();
    }

    // ── 3. Area outlines ──────────────────────────────────────────────────
    for (const area of svgAreasRef.current) {
      if (area.points.length < 3) continue;
      if (area.label === 'door' || area.isDoor) continue;

      const pts = area.points.map(p => pdfToCanvas(p.nx * dims.w, p.ny * dims.h));

      let distEdge = Infinity;
      let snapPt   = pts[0];
      for (let i = 0; i < pts.length; i++) {
        const j  = (i + 1) % pts.length;
        const cp = closestPointOnSegment(
          cursorVP.x * dpr, cursorVP.y * dpr,
          pts[i].x, pts[i].y, pts[j].x, pts[j].y,
        );
        const d = Math.hypot(cursorVP.x * dpr - cp.x, cursorVP.y * dpr - cp.y) / dpr;
        if (d < distEdge) { distEdge = d; snapPt = cp; }
      }
      if (distEdge > prox * 2) continue;

      const isSnapping = distEdge < thresh;
      const fade       = Math.max(0, 1 - distEdge / (prox * 2));
      const alpha      = isSnapping ? 0.90 : 0.15 + fade * 0.55;

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      pts.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
      ctx.closePath();
      ctx.strokeStyle = withAlpha(AREA_COLOUR.stroke, alpha);
      ctx.lineWidth   = (isSnapping ? 2.0 : 0.5 + fade * 1.5) * dpr;
      ctx.stroke();

      if (isSnapping) {
        ctx.beginPath();
        ctx.arc(snapPt.x, snapPt.y, 5 * dpr, 0, Math.PI * 2);
        ctx.fillStyle   = AREA_COLOUR.fill;
        ctx.fill();
        ctx.strokeStyle = 'white';
        ctx.lineWidth   = 1.5 * dpr;
        ctx.stroke();
      }
      ctx.restore();
    }

    // ── 4. Snap points — FIX B: grid query instead of O(n) linear scan ────
    const eligibleCandidates = spatialGridRef.current
      ? queryGrid(spatialGridRef.current, cursorPdf.x, cursorPdf.y, prox)
          .filter(c =>
            !shapeIdIncludes(c.shapeId, 'door') &&
            !shapeIdIncludes(c.shapeId, 'swing')
          )
      : candidatesCacheRef.current.filter(c =>
          !shapeIdIncludes(c.shapeId, 'door') &&
          !shapeIdIncludes(c.shapeId, 'swing')
        );

    let nearestCandidate:    typeof eligibleCandidates[0] | null = null;
    let nearestCandidateDist = Infinity;

    for (const c of eligibleCandidates) {
      const cp   = pdfToCanvas(c.x, c.y);
      const dist = Math.hypot(cursorVP.x - cp.x / dpr, cursorVP.y - cp.y / dpr);
      if (dist > prox) continue;
      const pri      = SNAP_PRIORITY[c.type] ?? 99;
      const nearPri  = nearestCandidate ? (SNAP_PRIORITY[nearestCandidate.type] ?? 99) : 99;
      const tooClose = nearestCandidate !== null && Math.abs(dist - nearestCandidateDist) < 4;
      if (
        nearestCandidate === null ||
        (tooClose && pri < nearPri) ||
        (!tooClose && dist < nearestCandidateDist)
      ) {
        nearestCandidateDist = dist;
        nearestCandidate     = c;
      }
    }

    // ── 4b. Draw nearest candidate only ──────────────────────────────────
    if (nearestCandidate) {
      const c       = nearestCandidate;
      const col     = SVG_SNAP_COLOURS[c.type] ?? SVG_SNAP_COLOURS['endpoint'];
      const sizeMul = SNAP_SIZE[c.type] ?? 1.0;
      const dist    = nearestCandidateDist;
      const isSnap  = dist < thresh;
      const fade    = Math.max(0, 1 - dist / prox);

      const cp = pdfToCanvas(c.x, c.y);

      ctx.save();

      if (isSnap) {
        const r  = 7 * dpr * sizeMul;
        const ch = 11 * dpr;

        ctx.beginPath();
        ctx.arc(cp.x, cp.y, r, 0, Math.PI * 2);
        ctx.fillStyle   = col.fill;
        ctx.globalAlpha = 0.25;
        ctx.fill();
        ctx.globalAlpha = 1;

        ctx.beginPath();
        ctx.arc(cp.x, cp.y, r, 0, Math.PI * 2);
        ctx.fillStyle = col.fill;
        ctx.fill();

        ctx.strokeStyle = 'white';
        ctx.lineWidth   = 2 * dpr;
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(cp.x - ch, cp.y); ctx.lineTo(cp.x + ch, cp.y);
        ctx.moveTo(cp.x, cp.y - ch); ctx.lineTo(cp.x, cp.y + ch);
        ctx.strokeStyle = 'rgba(255,255,255,0.65)';
        ctx.lineWidth   = 1.5 * dpr;
        ctx.stroke();

      } else {
        const sz = (2.5 + fade * 4.5) * dpr * sizeMul;
        const a  = 0.20 + fade * 0.65;

        ctx.strokeStyle = col.dot;
        ctx.globalAlpha = a;
        ctx.lineWidth   = (0.8 + fade * 0.8) * dpr;

        ctx.beginPath();
        ctx.moveTo(cp.x - sz, cp.y); ctx.lineTo(cp.x + sz, cp.y);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cp.x, cp.y - sz); ctx.lineTo(cp.x, cp.y + sz);
        ctx.stroke();

        if (fade > 0.35) {
          ctx.beginPath();
          ctx.arc(cp.x, cp.y, sz + 4 * dpr, 0, Math.PI * 2);
          ctx.strokeStyle = col.ring;
          ctx.globalAlpha = a * 0.35;
          ctx.lineWidth   = 0.8 * dpr;
          ctx.stroke();
        }

        ctx.globalAlpha = 1;
      }
      ctx.restore();
    }

    // ── 5. Proximity circle (only when a candidate is nearby) ─────────────
    if (nearestCandidate !== null) {
      const cc = { x: cursorVP.x * dpr, y: cursorVP.y * dpr };
      ctx.save();
      ctx.beginPath();
      ctx.arc(cc.x, cc.y, prox * dpr, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(100,100,100,0.08)';
      ctx.lineWidth   = 0.8 * dpr;
      ctx.setLineDash([3 * dpr, 4 * dpr]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

  }, [
    pinCanvasRef, viewportRef, pdfDimensionsRef,
    getSvgPointCandidates, getAreaPixelPoints, getLinePixels,
  ]);

  // ── redrawPinCanvas — rAF-throttled, zoom-pause aware ─────────────────────
  const redrawPinCanvas = useCallback(() => {
    if (isZoomingRef.current) {
      if (!zoomClearedRef.current) {
        const canvas = pinCanvasRef.current;
        if (canvas) canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
        zoomClearedRef.current = true;
      }
      if (zoomEndTimerRef.current) clearTimeout(zoomEndTimerRef.current);
      zoomEndTimerRef.current = setTimeout(() => {
        zoomClearedRef.current = false;
        if (rafRef.current === null) {
          rafRef.current = requestAnimationFrame(() => { rafRef.current = null; _actualRedraw(); });
        }
      }, 100);
      return;
    }
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => { rafRef.current = null; _actualRedraw(); });
  }, [_actualRedraw, pinCanvasRef]);

  useEffect(() => () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    if (zoomEndTimerRef.current) clearTimeout(zoomEndTimerRef.current);
  }, []);

  useEffect(() => {
    redrawPinCanvas();
  }, [redrawPinCanvas, showPins, snapThreshold, svgSnapPoints, svgLines, svgAreas, svgCurves, activeTool]);

  return {
    pageData, analysisStatus, analysisPage, snapFlashes,
    startExtraction, getScaledCorners, getScaledWallCorners, getScaledWallLines,
    snapToCorner, triggerSnapFlash, redrawPinCanvas, cursorPointRef,
    linearChain, addChainPoint, undoChainPoint, clearChain,
  };
}