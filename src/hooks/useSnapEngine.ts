import { useRef, useState, useCallback, useEffect } from 'react';
import type { SvgSnapPoint } from '@/hooks/useSvgSnapPoints';
import type { SvgLine, SvgArea } from '@/hooks/useSvgInteraction';

type PdfDimensions       = { w: number; h: number };
type ExtractionResult    = any;
type PageExtractionState = any;
type SnapFlash           = { x: number; y: number; id: number };
type SnapResult          = { point: { x: number; y: number }; snapped: boolean };

export interface LinearChainPoint {
  x: number;
  y: number;
  type: SvgSnapPoint['type'] | 'free';
  label?: string;
}

export type { ExtractionResult, PageExtractionState, SnapFlash, SnapResult, PdfDimensions };

// ── Snap point visual styles ───────────────────────────────────────────────────

const SVG_SNAP_COLOURS: Record<SvgSnapPoint['type'], { dot: string; ring: string; fill: string }> = {
  endpoint:     { dot: 'rgba(245,158,11,0.85)',  ring: 'rgba(245,158,11,0.5)',  fill: '#f59e0b' },
  midpoint:     { dot: 'rgba(16,185,129,0.85)',  ring: 'rgba(16,185,129,0.5)',  fill: '#10b981' },
  centroid:     { dot: 'rgba(139,92,246,0.85)',  ring: 'rgba(139,92,246,0.5)',  fill: '#8b5cf6' },
  intersection: { dot: 'rgba(244,63,94,0.85)',   ring: 'rgba(244,63,94,0.5)',   fill: '#f43f5e' },
};

const SNAP_SIZE: Record<SvgSnapPoint['type'], number> = {
  intersection: 1.6,
  endpoint:     1.0,
  midpoint:     0.85,
  centroid:     0.85,
};

const SVG_LINE_COLOUR = { base: 'rgba(56,189,248,{a})', fill: '#38bdf8' };
const SVG_AREA_COLOUR = { stroke: 'rgba(251,146,60,{a})', fill: '#fb923c' };

function withAlpha(template: string, a: number): string {
  return template.replace('{a}', String(a.toFixed(2)));
}

// ── Viewport transform helpers ─────────────────────────────────────────────────

interface ViewTransform {
  zoom: number;
  panX: number;
  panY: number;
  dpr:  number;
}

// SVG units → canvas pixels
function svgToCanvas(x: number, y: number, vt: ViewTransform): { x: number; y: number } {
  return {
    x: (x * vt.zoom + vt.panX) * vt.dpr,
    y: (y * vt.zoom + vt.panY) * vt.dpr,
  };
}

// Viewport CSS pixels → canvas pixels
function vpToCanvas(x: number, y: number, dpr: number): { x: number; y: number } {
  return { x: x * dpr, y: y * dpr };
}

export interface UseSnapEngineParams {
  pinCanvasRef:      React.RefObject<HTMLCanvasElement>;
  viewportRef:       React.RefObject<HTMLDivElement>;
  pdfDimensionsRef:  React.MutableRefObject<PdfDimensions | null>;
  pageNumberRef:     React.MutableRefObject<number>;
  snapEnabled:       boolean;
  showPins:          boolean;
  snapThreshold:     number;
  confidenceFilter:  number;
  proximityRadius?:  number;
  linearMode?:       boolean;
  svgSnapPoints?:    SvgSnapPoint[];
  svgLines?:         SvgLine[];
  svgAreas?:         SvgArea[];
  zoom:              number;
  pan:               { x: number; y: number };
}

export interface UseSnapEngineReturn {
  pageData:             Map<number, PageExtractionState>;
  analysisStatus:       'idle' | 'analyzing' | 'done';
  analysisPage:         { current: number; total: number } | null;
  snapFlashes:          SnapFlash[];
  linearChain:          LinearChainPoint[];
  startExtraction:      (pdf: any, file?: File) => void;
  getScaledCorners:     (pageIdx: number) => Array<{ x: number; y: number; confidence: number }>;
  getScaledWallCorners: (pageIdx: number) => Array<{ x: number; y: number; confidence: number; lineIndices: number[] }>;
  getScaledWallLines:   (pageIdx: number) => Array<{ x1: number; y1: number; x2: number; y2: number; angle: number; length: number }>;
  snapToCorner:         (rawX: number, rawY: number) => SnapResult;
  triggerSnapFlash:     (x: number, y: number) => void;
  addChainPoint:        (x: number, y: number, type?: SvgSnapPoint['type'] | 'free') => void;
  undoChainPoint:       () => void;
  clearChain:           () => void;
  redrawPinCanvas:      () => void;
  cursorPointRef:       React.MutableRefObject<{ x: number; y: number } | null>;
}

export function useSnapEngine({
  pinCanvasRef,
  viewportRef,
  pdfDimensionsRef,
  pageNumberRef,
  snapEnabled,
  showPins,
  snapThreshold,
  confidenceFilter,
  proximityRadius = 120,
  linearMode      = false,
  svgSnapPoints   = [],
  svgLines        = [],
  svgAreas        = [],
  zoom,
  pan,
}: UseSnapEngineParams): UseSnapEngineReturn {

  const snapEnabledRef      = useRef(snapEnabled);
  const showPinsRef         = useRef(showPins);
  const snapThresholdRef    = useRef(snapThreshold);
  const confidenceFilterRef = useRef(confidenceFilter);
  const proximityRadiusRef  = useRef(proximityRadius);
  const linearModeRef       = useRef(linearMode);
  const svgSnapPointsRef    = useRef<SvgSnapPoint[]>(svgSnapPoints);
  const svgLinesRef         = useRef<SvgLine[]>(svgLines);
  const svgAreasRef         = useRef<SvgArea[]>(svgAreas);
  const zoomRef             = useRef(zoom);
  const panRef              = useRef(pan);

  useEffect(() => { snapEnabledRef.current      = snapEnabled;      }, [snapEnabled]);
  useEffect(() => { showPinsRef.current         = showPins;         }, [showPins]);
  useEffect(() => { snapThresholdRef.current    = snapThreshold;    }, [snapThreshold]);
  useEffect(() => { confidenceFilterRef.current = confidenceFilter; }, [confidenceFilter]);
  useEffect(() => { proximityRadiusRef.current  = proximityRadius;  }, [proximityRadius]);
  useEffect(() => { linearModeRef.current       = linearMode;       }, [linearMode]);
  useEffect(() => { svgSnapPointsRef.current    = svgSnapPoints;    }, [svgSnapPoints]);
  useEffect(() => { svgLinesRef.current         = svgLines;         }, [svgLines]);
  useEffect(() => { svgAreasRef.current         = svgAreas;         }, [svgAreas]);
  useEffect(() => { zoomRef.current             = zoom;             }, [zoom]);
  useEffect(() => { panRef.current              = pan;              }, [pan]);

  const [pageData]       = useState<Map<number, PageExtractionState>>(new Map());
  const [analysisStatus] = useState<'idle' | 'analyzing' | 'done'>('done');
  const [analysisPage]   = useState<{ current: number; total: number } | null>(null);
  const [snapFlashes, setSnapFlashes] = useState<SnapFlash[]>([]);
  const [linearChain, setLinearChain] = useState<LinearChainPoint[]>([]);

  const cursorPointRef = useRef<{ x: number; y: number } | null>(null);
  const linearChainRef = useRef<LinearChainPoint[]>([]);
  const flashIdRef     = useRef(0);

  // FIX: keep a debug-once flag so we don't spam the console
  const debugLoggedRef = useRef(false);

  useEffect(() => { linearChainRef.current = linearChain; }, [linearChain]);

  const startExtraction      = useCallback((_pdf: any, _file?: File) => {}, []);
  const getScaledCorners     = useCallback(() => [], []);
  const getScaledWallCorners = useCallback(() => [], []);
  const getScaledWallLines   = useCallback(() => [], []);

  /** Returns snap point candidates in SVG-unit coordinates. */
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

  const getAreaPixelBounds = useCallback((area: SvgArea, dims: PdfDimensions) => ({
    minX: area.bounds.minNX * dims.w, minY: area.bounds.minNY * dims.h,
    maxX: area.bounds.maxNX * dims.w, maxY: area.bounds.maxNY * dims.h,
  }), []);

  const getAreaPixelPoints = useCallback((area: SvgArea, dims: PdfDimensions) =>
    area.points.map(p => ({ x: p.nx * dims.w, y: p.ny * dims.h })),
  []);

  const snapToCorner = useCallback((rawX: number, rawY: number): SnapResult => {
    if (!snapEnabledRef.current || !pdfDimensionsRef.current)
      return { point: { x: rawX, y: rawY }, snapped: false };

    const thresh = snapThresholdRef.current / zoomRef.current;
    let bestPoint: { x: number; y: number } | null = null;
    let bestDist  = thresh;

    for (const c of getSvgPointCandidates()) {
      const bonus = c.type === 'intersection' ? 1.4 : 1.0;
      const dist  = Math.hypot(rawX - c.x, rawY - c.y);
      if (dist < bestDist * bonus) { bestDist = dist / bonus; bestPoint = { x: c.x, y: c.y }; }
    }

    if (!bestPoint) {
      const dims = pdfDimensionsRef.current;
      for (const area of svgAreasRef.current) {
        const b = getAreaPixelBounds(area, dims);
        if (rawX < b.minX - thresh || rawX > b.maxX + thresh ||
            rawY < b.minY - thresh || rawY > b.maxY + thresh) continue;
        const pts = getAreaPixelPoints(area, dims);
        let minD = Infinity, closestPt = { x: rawX, y: rawY };
        for (let i = 0; i < pts.length; i++) {
          const j = (i + 1) % pts.length;
          const ax = rawX - pts[i].x, ay = rawY - pts[i].y;
          const bx = pts[j].x - pts[i].x, by = pts[j].y - pts[i].y;
          const len2 = bx*bx + by*by;
          const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (ax*bx + ay*by) / len2));
          const cx2 = pts[i].x + t * bx, cy2 = pts[i].y + t * by;
          const d = Math.hypot(rawX - cx2, rawY - cy2);
          if (d < minD) { minD = d; closestPt = { x: cx2, y: cy2 }; }
        }
        if (minD < bestDist) { bestDist = minD; bestPoint = closestPt; }
      }
    }

    return bestPoint
      ? { point: bestPoint, snapped: true }
      : { point: { x: rawX, y: rawY }, snapped: false };
  }, [getSvgPointCandidates, getAreaPixelBounds, getAreaPixelPoints]);

  const triggerSnapFlash = useCallback((x: number, y: number) => {
    const id = ++flashIdRef.current;
    setSnapFlashes(prev => [...prev, { x, y, id }]);
    setTimeout(() => setSnapFlashes(prev => prev.filter(f => f.id !== id)), 700);
  }, []);

  const addChainPoint = useCallback((x: number, y: number, type: SvgSnapPoint['type'] | 'free' = 'free') => {
    setLinearChain(prev => [...prev, { x, y, type }]);
  }, []);

  const undoChainPoint = useCallback(() => {
    setLinearChain(prev => prev.slice(0, -1));
  }, []);

  const clearChain = useCallback(() => {
    setLinearChain([]);
  }, []);

  // ── redrawPinCanvas ──────────────────────────────────────────────────────────

  const redrawPinCanvas = useCallback(() => {
    const canvas = pinCanvasRef.current;
    const vp     = viewportRef.current;
    const dims   = pdfDimensionsRef.current;
    if (!canvas || !vp || !dims) return;

    const dpr  = window.devicePixelRatio || 1;
    const vpW  = vp.clientWidth;
    const vpH  = vp.clientHeight;

    if (canvas.width !== Math.round(vpW * dpr) || canvas.height !== Math.round(vpH * dpr)) {
      canvas.width  = Math.round(vpW * dpr);
      canvas.height = Math.round(vpH * dpr);
      canvas.style.width  = `${vpW}px`;
      canvas.style.height = `${vpH}px`;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!showPinsRef.current) return;

    // FIX: read zoom/pan directly from refs (always current)
    const currentZoom = zoomRef.current;
    const currentPan  = panRef.current;
    const vt: ViewTransform = { zoom: currentZoom, panX: currentPan.x, panY: currentPan.y, dpr };
    const s2c = (x: number, y: number) => svgToCanvas(x, y, vt);

    const cursor = cursorPointRef.current;
    const thresh = snapThresholdRef.current;
    const prox   = proximityRadiusRef.current;

    // Cursor in viewport CSS pixels
    const cursorVP = cursor
      ? {
          x: cursor.x * currentZoom + currentPan.x,
          y: cursor.y * currentZoom + currentPan.y,
        }
      : null;

    // FIX: Get candidates ONCE up top, not inside the loop
    const candidates = getSvgPointCandidates();

    // === DIAGNOSTIC: log once when cursor is present and we have points ===
    if (cursor && candidates.length > 0 && !debugLoggedRef.current) {
      debugLoggedRef.current = true;
      const c0 = candidates[0];
      const cp0x = c0.x * currentZoom + currentPan.x; // viewport px
      const cp0y = c0.y * currentZoom + currentPan.y;
      const cvpx = cursor.x * currentZoom + currentPan.x;
      const cvpy = cursor.y * currentZoom + currentPan.y;
      console.log('[SNAP ENGINE DEBUG]', {
        dims,
        zoom: currentZoom,
        pan: currentPan,
        cursor_svgUnits: cursor,
        cursor_vpPx: { x: cvpx, y: cvpy },
        firstPt_svgUnits: { x: c0.x.toFixed(1), y: c0.y.toFixed(1) },
        firstPt_vpPx: { x: cp0x.toFixed(1), y: cp0y.toFixed(1) },
        dist_firstPt_to_cursor_vpPx: Math.hypot(cvpx - cp0x, cvpy - cp0y).toFixed(1),
        prox_radius: prox,
        total_candidates: candidates.length,
        dpr,
      });
      // Log a few more points spread across the range
      const sample = [0, Math.floor(candidates.length/4), Math.floor(candidates.length/2),
                      Math.floor(candidates.length*3/4), candidates.length-1]
        .filter(i=>i<candidates.length)
        .map(i=>({
          type: candidates[i].type,
          svgX: candidates[i].x.toFixed(1),
          svgY: candidates[i].y.toFixed(1),
          vpX: (candidates[i].x * currentZoom + currentPan.x).toFixed(1),
          vpY: (candidates[i].y * currentZoom + currentPan.y).toFixed(1),
        }));
      console.log('[SNAP ENGINE DEBUG] Sample points (vpPx):', sample);
    }
    // Reset debug log flag when cursor leaves
    if (!cursor) debugLoggedRef.current = false;

    // ── Layer 1: SVG area outlines ───────────────────────────────────────────
    for (const area of svgAreasRef.current) {
      if (area.points.length < 3) continue;
      const pts = area.points.map(p => s2c(p.nx * dims.w, p.ny * dims.h));

      let distEdge = Infinity;
      let snapPt = {
        x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
        y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
      };

      if (cursorVP) {
        let minD = Infinity;
        for (let i = 0; i < pts.length; i++) {
          const j = (i + 1) % pts.length;
          const ax = cursorVP.x * dpr - pts[i].x, ay = cursorVP.y * dpr - pts[i].y;
          const bx = pts[j].x - pts[i].x,         by = pts[j].y - pts[i].y;
          const len2 = bx*bx + by*by;
          const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (ax*bx + ay*by) / len2));
          const cx2 = pts[i].x + t * bx, cy2 = pts[i].y + t * by;
          const d = Math.hypot(cursorVP.x * dpr - cx2, cursorVP.y * dpr - cy2) / dpr;
          if (d < minD) { minD = d; distEdge = d; snapPt = { x: cx2, y: cy2 }; }
        }
      }

      if (cursorVP && distEdge > prox) continue;
      const isSnapping = distEdge < thresh;
      const fade       = cursorVP ? Math.max(0, 1 - distEdge / prox) : 0.25;
      const alpha      = isSnapping ? 0.95 : 0.2 + fade * 0.55;
      const lw         = (isSnapping ? 2.5 : 0.5 + fade * 1.5) * dpr;

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      pts.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
      ctx.closePath();
      ctx.strokeStyle = withAlpha(SVG_AREA_COLOUR.stroke, alpha);
      ctx.lineWidth   = lw;
      ctx.stroke();

      if (isSnapping && cursorVP) {
        const r = 7 * dpr;
        ctx.beginPath();
        ctx.arc(snapPt.x, snapPt.y, r, 0, Math.PI * 2);
        ctx.fillStyle   = SVG_AREA_COLOUR.fill;
        ctx.fill();
        ctx.strokeStyle = 'white';
        ctx.lineWidth   = 1.5 * dpr;
        ctx.stroke();
        ctx.font         = `bold ${9 * dpr}px ui-monospace,monospace`;
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        const label = area.label ? area.label.toUpperCase() : 'AREA';
        const tw    = ctx.measureText(label).width + 8 * dpr;
        ctx.fillStyle = 'rgba(0,0,0,0.80)';
        ctx.fillRect(snapPt.x - tw / 2, snapPt.y - 23 * dpr, tw, 13 * dpr);
        ctx.fillStyle = SVG_AREA_COLOUR.fill;
        ctx.fillText(label, snapPt.x, snapPt.y - 16 * dpr);
      }
      ctx.restore();
    }

    // ── Layer 1b: SVG lines ──────────────────────────────────────────────────
    for (const line of svgLinesRef.current) {
      if (!cursorVP) continue;
      const p1  = s2c(line.nx1 * dims.w, line.ny1 * dims.h);
      const p2  = s2c(line.nx2 * dims.w, line.ny2 * dims.h);
      const ax  = cursorVP.x * dpr - p1.x, ay = cursorVP.y * dpr - p1.y;
      const bx  = p2.x - p1.x,             by = p2.y - p1.y;
      const len2 = bx * bx + by * by;
      const t   = len2 === 0 ? 0 : Math.max(0, Math.min(1, (ax * bx + ay * by) / len2));
      const cpx = p1.x + t * bx, cpy = p1.y + t * by;
      const dist = Math.hypot(cursorVP.x * dpr - cpx, cursorVP.y * dpr - cpy) / dpr;
      if (dist > prox) continue;
      const fade  = 1 - dist / prox;
      const alpha = 0.12 + fade * 0.60;
      const lw    = (0.5 + fade * 1.5) * dpr;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.strokeStyle = withAlpha(SVG_LINE_COLOUR.base, alpha);
      ctx.lineWidth   = lw;
      ctx.stroke();
      ctx.restore();
    }

    // ── Layer 2: SVG snap points ─────────────────────────────────────────────
    // Sort so intersections render on top
    const sorted = [...candidates].sort((a, b) => {
      const order: Record<string, number> = { endpoint:0, midpoint:1, centroid:2, intersection:3 };
      return (order[a.type]??0) - (order[b.type]??0);
    });

    for (const c of sorted) {
      const col = SVG_SNAP_COLOURS[c.type as SvgSnapPoint['type']];
      if (!col) continue;

      const cp = s2c(c.x, c.y);
      // FIX: distance in viewport CSS pixels (cp is canvas px, divide by dpr = vp px)
      const cpVpX = cp.x / dpr;
      const cpVpY = cp.y / dpr;

      // If no cursor, draw all points faintly (so you can see them without hovering)
      // FIX: render ALL intersection points always (faint), proximity ones brighter
      const dist = cursorVP
        ? Math.hypot(cursorVP.x - cpVpX, cursorVP.y - cpVpY)
        : Infinity;

      const sizeMul  = SNAP_SIZE[c.type as SvgSnapPoint['type']] ?? 1.0;
      const isInSnap = cursorVP && dist < thresh * (c.type === 'intersection' ? 1.4 : 1.0);
      const isInProx = cursorVP && dist <= prox;
      const isInter  = c.type === 'intersection';

      // FIX: Always render intersection points as small dots even outside proximity
      // so user can see where corners ARE even before hovering near them
      if (!isInProx && isInter) {
        // Tiny always-visible dot for intersection points
        ctx.save();
        ctx.beginPath();
        ctx.arc(cp.x, cp.y, 2.5 * dpr * sizeMul, 0, Math.PI * 2);
        ctx.fillStyle = col.dot.replace(/[\d.]+\)$/, '0.35)');
        ctx.fill();
        ctx.restore();
        continue;
      }

      if (!isInProx) continue; // non-intersection points only show in proximity

      ctx.save();

      if (isInSnap) {
        const r = 8 * dpr * sizeMul;

        if (isInter) {
          // Intersection: filled square with corner tick marks
          const half = r * 0.75;

          ctx.beginPath();
          ctx.arc(cp.x, cp.y, r * 1.5, 0, Math.PI * 2);
          ctx.strokeStyle = col.ring.replace(/[\d.]+\)$/, '0.35)');
          ctx.lineWidth   = 2 * dpr;
          ctx.stroke();

          ctx.fillStyle   = col.fill;
          ctx.strokeStyle = 'white';
          ctx.lineWidth   = 2 * dpr;
          ctx.beginPath();
          ctx.rect(cp.x - half, cp.y - half, half * 2, half * 2);
          ctx.fill();
          ctx.stroke();

          const tk = half + 5 * dpr;
          ctx.strokeStyle = col.fill;
          ctx.lineWidth   = 1.5 * dpr;
          for (const [sx2, sy2] of [[-1,-1],[1,-1],[1,1],[-1,1]] as const) {
            ctx.beginPath();
            ctx.moveTo(cp.x + sx2 * half, cp.y + sy2 * tk);
            ctx.lineTo(cp.x + sx2 * half, cp.y + sy2 * half);
            ctx.lineTo(cp.x + sx2 * tk,   cp.y + sy2 * half);
            ctx.stroke();
          }

          ctx.font         = `bold ${9 * dpr}px ui-monospace,monospace`;
          ctx.textAlign    = 'center';
          ctx.textBaseline = 'middle';
          const label = 'CORNER';
          const tw    = ctx.measureText(label).width + 8 * dpr;
          ctx.fillStyle = 'rgba(0,0,0,0.85)';
          ctx.fillRect(cp.x - tw / 2, cp.y - 26 * dpr, tw, 13 * dpr);
          ctx.fillStyle = col.fill;
          ctx.fillText(label, cp.x, cp.y - 19 * dpr);

        } else {
          // Other types: circle + crosshair
          ctx.beginPath();
          ctx.arc(cp.x, cp.y, r, 0, Math.PI * 2);
          ctx.fillStyle   = col.fill;
          ctx.fill();
          ctx.strokeStyle = 'white';
          ctx.lineWidth   = 2 * dpr;
          ctx.stroke();
          const ch = 12 * dpr;
          ctx.beginPath();
          ctx.moveTo(cp.x - ch, cp.y); ctx.lineTo(cp.x + ch, cp.y);
          ctx.moveTo(cp.x, cp.y - ch); ctx.lineTo(cp.x, cp.y + ch);
          ctx.strokeStyle = 'rgba(255,255,255,0.7)';
          ctx.lineWidth   = 1 * dpr;
          ctx.stroke();
          ctx.font         = `bold ${9 * dpr}px ui-monospace,monospace`;
          ctx.textAlign    = 'center';
          ctx.textBaseline = 'middle';
          const label = c.type.toUpperCase();
          const tw    = ctx.measureText(label).width + 8 * dpr;
          ctx.fillStyle = 'rgba(0,0,0,0.80)';
          ctx.fillRect(cp.x - tw / 2, cp.y - 23 * dpr, tw, 13 * dpr);
          ctx.fillStyle = col.fill;
          ctx.fillText(label, cp.x, cp.y - 16 * dpr);
        }

      } else {
        // Proximity indicator (not yet snapping)
        const fade = 1 - dist / prox;
        const sz = (3 + fade * 5) * dpr * sizeMul;
        const a  = 0.15 + fade * 0.70;

        if (isInter) {
          ctx.strokeStyle = col.dot.replace(/[\d.]+\)$/, `${a.toFixed(2)})`);
          ctx.lineWidth   = (1 + fade * 1) * dpr;
          ctx.beginPath();
          ctx.moveTo(cp.x,           cp.y - sz * 1.4);
          ctx.lineTo(cp.x + sz*1.4,  cp.y);
          ctx.lineTo(cp.x,           cp.y + sz * 1.4);
          ctx.lineTo(cp.x - sz*1.4,  cp.y);
          ctx.closePath();
          ctx.stroke();
          if (fade > 0.3) {
            ctx.fillStyle = col.dot.replace(/[\d.]+\)$/, `${(a * 0.2).toFixed(2)})`);
            ctx.fill();
          }
        } else {
          ctx.strokeStyle = col.dot.replace(/[\d.]+\)$/, `${a.toFixed(2)})`);
          ctx.lineWidth   = (0.7 + fade * 0.8) * dpr;
          ctx.beginPath();
          ctx.moveTo(cp.x - sz, cp.y); ctx.lineTo(cp.x + sz, cp.y); ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(cp.x, cp.y - sz); ctx.lineTo(cp.x, cp.y + sz); ctx.stroke();
          if (fade > 0.45) {
            ctx.strokeStyle = col.ring.replace(/[\d.]+\)$/, `${(a * 0.45).toFixed(2)})`);
            ctx.beginPath();
            ctx.arc(cp.x, cp.y, sz + 5 * dpr, 0, Math.PI * 2);
            ctx.stroke();
          }
        }
      }
      ctx.restore();
    }

    // ── Layer 3: Linear chain ────────────────────────────────────────────────
    const chain = linearChainRef.current;

    if (chain.length >= 2) {
      const cp0 = s2c(chain[0].x, chain[0].y);
      ctx.save();
      ctx.strokeStyle = 'rgba(245,158,11,0.90)';
      ctx.lineWidth   = 1.5 * dpr;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(cp0.x, cp0.y);
      for (let i = 1; i < chain.length; i++) {
        const cp = s2c(chain[i].x, chain[i].y);
        ctx.lineTo(cp.x, cp.y);
      }
      ctx.stroke();
      ctx.restore();

      for (let i = 1; i < chain.length; i++) {
        const ca = s2c(chain[i - 1].x, chain[i - 1].y);
        const cb = s2c(chain[i].x, chain[i].y);
        const mx = (ca.x + cb.x) / 2, my = (ca.y + cb.y) / 2;
        const distLabel = Math.hypot(chain[i].x - chain[i-1].x, chain[i].y - chain[i-1].y).toFixed(1);
        ctx.save();
        ctx.font         = `bold ${9 * dpr}px ui-monospace,monospace`;
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        const tw = ctx.measureText(distLabel).width + 6 * dpr;
        ctx.fillStyle = 'rgba(0,0,0,0.80)';
        ctx.fillRect(mx - tw / 2, my - 8 * dpr, tw, 13 * dpr);
        ctx.fillStyle = '#f59e0b';
        ctx.fillText(distLabel, mx, my - 1 * dpr);
        ctx.restore();
      }

      if (cursorVP && linearModeRef.current) {
        const last = s2c(chain[chain.length - 1].x, chain[chain.length - 1].y);
        const curC = vpToCanvas(cursorVP.x, cursorVP.y, dpr);
        ctx.save();
        ctx.strokeStyle = 'rgba(245,158,11,0.35)';
        ctx.lineWidth   = 1 * dpr;
        ctx.setLineDash([4 * dpr, 4 * dpr]);
        ctx.beginPath();
        ctx.moveTo(last.x, last.y);
        ctx.lineTo(curC.x, curC.y);
        ctx.stroke();
        ctx.restore();
      }
    }

    for (let i = 0; i < chain.length; i++) {
      const p  = chain[i];
      const cp = s2c(p.x, p.y);
      const col = p.type !== 'free'
        ? SVG_SNAP_COLOURS[p.type as SvgSnapPoint['type']]?.fill ?? '#f59e0b'
        : '#f59e0b';
      const r = 5 * dpr;
      ctx.save();
      ctx.beginPath();
      ctx.arc(cp.x, cp.y, r, 0, Math.PI * 2);
      ctx.fillStyle   = col;
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth   = 1.5 * dpr;
      ctx.stroke();
      ctx.font         = `bold ${7 * dpr}px ui-monospace,monospace`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle    = '#000';
      ctx.fillText(String(i + 1), cp.x, cp.y + 0.5 * dpr);
      ctx.restore();
    }

    // ── Proximity circle guide ───────────────────────────────────────────────
    if (cursorVP) {
      const cc = vpToCanvas(cursorVP.x, cursorVP.y, dpr);
      ctx.save();
      ctx.beginPath();
      ctx.arc(cc.x, cc.y, prox * dpr, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(100,100,100,0.10)';
      ctx.lineWidth   = 0.8 * dpr;
      ctx.setLineDash([3 * dpr, 4 * dpr]);
      ctx.stroke();
      ctx.restore();
    }

  }, [pinCanvasRef, viewportRef, pdfDimensionsRef, getSvgPointCandidates, getAreaPixelBounds]);

  useEffect(() => {
    redrawPinCanvas();
  }, [redrawPinCanvas, showPins, snapThreshold, svgSnapPoints, svgLines, svgAreas, linearChain, zoom, pan]);

  return {
    pageData,
    analysisStatus,
    analysisPage,
    snapFlashes,
    linearChain,
    startExtraction,
    getScaledCorners,
    getScaledWallCorners,
    getScaledWallLines,
    snapToCorner,
    triggerSnapFlash,
    addChainPoint,
    undoChainPoint,
    clearChain,
    redrawPinCanvas,
    cursorPointRef,
  };
}