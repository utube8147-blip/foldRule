// hooks/useSnapEngine/useSnapEngine.tsx (SVG-only, normalized coords)
//
// NORMALIZATION FIX:
//   • svgSnapPoints arrive as nx/ny ∈ [0,1] from useSvgSnapPoints
//   • svgLines arrive as nx1/ny1/nx2/ny2 ∈ [0,1] from useSvgInteraction
//   • svgAreas arrive with points[].nx/ny ∈ [0,1] and bounds.minNX/maxNX etc.
//   • All snap math converts to pixels at call time: nx × pdfDimensions.w
//   • redrawPinCanvas multiplies normalized coords by canvas.width/height at draw time
//   • Zero re-detection on zoom — pdfDimensions changes do NOT trigger any effect here

import { useRef, useState, useCallback, useEffect } from 'react';
import type { SvgSnapPoint } from '@/hooks/useSvgSnapPoints';
import type { SvgLine, SvgArea } from '@/hooks/useSvgInteraction';
import type { ExtractionResult, PageExtractionState, SnapFlash, SnapResult, PdfDimensions } from './viewerTypes';

// ─── Geometry helpers ─────────────────────────────────────────────────────────

function closestPointOnSegment(
  px: number, py: number,
  x1: number, y1: number,
  x2: number, y2: number,
): { x: number; y: number } {
  const ax = px - x1, ay = py - y1;
  const bx = x2 - x1, by = y2 - y1;
  const dot = ax * bx + ay * by;
  const len2 = bx * bx + by * by;
  if (len2 === 0) return { x: x1, y: y1 };
  const t = Math.max(0, Math.min(1, dot / len2));
  return { x: x1 + t * bx, y: y1 + t * by };
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

const SVG_LINE_COLOUR      = { stroke: 'rgba(56,189,248,0.55)',  fill: '#38bdf8' };
const SVG_AREA_COLOUR      = { stroke: 'rgba(251,146,60,0.55)',  fill: '#fb923c' };
const SVG_DOOR_LINE_COLOUR = { stroke: 'rgba(34,197,94,0.85)',   fill: '#22c55e' };

// ─── Hook params ──────────────────────────────────────────────────────────────

export interface UseSnapEngineParams {
  pinCanvasRef:     React.RefObject<HTMLCanvasElement>;
  pdfDimensionsRef: React.MutableRefObject<PdfDimensions | null>;
  pageNumberRef:    React.MutableRefObject<number>;
  snapEnabled:      boolean;
  showPins:         boolean;
  snapThreshold:    number;
  confidenceFilter: number;
  svgSnapPoints?:   SvgSnapPoint[];
  svgLines?:        SvgLine[];
  svgAreas?:        SvgArea[];
}

// ─── Hook return ──────────────────────────────────────────────────────────────

export interface UseSnapEngineReturn {
  pageData:         Map<number, PageExtractionState>;
  analysisStatus:   'idle' | 'analyzing' | 'done';
  analysisPage:     { current: number; total: number } | null;
  snapFlashes:      SnapFlash[];
  startExtraction:  (pdf: any, file?: File) => void;
  getScaledCorners: (pageIdx: number) => Array<{ x: number; y: number; confidence: number }>;
  getScaledWallCorners: (pageIdx: number) => Array<{ x: number; y: number; confidence: number; lineIndices: number[] }>;
  getScaledWallLines: (pageIdx: number) => Array<{ x1: number; y1: number; x2: number; y2: number; angle: number; length: number }>;
  snapToCorner:     (rawX: number, rawY: number) => SnapResult;
  triggerSnapFlash: (x: number, y: number) => void;
  redrawPinCanvas:  () => void;
  cursorPointRef:   React.MutableRefObject<{ x: number; y: number } | null>;
}

// ─── useSnapEngine ─────────────────────────────────────────────────────────────

export function useSnapEngine({
  pinCanvasRef,
  pdfDimensionsRef,
  pageNumberRef,
  snapEnabled,
  showPins,
  snapThreshold,
  confidenceFilter,
  svgSnapPoints = [],
  svgLines      = [],
  svgAreas      = [],
}: UseSnapEngineParams): UseSnapEngineReturn {

  // ── Stable setting refs — no zoom re-renders ───────────────────────────────
  const snapEnabledRef      = useRef(snapEnabled);
  const showPinsRef         = useRef(showPins);
  const snapThresholdRef    = useRef(snapThreshold);
  const confidenceFilterRef = useRef(confidenceFilter);
  // Normalized data refs — updated when SVG changes (not on zoom)
  const svgSnapPointsRef    = useRef<SvgSnapPoint[]>(svgSnapPoints);
  const svgLinesRef         = useRef<SvgLine[]>(svgLines);
  const svgAreasRef         = useRef<SvgArea[]>(svgAreas);

  useEffect(() => { snapEnabledRef.current      = snapEnabled;      }, [snapEnabled]);
  useEffect(() => { showPinsRef.current         = showPins;         }, [showPins]);
  useEffect(() => { snapThresholdRef.current    = snapThreshold;    }, [snapThreshold]);
  useEffect(() => { confidenceFilterRef.current = confidenceFilter; }, [confidenceFilter]);
  useEffect(() => { svgSnapPointsRef.current    = svgSnapPoints;    }, [svgSnapPoints]);
  useEffect(() => { svgLinesRef.current         = svgLines;         }, [svgLines]);
  useEffect(() => { svgAreasRef.current         = svgAreas;         }, [svgAreas]);

  // ── State ──────────────────────────────────────────────────────────────────
  const [pageData]        = useState<Map<number, PageExtractionState>>(new Map());
  const [analysisStatus]  = useState<'idle' | 'analyzing' | 'done'>('done');
  const [analysisPage]    = useState<{ current: number; total: number } | null>(null);
  const [snapFlashes, setSnapFlashes] = useState<SnapFlash[]>([]);

  const cursorPointRef = useRef<{ x: number; y: number } | null>(null);
  const flashIdRef     = useRef(0);

  // ── No-op startExtraction ─────────────────────────────────────────────────
  const startExtraction = useCallback((_pdf: any, _file?: File) => {
    console.log('[useSnapEngine] SVG-only mode — raster extraction disabled');
  }, []);

  // ── Empty scaled getters ─────────────────────────────────────────────────
  const getScaledCorners      = useCallback(() => [], []);
  const getScaledWallCorners  = useCallback(() => [], []);
  const getScaledWallLines    = useCallback(() => [], []);

  // ── Scale normalized snap point to current canvas pixels ─────────────────
  // Called only at snap/draw time, never stored
  const normToCanvas = useCallback((nx: number, ny: number) => {
    const dims = pdfDimensionsRef.current;
    if (!dims) return null;
    return { x: nx * dims.w, y: ny * dims.h };
  }, [pdfDimensionsRef]);

  // ── SVG candidate helpers (normalized → pixel at call time) ──────────────
  const getSvgPointCandidates = useCallback(() => {
    const dims = pdfDimensionsRef.current;
    if (!dims) return [];
    return svgSnapPointsRef.current.map(p => ({
      x:           p.nx * dims.w,
      y:           p.ny * dims.h,
      type:        p.type,
      strokeWidth: p.strokeWidth,
      shapeId:     p.shapeId,
    }));
  }, [pdfDimensionsRef]);

  // Expand normalized area bounds → pixel bounds at call time
  const getAreaPixelBounds = useCallback((area: SvgArea, dims: PdfDimensions) => ({
    minX: area.bounds.minNX * dims.w,
    minY: area.bounds.minNY * dims.h,
    maxX: area.bounds.maxNX * dims.w,
    maxY: area.bounds.maxNY * dims.h,
  }), []);

  // Expand normalized area points → pixel points at call time
  const getAreaPixelPoints = useCallback((area: SvgArea, dims: PdfDimensions) =>
    area.points.map(p => ({ x: p.nx * dims.w, y: p.ny * dims.h })),
  []);

  // Expand normalized line → pixel line at call time
  const getLinePixels = useCallback((line: SvgLine, dims: PdfDimensions) => ({
    x1: line.nx1 * dims.w, y1: line.ny1 * dims.h,
    x2: line.nx2 * dims.w, y2: line.ny2 * dims.h,
  }), []);

  // ── snapToCorner ──────────────────────────────────────────────────────────
  const snapToCorner = useCallback((rawX: number, rawY: number): SnapResult => {
    if (!snapEnabledRef.current || !pdfDimensionsRef.current) {
      return { point: { x: rawX, y: rawY }, snapped: false };
    }

    const dims   = pdfDimensionsRef.current;
    const thresh = snapThresholdRef.current;
    let bestPoint: { x: number; y: number } | null = null;
    let bestDist = thresh;

    // Tier 1: SVG discrete snap points (normalized → pixel at call time)
    for (const c of getSvgPointCandidates()) {
      if (c.type !== 'arc-center') {
        const insideDoor = svgAreasRef.current
          .filter(a => a.label === 'door' || a.isDoor)
          .some(da => {
            const b = getAreaPixelBounds(da, dims);
            const pad = 20;
            return c.x >= b.minX - pad && c.x <= b.maxX + pad &&
                   c.y >= b.minY - pad && c.y <= b.maxY + pad;
          });
        if (insideDoor) continue;
      }
      const dist = Math.hypot(rawX - c.x, rawY - c.y);
      if (dist < bestDist) { bestDist = dist; bestPoint = { x: c.x, y: c.y }; }
    }

    // Tier 2: SVG lines (normalized → pixel at call time)
    if (!bestPoint) {
      for (const line of svgLinesRef.current) {
        if (line.shapeId?.toLowerCase().includes('door') ||
            line.shapeId?.toLowerCase().includes('swing')) continue;
        const { x1, y1, x2, y2 } = getLinePixels(line, dims);
        const closest = closestPointOnSegment(rawX, rawY, x1, y1, x2, y2);
        const dist    = Math.hypot(rawX - closest.x, rawY - closest.y);
        if (dist < bestDist) { bestDist = dist; bestPoint = closest; }
      }
    }

    // Tier 3: SVG area edges (normalized → pixel at call time)
    if (!bestPoint) {
      for (const area of svgAreasRef.current) {
        if (area.label === 'door' || area.isDoor) continue;
        const b = getAreaPixelBounds(area, dims);
        if (rawX < b.minX - thresh || rawX > b.maxX + thresh ||
            rawY < b.minY - thresh || rawY > b.maxY + thresh) continue;
        const pts    = getAreaPixelPoints(area, dims);
        const onEdge = closestPointOnPolygonEdge(rawX, rawY, pts);
        if (onEdge.dist < bestDist) {
          bestDist = onEdge.dist;
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

  // ── redrawPinCanvas — all coords derived from normalized at draw time ──────
  const redrawPinCanvas = useCallback(() => {
    const canvas = pinCanvasRef.current;
    const dims   = pdfDimensionsRef.current;
    if (!canvas || !dims) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!showPinsRef.current) return;

    const cursor        = cursorPointRef.current;
    const thresh        = snapThresholdRef.current;
    const CORNER_PROX   = 80;
    const cw            = canvas.width;   // current canvas pixel size — may differ from detection size
    const ch            = canvas.height;

    // ── Layer 1: SVG area outlines ────────────────────────────────────────
    for (const area of svgAreasRef.current) {
      if (area.points.length < 3) continue;

      // Scale normalized points → current canvas pixels at draw time
      const pts = area.points.map(p => ({ x: p.nx * cw, y: p.ny * ch }));

      const isDoor = area.label === 'door' || !!area.isDoor;
      ctx.save();

      if (isDoor) {
        const pivot  = pts[0];
        const arcPts = pts.slice(1);
        if (arcPts.length < 2) { ctx.restore(); continue; }

        const arcStart = arcPts[0];
        const arcEnd   = arcPts[arcPts.length - 1];

        const isHovered = cursor && (() => {
          const r       = Math.hypot(arcStart.x - pivot.x, arcStart.y - pivot.y);
          const cursorR = Math.hypot(cursor.x - pivot.x, cursor.y - pivot.y);
          return Math.abs(cursorR - r) < CORNER_PROX;
        })();

        const alpha = isHovered ? 0.95 : 0.75;
        const lw    = isHovered ? 2.5  : 1.8;

        // Door leaf
        ctx.beginPath();
        ctx.moveTo(pivot.x, pivot.y);
        ctx.lineTo(arcStart.x, arcStart.y);
        ctx.strokeStyle = `rgba(34,197,94,${alpha})`;
        ctx.lineWidth   = lw + 0.5;
        ctx.stroke();

        // Door swing arc (polyline)
        ctx.beginPath();
        ctx.moveTo(arcPts[0].x, arcPts[0].y);
        for (let i = 1; i < arcPts.length; i++) ctx.lineTo(arcPts[i].x, arcPts[i].y);
        ctx.strokeStyle = `rgba(34,197,94,${alpha})`;
        ctx.lineWidth   = lw;
        ctx.setLineDash([6, 4]);
        ctx.stroke();
        ctx.setLineDash([]);

        // Closing line (faint)
        ctx.beginPath();
        ctx.moveTo(pivot.x, pivot.y);
        ctx.lineTo(arcEnd.x, arcEnd.y);
        ctx.strokeStyle = `rgba(34,197,94,${alpha * 0.5})`;
        ctx.lineWidth   = 1;
        ctx.stroke();

        if (isHovered && cursor) {
          const midIdx = Math.floor(arcPts.length / 2);
          const mid    = arcPts[midIdx];
          ctx.beginPath();
          ctx.arc(mid.x, mid.y, 7, 0, Math.PI * 2);
          ctx.fillStyle   = SVG_DOOR_LINE_COLOUR.fill;
          ctx.fill();
          ctx.strokeStyle = 'white';
          ctx.lineWidth   = 1.5;
          ctx.stroke();
          ctx.font         = 'bold 9px ui-monospace,monospace';
          ctx.textAlign    = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle    = 'rgba(0,0,0,0.80)';
          ctx.fillRect(mid.x - 24, mid.y - 23, 48, 13);
          ctx.fillStyle = SVG_DOOR_LINE_COLOUR.fill;
          ctx.fillText('DOOR', mid.x, mid.y - 16);
        }

      } else {
        // Non-door room area
        const centroidX = pts.reduce((s, p) => s + p.x, 0) / pts.length;
        const centroidY = pts.reduce((s, p) => s + p.y, 0) / pts.length;

        let distEdge = Infinity;
        let snapPt   = { x: centroidX, y: centroidY };

        if (cursor) {
          const e = closestPointOnPolygonEdge(cursor.x, cursor.y, pts);
          distEdge = e.dist;
          snapPt   = { x: e.x, y: e.y };
        }

        const isSnapping  = distEdge < thresh;
        const isProximity = distEdge < CORNER_PROX * 2;
        const alpha = isSnapping ? 0.95 : isProximity ? 0.65 : 0.25;
        const lw    = isSnapping ? 2.5  : isProximity ? 1.8  : 1;

        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        pts.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
        ctx.closePath();
        ctx.strokeStyle = SVG_AREA_COLOUR.stroke.replace(/[\d.]+\)$/, `${alpha})`);
        ctx.lineWidth   = lw;
        ctx.stroke();

        if (isSnapping && cursor) {
          ctx.beginPath();
          ctx.arc(snapPt.x, snapPt.y, 7, 0, Math.PI * 2);
          ctx.fillStyle   = SVG_AREA_COLOUR.fill;
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
          ctx.fillStyle = SVG_AREA_COLOUR.fill;
          ctx.fillText(label, snapPt.x, snapPt.y - 16);
        }
      }

      ctx.restore();
    }

    // ── Layer 2: SVG discrete snap points ─────────────────────────────────
    // getSvgPointCandidates() scales nx/ny → pixels using current pdfDimensions
    const svgCandidates = getSvgPointCandidates();
    const doorAreas     = svgAreasRef.current.filter(a => a.label === 'door' || a.isDoor);

    for (const c of svgCandidates) {
      const col = SVG_SNAP_COLOURS[c.type];
      if (!col) continue;

      if (c.type !== 'arc-center') {
        const insideDoor = doorAreas.some(da => {
          const b   = getAreaPixelBounds(da, dims);
          const pad = 20;
          return c.x >= b.minX - pad && c.x <= b.maxX + pad &&
                 c.y >= b.minY - pad && c.y <= b.maxY + pad;
        });
        if (insideDoor) continue;
      }

      if (c.shapeId?.toLowerCase().includes('door') ||
          c.shapeId?.toLowerCase().includes('swing')) continue;

      const dist    = cursor ? Math.hypot(cursor.x - c.x, cursor.y - c.y) : Infinity;
      const isInSnap = dist < thresh;
      const inRange  = dist < CORNER_PROX;

      if (!cursor || !inRange) {
        ctx.beginPath();
        ctx.arc(c.x, c.y, 2, 0, Math.PI * 2);
        ctx.strokeStyle = col.dot;
        ctx.lineWidth   = 1.2;
        ctx.stroke();
        continue;
      }

      const alpha   = Math.max(0, 1 - dist / CORNER_PROX);
      const isClose = dist < 20;
      const size    = isClose ? 7 : 4;

      ctx.save();
      if (isInSnap) {
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
  }, [pinCanvasRef, pdfDimensionsRef, getSvgPointCandidates, getAreaPixelBounds]);

  // Redraw on SVG data changes or settings changes — NOT on zoom
  useEffect(() => {
    redrawPinCanvas();
  }, [redrawPinCanvas, showPins, snapThreshold, svgSnapPoints, svgLines, svgAreas]);

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
  };
}