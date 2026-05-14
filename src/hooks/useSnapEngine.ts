// useSnapEngine.tsx (SVG-only version with DOOR DETECTION)

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

const SVG_LINE_COLOUR     = { stroke: 'rgba(56,189,248,0.55)',  fill: '#38bdf8' };
const SVG_AREA_COLOUR     = { stroke: 'rgba(251,146,60,0.55)',  fill: '#fb923c' };
const SVG_DOOR_LINE_COLOUR = { stroke: 'rgba(34,197,94,0.85)',   fill: '#22c55e' };  // Green for doors

// ─── Door detection helper ─────────────────────────────────────────────────────

function isDoorShape(shapeId: string | undefined): boolean {
  if (!shapeId) return false;
  const doorKeywords = [
    'door', 'Door', 'DOOR',
    'door-swing', 'door-leaf',
    'swing', 'arc', 'threshold',
    'entry', 'entrance'
  ];
  return doorKeywords.some(keyword => shapeId.includes(keyword));
}

// ─── Hook params ──────────────────────────────────────────────────────────────

export interface UseSnapEngineParams {
  pinCanvasRef: React.RefObject<HTMLCanvasElement>;
  pdfDimensionsRef: React.MutableRefObject<PdfDimensions | null>;
  pageNumberRef: React.MutableRefObject<number>;
  snapEnabled: boolean;
  showPins: boolean;
  snapThreshold: number;
  confidenceFilter: number;
  svgSnapPoints?: SvgSnapPoint[];
  svgLines?: SvgLine[];
  svgAreas?: SvgArea[];
}

// ─── Hook return (matches original interface) ─────────────────────────────────

export interface UseSnapEngineReturn {
  pageData: Map<number, PageExtractionState>;
  analysisStatus: 'idle' | 'analyzing' | 'done';
  analysisPage: { current: number; total: number } | null;
  snapFlashes: SnapFlash[];
  startExtraction: (pdf: any, file?: File) => void;
  getScaledCorners: (pageIdx: number) => Array<{ x: number; y: number; confidence: number }>;
  getScaledWallCorners: (pageIdx: number) => Array<{ x: number; y: number; confidence: number; lineIndices: number[] }>;
  getScaledWallLines: (pageIdx: number) => Array<{ x1: number; y1: number; x2: number; y2: number; angle: number; length: number }>;
  snapToCorner: (rawX: number, rawY: number) => SnapResult;
  triggerSnapFlash: (x: number, y: number) => void;
  redrawPinCanvas: () => void;
  cursorPointRef: React.MutableRefObject<{ x: number; y: number } | null>;
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
  svgLines = [],
  svgAreas = [],
}: UseSnapEngineParams): UseSnapEngineReturn {

  // ── Stable setting refs ────────────────────────────────────────────────────
  const snapEnabledRef      = useRef(snapEnabled);
  const showPinsRef         = useRef(showPins);
  const snapThresholdRef    = useRef(snapThreshold);
  const confidenceFilterRef = useRef(confidenceFilter);
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

  // ── Empty state (no raster analysis) ───────────────────────────────────────
  const [pageData, setPageData] = useState<Map<number, PageExtractionState>>(new Map());
  const [analysisStatus, setAnalysisStatus] = useState<'idle' | 'analyzing' | 'done'>('idle');
  const [analysisPage, setAnalysisPage] = useState<{ current: number; total: number } | null>(null);
  const [snapFlashes, setSnapFlashes] = useState<SnapFlash[]>([]);
  
  const cursorPointRef = useRef<{ x: number; y: number } | null>(null);
  const flashIdRef = useRef(0);

  // ── Empty page state maker ─────────────────────────────────────────────────
  const makeEmptyPageState = (): PageExtractionState => ({
    status: 'idle',
    corners: [],
    lines: [],
    intersections: [],
    width: 0,
    height: 0,
    wallLines: [],
    wallCorners: [],
  });

  // ── No-op startExtraction (does nothing, but satisfies interface) ───────────
  const startExtraction = useCallback((pdf: any, file?: File) => {
    console.log('[useSnapEngine] SVG-only mode - raster extraction disabled');
    setAnalysisStatus('done');
    setAnalysisPage(null);
  }, []);

  // ── Empty scaled getters (return empty arrays) ─────────────────────────────
  const getScaledCorners = useCallback((): Array<{ x: number; y: number; confidence: number }> => {
    return [];
  }, []);

  const getScaledWallCorners = useCallback((): Array<{ x: number; y: number; confidence: number; lineIndices: number[] }> => {
    return [];
  }, []);

  const getScaledWallLines = useCallback((): Array<{ x1: number; y1: number; x2: number; y2: number; angle: number; length: number }> => {
    return [];
  }, []);

  // ── SVG candidate helpers ──────────────────────────────────────────────────
  const getSvgPointCandidates = useCallback(() => {
    const dims = pdfDimensionsRef.current;
    if (!dims) return [];
    return svgSnapPointsRef.current.map(p => ({
      x: p.nx * dims.w,
      y: p.ny * dims.h,
      type: p.type,
      strokeWidth: p.strokeWidth,
      shapeId: p.shapeId,
    }));
  }, [pdfDimensionsRef]);

  // ── snapToCorner (SVG only) ────────────────────────────────────────────────
  const snapToCorner = useCallback((rawX: number, rawY: number): SnapResult => {
    if (!snapEnabledRef.current || !pdfDimensionsRef.current) {
      return { point: { x: rawX, y: rawY }, snapped: false };
    }

    const thresh = snapThresholdRef.current;
    let bestPoint: { x: number; y: number } | null = null;
    let bestDist = thresh;

    // Tier 1: SVG discrete snap points  
    for (const c of getSvgPointCandidates()) {
      // Skip non-arc-center points inside door areas
      if (c.type !== 'arc-center') {
        const insideDoor = svgAreasRef.current
          .filter(a => a.label === 'door' || a.isDoor)
          .some(da => {
            const pad = 20;
            return c.x >= da.bounds.minX - pad && c.x <= da.bounds.maxX + pad &&
                  c.y >= da.bounds.minY - pad && c.y <= da.bounds.maxY + pad;
          });
        if (insideDoor) continue;
      }
      const dist = Math.hypot(rawX - c.x, rawY - c.y);
      if (dist < bestDist) { bestDist = dist; bestPoint = { x: c.x, y: c.y }; }
    }

    // Tier 2: SVG lines (skip door lines for snapping)
    if (!bestPoint) {
      for (const line of svgLinesRef.current) {
        // Skip door lines - users should snap to arc-center, not points along the arc
        if (isDoorShape(line.shapeId)) continue;
        
        const closest = closestPointOnSegment(rawX, rawY, line.x1, line.y1, line.x2, line.y2);
        const dist = Math.hypot(rawX - closest.x, rawY - closest.y);
        if (dist < bestDist) { bestDist = dist; bestPoint = closest; }
      }
    }

    // Tier 3: SVG areas (skip door areas for snapping)
    if (!bestPoint) {
      for (const area of svgAreasRef.current) {
        if (isDoorShape(area.shapeId)) continue;
        
        if (
          rawX < area.bounds.minX - thresh || rawX > area.bounds.maxX + thresh ||
          rawY < area.bounds.minY - thresh || rawY > area.bounds.maxY + thresh
        ) continue;
        const onEdge = closestPointOnPolygonEdge(rawX, rawY, area.points);
        if (onEdge.dist < bestDist) {
          bestDist = onEdge.dist;
          bestPoint = { x: onEdge.x, y: onEdge.y };
        }
      }
    }

    return bestPoint
      ? { point: { x: bestPoint.x, y: bestPoint.y }, snapped: true }
      : { point: { x: rawX, y: rawY }, snapped: false };
  }, [getSvgPointCandidates]);

  // ── triggerSnapFlash ───────────────────────────────────────────────────────
  const triggerSnapFlash = useCallback((x: number, y: number) => {
    const id = ++flashIdRef.current;
    setSnapFlashes(prev => [...prev, { x, y, id }]);
    setTimeout(() => setSnapFlashes(prev => prev.filter(f => f.id !== id)), 700);
  }, []);

  // ── redrawPinCanvas (SVG only with DOOR RENDERING) ─────────────────────────
  const redrawPinCanvas = useCallback(() => {
    const canvas = pinCanvasRef.current;
    if (!canvas || !pdfDimensionsRef.current) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!showPinsRef.current) return;

    const cursor = cursorPointRef.current;
    const thresh = snapThresholdRef.current;
    const CORNER_PROXIMITY = 80;

    // ── Layer 1: SVG lines (with door detection for styling) ─────────────────
    // for (const line of svgLinesRef.current) {
    //   const isDoor = isDoorShape(line.shapeId);
      
    //   // Choose styling based on door detection
    //   const colour = isDoor ? SVG_DOOR_LINE_COLOUR : SVG_LINE_COLOUR;
    //   const dashPattern = isDoor ? [8, 6] : [];  // Dashed line for doors
      
    //   let distSeg = Infinity;
    //   let snapPt = { x: (line.x1 + line.x2) / 2, y: (line.y1 + line.y2) / 2 };

    //   if (cursor) {
    //     const c = closestPointOnSegment(cursor.x, cursor.y, line.x1, line.y1, line.x2, line.y2);
    //     distSeg = Math.hypot(cursor.x - c.x, cursor.y - c.y);
    //     snapPt = c;
    //   }

    //   const isSnapping = !isDoor && distSeg < thresh;  // Don't show snap UI on doors
    //   const isProximity = distSeg < CORNER_PROXIMITY * 2;
    //   const alpha = isSnapping ? 0.95 : isProximity ? 0.65 : (isDoor ? 0.7 : 0.35);
    //   const lw = isSnapping ? 2.5 : isProximity ? 1.8 : (isDoor ? 2 : 1);

    //   ctx.save();
      
    //   // Apply dashed pattern for doors
    //   if (dashPattern.length) {
    //     ctx.setLineDash(dashPattern);
    //   }
      
    //   ctx.beginPath();
    //   ctx.moveTo(line.x1, line.y1);
    //   ctx.lineTo(line.x2, line.y2);
    //   ctx.strokeStyle = colour.stroke.replace(/[\d.]+\)$/, `${alpha})`);
    //   ctx.lineWidth = lw;
    //   ctx.stroke();
      
    //   // Reset dash pattern
    //   if (dashPattern.length) {
    //     ctx.setLineDash([]);
    //   }

    //   // Show label on hover (only for non-door lines, or show DOOR label)
    //   if (isSnapping && cursor && !isDoor) {
    //     ctx.beginPath();
    //     ctx.arc(snapPt.x, snapPt.y, 7, 0, Math.PI * 2);
    //     ctx.fillStyle = colour.fill;
    //     ctx.fill();
    //     ctx.strokeStyle = 'white';
    //     ctx.lineWidth = 1.5;
    //     ctx.stroke();
    //     ctx.font = 'bold 9px ui-monospace,monospace';
    //     ctx.textAlign = 'center';
    //     ctx.textBaseline = 'middle';
    //     const label = line.label ? line.label.toUpperCase() : 'LINE';
    //     const tw = ctx.measureText(label).width + 8;
    //     ctx.fillStyle = 'rgba(0,0,0,0.80)';
    //     ctx.fillRect(snapPt.x - tw / 2, snapPt.y - 23, tw, 13);
    //     ctx.fillStyle = colour.fill;
    //     ctx.fillText(label, snapPt.x, snapPt.y - 16);
    //   } else if (isDoor && cursor && distSeg < thresh) {
    //     // Show "DOOR" label when hovering over door swing
    //     ctx.beginPath();
    //     ctx.arc(snapPt.x, snapPt.y, 7, 0, Math.PI * 2);
    //     ctx.fillStyle = SVG_DOOR_LINE_COLOUR.fill;
    //     ctx.fill();
    //     ctx.strokeStyle = 'white';
    //     ctx.lineWidth = 1.5;
    //     ctx.stroke();
    //     ctx.font = 'bold 9px ui-monospace,monospace';
    //     ctx.textAlign = 'center';
    //     ctx.textBaseline = 'middle';
    //     ctx.fillStyle = 'rgba(0,0,0,0.80)';
    //     ctx.fillRect(snapPt.x - 28, snapPt.y - 23, 56, 13);
    //     ctx.fillStyle = SVG_DOOR_LINE_COLOUR.fill;
    //     ctx.fillText('DOOR', snapPt.x, snapPt.y - 16);
    //   }
    //   ctx.restore();
    // }

    // ── Layer 2: SVG area outlines ────────────────────────────────────────────────
    for (const area of svgAreasRef.current) {
      if (area.points.length < 3) continue;

      const isDoor = area.label === 'door' || !!area.isDoor;

      ctx.save();

      if (isDoor) {
        // points = [pivot, ...interpolated arc pts]
        // Just stroke the shape directly — no arc() needed
        const pivot = area.points[0];
        const arcPts = area.points.slice(1);
        if (arcPts.length < 2) { ctx.restore(); continue; }

        const arcStart = arcPts[0];
        const arcEnd   = arcPts[arcPts.length - 1];

        const isHovered = cursor && (() => {
          const dx = cursor.x - pivot.x, dy = cursor.y - pivot.y;
          const r  = Math.hypot(arcStart.x - pivot.x, arcStart.y - pivot.y);
          const cursorR = Math.hypot(dx, dy);
          return Math.abs(cursorR - r) < CORNER_PROXIMITY;
        })();

        const alpha = isHovered ? 0.95 : 0.75;
        const lw    = isHovered ? 2.5  : 1.8;

        // Door leaf (pivot → arcStart)
        ctx.beginPath();
        ctx.moveTo(pivot.x, pivot.y);
        ctx.lineTo(arcStart.x, arcStart.y);
        ctx.strokeStyle = `rgba(34,197,94,${alpha})`;
        ctx.lineWidth   = lw + 0.5;
        ctx.stroke();

        // Door swing arc (polyline through interpolated points)
        ctx.beginPath();
        ctx.moveTo(arcPts[0].x, arcPts[0].y);
        for (let i = 1; i < arcPts.length; i++) ctx.lineTo(arcPts[i].x, arcPts[i].y);
        ctx.strokeStyle = `rgba(34,197,94,${alpha})`;
        ctx.lineWidth   = lw;
        ctx.setLineDash([6, 4]);
        ctx.stroke();
        ctx.setLineDash([]);

        // Closing line (arcEnd → pivot, faint)
        ctx.beginPath();
        ctx.moveTo(pivot.x, pivot.y);
        ctx.lineTo(arcEnd.x, arcEnd.y);
        ctx.strokeStyle = `rgba(34,197,94,${alpha * 0.5})`;
        ctx.lineWidth   = 1;
        ctx.stroke();

        // Hover label
        if (isHovered && cursor) {
          const midIdx = Math.floor(arcPts.length / 2);
          const mid = arcPts[midIdx];
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
        // Non-door area — existing logic unchanged
        const colour = SVG_AREA_COLOUR;

        const centroidX = area.points.reduce((s, p) => s + p.x, 0) / area.points.length;
        const centroidY = area.points.reduce((s, p) => s + p.y, 0) / area.points.length;

        let distEdge = Infinity;
        let snapPt = { x: centroidX, y: centroidY };

        if (cursor) {
          const e = closestPointOnPolygonEdge(cursor.x, cursor.y, area.points);
          distEdge = e.dist;
          snapPt = { x: e.x, y: e.y };
        }

        const isSnapping  = distEdge < thresh;
        const isProximity = distEdge < CORNER_PROXIMITY * 2;
        const alpha = isSnapping ? 0.95 : isProximity ? 0.65 : 0.25;
        const lw    = isSnapping ? 2.5  : isProximity ? 1.8  : 1;

        ctx.beginPath();
        ctx.moveTo(area.points[0].x, area.points[0].y);
        area.points.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
        ctx.closePath();
        ctx.strokeStyle = colour.stroke.replace(/[\d.]+\)$/, `${alpha})`);
        ctx.lineWidth = lw;
        ctx.stroke();

        if (isSnapping && cursor) {
          ctx.beginPath();
          ctx.arc(snapPt.x, snapPt.y, 7, 0, Math.PI * 2);
          ctx.fillStyle = colour.fill;
          ctx.fill();
          ctx.strokeStyle = 'white';
          ctx.lineWidth = 1.5;
          ctx.stroke();
          ctx.font = 'bold 9px ui-monospace,monospace';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          const label = area.label ? area.label.toUpperCase() : 'AREA';
          const tw = ctx.measureText(label).width + 8;
          ctx.fillStyle = 'rgba(0,0,0,0.80)';
          ctx.fillRect(snapPt.x - tw / 2, snapPt.y - 23, tw, 13);
          ctx.fillStyle = colour.fill;
          ctx.fillText(label, snapPt.x, snapPt.y - 16);
        }
      }

      ctx.restore();
    }

    // ── Layer 3: SVG discrete snap points (arc-center only for doors) ────────
    const svgCandidates = getSvgPointCandidates();
    const doorAreas = svgAreasRef.current.filter(a => a.label === 'door' || a.isDoor);

    for (const c of svgCandidates) {
      const col = SVG_SNAP_COLOURS[c.type];
      if (!col) continue;

      // Suppress all non-arc-center points that lie inside a door area bounding box
      if (c.type !== 'arc-center') {
        const insideDoor = doorAreas.some(da => {
          const pad = 20;
          return (
            c.x >= da.bounds.minX - pad && c.x <= da.bounds.maxX + pad &&
            c.y >= da.bounds.minY - pad && c.y <= da.bounds.maxY + pad
          );
        });
        if (insideDoor) continue;
      }

      const dist = cursor ? Math.hypot(cursor.x - c.x, cursor.y - c.y) : Infinity;
      const isInSnap = dist < thresh;
      const inRange = dist < CORNER_PROXIMITY;

      // Other snap point types (endpoint, midpoint, centroid, intersection)
      // Skip rendering these if they belong to a door shape
      const isDoorPoint = c.shapeId?.toLowerCase().includes('door') ||
                          c.shapeId?.toLowerCase().includes('swing');
      
      if (isDoorPoint) {
        // Door endpoints/midpoints are filtered out (don't render)
        continue;
      }

      if (!cursor || !inRange) {
        ctx.beginPath();
        ctx.arc(c.x, c.y, 2, 0, Math.PI * 2);
        ctx.strokeStyle = col.dot;
        ctx.lineWidth = 1.2;
        ctx.stroke();
        continue;
      }

      const alpha = Math.max(0, 1 - dist / CORNER_PROXIMITY);
      const isClose = dist < 20;
      const size = isClose ? 7 : 4;

      ctx.save();
      if (isInSnap) {
        ctx.beginPath();
        ctx.arc(c.x, c.y, 8, 0, Math.PI * 2);
        ctx.fillStyle = col.fill;
        ctx.fill();
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(c.x - 12, c.y);
        ctx.lineTo(c.x + 12, c.y);
        ctx.moveTo(c.x, c.y - 12);
        ctx.lineTo(c.x, c.y + 12);
        ctx.strokeStyle = 'rgba(255,255,255,0.7)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.font = 'bold 9px ui-monospace,monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const label = c.type.toUpperCase();
        const tw = ctx.measureText(label).width + 8;
        ctx.fillStyle = 'rgba(0,0,0,0.80)';
        ctx.fillRect(c.x - tw / 2, c.y - 23, tw, 13);
        ctx.fillStyle = col.fill;
        ctx.fillText(label, c.x, c.y - 16);
      } else {
        const rgbaStroke = col.dot.replace(/[\d.]+\)$/, `${alpha})`);
        ctx.strokeStyle = rgbaStroke;
        ctx.lineWidth = isClose ? 1.5 : 1;
        ctx.beginPath();
        ctx.moveTo(c.x - size, c.y);
        ctx.lineTo(c.x + size, c.y);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(c.x, c.y - size);
        ctx.lineTo(c.x, c.y + size);
        ctx.stroke();
        if (isClose) {
          ctx.strokeStyle = col.ring.replace(/[\d.]+\)$/, `${alpha * 0.5})`);
          ctx.beginPath();
          ctx.arc(c.x, c.y, 11, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      ctx.restore();
    }
  }, [pinCanvasRef, pdfDimensionsRef, getSvgPointCandidates]);

  // Redraw on changes
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