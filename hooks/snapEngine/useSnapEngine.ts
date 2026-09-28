'use client';

/**
 * useSnapEngine
 *
 * Drop-in replacement that accepts raw PDF geometry types (PdfLine, PdfCurve,
 * SnapPoint) directly from usePdfDocument — no SvgLine/SvgSnapPoint conversion.
 *
 * RENDERING: Matches the SVG snap engine visual style exactly:
 *   - Secondary candidates: hollow ring + centre dot + type badge (e/m/i/c/n)
 *   - Primary candidate approaching: growing crosshair arms + faint ring
 *   - Primary candidate locked (snapped): filled dot + white ring + crosshair arms
 *   - Proximity circle guide: dashed ring around cursor when near any candidate
 *   - Per-type colors: endpoint=amber, midpoint=green, centroid=purple,
 *                      intersection=red, curve-node=cyan
 *
 * COLORS (matching SVG engine exactly):
 *   endpoint     → amber  #f59e0b
 *   midpoint     → green  #10b981
 *   centroid     → purple #8b5cf6
 *   intersection → red    #f43f5e
 *   curve-node   → cyan   #22d3ee
 */

import { useRef, useState, useCallback, useEffect } from 'react';
import type { PdfLine, PdfCurve, SnapPoint } from '@/types/snapTypes';

// ─── Re-exported convenience types ───────────────────────────────────────────

export type SnapFlash  = { x: number; y: number; id: number };
export type SnapResult = { point: { x: number; y: number }; snapped: boolean; type: string | null };

export interface LinearChainPoint {
  x: number; y: number; type: string; label?: string;
}

// ─── Worker (source: workers/snapPins.worker.js) ─────────────────────────────

function createSnapWorker(): Worker {
  return new Worker(new URL('../../workers/snapPins.worker.js', import.meta.url));
}

// ─── Transferred-canvas guard ─────────────────────────────────────────────────

const transferredCanvases = new WeakMap<HTMLCanvasElement, true>();

// ─── Main-thread helpers ──────────────────────────────────────────────────────

function closestPointOnSegment(
  px: number, py: number,
  x1: number, y1: number,
  x2: number, y2: number,
): { x: number; y: number } {
  const ax = px - x1, ay = py - y1;
  const bx = x2 - x1, by = y2 - y1;
  const len2 = bx * bx + by * by;
  if (len2 === 0) return { x: x1, y: y1 };
  const t = Math.max(0, Math.min(1, (ax * bx + ay * by) / len2));
  return { x: x1 + t * bx, y: y1 + t * by };
}

// ─── Spatial grid (main thread) ───────────────────────────────────────────────

interface Candidate {
  x: number; y: number; type: string; sourceId?: string;
}

interface SpatialGrid {
  cells: Map<string, Candidate[]>;
  cellSize: number;
}

function buildGridMain(candidates: Candidate[], cellSize: number): SpatialGrid {
  const cells = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const key = `${Math.floor(c.x / cellSize)},${Math.floor(c.y / cellSize)}`;
    let bucket = cells.get(key);
    if (!bucket) { bucket = []; cells.set(key, bucket); }
    bucket.push(c);
  }
  return { cells, cellSize };
}

function queryGridMain(grid: SpatialGrid, x: number, y: number, radius: number): Candidate[] {
  const { cells, cellSize } = grid;
  const r  = Math.ceil(radius / cellSize);
  const cx = Math.floor(x / cellSize);
  const cy = Math.floor(y / cellSize);
  const out: Candidate[] = [];
  for (let dx = -r; dx <= r; dx++)
    for (let dy = -r; dy <= r; dy++) {
      const b = cells.get(`${cx + dx},${cy + dy}`);
      if (b) out.push(...b);
    }
  return out;
}

// ─── Hook params ──────────────────────────────────────────────────────────────

export interface UseSnapEngineParams {
  pinCanvasRef:     React.RefObject<HTMLCanvasElement | null>;
  viewportRef:      React.RefObject<HTMLDivElement | null>;
  snapEnabled:      boolean;
  showPins:         boolean;
  snapThreshold:    number;
  lines?:           PdfLine[];
  curves?:          PdfCurve[];
  snapPoints?:      SnapPoint[];
  activeTool?:      string;
  zoom:             number;
  pan:              { x: number; y: number };
  proximityRadius?: number;
}

export interface UseSnapEngineReturn {
  snapFlashes:      SnapFlash[];
  snapToCorner:     (canvasX: number, canvasY: number) => SnapResult;
  triggerSnapFlash: (x: number, y: number) => void;
  redrawPinCanvas:  () => void;
  cursorPointRef:   React.MutableRefObject<{ x: number; y: number } | null>;
  linearChain:      LinearChainPoint[];
  addChainPoint:    (x: number, y: number, type: string) => void;
  undoChainPoint:   () => void;
  clearChain:       () => void;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useSnapEngine({
  pinCanvasRef,
  viewportRef,
  snapEnabled,
  showPins,
  snapThreshold,
  lines      = [],
  curves     = [],
  snapPoints = [],
  activeTool = 'linear',
  zoom,
  pan,
  proximityRadius = 80,
}: UseSnapEngineParams): UseSnapEngineReturn {

  const workerRef      = useRef<Worker | null>(null);
  const workerReadyRef = useRef(false);

  const snapEnabledRef    = useRef(snapEnabled);
  const snapThresholdRef  = useRef(snapThreshold);
  const linesRef          = useRef(lines);
  const proximityRef      = useRef(proximityRadius);
  const showPinsRef       = useRef(showPins);
  const zoomRef           = useRef(zoom);

  useEffect(() => { snapEnabledRef.current   = snapEnabled;    }, [snapEnabled]);
  useEffect(() => { snapThresholdRef.current = snapThreshold;  }, [snapThreshold]);
  useEffect(() => { linesRef.current         = lines;          }, [lines]);
  useEffect(() => { proximityRef.current     = proximityRadius; }, [proximityRadius]);
  useEffect(() => { showPinsRef.current      = showPins;       }, [showPins]);
  useEffect(() => { zoomRef.current          = zoom;           }, [zoom]);

  const candidatesCacheRef = useRef<Candidate[]>([]);
  const spatialGridRef     = useRef<SpatialGrid | null>(null);
  const workerInitedRef    = useRef(false);

  const [snapFlashes, setSnapFlashes] = useState<SnapFlash[]>([]);
  const [linearChain, setLinearChain] = useState<LinearChainPoint[]>([]);

  const cursorPointRef = useRef<{ x: number; y: number } | null>(null);
  const flashIdRef     = useRef(0);

  const post = useCallback((msg: object) => {
    if (workerRef.current && workerReadyRef.current)
      workerRef.current.postMessage(msg);
  }, []);

  // ── Spawn worker ──────────────────────────────────────────────────────────
  useEffect(() => {
    const worker = createSnapWorker();
    workerRef.current      = worker;
    workerReadyRef.current = true;
    return () => {
      worker.terminate();
      workerRef.current       = null;
      workerReadyRef.current  = false;
      workerInitedRef.current = false;
      const canvas = pinCanvasRef.current;
      if (canvas) transferredCanvases.delete(canvas);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Transfer OffscreenCanvas + init ───────────────────────────────────────
  useEffect(() => {
    const canvas = pinCanvasRef.current;
    const worker = workerRef.current;
    if (!canvas || !worker) return;

    if (!transferredCanvases.has(canvas)) {
      if (!('transferControlToOffscreen' in canvas)) return;
      try {
        const offscreen = canvas.transferControlToOffscreen();
        const vp        = viewportRef?.current;
        transferredCanvases.set(canvas, true);
        workerInitedRef.current = true;
        worker.postMessage(
          {
            type: 'init', canvas: offscreen,
            dpr:  window.devicePixelRatio || 1,
            vpW:  vp?.clientWidth  ?? 800,
            vpH:  vp?.clientHeight ?? 600,
            zoom, panX: pan.x, panY: pan.y,
            lines, curves,
            candidates:     candidatesCacheRef.current,
            snapThreshold,
            proximityRadius,
            showPins,
            activeTool,
          },
          [offscreen],
        );
      } catch {
        transferredCanvases.set(canvas, true);
        workerInitedRef.current = true;
      }
    } else if (workerInitedRef.current && candidatesCacheRef.current.length > 0) {
      worker.postMessage({
        type: 'data',
        lines,
        curves,
        candidates: candidatesCacheRef.current,
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapPoints.length]);

  // ── Data effect — lines, curves, snapPoints ───────────────────────────────
  const lastLinesRef      = useRef<PdfLine[]>([]);
  const lastCurvesRef     = useRef<PdfCurve[]>([]);
  const lastSnapPointsRef = useRef<SnapPoint[]>([]);

  useEffect(() => {
    const unchanged =
      lines      === lastLinesRef.current &&
      curves     === lastCurvesRef.current &&
      snapPoints === lastSnapPointsRef.current;
    if (unchanged) return;

    lastLinesRef.current      = lines;
    lastCurvesRef.current     = curves;
    lastSnapPointsRef.current = snapPoints;

    // snapPoints carry absolute canvas-space x/y (resolved upstream in Viewer.tsx)
    const cands: Candidate[] = snapPoints.map(sp => ({
      x:        (sp as any).x ?? sp.nx,
      y:        (sp as any).y ?? sp.ny,
      type:     sp.type,
      sourceId: sp.sourceId,
    }));

    candidatesCacheRef.current = cands;
    spatialGridRef.current     = buildGridMain(cands, proximityRadius);

    const canvas = pinCanvasRef.current;
    if (canvas && transferredCanvases.has(canvas)) {
      post({ type: 'data', lines, curves, candidates: cands });
    }
  }, [lines, curves, snapPoints, proximityRadius, post, pinCanvasRef]);

  // ── Transform effect ──────────────────────────────────────────────────────
  useEffect(() => {
    post({ type: 'transform', zoom, panX: pan.x, panY: pan.y });
  }, [zoom, pan.x, pan.y, post]);

  // ── Settings effect ───────────────────────────────────────────────────────
  useEffect(() => {
    post({ type: 'settings', showPins, activeTool, snapThreshold, proximityRadius });
    if (!showPins) {
      post({ type: 'cursor_leave' });
      post({ type: 'clear' });
    }
  }, [showPins, activeTool, snapThreshold, proximityRadius, post]);

  // ── Resize observer ───────────────────────────────────────────────────────
  useEffect(() => {
    const el = viewportRef?.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      for (const e of entries) {
        const { width, height } = e.contentRect;
        post({ type: 'resize', vpW: width, vpH: height, dpr: window.devicePixelRatio || 1 });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [viewportRef, post]);

  // ── redrawPinCanvas ───────────────────────────────────────────────────────
  const redrawPinCanvas = useCallback(() => {
    if (!showPinsRef.current) {
      post({ type: 'cursor_leave' });
      return;
    }
    const cursor = cursorPointRef.current;
    if (cursor) post({ type: 'cursor', x: cursor.x, y: cursor.y });
    else        post({ type: 'cursor_leave' });
  }, [post]);

  // ── snapToCorner — main thread, synchronous ───────────────────────────────
  const snapToCorner = useCallback((canvasX: number, canvasY: number): SnapResult => {
    if (!snapEnabledRef.current)
      return { point: { x: canvasX, y: canvasY }, snapped: false, type: null };

    const threshC = snapThresholdRef.current / zoomRef.current;
    let best: { x: number; y: number } | null = null;
    let bestDist = threshC;
    let bestType: string | null = null;

    // 1. Snap points (highest priority — endpoint, midpoint, intersection, etc.)
    const nearby = spatialGridRef.current
      ? queryGridMain(spatialGridRef.current, canvasX, canvasY, threshC)
      : candidatesCacheRef.current;

    for (const c of nearby) {
      const d = Math.hypot(canvasX - c.x, canvasY - c.y);
      if (d < bestDist) { bestDist = d; best = { x: c.x, y: c.y }; bestType = c.type; }
    }

    // 2. Nearest point on any line (fallback — gives 'line' type)
    if (!best) {
      for (const line of linesRef.current) {
        const [a, b] = line.vertices;
        const cp = closestPointOnSegment(canvasX, canvasY, a.x, a.y, b.x, b.y);
        const d  = Math.hypot(canvasX - cp.x, canvasY - cp.y);
        if (d < bestDist) { bestDist = d; best = cp; bestType = 'line'; }
      }
    }

    return best
      ? { point: best, snapped: true,  type: bestType }
      : { point: { x: canvasX, y: canvasY }, snapped: false, type: null };
  }, []);

  // ── triggerSnapFlash ──────────────────────────────────────────────────────
  const triggerSnapFlash = useCallback((x: number, y: number) => {
    const id = ++flashIdRef.current;
    setSnapFlashes(prev => [...prev, { x, y, id }]);
    setTimeout(() => setSnapFlashes(prev => prev.filter(f => f.id !== id)), 700);
  }, []);

  // ── Chain ─────────────────────────────────────────────────────────────────
  const addChainPoint  = useCallback((x: number, y: number, type: string) => {
    setLinearChain(prev => [...prev, { x, y, type }]);
  }, []);
  const undoChainPoint = useCallback(() => setLinearChain(prev => prev.slice(0, -1)), []);
  const clearChain     = useCallback(() => setLinearChain([]), []);

  return {
    snapFlashes,
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