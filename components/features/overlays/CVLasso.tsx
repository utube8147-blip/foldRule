/**
 * CVLasso.tsx  v1.0
 * ──────────────────
 * Freehand auto-closing lasso for template sampling.
 *
 * Replaces useCVRubberBand + CVRubberBand from CVMatchOverlay.tsx.
 *
 * CONTRACT
 *  • Points are collected in viewport space (raw pointer coords relative to
 *    the viewport div).
 *  • onCommit receives the viewport-space polygon.  The caller is responsible
 *    for converting to canvas space via  canvasPt = (vpPt - pan) / zoom.
 *  • Auto-closes when the pointer returns within CLOSE_RADIUS px of the
 *    start point OR when the pointer is released (min 8 points enforced).
 *  • If fewer than 3 points are captured the lasso is silently discarded.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';

// ─── Constants ────────────────────────────────────────────────────────────────

const CLOSE_RADIUS = 18;   // px — snap-to-close distance
const MIN_DIST     = 4;    // px — minimum distance between recorded points
const MIN_POINTS   = 3;    // discard if fewer than this many unique points

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LassoPoint { x: number; y: number }

export interface LassoCommitPayload {
  /** Viewport-space polygon (not yet in canvas/image space) */
  points:    LassoPoint[];
  /** Axis-aligned bounding box in viewport space */
  vpBbox:    { x: number; y: number; w: number; h: number };
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useCVLasso(
  viewportRef: React.RefObject<HTMLDivElement | null>,
  enabled:     boolean,
  onCommit:    (payload: LassoCommitPayload) => void,
) {
  const [points,      setPoints]      = useState<LassoPoint[]>([]);
  const [isDrawing,   setIsDrawing]   = useState(false);
  const [nearClose,   setNearClose]   = useState(false);  // snap indicator
  const [tooSmall,    setTooSmall]    = useState(false);

  const activeRef = useRef(false);
  const ptsRef    = useRef<LassoPoint[]>([]);

  // ── Helpers ──────────────────────────────────────────────────────────────────

  const vpRect = useCallback((): DOMRect | null =>
    viewportRef.current?.getBoundingClientRect() ?? null, [viewportRef]);

  const bboxOf = (pts: LassoPoint[]) => {
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  };

  const commit = useCallback((pts: LassoPoint[]) => {
    if (pts.length < MIN_POINTS) return;
    const bb = bboxOf(pts);
    if (bb.w < 6 || bb.h < 6) return;
    onCommit({ points: pts, vpBbox: bb });
  }, [onCommit]);

  // ── PointerDown — start lasso ─────────────────────────────────────────────

  const startLasso = useCallback((e: React.PointerEvent) => {
    if (!enabled) return;
    const vr = vpRect(); if (!vr) return;
    const pt = { x: e.clientX - vr.left, y: e.clientY - vr.top };
    ptsRef.current  = [pt];
    activeRef.current = true;
    setPoints([pt]);
    setIsDrawing(true);
    setNearClose(false);
    setTooSmall(false);
  }, [enabled, vpRect]);

  // ── PointerMove + PointerUp listeners (attached to window while drawing) ──

  useEffect(() => {
    if (!enabled) return;
    const vp = viewportRef.current; if (!vp) return;

    const onMove = (e: PointerEvent) => {
      if (!activeRef.current) return;
      const vr = vp.getBoundingClientRect();
      const pt = { x: e.clientX - vr.left, y: e.clientY - vr.top };

      // Throttle — only record if moved MIN_DIST from last point
      const last = ptsRef.current[ptsRef.current.length - 1];
      const dist = Math.hypot(pt.x - last.x, pt.y - last.y);
      if (dist >= MIN_DIST) {
        ptsRef.current = [...ptsRef.current, pt];
        setPoints([...ptsRef.current]);
      }

      // Check near-close
      const first = ptsRef.current[0];
      const dClose = Math.hypot(pt.x - first.x, pt.y - first.y);
      setNearClose(dClose < CLOSE_RADIUS && ptsRef.current.length > 8);

      // Bounding-box size feedback
      if (ptsRef.current.length >= 3) {
        const bb = bboxOf(ptsRef.current);
        setTooSmall(bb.w < 6 || bb.h < 6);
      }

      // Auto-close if near start
      if (dClose < CLOSE_RADIUS && ptsRef.current.length > 8) {
        activeRef.current = false;
        setIsDrawing(false);
        setNearClose(false);
        commit(ptsRef.current);
        ptsRef.current = [];
        setPoints([]);
      }
    };

    const onUp = (_e: PointerEvent) => {
      if (!activeRef.current) return;
      activeRef.current = false;
      setIsDrawing(false);
      setNearClose(false);
      commit(ptsRef.current);
      ptsRef.current = [];
      setPoints([]);
    };

    vp.addEventListener('pointermove', onMove);
    vp.addEventListener('pointerup',   onUp);
    return () => {
      vp.removeEventListener('pointermove', onMove);
      vp.removeEventListener('pointerup',   onUp);
    };
  }, [enabled, viewportRef, commit]);

  return { points, isDrawing, nearClose, tooSmall, startLasso };
}

// ─── SVG overlay ─────────────────────────────────────────────────────────────

interface CVLassoOverlayProps {
  points:    LassoPoint[];
  isDrawing: boolean;
  nearClose: boolean;
  tooSmall:  boolean;
  /** Accent colour — defaults to sky blue */
  color?:    string;
}

export function CVLassoOverlay({
  points, isDrawing, nearClose, tooSmall, color = '#38bdf8',
}: CVLassoOverlayProps) {
  if (!isDrawing || points.length < 2) return null;

  const col  = tooSmall ? '#f43f5e' : nearClose ? '#22c55e' : color;
  const poly = points.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const fp   = points[0];
  const lp   = points[points.length - 1];

  // Animated dash offset for a "marching ants" feel
  return (
    <svg
      style={{
        position:'absolute',inset:0,pointerEvents:'none',
        zIndex:35,overflow:'visible',
      }}
      width="100%" height="100%"
    >
      <defs>
        <style>{`
          @keyframes lasso-march { from { stroke-dashoffset: 0 } to { stroke-dashoffset: -20 } }
          @keyframes lasso-pulse { 0%,100%{opacity:.5} 50%{opacity:1} }
        `}</style>
        <filter id="lasso-glow">
          <feGaussianBlur stdDeviation="1.5" result="blur"/>
          <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>

      {/* Filled interior — light tint */}
      <polygon
        points={poly}
        fill={col}
        fillOpacity={0.08}
      />

      {/* Marching-ants outline */}
      <polygon
        points={poly}
        fill="none"
        stroke={col}
        strokeWidth={1.5}
        strokeDasharray="8 4"
        strokeLinejoin="round"
        style={{ animation: 'lasso-march 0.5s linear infinite' }}
        filter="url(#lasso-glow)"
      />

      {/* Solid inner outline */}
      <polygon
        points={poly}
        fill="none"
        stroke="rgba(0,0,0,0.35)"
        strokeWidth={0.75}
        strokeLinejoin="round"
      />

      {/* Start-point indicator */}
      <circle
        cx={fp.x} cy={fp.y}
        r={nearClose ? CLOSE_RADIUS : 5}
        fill={nearClose ? `${col}22` : 'none'}
        stroke={col}
        strokeWidth={nearClose ? 1.5 : 1}
        style={{ animation: nearClose ? 'lasso-pulse .6s ease-in-out infinite' : 'none',
                 transition: 'r .15s, fill .15s' }}
      />
      <circle cx={fp.x} cy={fp.y} r={3} fill={col} />

      {/* Current cursor dot */}
      <circle cx={lp.x} cy={lp.y} r={3} fill={col} fillOpacity={0.7} />

      {/* Closing line preview */}
      {nearClose && (
        <line
          x1={lp.x} y1={lp.y} x2={fp.x} y2={fp.y}
          stroke={col} strokeWidth={1} strokeDasharray="4 3" strokeOpacity={0.6}
        />
      )}

      {/* Label */}
      <text
        x={fp.x + 10} y={fp.y - 8}
        fontSize={8} fill={col}
        fontFamily="'Courier New',monospace"
        style={{ filter:'url(#lasso-glow)' }}
      >
        {tooSmall
          ? 'Too small'
          : nearClose
            ? '↩ Release to close'
            : `${points.length} pts`}
      </text>
    </svg>
  );
}

// ─── Utility: convert viewport-space lasso to canvas-space ───────────────────

export function vpLassoToCanvas(
  points: LassoPoint[],
  zoom:   number,
  pan:    { x: number; y: number },
): LassoPoint[] {
  return points.map(p => ({
    x: (p.x - pan.x) / zoom,
    y: (p.y - pan.y) / zoom,
  }));
}

/**
 * Given a canvas-space lasso polygon, crops the *bounding rect* of the lasso
 * from `srcCanvas`, then masks out any pixel that falls outside the polygon
 * by painting it white.  Returns an ImageData ready for matchTemplate.
 *
 * @param srcCanvas  The full rendered PDF canvas.
 * @param canvasPts  Lasso points already in canvas-pixel space.
 */
export function lassoToImageData(
  srcCanvas: HTMLCanvasElement,
  canvasPts: LassoPoint[],
): { imageData: ImageData; bbox: { x: number; y: number; w: number; h: number } } | null {
  if (canvasPts.length < 3) return null;

  const xs = canvasPts.map(p => p.x), ys = canvasPts.map(p => p.y);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const x1 = Math.min(srcCanvas.width,  Math.ceil(Math.max(...xs)));
  const y1 = Math.min(srcCanvas.height, Math.ceil(Math.max(...ys)));
  const bw  = x1 - x0, bh = y1 - y0;
  if (bw < 4 || bh < 4) return null;

  // Crop the bounding rect
  const ctx  = srcCanvas.getContext('2d')!;
  const crop = ctx.getImageData(x0, y0, bw, bh);

  // Translate polygon to bbox-local coords
  const localPts = canvasPts.map(p => ({ x: p.x - x0, y: p.y - y0 }));

  // Point-in-polygon test (ray casting)
  function inPolygon(px: number, py: number): boolean {
    let inside = false;
    const n = localPts.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = localPts[i].x, yi = localPts[i].y;
      const xj = localPts[j].x, yj = localPts[j].y;
      const intersect = ((yi > py) !== (yj > py)) &&
        (px < (xj - xi) * (py - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  // Mask: set pixels outside polygon to white
  const d = crop.data;
  for (let row = 0; row < bh; row++) {
    for (let col = 0; col < bw; col++) {
      if (!inPolygon(col + 0.5, row + 0.5)) {
        const i = (row * bw + col) * 4;
        d[i] = d[i+1] = d[i+2] = 255;
        d[i+3] = 255;
      }
    }
  }

  return {
    imageData: crop,
    bbox: { x: x0, y: y0, w: bw, h: bh },
  };
}