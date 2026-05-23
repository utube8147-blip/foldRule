// hooks/useSnapEngine/useSnapEngine.tsx
//
// CHANGES vs previous version:
//
//  1. activeTool param added — snap overlay is suppressed when tool === 'select'
//  2. Proximity circle guide restored (dashed ring around cursor, matches test page)
//  3. Approach indicator fixed: crosshair grows + brightens as cursor closes in,
//     faint ring appears at fade > 0.35 — exactly matching useSnapEngine-test
//  4. Snap lock: filled dot + white ring + crosshair arms (unchanged)
//  5. All distance comparisons done consistently in viewport-pixel space

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
  // NEW: activeTool — overlay is hidden when tool === 'select'
  activeTool?:      string;
  // Viewport-space drawing
  viewportRef:      React.RefObject<HTMLDivElement | null>;
  zoom:             number;
  pan:              { x: number; y: number };
  // Proximity radius in viewport-pixels (default 120, matches test page at 40px
  // but feels better at 80-120 on a real PDF viewer)
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

  // Sync all mutable params into refs so _actualRedraw always sees latest values
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

  // ── Snap candidates in PDF-pixel space ────────────────────────────────────
  const getSvgPointCandidates = useCallback(() => {
    const dims = pdfDimensionsRef.current;
    if (!dims) return [];
    return svgSnapPointsRef.current.map(p => ({
      x: p.nx * dims.w, y: p.ny * dims.h,
      type: p.type, strokeWidth: p.strokeWidth, shapeId: p.shapeId,
    }));
  }, [pdfDimensionsRef]);

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

  // ── snapToCorner — operates in PDF-pixel space ────────────────────────────
  const snapToCorner = useCallback((rawX: number, rawY: number): SnapResult => {
    if (!snapEnabledRef.current || !pdfDimensionsRef.current)
      return { point: { x: rawX, y: rawY }, snapped: false };

    const dims   = pdfDimensionsRef.current;
    const thresh = snapThresholdRef.current;
    let bestPoint: { x: number; y: number } | null = null;
    let bestDist = thresh;

    for (const c of getSvgPointCandidates()) {
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

    // Resize canvas to match viewport (DPR-aware)
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

    // ── Gate: hide overlay for 'select' tool or when pins disabled ────────
    const tool = activeToolRef.current;
    if (!showPinsRef.current || tool === 'select') return;

    const currentZoom = zoomRef.current;
    const currentPan  = panRef.current;
    const prox        = proximityRef.current;

    // PDF-pixel → canvas-pixel
    const pdfToCanvas = (x: number, y: number) => ({
      x: (x * currentZoom + currentPan.x) * dpr,
      y: (y * currentZoom + currentPan.y) * dpr,
    });

    // cursorPointRef is in PDF-pixel space — convert to viewport-pixel for distance
    const cursorPdf = cursorPointRef.current;
    const cursorVP  = cursorPdf
      ? {
          x: cursorPdf.x * currentZoom + currentPan.x,
          y: cursorPdf.y * currentZoom + currentPan.y,
        }
      : null;

    const thresh = snapThresholdRef.current;

    const candidates = getSvgPointCandidates();

    // ── 1. Bezier curves ──────────────────────────────────────────────────
    for (const curve of svgCurvesRef.current) {
      const p0 = pdfToCanvas(curve.nx1   * dims.w, curve.ny1   * dims.h);
      const p1 = pdfToCanvas(curve.ncp1x * dims.w, curve.ncp1y * dims.h);
      const p3 = pdfToCanvas(curve.nx2   * dims.w, curve.ny2   * dims.h);
      const p2 = (curve.type === 'cubic' && curve.ncp2x !== undefined)
        ? pdfToCanvas(curve.ncp2x * dims.w, curve.ncp2y! * dims.h) : null;

      let minDist = Infinity;
      if (cursorVP) {
        const STEPS = 24;
        for (let i = 0; i <= STEPS; i++) {
          const t  = i / STEPS;
          const pt = curve.type === 'cubic' && p2
            ? cubicAt(t, p0.x, p0.y, p1.x, p1.y, p2.x, p2.y, p3.x, p3.y)
            : quadAt(t,  p0.x, p0.y, p1.x, p1.y,              p3.x, p3.y);
          const d = Math.hypot(cursorVP.x * dpr - pt.x, cursorVP.y * dpr - pt.y) / dpr;
          if (d < minDist) minDist = d;
        }
      }
      if (cursorVP && minDist > prox) continue;

      const fade  = cursorVP ? Math.max(0, 1 - minDist / prox) : 0;
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

    if (cursorVP) {
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
    }

    for (const line of eligibleLines) {
      if (!cursorVP) continue;
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
      if (cursorVP) {
        for (let i = 0; i < pts.length; i++) {
          const j  = (i + 1) % pts.length;
          const cp = closestPointOnSegment(
            cursorVP.x * dpr, cursorVP.y * dpr,
            pts[i].x, pts[i].y, pts[j].x, pts[j].y,
          );
          const d = Math.hypot(cursorVP.x * dpr - cp.x, cursorVP.y * dpr - cp.y) / dpr;
          if (d < distEdge) { distEdge = d; snapPt = cp; }
        }
      }
      if (cursorVP && distEdge > prox * 2) continue;

      const isSnapping = distEdge < thresh;
      const fade       = cursorVP ? Math.max(0, 1 - distEdge / (prox * 2)) : 0;
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

    // ── 4. Snap points — SINGLE NEAREST ONLY ─────────────────────────────
// ── 4. Snap points — secondary candidates + primary ──────────────────
    const TYPE_LABEL: Record<string, string> = {
      endpoint: 'e', midpoint: 'm', intersection: 'i', centroid: 'c', 'arc-center': 'a',
    };

    const eligibleCandidates = candidates.filter(c =>
      !shapeIdIncludes(c.shapeId, 'door') &&
      !shapeIdIncludes(c.shapeId, 'swing')
    );

    // Priority-aware nearest, matching demo logic
    let nearestCandidate:    typeof eligibleCandidates[0] | null = null;
    let nearestCandidateDist = Infinity;

    if (cursorVP) {
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
    }

    // ── 4a. Secondary candidates (all in-range, dimmed, with type badge) ─
    if (cursorVP) {
      for (const c of eligibleCandidates) {
        if (c === nearestCandidate) continue;
        const cp   = pdfToCanvas(c.x, c.y);
        const dist = Math.hypot(cursorVP.x - cp.x / dpr, cursorVP.y - cp.y / dpr);
        if (dist > prox) continue;

        const col  = SVG_SNAP_COLOURS[c.type] ?? SVG_SNAP_COLOURS['endpoint'];
        const fade = Math.max(0, 1 - dist / prox);
        const a    = 0.12 + fade * 0.40;
        const r    = (3 + fade * 3.5) * dpr;

        ctx.save();

        // Hollow ring
        ctx.beginPath();
        ctx.arc(cp.x, cp.y, r, 0, Math.PI * 2);
        ctx.strokeStyle = col.fill;
        ctx.globalAlpha = a;
        ctx.lineWidth   = 1 * dpr;
        ctx.stroke();

        // Centre dot
        ctx.beginPath();
        ctx.arc(cp.x, cp.y, 1.5 * dpr, 0, Math.PI * 2);
        ctx.fillStyle   = col.fill;
        ctx.globalAlpha = Math.min(1, a + 0.15);
        ctx.fill();

        // Type badge label (e / m / i / c / a) — appears when close enough
        if (fade > 0.25) {
          ctx.globalAlpha = a * 0.9;
          ctx.fillStyle   = col.fill;
          ctx.font        = `${Math.round((8 + fade * 3) * dpr)}px monospace`;
          ctx.textAlign   = 'center';
          ctx.textBaseline = 'bottom';
          ctx.fillText(TYPE_LABEL[c.type] ?? '?', cp.x, cp.y - r - 2 * dpr);
        }

        ctx.globalAlpha = 1;
        ctx.restore();
      }
    }

    // ── 4b. Primary candidate ─────────────────────────────────────────────
    if (nearestCandidate && cursorVP) {
      const c       = nearestCandidate;
      const col     = SVG_SNAP_COLOURS[c.type] ?? SVG_SNAP_COLOURS['endpoint'];
      const sizeMul = SNAP_SIZE[c.type] ?? 1.0;
      const dist    = nearestCandidateDist;
      const isSnap  = dist < thresh;
      const fade    = Math.max(0, 1 - dist / prox);

      const cp = pdfToCanvas(c.x, c.y);

      ctx.save();

      if (isSnap) {
        // ── LOCKED: filled dot + white ring + crosshair arms ─────────────
        const r  = 7 * dpr * sizeMul;
        const ch = 11 * dpr;

        // Soft glow halo
        ctx.beginPath();
        ctx.arc(cp.x, cp.y, r, 0, Math.PI * 2);
        ctx.fillStyle   = col.fill;
        ctx.globalAlpha = 0.25;
        ctx.fill();
        ctx.globalAlpha = 1;

        // Filled dot
        ctx.beginPath();
        ctx.arc(cp.x, cp.y, r, 0, Math.PI * 2);
        ctx.fillStyle = col.fill;
        ctx.fill();

        // White ring
        ctx.strokeStyle = 'white';
        ctx.lineWidth   = 2 * dpr;
        ctx.stroke();

        // Crosshair arms
        ctx.beginPath();
        ctx.moveTo(cp.x - ch, cp.y); ctx.lineTo(cp.x + ch, cp.y);
        ctx.moveTo(cp.x, cp.y - ch); ctx.lineTo(cp.x, cp.y + ch);
        ctx.strokeStyle = 'rgba(255,255,255,0.65)';
        ctx.lineWidth   = 1.5 * dpr;
        ctx.stroke();

      } else {
        // ── APPROACHING: growing crosshair arms + faint ring ─────────────
        // No cursor dot — crosshair arms grow and brighten as cursor closes in
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

        // Faint ring appears when cursor is more than 35% of the way in
        if (fade > 0.35) {
          ctx.beginPath();
          ctx.arc(cp.x, cp.y, sz + 4 * dpr, 0, Math.PI * 2);
          ctx.strokeStyle = col.ring;
          ctx.globalAlpha = a * 0.35;
          ctx.lineWidth   = 0.8 * dpr;
          ctx.stroke();
        }

        ctx.globalAlpha = 1;
        // ── NO cursor dot drawn here ──────────────────────────────────────
      }
      ctx.restore();
    }

    // ── 5. Proximity circle guide (dashed ring around cursor) ─────────────
    // Only drawn when at least one snap point candidate is within the proximity
    // radius — matches useSnapEngine-test exactly (circle appears only near snaps,
    // not permanently under the cursor when there's nothing to snap to).
    if (cursorVP && nearestCandidate !== null) {
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
  }, [redrawPinCanvas, showPins, snapThreshold, svgSnapPoints, svgLines, svgAreas, svgCurves, zoom, pan, activeTool]);

  return {
    pageData, analysisStatus, analysisPage, snapFlashes,
    startExtraction, getScaledCorners, getScaledWallCorners, getScaledWallLines,
    snapToCorner, triggerSnapFlash, redrawPinCanvas, cursorPointRef,
    linearChain, addChainPoint, undoChainPoint, clearChain,
  };
}