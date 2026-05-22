// hooks/useSnapEngine/useSnapEngine.tsx
//
// SVG-only snap engine. All snap data comes from useSvgSnapPoints via
// Viewer.tsx. No raster extraction — zero re-detection on zoom.
//
// All coords stored normalised (nx/ny ∈ [0,1]) and converted to pixels
// at snap/draw time using pdfDimensionsRef. This means zoom changes never
// invalidate snap data.
//
// Fixes vs previous versions:
// 1. svgCurves accepted and drawn as real bezier paths (not polylines)
// 2. shapeId?.toLowerCase() crash fixed — all checks use (x ?? '').toLowerCase()
// 3. Nearest-only proximity: only the closest snap point gets the full
//    proximity ring/crosshair treatment; others get a faint ghost dot
// 4. rAF-throttled redraw with zoom-pause clear to avoid jank

import { useRef, useState, useCallback, useEffect } from 'react';
import type { SvgSnapPoint, SvgCurve } from '@/hooks/useSvgSnapPoints';
import type { SvgLine, SvgArea } from '@/hooks/useSvgInteraction';

type PdfDimensions        = { w: number; h: number };
type ExtractionResult     = any;
type PageExtractionState  = any;
type SnapFlash            = { x: number; y: number; id: number };
type SnapResult           = { point: { x: number; y: number }; snapped: boolean };

// ─── Geometry helpers ─────────────────────────────────────────────────────────

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

// ─── Safe shapeId check — never throws on undefined ──────────────────────────

function shapeIdIncludes(shapeId: string | undefined | null, term: string): boolean {
  return (shapeId ?? '').toLowerCase().includes(term);
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type { ExtractionResult, PageExtractionState, SnapFlash, SnapResult, PdfDimensions };

// ─── Colour legend ────────────────────────────────────────────────────────────

const SVG_SNAP_COLOURS: Record<SvgSnapPoint['type'], { dot: string; ring: string; fill: string }> = {
  endpoint:     { dot: 'rgba(245,158,11,0.85)',  ring: 'rgba(245,158,11,0.5)',  fill: '#f59e0b' },
  midpoint:     { dot: 'rgba(16,185,129,0.85)',  ring: 'rgba(16,185,129,0.5)',  fill: '#10b981' },
  centroid:     { dot: 'rgba(139,92,246,0.85)',  ring: 'rgba(139,92,246,0.5)',  fill: '#8b5cf6' },
  intersection: { dot: 'rgba(244,63,94,0.85)',   ring: 'rgba(244,63,94,0.5)',   fill: '#f43f5e' },
  'arc-center': { dot: 'rgba(34,211,238,0.90)',  ring: 'rgba(34,211,238,0.45)', fill: '#22d3ee' },
};

const LINE_PROX_COLOUR = { stroke: 'rgba(56,189,248,', fill: '#38bdf8' };
const AREA_COLOUR      = { stroke: 'rgba(251,146,60,0.55)', fill: '#fb923c' };
const DOOR_LINE_COLOUR = { stroke: 'rgba(34,197,94,0.85)',  fill: '#22c55e' };

// ─── Hook params ──────────────────────────────────────────────────────────────

export interface UseSnapEngineParams {
  pinCanvasRef:     React.RefObject<HTMLCanvasElement>;
  pdfDimensionsRef: React.MutableRefObject<PdfDimensions | null>;
  pageNumberRef:    React.MutableRefObject<number>;
  // scaleRef — current CSS zoom/scale of the PDF canvas on screen.
  // Used to convert fixed screen-pixel proximity radii into canvas-pixel
  // space so proximity highlights work correctly at any zoom level.
  // Pass the same scaleRef used by useViewerPdf.
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
  // SnapEnginePage extras (optional — ignored in Viewer)
  viewportRef?:     React.RefObject<HTMLDivElement>;
  proximityRadius?: number;
  linearMode?:      boolean;
  zoom?:            number;
  pan?:             { x: number; y: number };
}

// ─── Hook return ──────────────────────────────────────────────────────────────

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
  // SnapEnginePage chain API (no-ops in Viewer)
  linearChain:          Array<{ x: number; y: number; type: string }>;
  addChainPoint:        (x: number, y: number, type: string) => void;
  undoChainPoint:       () => void;
  clearChain:           () => void;
}

// ─── Hex + alpha helper ───────────────────────────────────────────────────────

function hexWithAlpha(hex: string, alpha: number): string {
  const aa = Math.max(0, Math.min(255, Math.round(alpha * 255)))
    .toString(16).padStart(2, '0');
  return hex + aa;
}

// ─── useSnapEngine ────────────────────────────────────────────────────────────

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
}: UseSnapEngineParams): UseSnapEngineReturn {

  // ── Stable setting refs ───────────────────────────────────────────────────
  const snapEnabledRef      = useRef(snapEnabled);
  const showPinsRef         = useRef(showPins);
  const snapThresholdRef    = useRef(snapThreshold);
  const confidenceFilterRef = useRef(confidenceFilter);
  const svgSnapPointsRef    = useRef<SvgSnapPoint[]>(svgSnapPoints);
  const svgLinesRef         = useRef<SvgLine[]>(svgLines);
  const svgAreasRef         = useRef<SvgArea[]>(svgAreas);
  const svgCurvesRef        = useRef<SvgCurve[]>(svgCurves);
  const isZoomingRef        = useRef(isZooming);

  useEffect(() => { snapEnabledRef.current      = snapEnabled;      }, [snapEnabled]);
  useEffect(() => { showPinsRef.current         = showPins;         }, [showPins]);
  useEffect(() => { snapThresholdRef.current    = snapThreshold;    }, [snapThreshold]);
  useEffect(() => { confidenceFilterRef.current = confidenceFilter; }, [confidenceFilter]);
  useEffect(() => { svgSnapPointsRef.current    = svgSnapPoints;    }, [svgSnapPoints]);
  useEffect(() => { svgLinesRef.current         = svgLines;         }, [svgLines]);
  useEffect(() => { svgAreasRef.current         = svgAreas;         }, [svgAreas]);
  useEffect(() => { svgCurvesRef.current        = svgCurves;        }, [svgCurves]);
  useEffect(() => { isZoomingRef.current        = isZooming;        }, [isZooming]);

  // ── State ─────────────────────────────────────────────────────────────────
  const [pageData]       = useState<Map<number, PageExtractionState>>(new Map());
  const [analysisStatus] = useState<'idle' | 'analyzing' | 'done'>('done');
  const [analysisPage]   = useState<{ current: number; total: number } | null>(null);
  const [snapFlashes, setSnapFlashes] = useState<SnapFlash[]>([]);

  // Chain state (used by SnapEnginePage; no-ops in Viewer)
  const [linearChain, setLinearChain] = useState<Array<{ x: number; y: number; type: string }>>([]);

  const cursorPointRef = useRef<{ x: number; y: number } | null>(null);
  const flashIdRef     = useRef(0);

  // ── rAF throttle ─────────────────────────────────────────────────────────
  const rafRef          = useRef<number | null>(null);
  const zoomEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const zoomClearedRef  = useRef(false);

  // ── No-op stubs ───────────────────────────────────────────────────────────
  const startExtraction      = useCallback(() => {}, []);
  const getScaledCorners     = useCallback(() => [], []);
  const getScaledWallCorners = useCallback(() => [], []);
  const getScaledWallLines   = useCallback(() => [], []);

  // Chain API (used by SnapEnginePage)
  const addChainPoint  = useCallback((x: number, y: number, type: string) => {
    setLinearChain(prev => [...prev, { x, y, type }]);
  }, []);
  const undoChainPoint = useCallback(() => {
    setLinearChain(prev => prev.slice(0, -1));
  }, []);
  const clearChain     = useCallback(() => {
    setLinearChain([]);
  }, []);

  // ── Pixel converters ──────────────────────────────────────────────────────
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
    area.points.map(p => ({ x: p.nx * dims.w, y: p.ny * dims.h })),
  []);

  const getLinePixels = useCallback((line: SvgLine, dims: PdfDimensions) => ({
    x1: line.nx1 * dims.w, y1: line.ny1 * dims.h,
    x2: line.nx2 * dims.w, y2: line.ny2 * dims.h,
  }), []);

  // ── snapToCorner ──────────────────────────────────────────────────────────
  const snapToCorner = useCallback((rawX: number, rawY: number): SnapResult => {
    if (!snapEnabledRef.current || !pdfDimensionsRef.current)
      return { point: { x: rawX, y: rawY }, snapped: false };

    const dims   = pdfDimensionsRef.current;
    const thresh = snapThresholdRef.current;
    let bestPoint: { x: number; y: number } | null = null;
    let bestDist = thresh;

    // Tier 1: SVG discrete snap points
    for (const c of getSvgPointCandidates()) {
      if (c.type !== 'arc-center') {
        const insideDoor = svgAreasRef.current
          .filter(a => a.label === 'door' || a.isDoor)
          .some(da => {
            const b   = getAreaPixelBounds(da, dims);
            const pad = 20;
            return c.x >= b.minX - pad && c.x <= b.maxX + pad &&
                   c.y >= b.minY - pad && c.y <= b.maxY + pad;
          });
        if (insideDoor) continue;
      }
      if (shapeIdIncludes(c.shapeId, 'door') || shapeIdIncludes(c.shapeId, 'swing')) continue;

      const dist = Math.hypot(rawX - c.x, rawY - c.y);
      if (dist < bestDist) { bestDist = dist; bestPoint = { x: c.x, y: c.y }; }
    }

    // Tier 2: SVG lines
    if (!bestPoint) {
      for (const line of svgLinesRef.current) {
        if (shapeIdIncludes((line as any).shapeId, 'door') ||
            shapeIdIncludes((line as any).shapeId, 'swing')) continue;

        const { x1, y1, x2, y2 } = getLinePixels(line, dims);
        const closest = closestPointOnSegment(rawX, rawY, x1, y1, x2, y2);
        const dist    = Math.hypot(rawX - closest.x, rawY - closest.y);
        if (dist < bestDist) { bestDist = dist; bestPoint = { x: closest.x, y: closest.y }; }
      }
    }

    // Tier 3: SVG area edges
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
      ? { point: { x: bestPoint.x, y: bestPoint.y }, snapped: true }
      : { point: { x: rawX, y: rawY }, snapped: false };
  }, [getSvgPointCandidates, getAreaPixelBounds, getAreaPixelPoints, getLinePixels]);

  // ── triggerSnapFlash ──────────────────────────────────────────────────────
  const triggerSnapFlash = useCallback((x: number, y: number) => {
    const id = ++flashIdRef.current;
    setSnapFlashes(prev => [...prev, { x, y, id }]);
    setTimeout(() => setSnapFlashes(prev => prev.filter(f => f.id !== id)), 700);
  }, []);

  // ── _actualRedraw ─────────────────────────────────────────────────────────
  const _actualRedraw = useCallback(() => {
    const canvas = pinCanvasRef.current;
    const dims   = pdfDimensionsRef.current;
    if (!canvas || !dims) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!showPinsRef.current) return;

    const cursor      = cursorPointRef.current;
    // Convert fixed screen-pixel radii into canvas-pixel space.
    // At zoom=2 the canvas is drawn at 2× screen size, so a 80px screen
    // proximity circle is only 40 canvas pixels wide — divide by scale.
    const currentScale = scaleRef?.current ?? 1;
    const thresh      = snapThresholdRef.current / currentScale;
    const CORNER_PROX = 80 / currentScale;
    const LINE_PROX   = 60 / currentScale;
    const cw          = canvas.width;
    const ch          = canvas.height;

    // ── Static-only path (no cursor) ─────────────────────────────────────
    if (!cursor) {
      // Draw area outlines faintly
      for (const area of svgAreasRef.current) {
        if (area.points.length < 3) continue;
        if (area.label === 'door' || area.isDoor) continue;
        const pts = area.points.map(p => ({ x: p.nx * cw, y: p.ny * ch }));
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        pts.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
        ctx.closePath();
        ctx.strokeStyle = AREA_COLOUR.stroke;
        ctx.lineWidth   = 1;
        ctx.stroke();
        ctx.restore();
      }

      // Draw faint static snap dots
      const svgCandidates = getSvgPointCandidates();
      const doorAreas     = svgAreasRef.current.filter(a => a.label === 'door' || a.isDoor);

      for (const c of svgCandidates) {
        const col = SVG_SNAP_COLOURS[c.type as SvgSnapPoint['type']];
        if (!col) continue;
        if (shapeIdIncludes(c.shapeId, 'door') || shapeIdIncludes(c.shapeId, 'swing')) continue;
        if (c.type !== 'arc-center') {
          const insideDoor = doorAreas.some(da => {
            const b = getAreaPixelBounds(da, dims); const pad = 20;
            return c.x >= b.minX - pad && c.x <= b.maxX + pad &&
                   c.y >= b.minY - pad && c.y <= b.maxY + pad;
          });
          if (insideDoor) continue;
        }
        ctx.beginPath();
        ctx.arc(c.x, c.y, 2, 0, Math.PI * 2);
        ctx.strokeStyle = col.dot;
        ctx.lineWidth   = 1.2;
        ctx.stroke();
      }
      return;
    }

    // ── Full pass (cursor present) ────────────────────────────────────────

    // ═══════════════════════════════════════════════════════════════
    // LAYER 0: SVG bezier curves
    // ═══════════════════════════════════════════════════════════════
    for (const curve of svgCurvesRef.current) {
      const x1  = curve.nx1  * cw, y1  = curve.ny1  * ch;
      const x2  = curve.nx2  * cw, y2  = curve.ny2  * ch;
      const cp1x = curve.ncp1x * cw, cp1y = curve.ncp1y * ch;

      // Rough distance from cursor to chord midpoint
      const midX = (x1 + x2) / 2, midY = (y1 + y2) / 2;
      const dist = Math.hypot(cursor.x - midX, cursor.y - midY);
      if (dist > LINE_PROX * 2) continue;

      const alpha = Math.max(0, 1 - dist / (LINE_PROX * 2)) * 0.6;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      if (curve.type === 'cubic' && curve.ncp2x !== undefined) {
        const cp2x = curve.ncp2x * cw, cp2y = curve.ncp2y! * ch;
        ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x2, y2);
      } else {
        ctx.quadraticCurveTo(cp1x, cp1y, x2, y2);
      }
      ctx.strokeStyle = LINE_PROX_COLOUR.stroke + alpha.toFixed(2) + ')';
      ctx.lineWidth   = 1.2;
      ctx.stroke();
      ctx.restore();
    }

    // ═══════════════════════════════════════════════════════════════
    // LAYER 1: SVG LINE proximity rendering
    // ═══════════════════════════════════════════════════════════════
    const eligibleLines = svgLinesRef.current.filter(line =>
      !shapeIdIncludes((line as any).shapeId, 'door') &&
      !shapeIdIncludes((line as any).shapeId, 'swing')
    );

    // Find nearest line within LINE_PROX
    let nearestLine:       typeof eligibleLines[0] | null = null;
    let nearestLineDist    = LINE_PROX;
    let nearestLineClosest = { x: 0, y: 0, t: 0 };

    for (const line of eligibleLines) {
      const { x1, y1, x2, y2 } = getLinePixels(line, dims);
      const cp   = closestPointOnSegment(cursor.x, cursor.y, x1, y1, x2, y2);
      const dist = Math.hypot(cursor.x - cp.x, cursor.y - cp.y);
      if (dist < nearestLineDist) {
        nearestLineDist    = dist;
        nearestLine        = line;
        nearestLineClosest = cp;
      }
    }

    for (const line of eligibleLines) {
      const { x1, y1, x2, y2 } = getLinePixels(line, dims);
      const cp   = closestPointOnSegment(cursor.x, cursor.y, x1, y1, x2, y2);
      const dist = Math.hypot(cursor.x - cp.x, cursor.y - cp.y);
      if (dist >= LINE_PROX) continue;

      const isNearest  = line === nearestLine;
      const isSnapping = dist < thresh;
      const rawAlpha   = 1 - dist / LINE_PROX;
      const lineAlpha  = isNearest ? rawAlpha : rawAlpha * 0.35;
      const lineWidth  = isSnapping && isNearest ? 2.0
                       : isNearest              ? 1.4
                       : 0.8;

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.strokeStyle = LINE_PROX_COLOUR.stroke + lineAlpha.toFixed(2) + ')';
      ctx.lineWidth   = lineWidth;
      if (!isSnapping && isNearest) ctx.setLineDash([6, 4]);
      ctx.stroke();
      ctx.setLineDash([]);

      if (isNearest) {
        const epAlpha = rawAlpha * 0.7;
        for (const [ex, ey] of [[x1, y1], [x2, y2]] as [number, number][]) {
          ctx.beginPath();
          ctx.arc(ex, ey, isSnapping ? 4 : 2.5, 0, Math.PI * 2);
          ctx.fillStyle   = hexWithAlpha(LINE_PROX_COLOUR.fill, epAlpha);
          ctx.fill();
          ctx.strokeStyle = LINE_PROX_COLOUR.stroke + epAlpha.toFixed(2) + ')';
          ctx.lineWidth   = 1;
          ctx.stroke();
        }
      }

      if (isNearest && isSnapping) {
        const { x: cx2, y: cy2 } = nearestLineClosest;
        const dx = x2 - x1, dy = y2 - y1;
        const len = Math.hypot(dx, dy);
        if (len > 0) {
          const nx = -dy / len, ny = dx / len;
          const tick = 6;
          ctx.beginPath();
          ctx.moveTo(cx2 + nx * tick, cy2 + ny * tick);
          ctx.lineTo(cx2 - nx * tick, cy2 - ny * tick);
          ctx.strokeStyle = LINE_PROX_COLOUR.fill;
          ctx.lineWidth   = 1.5;
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.arc(cx2, cy2, 5, 0, Math.PI * 2);
        ctx.fillStyle   = LINE_PROX_COLOUR.fill;
        ctx.fill();
        ctx.strokeStyle = 'white';
        ctx.lineWidth   = 1.5;
        ctx.stroke();
      }
      ctx.restore();
    }

    // ═══════════════════════════════════════════════════════════════
    // LAYER 2: SVG area outlines
    // ═══════════════════════════════════════════════════════════════
    for (const area of svgAreasRef.current) {
      if (area.points.length < 3) continue;
      const pts    = area.points.map(p => ({ x: p.nx * cw, y: p.ny * ch }));
      const isDoor = area.label === 'door' || !!area.isDoor;
      ctx.save();

      if (isDoor) {
        const pivot  = pts[0];
        const arcPts = pts.slice(1);
        if (arcPts.length < 2) { ctx.restore(); continue; }
        const arcStart = arcPts[0];
        const arcEnd   = arcPts[arcPts.length - 1];
        const r        = Math.hypot(arcStart.x - pivot.x, arcStart.y - pivot.y);
        const cursorR  = Math.hypot(cursor.x - pivot.x, cursor.y - pivot.y);
        const isHovered = Math.abs(cursorR - r) < CORNER_PROX;
        const alpha = isHovered ? 0.95 : 0.75;
        const lw    = isHovered ? 2.5  : 1.8;

        ctx.beginPath();
        ctx.moveTo(pivot.x, pivot.y);
        ctx.lineTo(arcStart.x, arcStart.y);
        ctx.strokeStyle = `rgba(34,197,94,${alpha})`;
        ctx.lineWidth   = lw + 0.5;
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(arcPts[0].x, arcPts[0].y);
        for (let i = 1; i < arcPts.length; i++) ctx.lineTo(arcPts[i].x, arcPts[i].y);
        ctx.strokeStyle = `rgba(34,197,94,${alpha})`;
        ctx.lineWidth   = lw;
        ctx.setLineDash([6, 4]);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.beginPath();
        ctx.moveTo(pivot.x, pivot.y);
        ctx.lineTo(arcEnd.x, arcEnd.y);
        ctx.strokeStyle = `rgba(34,197,94,${alpha * 0.5})`;
        ctx.lineWidth   = 1;
        ctx.stroke();

        if (isHovered) {
          const midIdx = Math.floor(arcPts.length / 2);
          const mid    = arcPts[midIdx];
          ctx.beginPath();
          ctx.arc(mid.x, mid.y, 7, 0, Math.PI * 2);
          ctx.fillStyle   = DOOR_LINE_COLOUR.fill;
          ctx.fill();
          ctx.strokeStyle = 'white';
          ctx.lineWidth   = 1.5;
          ctx.stroke();
          ctx.font         = 'bold 9px ui-monospace,monospace';
          ctx.textAlign    = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle    = 'rgba(0,0,0,0.80)';
          ctx.fillRect(mid.x - 24, mid.y - 23, 48, 13);
          ctx.fillStyle = DOOR_LINE_COLOUR.fill;
          ctx.fillText('DOOR', mid.x, mid.y - 16);
        }
      } else {
        const e        = closestPointOnPolygonEdge(cursor.x, cursor.y, pts);
        const distEdge = e.dist;
        const snapPt   = { x: e.x, y: e.y };
        const isSnapping  = distEdge < thresh;
        const isProximity = distEdge < CORNER_PROX * 2;
        const alpha = isSnapping ? 0.95 : isProximity ? 0.65 : 0.25;
        const lw    = isSnapping ? 2.5  : isProximity ? 1.8  : 1;

        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        pts.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
        ctx.closePath();
        ctx.strokeStyle = AREA_COLOUR.stroke.replace(/[\d.]+\)$/, `${alpha})`);
        ctx.lineWidth   = lw;
        ctx.stroke();

        if (isSnapping) {
          ctx.beginPath();
          ctx.arc(snapPt.x, snapPt.y, 7, 0, Math.PI * 2);
          ctx.fillStyle   = AREA_COLOUR.fill;
          ctx.fill();
          ctx.strokeStyle = 'white';
          ctx.lineWidth   = 1.5;
          ctx.stroke();
          ctx.font         = 'bold 9px ui-monospace,monospace';
          ctx.textAlign    = 'center';
          ctx.textBaseline = 'middle';
          const label = area.label ? area.label.toUpperCase() : 'AREA';
          const tw    = ctx.measureText(label).width + 8;
          ctx.fillStyle = 'rgba(0,0,0,0.80)';
          ctx.fillRect(snapPt.x - tw / 2, snapPt.y - 23, tw, 13);
          ctx.fillStyle = AREA_COLOUR.fill;
          ctx.fillText(label, snapPt.x, snapPt.y - 16);
        }
      }
      ctx.restore();
    }

    // ═══════════════════════════════════════════════════════════════
    // LAYER 3: SVG discrete snap points — nearest-only proximity
    // ═══════════════════════════════════════════════════════════════
    const svgCandidates = getSvgPointCandidates();
    const doorAreas     = svgAreasRef.current.filter(a => a.label === 'door' || a.isDoor);

    const eligibleCandidates = svgCandidates.filter(c => {
      if (shapeIdIncludes(c.shapeId, 'door') || shapeIdIncludes(c.shapeId, 'swing')) return false;
      if (c.type !== 'arc-center') {
        const insideDoor = doorAreas.some(da => {
          const b = getAreaPixelBounds(da, dims); const pad = 20;
          return c.x >= b.minX - pad && c.x <= b.maxX + pad &&
                 c.y >= b.minY - pad && c.y <= b.maxY + pad;
        });
        if (insideDoor) return false;
      }
      return true;
    });

    // Find nearest within CORNER_PROX
    let nearestCandidate:    typeof eligibleCandidates[0] | null = null;
    let nearestCandidateDist = CORNER_PROX;
    for (const c of eligibleCandidates) {
      const dist = Math.hypot(cursor.x - c.x, cursor.y - c.y);
      if (dist < nearestCandidateDist) { nearestCandidateDist = dist; nearestCandidate = c; }
    }

    for (const c of eligibleCandidates) {
      const col  = SVG_SNAP_COLOURS[c.type as SvgSnapPoint['type']];
      if (!col) continue;
      const dist = Math.hypot(cursor.x - c.x, cursor.y - c.y);

      // Outside proximity — faint static dot
      if (dist >= CORNER_PROX) {
        ctx.beginPath();
        ctx.arc(c.x, c.y, 2, 0, Math.PI * 2);
        ctx.strokeStyle = col.dot;
        ctx.lineWidth   = 1.2;
        ctx.stroke();
        continue;
      }

      // Inside proximity but not nearest — ghost dot
      if (c !== nearestCandidate) {
        ctx.beginPath();
        ctx.arc(c.x, c.y, 1.5, 0, Math.PI * 2);
        ctx.strokeStyle = col.dot.replace(/[\d.]+\)$/, '0.18)');
        ctx.lineWidth   = 1;
        ctx.stroke();
        continue;
      }

      // ── Nearest winner ────────────────────────────────────────────────────
      const alpha    = Math.max(0, 1 - nearestCandidateDist / CORNER_PROX);
      const isInSnap = nearestCandidateDist < thresh;
      const isClose  = nearestCandidateDist < 20;
      const size     = isClose ? 7 : 4;

      ctx.save();
      if (isInSnap) {
        // Fully snapped: filled circle + crosshair + label
        ctx.beginPath();
        ctx.arc(c.x, c.y, 8, 0, Math.PI * 2);
        ctx.fillStyle   = col.fill;
        ctx.fill();
        ctx.strokeStyle = 'white';
        ctx.lineWidth   = 2;
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(c.x - 12, c.y); ctx.lineTo(c.x + 12, c.y);
        ctx.moveTo(c.x, c.y - 12); ctx.lineTo(c.x, c.y + 12);
        ctx.strokeStyle = 'rgba(255,255,255,0.7)';
        ctx.lineWidth   = 1;
        ctx.stroke();
        ctx.font         = 'bold 9px ui-monospace,monospace';
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        const label = c.type.toUpperCase();
        const tw    = ctx.measureText(label).width + 8;
        ctx.fillStyle = 'rgba(0,0,0,0.80)';
        ctx.fillRect(c.x - tw / 2, c.y - 23, tw, 13);
        ctx.fillStyle = col.fill;
        ctx.fillText(label, c.x, c.y - 16);
      } else {
        // In proximity, not yet snapped: growing dot + crosshair + ring
        const proximityDotR = 2 + (1 - nearestCandidateDist / CORNER_PROX) * 5;
        ctx.beginPath();
        ctx.arc(c.x, c.y, proximityDotR, 0, Math.PI * 2);
        ctx.fillStyle   = hexWithAlpha(col.fill, alpha * 0.55);
        ctx.fill();
        ctx.strokeStyle = col.dot.replace(/[\d.]+\)$/, `${alpha})`);
        ctx.lineWidth   = isClose ? 1.5 : 1;
        ctx.stroke();

        ctx.strokeStyle = col.dot.replace(/[\d.]+\)$/, `${alpha})`);
        ctx.lineWidth   = isClose ? 1.5 : 1;
        ctx.beginPath();
        ctx.moveTo(c.x - size, c.y); ctx.lineTo(c.x + size, c.y); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(c.x, c.y - size); ctx.lineTo(c.x, c.y + size); ctx.stroke();

        if (isClose) {
          ctx.strokeStyle = col.ring.replace(/[\d.]+\)$/, `${alpha * 0.5})`);
          ctx.beginPath();
          ctx.arc(c.x, c.y, 11, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      ctx.restore();
    }
  }, [pinCanvasRef, pdfDimensionsRef, getSvgPointCandidates, getAreaPixelBounds, getLinePixels]);

  // ── redrawPinCanvas — rAF-throttled, zoom-pause aware ────────────────────
  const redrawPinCanvas = useCallback(() => {
    if (isZoomingRef.current) {
      // During zoom: clear once and defer redraw until zoom settles
      if (!zoomClearedRef.current) {
        const canvas = pinCanvasRef.current;
        if (canvas) {
          const ctx = canvas.getContext('2d');
          ctx?.clearRect(0, 0, canvas.width, canvas.height);
        }
        zoomClearedRef.current = true;
      }
      if (zoomEndTimerRef.current) clearTimeout(zoomEndTimerRef.current);
      zoomEndTimerRef.current = setTimeout(() => {
        zoomClearedRef.current = false;
        if (rafRef.current === null) {
          rafRef.current = requestAnimationFrame(() => {
            rafRef.current = null;
            _actualRedraw();
          });
        }
      }, 100);
      return;
    }

    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      _actualRedraw();
    });
  }, [_actualRedraw, pinCanvasRef]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      if (zoomEndTimerRef.current) clearTimeout(zoomEndTimerRef.current);
    };
  }, []);

  // Redraw when SVG data or settings change
  useEffect(() => {
    redrawPinCanvas();
  }, [redrawPinCanvas, showPins, snapThreshold, svgSnapPoints, svgLines, svgAreas, svgCurves]);

  return {
    pageData,
    analysisStatus,
    analysisPage,
    snapFlashes,
    startExtraction,
    getScaledCorners,
    getScaledWallCorners,
    getScaledWallLines,
    snapToCorner,
    triggerSnapFlash,
    redrawPinCanvas,
    cursorPointRef,
    linearChain,
    addChainPoint,
    undoChainPoint,
    clearChain,
  };
}